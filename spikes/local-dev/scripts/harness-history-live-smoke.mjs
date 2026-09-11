// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// P4 real native history fixture with the fixed legacy device-tool table.
// This is explicitly a migration fixture, never a claim about private production history.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { prepareArtifactFixture, verifyArtifactHistory } from './harness-artifact-history-smoke.mjs';

const endpoint = process.env.HARNESS_HISTORY_GATEWAY_URL ?? process.env.HARNESS_GATEWAY_URL;
if (!endpoint) throw new Error('Set HARNESS_HISTORY_GATEWAY_URL to the explicitly selected isolated real central gateway');
const url = new URL(endpoint);
if (url.port === '4510') throw new Error('History fixture acceptance refuses the production 4510 service');
const runId = randomUUID();
const deviceId = `harness-history-${runId}`;
const userId = deviceId;
url.searchParams.set('userId', userId);
url.searchParams.set('deviceId', deviceId);
const agentUrl = new URL(url);
agentUrl.pathname = '/ws/agent';
agentUrl.searchParams.delete('userId');
const fixture = (await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-history-')))).replace(/^\\\\\?\\/, '');
await writeFile(join(fixture, 'AGENTS.md'), 'This is an isolated P4 history migration fixture. Test writes to history.txt, counter.log and the explicitly specified artifact-history-* client-result.txt are authorized. Preserve all client-source.txt attachments. Do not modify other files or use central filesystem tools.\n');
await writeFile(join(fixture, 'history.txt'), 'legacy\r\n');
await writeFile(join(fixture, 'counter.log'), '');
const agentBinary = resolve(process.env.LOCAL_AGENT_BIN ?? 'target/harness-agent/debug/local-agent.exe');
const agentSha256 = createHash('sha256').update(await readFile(agentBinary)).digest('hex');
const agent = spawn(agentBinary, [
  '--workspace-root', fixture, '--gateway-url', String(agentUrl), '--allow-insecure-lan', '--attachment-stdio',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let diagnostics = '';
agent.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-4096); });
const ipcPending = new Map();
createInterface({ input: agent.stdout }).on('line', line => {
  const value = JSON.parse(line);
  const pending = ipcPending.get(value.id);
  if (!pending) return;
  ipcPending.delete(value.id);
  clearTimeout(pending.timer);
  value.ok ? pending.resolve(value.result) : pending.reject(new Error(value.error));
});
function ipc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { ipcPending.delete(id); reject(new Error(`IPC ${method} timed out; do not replay writes`)); }, 15000);
    ipcPending.set(id, { resolve, reject, timer });
    agent.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

let socket;
let threadId;
let activeTurnId;
let archived = false;
let approvals = 0;
const events = [];
const pending = new Map();
const deliberatelyLost = new Set();
let discardedResponses = 0;
const exactPatch = '*** Begin Patch\n*** Update File: history.txt\n@@\n-legacy\n+resumed\n*** End Patch';

