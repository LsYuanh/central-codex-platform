// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Opt-in native relay acceptance: complete signed download, then restart the
// isolated public relay while retaining the exact same UI WebSocket process.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.env.YUAN_RELAY_LIVE_QA, '1');
assert.equal(process.platform, 'win32');
const emit = value => console.log(JSON.stringify(value));
let config, input = '', child, deviceId, failure, restarted = false, closed, cleanup;
const frames = [], pending = new Map();
process.stdin.on('data', bytes => {
  input += bytes;
  if (input.length > 100000) { failure = 'QA_INPUT_LIMIT'; return; }
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (!config) config = value;
      else if (value.restarted === true && Object.keys(value).length === 1) restarted = true;
      else failure = 'QA_INPUT_INVALID';
    } catch { failure = 'QA_INPUT_INVALID'; }
  }
});
process.stdin.on('end', () => { failure = 'QA_CONTROLLER_CLOSED'; });
async function until(predicate, milliseconds, code) {
  const end = Date.now() + milliseconds;
  while (!predicate()) {
    if (failure) throw Error(failure);
    if (Date.now() >= end) throw Error(code);
    await delay(30);
  }
}
function write(value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  child.stdin.write(bytes, () => bytes.fill(0));
}
async function rpc(operation, payload = {}) {
  const requestId = randomUUID();
  const state = {}; pending.set(requestId, state);
  write({kind: 'send', message: {type: 'request', requestId, operation, payload}});
  try {
    await until(() => state.response, 60000, 'QA_RESTART_RPC_TIMEOUT');
    assert.equal(state.response.ok, true);
    return state.response.data;
  } finally { pending.delete(requestId); }
}
try {
  await until(() => config, 15000, 'QA_BOOTSTRAP_TIMEOUT');
  assert.equal(config.gateway, process.env.CENTRAL_FORMAL_GATEWAY);
  assert(config.code.startsWith('yzpair1.') && path.isAbsolute(config.helperBinary));
  const tokenRoot = path.join(path.dirname(config.workspace), 'maintenance-token-data');
  mkdirSync(tokenRoot);
  child = spawn(config.helperBinary, ['--formal-4510'],
    {windowsHide: true, cwd: config.workspace, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdin.on('error', () => { failure = 'QA_HELPER_INPUT_FAILED'; });
  child.on('error', () => { failure = 'QA_HELPER_SPAWN_FAILED'; });
  const exit = new Promise(resolve => child.once('close', resolve));
  let buffer = '';
  child.stdout.on('data', bytes => {
    buffer += bytes;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line); frames.push(value);
        if (value.kind === 'paired') { deviceId = value.deviceId; emit({phase: 'paired', deviceId}); }
        if (value.kind === 'message' && value.message.type === 'response') {
          const state = pending.get(value.message.requestId); if (state) state.response = value.message;
        }
        if (value.kind === 'closed') closed = value;
        if (value.kind === 'cleanup') cleanup = value;
        if (value.kind === 'update-download-progress') emit({phase: 'download-started', bytes: value.total});
      } catch { failure = 'QA_HELPER_PROTOCOL_INVALID'; }
    }
  });
  child.stderr.on('data', bytes => {
    const code = bytes.toString().match(/\bQA_[A-Z_]+\b/)?.[0];
    if (code) failure = code;
  });
  write({gateway: config.gateway, caPath: '', code: config.code, tokenRoot,
    namespace: 'com.centralcodex.harnessqa.central-live'}); config.code = '';
  await until(() => frames.some(f => f.kind === 'connected'), 30000, 'QA_PAIR_TIMEOUT');
  await rpc('session.initialize', {clientInfo: {name: 'relay-maintenance-qa', version: '1'}});
  const before = await rpc('model.list', {limit: 100, includeHidden: false});
  assert(before.data.some(m => m.id === config.model));
  write({kind: 'update-download'});
  await until(() => frames.some(f => f.kind === 'update-download'), 660000, 'QA_DOWNLOAD_TIMEOUT');
  const download = frames.find(f => f.kind === 'update-download');
  assert.equal(download.signatureVerified, true);
  emit({phase: 'download-verified', ...download});
  emit({phase: 'restart-relay'});
  await until(() => restarted, 180000, 'QA_RESTART_TIMEOUT');
  const start = Date.now();
  const after = await rpc('model.list', {limit: 100, includeHidden: false});
  assert(after.data.some(m => m.id === config.model));
  write({kind: 'update-probe', requestId: randomUUID()});
  await until(() => frames.some(f => f.kind === 'update-probe'), 30000, 'QA_RESTART_HTTPS_TIMEOUT');
  const lease = frames.find(f => f.kind === 'update-probe');
  assert.equal(lease.status, 200); assert.equal(lease.leaseReleased, true);
  const evidence = {signedDownload: download, sameNativeProcessAndWebSocketAfterRelayRestart: true,
    httpsAfterRelayRestart: true, restartRecoveryMs: Date.now() - start, installerStarted: false};
  emit({phase: 'completed', deviceId, evidence});
  await until(() => closed && cleanup, 20000, 'QA_REVOKE_TIMEOUT');
  assert.equal(closed.code, 4001); assert.equal(closed.reason, 'DEVICE_REVOKED');
  assert.equal(cleanup.localRemoved, true);
  child.stdin.end();
  assert.equal(await Promise.race([exit, delay(5000).then(() => 'timeout')]), 0);
  writeFileSync(config.output, JSON.stringify({passed: true, evidence, revoked: true,
    localTokenRemoved: true, deviceId}, null, 2), {flag: 'wx'});
  emit({phase: 'revoked', deviceId});
} catch (error) {
  emit({phase: 'failed', code: /^QA_[A-Z_]+$/.test(error.message) ? error.message : 'QA_MAINTENANCE_FAILED', deviceId});
  process.exitCode = 1;
} finally {
  child?.stdin.end();
  if (child && child.exitCode === null) { await delay(1000); child.kill(); }
  process.stdin.pause();
}
