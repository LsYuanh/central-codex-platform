// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real central harness -> gateway -> independent Windows Agent. No production default.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

if (!process.env.HARNESS_GATEWAY_URL) throw new Error('Set HARNESS_GATEWAY_URL to the isolated real central harness gateway');
const url = new URL(process.env.HARNESS_GATEWAY_URL);
if (url.port === '4510') throw new Error('This acceptance script refuses the production 4510 service');
const deviceId = `harness-live-${randomUUID()}`;
url.searchParams.set('deviceId', deviceId);
url.searchParams.set('userId', deviceId);
const agentUrl = new URL(url);
agentUrl.pathname = '/ws/agent';
agentUrl.searchParams.delete('userId');
// Match Agent canonicalize()+display_path(), including a short-name or aliased TEMP.
const fixture = (await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-live-')))).replace(/^\\\\\?\\/, '');
const outputDirectory = (await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-output-')))).replace(/^\\\\\?\\/, '');
const samplePath = join(fixture, 'sample.txt').replaceAll('\\', '/');
const clientMarker = `CLIENT_RULE_${randomUUID()}`;
await writeFile(join(fixture, 'AGENTS.md'), `Project rule from this Windows client: ${clientMarker}. Edit sample.txt only through device_workspace_apply_patch. Do not edit any other file.\n`);
await writeFile(join(fixture, 'sample.txt'), 'value=before\r\n');
execFileSync('git', ['init', '-q', fixture], { windowsHide: true });
execFileSync('git', ['-C', fixture, 'add', '.'], { windowsHide: true });
const agent = spawn(resolve(process.env.LOCAL_AGENT_BIN ?? 'target/debug/local-agent.exe'), [
  '--workspace-root', outputDirectory, '--gateway-url', String(agentUrl), '--allow-insecure-lan', '--attachment-stdio',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
// Exercise the same open private IPC handles as a Tauri-managed Agent.
agent.stdout.resume();
let diagnostics = '';
agent.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4096); });
const socket = new WebSocket(url);
const events = [];
const pending = new Map();
const exactPatch = `*** Begin Patch\n*** Update File: ${samplePath}\n@@\n-value=before\n+value=after\n*** End Patch`;
let approvals = 0;
socket.on('message', data => {
  const message = JSON.parse(String(data));
  events.push(message);
  if (message.type === 'response') pending.get(message.requestId)?.(message);
  if (message.type === 'approval.request') {
    const allowed = message.method === 'device/fileChange/requestApproval'
      && message.data?.deviceId === deviceId
      && message.data?.workspaceRoot === outputDirectory
      && String(message.data?.patch).trim() === exactPatch
      && Object.keys(message.data?.expectedVersions ?? {}).join(',') === samplePath
      && approvals === 0;
    if (allowed) approvals++;
    socket.send(JSON.stringify({ type: 'approval.response', requestId: message.requestId, result: { decision: allowed ? 'accept' : 'reject' } }));
    console.log(JSON.stringify({ phase: 'fixture-patch-approval', accepted: allowed, requestId: message.requestId }));
  }
});
function request(operation, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${operation} response unknown/timeout; do not replay`)); }, 65000);
    pending.set(requestId, response => {
      clearTimeout(timer);
      pending.delete(requestId);
      response.ok ? resolve(response.data) : reject(new Error(response.error));
    });
    socket.send(JSON.stringify({ type: 'request', operation, requestId, payload }));
  });
}
async function until(predicate, label, timeout = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
let threadId;
let turnId;
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await until(() => events.some(event => event.agent === 'online'), 'independent client Agent registration', 20000);
  await request('session.initialize', { clientInfo: { name: 'harness-real-acceptance', version: '1' } });
  const context = await request('device.workspace.context', {path:fixture});
  assert.equal(context.ok, true);
  assert.equal(context.result.os, 'windows');
  assert.equal(context.result.workspaceRoot, outputDirectory);
  assert(context.result.rules.some(rule => rule.content.includes(clientMarker)));
  threadId = (await request('conversation.create')).thread.id;
  const code = "const fs=require('fs');if(!fs.readFileSync('sample.txt','utf8').includes('value=after'))process.exit(9);console.log('CLIENT_TEST_OK '+require('os').hostname())";
  const prompt = `Run this authorized acceptance scenario in the client project ${JSON.stringify(fixture)}, which is OUTSIDE the default output directory ${JSON.stringify(outputDirectory)}. Use the named device tools in order: device_workspace_context(path=${JSON.stringify(fixture)}), device_workspace_search(path=${JSON.stringify(fixture)},mode="text",query="value=before"), device_workspace_read_text(path=${JSON.stringify(samplePath)}), device_workspace_apply_patch with exactly this patch:\n${exactPatch}\nAfter approval and successful modification, call device_workspace_git_status and device_workspace_git_diff with path=${JSON.stringify(fixture)}. Then call device_exec with cwd=${JSON.stringify(fixture)}, program=${JSON.stringify(process.execPath)}, args=${JSON.stringify(['-e', code])}. Finally call device_exec with cwd=${JSON.stringify(fixture)}, the same program and args=${JSON.stringify(['-e', 'console.log("CLIENT_NONZERO_STDOUT");console.error("CLIENT_NONZERO_STDERR");process.exit(7)'])}; this deliberate failure is expected, report its real exit code and do not retry. Finish with the client project-rule marker and client hostname returned by tools. Do not use built-in central tools, modify other files, or substitute a file-write tool for the patch tool. No clarification is needed for this isolated test fixture.`;
  turnId = (await request('conversation.turn.create', { threadId, clientMessageId: randomUUID(), input: [{ type: 'text', text: prompt }] })).turn.id;
  console.log(JSON.stringify({ phase: 'real-model-turn-started', threadId, turnId, deviceId, fixture }));
  await until(() => events.find(event => event.eventType === 'turn.completed' && event.data?.threadId === threadId && (event.data?.turn?.id ?? event.data?.turnId) === turnId), 'real central model turn');
  assert.equal(approvals, 1);
  assert.equal(await readFile(join(fixture, 'sample.txt'), 'utf8'), 'value=after\r\n');
  const completed = events.filter(event => event.name === 'device/tool/completed' && event.data?.threadId === threadId && event.data?.turnId === turnId);
  for (const tool of ['device_workspace_context', 'device_workspace_search', 'device_workspace_read_text', 'device_workspace_apply_patch', 'device_workspace_git_status', 'device_workspace_git_diff']) {
    assert(completed.some(event => event.data.tool === tool && event.data.status === 'succeeded'), `Missing successful ${tool}`);
  }
  assert(completed.some(event => event.data.tool === 'device_exec' && event.data.exitCode === 0));
  assert(completed.some(event => event.data.tool === 'device_exec' && event.data.exitCode === 7 && event.data.status === 'failed'));
  const diff = await request('device.workspace.git_diff', {path:fixture});
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.match(diff.result.stdout, /\+value=after/);
  assert(events.some(event => event.name === 'device/tool/output' && String(event.data?.chunk).includes(`CLIENT_TEST_OK ${hostname()}`)));
  const history = await request('conversation.read', { threadId, includeTurns: true });
  const turn = history.thread.turns.find(turn => turn.id === turnId);
  assert.equal(turn.status, 'completed');
  const response = turn.items.filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n');
  assert(response.includes(clientMarker), 'model final response must identify the client project-rule marker');
  assert(response.toLowerCase().includes(hostname().toLowerCase()), 'model final response must identify the actual client hostname');
  console.log(JSON.stringify({ ok: true, source: 'real-central-harness-windows-agent', threadId, turnId, fixture, deviceId,
    checks: ['project-outside-output-directory', 'absolute-cwd', 'client-rules-context', 'model-search-read-patch', 'single-invocation-approval', 'actual-crlf-write', 'actual-client-git-diff', 'client-test-stdout-exit', 'structured-nonzero-exit', 'native-turn-completion'] }));
} catch (error) {
  console.error(JSON.stringify({ phase: 'acceptance-failed', threadId, turnId, fixture, diagnostics,
    recent: events.slice(-6).map(event => ({ type: event.type, event: event.name ?? event.eventType, data: event.data })) }));
  throw error;
} finally {
  if (threadId && turnId && !events.some(event => event.eventType === 'turn.completed' && event.data?.threadId === threadId)) {
    try { await request('conversation.turn.cancel', { threadId, turnId }); } catch {}
  }
  if (threadId) { try { await request('conversation.archive', { threadId }); } catch {} }
  socket.close();
  agent.kill();
  // Keep the tiny fixture and its actual Git diff as auditable acceptance evidence.
}
