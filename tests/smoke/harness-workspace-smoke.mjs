// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Local Agent on this client; loopback AgentRPC transport, no model/central acceptance claim.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { deflateSync } from 'node:zlib';
import { OutputBroker } from '../../services/central-gateway/dist/outputs.js';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const directory = await mkdtemp(join(tmpdir(), 'codex-harness-workspace-'));
await mkdir(join(directory, 'src'));
await writeFile(join(directory, 'AGENTS.md'), 'Client fixture rule: CLIENT_ONLY_MARKER\n');
await writeFile(join(directory, 'src', 'code.txt'), 'original\r\nsecond\r\n');
execFileSync('git', ['init', '-q', directory], { windowsHide: true });
execFileSync('git', ['-C', directory, 'add', '.'], { windowsHide: true });
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const deviceId = `harness-${randomUUID()}`;
let socket;
let hello;
const waiting = new Map();
let dropResponse;
let connected;
let ready = new Promise(resolve => { connected = resolve; });
server.on('connection', value => {
  socket = value;
  value.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.type === 'agent.hello') {
      hello = frame.payload.agent;
      connected();
    } else if (frame.type === 'agent.response') {
      if (dropResponse === frame.requestId) {
        dropResponse = undefined;
        value.close();
        waiting.get(frame.requestId)?.reject(new Error('RESULT_UNKNOWN: response deliberately discarded'));
      } else waiting.get(frame.requestId)?.resolve(frame.payload);
      waiting.delete(frame.requestId);
    }
  });
});
const agent = spawn(process.env.AGENT_SMOKE_BINARY ?? resolve('target/debug/local-agent.exe'), [
  '--workspace-root', directory, '--gateway-url', `ws://127.0.0.1:${server.address().port}/ws/agent?deviceId=${deviceId}`,
  '--attachment-stdio',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
// Keep the inherited desktop IPC open for the full test, exactly as Tauri does.
// Tool processes must not inherit this stdin or the attachment reader can starve them.
agent.stdout.resume();
let diagnostic = '';
agent.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4096); });
const timer = setTimeout(() => { throw new Error(`Agent smoke timed out: ${diagnostic}`); }, 45000);
function begin(method, params = {}, options = {}) {
  const requestId = randomUUID();
  const binding = { policy: 'remote-workspace/v1', userId: 'smoke-user', deviceId,
    deviceKey: hello.deviceKey, workspaceRoot: hello.workspaceRoot };
  const promise = new Promise((resolve, reject) => waiting.set(requestId, { resolve, reject }));
  if (options.drop) dropResponse = requestId;
  socket.send(JSON.stringify({ protocol: 'agentrpc', version: 1, type: 'agent.request', requestId,
    payload: { method, params: { ...params, __remoteWorkspace: { ...binding, ...options.binding } } } }));
  return { requestId, promise };
}
async function call(method, params, options) {
  const response = await begin(method, params, options).promise;
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}
try {
  await ready;
  assert(hello.capabilities.includes('workspace/apply_patch'));
  const context = await call('workspace/context');
  assert.equal(context.source, 'client');
  assert.match(context.rules[0].content, /CLIENT_ONLY_MARKER/);
  const search = await call('workspace/search', { mode: 'text', query: 'original' });
  assert.equal(search.matches[0].path, 'src/code.txt');
  const wrongDevice = await begin('workspace/context', {}, { binding: { deviceKey: 'wrong' } }).promise;
  assert.equal(wrongDevice.errorCode, 'WORKSPACE_BINDING_MISMATCH');
  const outside = await mkdtemp(join(tmpdir(), 'codex-harness-outside-'));
  await writeFile(join(outside, 'outside.txt'), 'EXTERNAL_CLIENT_MARKER');
  await writeFile(join(outside, 'AGENTS.md'), 'EXTERNAL_PROJECT_RULE');
  assert(hello.capabilities.includes('client-paths/v1'));
  assert.equal((await call('workspace/read_text', { path: join(outside, 'outside.txt') })).content, 'EXTERNAL_CLIENT_MARKER');
  assert.equal((await call('workspace/read_text', { path: relative(directory, join(outside, 'outside.txt')) })).content, 'EXTERNAL_CLIENT_MARKER');
  assert((await call('workspace/context', { path: outside })).rules.some(rule => rule.content === 'EXTERNAL_PROJECT_RULE'));
  assert((await call('workspace/list', { path: outside })).entries.some(entry => entry.name === 'outside.txt'));
  assert.equal((await call('read_file', { path: join(outside, 'outside.txt') })).content, 'EXTERNAL_CLIENT_MARKER');
  assert.equal((await call('workspace/search', { path: outside, mode: 'text', query: 'EXTERNAL_CLIENT_MARKER' })).matches.length, 1);
  const cwdResult = await call('exec', { program: process.execPath, args: ['-e', 'console.log(require("node:fs").realpathSync(process.cwd()))'], cwd: outside });
  assert.equal(cwdResult.stdout.trim().toLowerCase(), outside.toLowerCase());
  execFileSync('git', ['init', '-q', outside], { windowsHide: true });
  execFileSync('git', ['-C', outside, 'add', '.'], { windowsHide: true });
  const externalPatch = `*** Begin Patch\n*** Update File: ${join(outside, 'outside.txt').replaceAll('\\', '/')}\n@@\n-EXTERNAL_CLIENT_MARKER\n+EXTERNAL_EDITED_MARKER\n*** End Patch`;
  const externalPreview = await call('workspace/apply_patch', { patch: externalPatch, dryRun: true });
  assert.equal((await call('workspace/apply_patch', { ...externalPreview, patch: externalPatch, dryRun: false })).outcome, 'completed');
  assert.match((await call('workspace/git_diff', { path: outside })).stdout, /EXTERNAL_EDITED_MARKER/);
  assert.match((await call('workspace/git_status', { path: outside })).stdout, /outside.txt/);
  const savedText = await call('file/write_text', { name: 'generated.txt', content: 'DEFAULT_OUTPUT_MARKER' });
  assert.equal(await readFile(join(directory, 'generated.txt'), 'utf8'), 'DEFAULT_OUTPUT_MARKER');
  assert.equal((await call('file/output_paths')).outputDirectory, hello.workspaceRoot);
  const outputSummary = {deviceId, deviceKey: hello.deviceKey};
  const broker = new OutputBroker({ summary: () => outputSummary, deviceKey: () => hello.deviceKey, changed: () => {}, call: async (_, method, params) => begin(method, params).promise });
  // Use a known valid client-created image; the broker receives inline bytes only.
  const imageBytes = fixturePng();
  await broker.image('output-test', 'output-turn', {type:'imageGeneration',id:randomUUID(),status:'completed',result:imageBytes.toString('base64')});
  const imageOutput = broker.list('output-test')[0];
  assert.equal(imageOutput.status, 'saved', imageOutput.error);
  assert.equal(resolve(imageOutput.path), join(directory, imageOutput.name));
  assert.deepEqual(await readFile(imageOutput.path), imageBytes);
  await symlink(outside, join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('workspace/read_text', { path: 'escape/outside.txt' })).content.trim(), 'EXTERNAL_EDITED_MARKER');
  const linkPatch = '*** Begin Patch\n*** Update File: escape/outside.txt\n@@\n-EXTERNAL_EDITED_MARKER\n+LINK_EDITED\n*** End Patch';
  const linkPreview = await call('workspace/apply_patch', { patch: linkPatch, dryRun: true });
  const redirected = await mkdtemp(join(tmpdir(), 'codex-harness-link-target-'));
  await writeFile(join(redirected, 'outside.txt'), await readFile(join(outside, 'outside.txt')));
  await unlink(join(directory, 'escape')); // Remove only this test's link, never its target.
  await symlink(redirected, join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const retargeted = await begin('workspace/apply_patch', { ...linkPreview, patch: linkPatch, dryRun: false }).promise;
  assert.equal(retargeted.errorCode, 'PATCH_APPROVAL_MISMATCH');
  assert.equal((await readFile(join(redirected, 'outside.txt'), 'utf8')).trim(), 'EXTERNAL_EDITED_MARKER');
  const linkSearch = await call('workspace/search', { query: 'outside' });
  assert.equal(linkSearch.matches.length, 0);
  assert.equal(linkSearch.skippedEntries, 1);
  const patch = '*** Begin Patch\n*** Update File: src/code.txt\n@@\n-original\n+modified\n*** End Patch';
  const preview = await call('workspace/apply_patch', { patch, dryRun: true });
  assert.equal(await readFile(join(directory, 'src/code.txt'), 'utf8'), 'original\r\nsecond\r\n');
  await writeFile(join(directory, 'src/code.txt'), 'original\r\nchanged-after-preview\r\n');
  const conflict = await begin('workspace/apply_patch', { patch, patchHash: preview.patchHash, expectedVersions: preview.expectedVersions, expectedPaths: preview.expectedPaths }).promise;
  assert.equal(conflict.errorCode, 'VERSION_CONFLICT');
  const current = await call('workspace/apply_patch', { patch, dryRun: true });
  const applied = await call('workspace/apply_patch', { patch, patchHash: current.patchHash, expectedVersions: current.expectedVersions, expectedPaths: current.expectedPaths });
  assert.equal(applied.outcome, 'completed');
  assert.equal(await readFile(join(directory, 'src/code.txt'), 'utf8'), 'modified\r\nchanged-after-preview\r\n');
  const diff = await call('workspace/git_diff');
  assert.equal(diff.exitCode, 0);
  assert.match(diff.stdout, /\+modified/);
  assert.match((await call('workspace/git_status')).stdout, /src\/code.txt/);
  await writeFile(join(directory, 'part-one.txt'), 'old\n');
  await writeFile(join(directory, 'part-two.txt'), 'old\n');
  const partialPatch = '*** Begin Patch\n*** Update File: part-one.txt\n@@\n-old\n+new\n*** Update File: part-two.txt\n@@\n-old\n+new\n*** End Patch';
  const partialPreview = await call('workspace/apply_patch', { patch: partialPatch, dryRun: true });
  await chmod(join(directory, 'part-two.txt'), 0o444);
  try {
    const partial = await call('workspace/apply_patch', { patch: partialPatch, patchHash: partialPreview.patchHash, expectedVersions: partialPreview.expectedVersions, expectedPaths: partialPreview.expectedPaths });
    assert.equal(partial.outcome, 'partial');
    assert.match(partial.error, /PERMISSION_DENIED/);
    assert.equal(partial.applied[0].path, 'part-one.txt');
    assert.equal(await readFile(join(directory, 'part-one.txt'), 'utf8'), 'new\n');
    assert.equal(await readFile(join(directory, 'part-two.txt'), 'utf8'), 'old\n');
  } finally { await chmod(join(directory, 'part-two.txt'), 0o666); }
  const success = await call('exec', { program: process.execPath, args: ['-e', 'console.log("CLIENT_TEST_PASSED")'] });
  assert.equal(success.exitCode, 0);
  assert.match(success.stdout, /CLIENT_TEST_PASSED/);
  const failure = await begin('exec', { program: process.execPath, args: ['-e', 'console.log("CLIENT_BEFORE_FAILURE"); console.error("CLIENT_ERROR_DETAIL"); process.exit(7)'] }).promise;
  assert.equal(failure.ok, false);
  assert.equal(failure.errorCode, 'COMMAND_FAILED');
  assert.equal(failure.result.exitCode, 7);
  assert.match(failure.result.stdout, /CLIENT_BEFORE_FAILURE/);
  assert.match(failure.result.stderr, /CLIENT_ERROR_DETAIL/);
  const timeout = await begin('exec', { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 1000 }).promise;
  assert.equal(timeout.errorCode, 'COMMAND_TIMEOUT');
  const active = begin('exec', { program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] });
  await new Promise(resolve => setTimeout(resolve, 300));
  socket.send(JSON.stringify({ protocol: 'agentrpc', version: 1, type: 'job.cancel', requestId: active.requestId }));
  assert.equal((await active.promise).errorCode, 'COMMAND_CANCELLED');
  const addPatch = '*** Begin Patch\n*** Add File: lost-result.txt\n+written-once\n*** End Patch';
  const addPreview = await call('workspace/apply_patch', { patch: addPatch, dryRun: true });
  ready = new Promise(resolve => { connected = resolve; });
  await assert.rejects(begin('workspace/apply_patch', { patch: addPatch, patchHash: addPreview.patchHash, expectedVersions: addPreview.expectedVersions, expectedPaths: addPreview.expectedPaths }, { drop: true }).promise, /RESULT_UNKNOWN/);
  await ready;
  assert.equal((await call('workspace/read_text', { path: 'lost-result.txt' })).content, 'written-once\n');
  console.log(JSON.stringify({ ok: true, source: 'real-client-agent-loopback-rpc', fixture: directory,
    checks: ['context-rules', 'search', 'device-mismatch', 'external-path-access', 'explicit-symlink-junction-access', 'approval-rejects-retargeted-link', 'default-document-and-image-output', 'absolute-command-cwd', 'external-project-git', 'preview-no-write', 'approval-version-conflict', 'upstream-patch-crlf', 'actual-git-diff', 'readonly-partial-patch', 'test-exit-output', 'nonzero-structured-exit-output', 'timeout', 'cancel', 'lost-result-reconcile-no-replay'] }));
} finally {
  clearTimeout(timer);
  agent.kill();
  for (const client of server.clients) client.terminate();
  await new Promise(resolve => server.close(resolve));
  // Retain the small fixture for evidence; no recursive deletion of a computed path.
}

function fixturePng(){
  const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
  const raw=Buffer.alloc(32*(32*3+1));for(let y=0;y<32;y++)for(let x=0;x<32;x++)raw[y*97+1+x*3+1]=255;
  const chunk=(name,data)=>{const type=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);let crc=0xffffffff;for(const byte of Buffer.concat([type,data])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const check=Buffer.alloc(4);check.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,type,data,check]);};
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
