// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Wall-clock lease expiry, real AppContainer Workers, synthetic upstream only.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {ModelCredentialBroker} from '../services/test-gateway/dist/model-credential-broker.js';
import {bounded, createWindowsRuntimeSession} from './windows-runtime-session.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(['--launcher', '--runtime', '--output'].includes(key) && value && !args.has(key)); args.set(key, value);
}
for (const key of ['--launcher', '--runtime', '--output']) assert(isAbsolute(args.get(key) ?? ''));
const launcher = realpathSync(args.get('--launcher')), runtime = realpathSync(args.get('--runtime')), output = resolve(args.get('--output'));
assert(!args.get('--output').split(/[\\/]/).some(part => part === '.' || part === '..') && !output.startsWith('\\\\'));
assert(!existsSync(output) && existsSync(dirname(output))); assert.equal(realpathSync(dirname(output)).toLowerCase(), dirname(output).toLowerCase());
mkdirSync(output);
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, code, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return; await pause(20); } throw Error(code); }
const checks = [], sessions = [], leases = [], upstreamCounts = {alice: 0, bob: 0};
const secret = 'SYNTHETIC_EXPIRY_' + randomBytes(24).toString('hex');
let broker, held, heldClosedAt, phase = 'setup', activeUser = 'alice', fixtureFailed = false;
const result = {scope: 'real-windows-worker-wall-clock-lease-expiry-synthetic-model', passed: false, automaticExpiryTested: true,
  realModelVerified: false, realDeviceVerified: false, productionWindowsWorkerEnabled: false, deployable: false, checks};