async function connect() {
  const current = new WebSocket(url);
  socket = current;
  current.on('message', bytes => {
    const value = JSON.parse(String(bytes));
    if (value.type === 'response' && deliberatelyLost.delete(value.requestId)) {
      discardedResponses++;
      // Do not consume the submission's turn ID/result; reconciliation must use public history/status.
      return;
    }
    events.push(value);
    if (value.name === 'turn/started' && value.data?.threadId === threadId) {
      activeTurnId = value.data.turn?.id;
      console.log(JSON.stringify({ phase: 'history-turn-started', threadId, turnId: activeTurnId }));
    }
    if (value.name === 'device/tool/completed' && value.data?.threadId === threadId) {
      console.log(JSON.stringify({ phase: 'history-client-tool', tool: value.data.tool, status: value.data.status, exitCode: value.data.exitCode, cwd: value.data.cwd, error: value.data.error }));
    }
    if (value.type === 'response') pending.get(value.requestId)?.finish(value);
    if (value.type === 'approval.request') {
      const allowed = value.method === 'device/fileChange/requestApproval'
        && value.data?.threadId === threadId && value.data?.deviceId === deviceId
        && value.data?.workspaceRoot === fixture && String(value.data?.patch).trim() === exactPatch
        && Object.keys(value.data?.expectedVersions ?? {}).join(',') === 'history.txt' && approvals === 0;
      if (allowed) approvals++;
      current.send(JSON.stringify({ type: 'approval.response', requestId: value.requestId, result: { decision: allowed ? 'accept' : 'reject' } }));
      console.log(JSON.stringify({ phase: 'legacy-fixture-patch-approval', accepted: allowed }));
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('History QA gateway connection timeout')), 10000);
    current.once('open', () => { clearTimeout(timer); resolve(); });
    current.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
function request(operation, payload = {}) {
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) { reject(new Error('Gateway disconnected; reconcile before retry')); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${operation} result unknown/timeout; do not replay`)); }, 65000);
    pending.set(requestId, { finish(value) {
      clearTimeout(timer);
      pending.delete(requestId);
      value.ok ? resolve(value.data) : reject(new Error(value.error));
    } });
    socket.send(JSON.stringify({ type: 'request', requestId, operation, payload }));
  });
}
function loseSubmissionResponse(payload) {
  const requestId = randomUUID();
  deliberatelyLost.add(requestId);
  socket.send(JSON.stringify({ type: 'request', requestId, operation: 'conversation.turn.create', payload }));
}
async function reconnect() {
  const previous = socket;
  await new Promise(resolve => { previous.once('close', resolve); previous.close(); });
  await connect();
  await request('session.initialize', { clientInfo: { name: 'harness-history-acceptance', version: '1' } });
}
async function until(predicate, label, timeout = 240000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const listEntries = value => value.data ?? value.threads ?? [];
function completedTurn(turnId) {
  return events.find(event => event.eventType === 'turn.completed' && event.data?.threadId === threadId && event.data?.turn?.id === turnId);
}
function legacyCalls(value, found = []) {
  if (Array.isArray(value)) { for (const entry of value) legacyCalls(entry, found); }
  else if (value && typeof value === 'object') {
    if (value.type === 'dynamicToolCall' && typeof value.tool === 'string') found.push(value);
    for (const nested of Object.values(value)) if (nested && typeof nested === 'object') legacyCalls(nested, found);
  }
  return found;
}

try {
  await connect();
  await until(() => events.some(event => event.agent === 'online'), 'independent history Agent registration', 20000);
  await request('session.initialize', { clientInfo: { name: 'harness-history-acceptance', version: '1' } });
  const identity = await ipc('attachment/identity');
  assert.equal(identity.deviceId, deviceId);
  assert.equal(identity.workspaceRoot, fixture);
  const artifacts = await prepareArtifactFixture({ ipc, fixture, deviceId });
  // The QA hook accepts no overrides and creates a REAL native Thread with only fixed old tools.
  const created = await request('test.history.legacy_create');
  threadId = created.thread.id;
  assert.deepEqual(created.legacyHistoryFixture.tools, ['device_workspace_list', 'device_read_file', 'device_exec']);
  assert.equal(created.legacyHistoryFixture.metadataVersion, 1);
  assert.equal(created.legacyHistoryFixture.remoteWorkspacePresent, false);
  console.log(JSON.stringify({ phase: 'legacy-table-native-fixture-created', fixtureKind: 'QA migration fixture, not production legacy history', threadId, userId, deviceId, fixture, legacyTools: created.legacyHistoryFixture.tools }));

  const seedMarker = `LEGACY_HISTORY_SEED_${runId}`;
  const seed = await request('conversation.turn.create', { threadId, clientMessageId: randomUUID(), input: [{ type: 'text', text: `Reply exactly ${seedMarker}. Do not call any tools or modify any files.` }] });
  const seedTurnId = seed.turn.id;
  activeTurnId = seedTurnId;
  assert.equal((await until(() => completedTurn(seedTurnId), 'native legacy-table seed turn')).data.turn.status, 'completed');
  await reconnect();
  assert.equal((await request('conversation.resume', { threadId })).thread.id, threadId);
  const restoredSeed = await request('conversation.read', { threadId, includeTurns: true });
  assert.equal(restoredSeed.thread.turns.length, 1);
  assert(restoredSeed.thread.turns[0].items.some(item => item.type === 'agentMessage' && item.text?.includes(seedMarker)));
  assert.equal(await readFile(join(fixture, 'counter.log'), 'utf8'), '');

  const commandMarker = `HISTORY_EXECUTED_ONCE_${runId}`;
  const command = `require('fs').appendFileSync('counter.log','once\\n');console.log('${commandMarker}')`;
  const workspaceArgs = operation => JSON.stringify([operation, '{}']);
  const prompt = `Continue this restored legacy-tool-table QA Thread. The only execution tool available is device_exec. Use its RESERVED broker program codexia.workspace, never try to launch that name as a real process. Perform context (args=${workspaceArgs('context')}), search (args=${JSON.stringify(['search', JSON.stringify({ mode: 'text', query: 'legacy', path: '.' })])}), read_text (args=${JSON.stringify(['read_text', JSON.stringify({ path: 'history.txt' })])}), then apply_patch (args=${JSON.stringify(['apply_patch', JSON.stringify({ patch: exactPatch })])}). The user has authorized the isolated fixture and will approve this exact patch once. ${artifacts.prompt} Finally call device_exec ONCE with program=${JSON.stringify(process.execPath)}, args=${JSON.stringify(['-e', command])}, cwd="." (workspace-relative, never an absolute cwd); it appends a single counter marker and prints proof. Do not repeat successful calls, use alternate file-writing tools, or write outside this fixture. Finish with HISTORY_COMPAT_COMPLETE and recall the previous seed marker ${seedMarker}.`;
  const clientMessageId = randomUUID();
  const payload = { threadId, clientMessageId, attachments: [artifacts.attachment], input: [{ type: 'text', text: prompt }] };
  const eventStart = events.length;
  loseSubmissionResponse(payload);
  const completed = await until(() => events.slice(eventStart).find(event => event.eventType === 'turn.completed' && event.data?.threadId === threadId), 'legacy compatibility turn after deliberately lost submit response');
  activeTurnId = completed.data.turn.id;
  assert.equal(completed.data.turn.status, 'completed');
  const finalText = completed.data.turn.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
  assert(finalText.includes('HISTORY_COMPAT_COMPLETE') && finalText.includes(seedMarker), 'restored continuation must produce its final response');
  assert.equal(discardedResponses, 1);
  assert.equal(approvals, 1);
  assert.equal(await readFile(join(fixture, 'history.txt'), 'utf8'), 'resumed\r\n');
  assert.equal(await readFile(join(fixture, 'counter.log'), 'utf8'), 'once\n');
  const toolEvents = events.slice(eventStart).filter(event => event.name === 'device/tool/completed' && event.data?.turnId === activeTurnId);
  for (const tool of ['device_workspace_context', 'device_workspace_search', 'device_workspace_read_text', 'device_workspace_apply_patch', 'device_write_file']) {
    assert(toolEvents.some(event => event.data.tool === tool && event.data.status === 'succeeded'), `Legacy compatibility handler did not succeed: ${tool}`);
  }
  assert(toolEvents.some(event => event.data.tool === 'device_exec' && event.data.exitCode === 0));
  const nativeCalls = legacyCalls(events.slice(eventStart));
  assert(nativeCalls.length > 0, 'native events must prove calls used the legacy tool table');
  assert(nativeCalls.every(call => ['device_workspace_list', 'device_read_file', 'device_exec'].includes(call.tool)), 'a new dynamic tool escaped the legacy-table fixture');
  assert(nativeCalls.some(call => call.tool === 'device_exec' && JSON.stringify(call.arguments).includes('codexia.workspace')));
  assert(nativeCalls.some(call => call.tool === 'device_exec' && JSON.stringify(call.arguments).includes('codexia.files')));

  await reconnect();
  const status = await request('conversation.message.status', { threadId, clientMessageId });
  assert.equal(status.status, 'sent');
  assert.equal(status.turnId, activeTurnId);
  // Reissue only AFTER public status confirms acceptance; the gateway must return the same turn.
  const duplicate = await request('conversation.turn.create', payload);
  assert.equal(duplicate.turn.id, activeTurnId);
  assert.equal(await readFile(join(fixture, 'counter.log'), 'utf8'), 'once\n');
  const beforeArchive = await request('conversation.read', { threadId, includeTurns: true });
  assert.deepEqual(beforeArchive.thread.turns.map(turn => turn.id), [seedTurnId, activeTurnId]);
  assert.equal(beforeArchive.attachmentSubmissions.filter(entry => entry.clientMessageId === clientMessageId).length, 1);
  const snapshot = await verifyArtifactHistory({ ...artifacts, request, ipc, threadId, phase: 'before-archive' });
  await request('conversation.archive', { threadId });
  archived = true;
  assert(listEntries(await request('conversation.list', { archived: true })).some(thread => thread.id === threadId));
  assert(!listEntries(await request('conversation.list')).some(thread => thread.id === threadId));
  await reconnect();
  await request('conversation.unarchive', { threadId });
  archived = false;
  assert.equal((await request('conversation.resume', { threadId })).thread.id, threadId);
  const afterArchive = await request('conversation.read', { threadId, includeTurns: true });
  assert.deepEqual(afterArchive.thread.turns.map(turn => turn.id), [seedTurnId, activeTurnId]);
  assert.equal(await readFile(join(fixture, 'counter.log'), 'utf8'), 'once\n');
  await verifyArtifactHistory({ ...artifacts, request, ipc, threadId, previousSnapshot: snapshot, verifySaving: false, phase: 'restored' });
  const result = { ok: true, source: 'real-central-harness-windows-agent', fixtureKind: 'legacy-tool-table-and-v1-metadata-QA-migration-fixture', threadId, turns: [seedTurnId, activeTurnId], userId, deviceId, fixture, agentBinary, agentSha256,
    checks: ['fixed-legacy-native-tools', 'v1-summary-additive-binding-migration', 'native-history-reconnect-resume', 'codexia-workspace-compatibility', 'codexia-files-output', 'exact-patch-approval', 'lost-submission-reconciled-before-reissue', 'same-submission-no-duplicate-turn-or-counter', 'archive-list-unarchive-resume', 'artifact-history-equivalence'] };
  await writeFile(join(fixture, 'history-result.json'), `${JSON.stringify({ ...result, artifacts: snapshot }, null, 2)}\n`);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ phase: 'history-acceptance-failed', threadId, activeTurnId, userId, deviceId, fixture, diagnostics,
    recent: events.slice(-5).map(event => ({ type: event.type, name: event.name ?? event.eventType, data: event.data })) }));
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN && threadId) {
    if (activeTurnId && !completedTurn(activeTurnId)) { try { await request('conversation.turn.cancel', { threadId, turnId: activeTurnId }); } catch {} }
    if (!archived) { try { await request('conversation.archive', { threadId }); } catch {} }
  }
  socket?.close();
  agent.kill();
  // Keep all tiny QA files and central QA history for evidence; never alter production data.
}
