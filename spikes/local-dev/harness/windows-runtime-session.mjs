// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// QA only: actual AppContainer launcher; never launches the runtime directly.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, isAbsolute, join} from 'node:path';

export async function bounded(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
const textEvidence = text => ({utf8Bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')});
export function createWindowsRuntimeSession({launcher, runtime, root, lease, model = 'fixture-model', onToolCall, onAgentMessage}) {
  assert.equal(process.platform, 'win32');
  assert([launcher, runtime, root].every(isAbsolute), 'QA_SESSION_ABSOLUTE_PATH_REQUIRED');
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model), 'QA_SESSION_MODEL_INVALID');
  assert(lease?.closed instanceof Promise && typeof lease.token === 'string', 'QA_SESSION_LEASE_REQUIRED');
  const environment = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH'])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, {YUAN_QA_MODEL_PORT: String(lease.forwardPort), YUAN_QA_MODEL_CA_PEM: lease.certificatePem,
    YUAN_QA_MODEL_LEASE: lease.token, YUAN_QA_MODEL_NAME: model});
  const child = spawn(launcher, [root, '--model-runtime-binary', runtime],
    {cwd: dirname(root), env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const pending = new Map(), turns = new Map(), diagnostics = new Set(), messages = [];
  let nextId = 0, failure, stopping = false, stopPromise, cleanup, stdoutBytes = 0, stderrBytes = 0, toolCalls = 0;
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Automatic lifecycle rejection must remain observable without becoming an unhandled rejection.
  void closed.catch(() => {});
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}));
    child.once('error', () => resolve({code: null, signal: 'spawn-error'}));
  });
  function fail(code) {
    failure ??= code;
    for (const entry of pending.values()) entry.reject(Error(code));
    pending.clear();
    // A failed session owns its child's cleanup even when the caller is waiting
    // only on closed. Preserve the failure category; stop records cleanup.
    void stop().catch(() => {});
  }
  function notify(message) {
    if (stopping || failure) throw Error(failure ?? 'QA_SESSION_STOPPING');
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  child.on('error', () => fail('QA_LAUNCHER_SPAWN_FAILED'));
  child.stdin.on('error', () => { if (!stopping) fail('QA_LAUNCHER_STDIN_CLOSED'); });
  child.on('exit', () => { if (!stopping) fail('QA_LAUNCHER_EXITED'); });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
  child.stdout.on('data', bytes => { stdoutBytes += bytes.length; if (stdoutBytes > 32 * 1024 * 1024) fail('QA_STDOUT_LIMIT'); });
  createInterface({input: child.stdout}).on('line', line => {
    if (stopping || failure) return;
    try {
      if (line.length > 4 * 1024 * 1024) return fail('QA_LINE_LIMIT');
      let message;
      try { message = JSON.parse(line); } catch { if (!stopping) fail('QA_NON_JSON_STDOUT'); return; }
      if (message.error || message.method === 'error' || message.method === 'turn/completed') {
        for (const code of JSON.stringify(message).match(/\b(?:MODEL_PIPE|REMOTE_WORKSPACE)_[A-Z0-9_]{1,80}\b/g) ?? []) diagnostics.add(code);
      }
      if (message.method === 'item/tool/call') {
        toolCalls++;
        if (!onToolCall) return fail('QA_TOOL_HANDLER_MISSING');
        Promise.resolve().then(() => {
          // Another line in the same stdout batch may fail before this queued
          // callback runs. Do not start new work after that failure either.
          if (stopping || failure) return;
          return onToolCall(message.params);
        }).then(result => {
          if (!stopping && !failure) notify({id: message.id, result});
        }).catch(() => { if (!stopping) fail('QA_TOOL_HANDLER_FAILED'); });
      } else if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); entry.resolve(message);
      } else if (message.method === 'turn/completed') {
        assert.equal(typeof message.params?.turn?.id, 'string');
        turns.set(message.params.turn.id, message.params.turn);
      }
      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
        assert.equal(typeof message.params.item.text, 'string'); messages.push(textEvidence(message.params.item.text));
        // Caller may compare an in-memory marker. No message body enters safeEvidence or disk here.
        if (onAgentMessage) onAgentMessage(message.params.item.text, message.params.turnId);
      }
    } catch { fail('QA_PROTOCOL_INVALID'); }
  });
  function request(method, params = {}) {
    if (failure || stopping) return Promise.reject(Error(failure ?? 'QA_SESSION_STOPPING'));
    const id = `qa-session-${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('QA_RPC_TIMEOUT'), 30000);
      pending.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
      try { notify({id, method, params}); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function safeEvidence() {
    return {launcherPid: child.pid, stopped: !!cleanup, failureCode: failure ?? null, stdoutBytes, stderrBytes, toolCalls,
      diagnosticCategories: [...diagnostics], terminalStatuses: [...turns.values()].map(turn =>
        ['completed', 'interrupted', 'failed'].includes(turn.status) ? turn.status : 'unexpected'),
      agentMessages: [...messages], ...(cleanup ? {cleanup: {...cleanup}} : {})};
  }
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    for (const entry of pending.values()) entry.reject(Error('QA_SESSION_STOPPING')); pending.clear();
    stopPromise = (async () => {
      child.stdin.end();
      let exit;
      try { exit = await bounded(exited, 15000, 'QA_LAUNCHER_SHUTDOWN_TIMEOUT'); }
      catch { child.kill(); await bounded(exited, 5000, 'QA_LAUNCHER_FORCED_EXIT_TIMEOUT'); throw Error('QA_LAUNCHER_SHUTDOWN_TIMEOUT'); }
      assert.equal(exit.code, 0, 'QA_LAUNCHER_CLEANUP_FAILED');
      const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
      assert.equal(summary.scope, 'model-runtime-transport-verify-separately', 'QA_SCOPE_INVALID');
      assert.equal(summary.profileCleaned, true, 'QA_PROFILE_REMAINS');
      assert.equal(summary.jobCloseVerified, true, 'QA_JOB_EXIT_UNVERIFIED');
      cleanup = {profileCleaned: true, jobCloseVerified: true};
      for (const key of ['modelPipeConnections', 'modelPipeTailDrains', 'modelPipeTailDrainCancels']) {
        assert(Number.isSafeInteger(summary[key]) && summary[key] >= 0, 'QA_COUNTER_INVALID'); cleanup[key] = summary[key];
      }
      return safeEvidence();
    })();
    void stopPromise.then(resolveClosed, () => { failure ??= 'QA_SESSION_CLEANUP_FAILED'; rejectClosed(Error(failure)); });
    return stopPromise;
  }
  // This closure owns exactly this child generation; it never looks up a user-key replacement.
  void lease.closed.then(() => stop(), () => stop()).catch(() => {});
  return {pid: child.pid, closed, request, notify, stop, safeEvidence,
    async initialize() {
      const reply = await request('initialize', {clientInfo: {name: 'yuan_windows_session_qa', version: '1'}, capabilities: {experimentalApi: true}});
      assert.equal(reply.error, undefined, 'QA_INITIALIZE_FAILED');
      assert.match(reply.result?.userAgent ?? '', /yuan-zhou-remote-workspace\/1/, 'QA_RUNTIME_MARKER_MISSING');
      assert(!/SYNTHETIC_.*FIXTURE/.test(reply.result.userAgent), 'QA_REAL_RUNTIME_REQUIRED');
      notify({method: 'initialized', params: {}}); return reply;
    },
    async waitTurn(turnId, {timeoutMs = 45000} = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (turns.has(turnId)) return turns.get(turnId);
        if (failure || stopping) throw Error(failure ?? 'QA_SESSION_STOPPING');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('QA_TURN_TIMEOUT');
    }};
}