const pass = value => { checks.push(value); console.log('PASS ' + value); };
const upstream = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses'); assert.equal(request.headers.authorization, 'Bearer ' + secret);
    let bytes = 0; for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 8 * 1024 * 1024); }
    upstreamCounts[activeUser]++;
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({type: 'response.created', response: {id: 'synthetic-expiry'}}) + '\n\n');
    if (activeUser === 'alice') { assert(!held); held = response; response.once('close', () => { held = undefined; heldClosedAt = Date.now(); }); }
    else response.end([{type: 'response.output_item.done', item: {type: 'message', id: 'bob-reply', role: 'assistant', content: [{type: 'output_text', text: 'Synthetic Bob is still available.'}]}},
      {type: 'response.completed', response: {id: 'bob-completed', status: 'completed', usage: {input_tokens: 5, output_tokens: 5, total_tokens: 10}}}]
      .map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  } catch { fixtureFailed = true; response.destroy(); }
});
async function startThread(session) { const reply = await session.request('thread/start', {ephemeral: true}); assert.equal(reply.error, undefined); assert(reply.result?.thread?.id); return reply.result.thread.id; }
async function startTurn(session, threadId) { const reply = await session.request('turn/start', {threadId, input: [{type: 'text', text: 'Run the synthetic expiry fixture.'}]}); assert.equal(reply.error, undefined); assert(reply.result?.turn?.id); return reply.result.turn.id; }
try {
  result.launcherSha256 = createHash('sha256').update(readFileSync(launcher)).digest('hex'); result.runtimeSha256 = createHash('sha256').update(readFileSync(runtime)).digest('hex');
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  save('synthetic-credential.json', {apiKey: secret});
  save('bindings.json', {version: 1, users: {alice: {providerId: 'fixture', enabled: true}, bob: {providerId: 'fixture', enabled: true}}, providers: {
    fixture: {id: 'fixture', kind: 'api-key', credentialFile: join(output, 'synthetic-credential.json'), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`}}});
  // Production TTL computation remains untouched: timeout + 60 seconds.
  broker = await ModelCredentialBroker.start({configFile: join(output, 'bindings.json'), allowLoopbackTestProviders: true, timeoutMs: 5000, maxConcurrent: 2, maxConcurrentPerUser: 1});
  const createdAt = Date.now(), aLease = await broker.createPipeLease('alice', 'expiry-alice'); leases.push(aLease);
  const a = createWindowsRuntimeSession({launcher, runtime, root: join(output, 'alice'), lease: aLease}); sessions.push(a);
  await a.initialize(); const aThread = await startThread(a);
  result.leaseDurationMs = aLease.expiresAt - createdAt;
  assert(result.leaseDurationMs >= 64000 && result.leaseDurationMs <= 67000);
  pass('Real isolated Worker initializes with the unchanged wall-clock lease TTL');
  phase = 'wait-until-expiry-window';
  while (Date.now() < aLease.expiresAt - 15000) await pause(Math.min(1000, aLease.expiresAt - 15000 - Date.now()));
  const bLease = await broker.createPipeLease('bob', 'expiry-bob'); leases.push(bLease);
  const b = createWindowsRuntimeSession({launcher, runtime, root: join(output, 'bob'), lease: bLease}); sessions.push(b);
  await b.initialize(); const bThread = await startThread(b), bPid = b.pid;
  while (Date.now() < aLease.expiresAt - 2500) await pause(Math.min(200, aLease.expiresAt - 2500 - Date.now()));
  assert(aLease.expiresAt - Date.now() >= 1000, 'QA_EXPIRY_SETUP_TOO_SLOW');
  phase = 'active-stream-expiry'; await startTurn(a, aThread); await until(() => !!held, 'QA_EXPIRY_UPSTREAM_NOT_STARTED', 1000);
  assert(Date.now() < aLease.expiresAt && aLease.expiresAt - Date.now() < 5000);
  // No release(), revokeUser(), clock override or broker.close() before these observations.
  await bounded(aLease.closed, 6000, 'QA_LEASE_DID_NOT_EXPIRE');
  result.leaseClosedAfterExpiryMs = Date.now() - aLease.expiresAt; assert(result.leaseClosedAfterExpiryMs >= 0);
  await bounded(a.closed, 15000, 'QA_EXPIRED_WORKER_REMAINS');
  result.workerClosedAfterExpiryMs = Date.now() - aLease.expiresAt;
  await until(() => heldClosedAt !== undefined, 'QA_EXPIRED_UPSTREAM_REMAINS');
  result.upstreamClosedAfterExpiryMs = heldClosedAt - aLease.expiresAt;
  assert(result.upstreamClosedAfterExpiryMs >= 0 && result.upstreamClosedAfterExpiryMs < 5000);
  assert(result.workerClosedAfterExpiryMs < 15000); assert.equal(a.safeEvidence().cleanup?.jobCloseVerified, true);
  pass('Actual expiry closes the active upstream and automatically reaps the exact Worker Job and profile');
  phase = 'other-worker-continues'; activeUser = 'bob';
  assert.equal(b.safeEvidence().stopped, false); assert.equal(b.pid, bPid);
  assert.equal((await b.waitTurn(await startTurn(b, bThread))).status, 'completed'); assert.equal(b.pid, bPid);
  assert.equal(upstreamCounts.alice, 1); assert.equal(upstreamCounts.bob, 1);
  pass('Later-issued sibling lease and Worker continue without replaying the expired request');
  phase = 'expired-endpoint-rejected';
  await assert.rejects(() => bounded(new Promise((resolve, reject) => {
    const request = https.request({hostname: '127.0.0.1', port: aLease.forwardPort, servername: aLease.serverName, ca: aLease.certificatePem, agent: false,
      method: 'POST', path: '/v1/responses', headers: {'content-type': 'application/json', authorization: 'Bearer ' + aLease.token}}, response => {response.resume(); resolve(response.statusCode);});
    request.on('error', reject); request.setTimeout(2000, () => request.destroy(Error('QA_ENDPOINT_TIMEOUT'))); request.end('{}');
  }), 3000, 'QA_ENDPOINT_TIMEOUT'), error => error.code === 'ECONNREFUSED');
  assert.equal(fixtureFailed, false); assert.equal(upstreamCounts.alice, 1);
  pass('Expired listener refuses a new connection; no extra upstream request is admitted');
  result.passed = true;
} catch (error) {
  result.failedPhase = phase; result.failureCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message ?? '') ? error.message : 'QA_EXPIRY_FAILED'; process.exitCode = 1;
} finally {
  for (const lease of leases) lease.release();
  const stopped = await Promise.allSettled(sessions.map(session => session.stop()));
  if (stopped.some(value => value.status !== 'fulfilled')) { result.passed = false; result.cleanupFailed = true; process.exitCode = 1; }
  if (broker) await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  result.sessions = sessions.map(session => session.safeEvidence()); result.upstreamCounts = upstreamCounts;
  save('result.json', result); console.log(JSON.stringify({passed: result.passed, checks: checks.length, failedPhase: result.failedPhase}));
}
