// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// QA only: concurrent real AppContainer runtimes, synthetic model authority.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {ModelCredentialBroker} from '../services/test-gateway/dist/model-credential-broker.js';
import {bounded, createWindowsRuntimeSession} from './windows-runtime-session.mjs';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--launcher', '--runtime', '--output'].includes(process.argv[i]) && process.argv[i + 1] && !options.has(process.argv[i]), 'QA_ARGUMENT_INVALID');
  options.set(process.argv[i], process.argv[i + 1]);
}
for (const key of ['--launcher', '--runtime', '--output']) assert(isAbsolute(options.get(key) ?? ''), 'QA_ABSOLUTE_PATH_REQUIRED');
const launcher = realpathSync(options.get('--launcher')), runtime = realpathSync(options.get('--runtime'));
const requested = options.get('--output'), output = resolve(requested);
assert(!requested.split(/[\\/]/).some(part => part === '.' || part === '..') && !requested.startsWith('\\\\'), 'QA_OUTPUT_UNSAFE');
assert(!existsSync(output) && existsSync(dirname(output)), 'QA_OUTPUT_MUST_BE_NEW');
assert.equal(realpathSync(dirname(output)).toLowerCase(), dirname(output).toLowerCase(), 'QA_PARENT_REDIRECTED');
mkdirSync(output);
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const checks = [], sessions = [], leases = [], held = new Map(), counts = {alice: 0, bob: 0};
const secrets = {alice: 'SYNTHETIC_ALICE_' + randomBytes(24).toString('hex'), bob: 'SYNTHETIC_BOB_' + randomBytes(24).toString('hex')};
const modes = {alice: 'hold', bob: 'hold'};
let broker, fixtureError = false, phase = 'setup';
const result = {scope: 'two-real-windows-workers-synthetic-model-lease-lifecycle', passed: false,
  realModelVerified: false, realDeviceVerified: false, deployable: false,
  oldCredentialRejectionScope: 'node-scoped-https-client-against-replacement-endpoint',
  automaticExpiryTested: false, networkPolicyDenialQualified: false, checks};
const pass = value => { checks.push(value); console.log('PASS ' + value); };
async function until(condition, code, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(code);
}
function complete(response, user) {
  const id = 'synthetic-' + user + '-' + counts[user];
  response.end([
    {type: 'response.output_item.done', item: {type: 'message', id, role: 'assistant', content: [{type: 'output_text', text: 'Synthetic reply for ' + user}]}},
    {type: 'response.completed', response: {id, usage: {input_tokens: 5, output_tokens: 5, total_tokens: 10}}}
  ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
}
const upstream = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
    const user = Object.keys(secrets).find(user => request.headers.authorization === 'Bearer ' + secrets[user]);
    assert(user, 'QA_SYNTHETIC_CREDENTIAL_MISMATCH');
    let total = 0; for await (const chunk of request) { total += chunk.length; assert(total < 8 * 1024 * 1024); }
    counts[user]++;
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('data: ' + JSON.stringify({type: 'response.created', response: {id: 'synthetic-' + user}}) + '\n\n');
    if (modes[user] === 'hold') {
      assert(!held.has(user), 'QA_USER_CONCURRENCY_UNEXPECTED'); held.set(user, response);
      response.once('close', () => { if (held.get(user) === response) held.delete(user); });
    } else complete(response, user);
  } catch { fixtureError = true; response.destroy(); }
});
async function lease(user, instance) { const value = await broker.createPipeLease(user, instance); leases.push(value); return value; }
function session(name, value) {
  const context = createWindowsRuntimeSession({launcher, runtime, root: join(output, name), lease: value});
  sessions.push(context); return context;
}
async function thread(context) {
  const reply = await context.request('thread/start', {ephemeral: true}); assert.equal(reply.error, undefined);
  assert.equal(typeof reply.result?.thread?.id, 'string'); return reply.result.thread.id;
}
async function turn(context, threadId) {
  const reply = await context.request('turn/start', {threadId, input: [{type: 'text', text: 'Run the synthetic lease lifecycle fixture.'}]});
  assert.equal(reply.error, undefined); assert.equal(typeof reply.result?.turn?.id, 'string'); return reply.result.turn.id;
}
function tlsRequest(value, overrides = {}) {
  return bounded(new Promise((resolve, reject) => {
    const request = https.request({hostname: '127.0.0.1', port: value.forwardPort, servername: value.serverName,
      ca: value.certificatePem, rejectUnauthorized: true, agent: false, method: 'POST', path: '/v1/responses',
      headers: {'content-type': 'application/json', authorization: 'Bearer ' + value.token}, ...overrides}, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject); request.setTimeout(4000, () => request.destroy(Error('QA_TLS_TIMEOUT'))); request.end('{}');
  }), 5000, 'QA_TLS_TIMEOUT');
}
try {
  result.launcherSha256 = createHash('sha256').update(readFileSync(launcher)).digest('hex');
  result.runtimeSha256 = createHash('sha256').update(readFileSync(runtime)).digest('hex');
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config = {version: 1, users: {}, providers: {}};
  for (const user of ['alice', 'bob']) {
    const credentialFile = join(output, user + '-synthetic-credential.json'); save(user + '-synthetic-credential.json', {apiKey: secrets[user]});
    config.users[user] = {providerId: user, enabled: true};
    config.providers[user] = {id: user, kind: 'api-key', credentialFile, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`};
  }
  save('synthetic-bindings.json', config);
  broker = await ModelCredentialBroker.start({configFile: join(output, 'synthetic-bindings.json'), allowLoopbackTestProviders: true,
    maxConcurrent: 2, maxConcurrentPerUser: 1, timeoutMs: 60000});
  phase = 'parallel-start';
  const aLease = await lease('alice', 'alice-generation-1'), bLease = await lease('bob', 'bob-generation-1');
  const a = session('alice-1', aLease), b = session('bob-1', bLease);
  assert.notEqual(a.pid, b.pid); await Promise.all([a.initialize(), b.initialize()]);
  const [aThread, bThread] = await Promise.all([thread(a), thread(b)]);
  const [, bTurn] = await Promise.all([turn(a, aThread), turn(b, bThread)]);
  await until(() => held.size === 2, 'QA_TWO_ACTIVE_STREAMS_MISSING');
  const bPid = b.pid, beforeB = counts.bob;
  pass('Two real AppContainer Workers hold independent synthetic model streams concurrently');
  phase = 'revoke-alice';
  const revokeStarted = Date.now(); aLease.release();
  await until(() => !held.has('alice'), 'QA_ALICE_UPSTREAM_REMAINS'); result.aliceUpstreamCloseMs = Date.now() - revokeStarted;
  await bounded(a.closed, 15000, 'QA_ALICE_WORKER_REMAINS'); result.aliceWorkerCloseMs = Date.now() - revokeStarted;
  assert(held.has('bob')); assert.equal(b.pid, bPid); assert.equal(b.safeEvidence().stopped, false);
  aLease.release(); await a.stop(); assert.equal(counts.bob, beforeB);
  complete(held.get('bob'), 'bob'); assert.equal((await b.waitTurn(bTurn)).status, 'completed');
  modes.bob = 'reply'; const bAgain = await turn(b, bThread); assert.equal((await b.waitTurn(bAgain)).status, 'completed');
  assert.equal(b.pid, bPid);
  pass('Lease closure stops Alice Job/profile; repeated release leaves Bob PID and requests intact');
  phase = 'replace-alice';
  const replacementLease = await lease('alice', 'alice-generation-2');
  assert.notEqual(replacementLease.token, aLease.token); assert.notEqual(replacementLease.certificatePem, aLease.certificatePem);
  const beforeReplacement = counts.alice;
  await assert.rejects(() => tlsRequest(replacementLease, {ca: aLease.certificatePem}), error =>
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_SIGNATURE_FAILURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  assert.equal(await tlsRequest(replacementLease, {headers: {'content-type': 'application/json', authorization: 'Bearer ' + aLease.token}}), 401);
  assert.equal(counts.alice, beforeReplacement);
  const replacement = session('alice-2', replacementLease); await replacement.initialize();
  const replacementThread = await thread(replacement); modes.alice = 'reply';
  aLease.release(); await a.stop(); // Old generation callback/stop can only touch its original child.
  assert.equal((await replacement.waitTurn(await turn(replacement, replacementThread))).status, 'completed');
  assert.equal(replacement.safeEvidence().stopped, false); assert.equal(b.safeEvidence().stopped, false);
  pass('Replacement Alice rejects old CA/token and survives old-generation lifecycle calls');
  phase = 'broker-close'; modes.alice = 'hold'; modes.bob = 'hold';
  await Promise.all([turn(replacement, replacementThread), turn(b, bThread)]);
  await until(() => held.size === 2, 'QA_FINAL_STREAMS_MISSING');
  await bounded(broker.close(), 5000, 'QA_BROKER_CLOSE_TIMEOUT');
  await Promise.all([bounded(replacement.closed, 15000, 'QA_REPLACEMENT_REMAINS'), bounded(b.closed, 15000, 'QA_BOB_REMAINS')]);
  await until(() => held.size === 0, 'QA_UPSTREAM_REMAINS'); assert.equal(fixtureError, false);
  pass('Broker close propagates to both remaining Worker Jobs, profiles and active upstreams');
  result.sessions = sessions.map(context => context.safeEvidence());
  assert(result.sessions.every(value => value.cleanup?.profileCleaned && value.cleanup?.jobCloseVerified));
  result.residualKnownLaunchers = sessions.filter(context => { try { process.kill(context.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }).length;
  assert.equal(result.residualKnownLaunchers, 0); result.requests = counts; result.passed = true;
  save('result.json', result); console.log('WINDOWS_WORKER_LEASE_QA_OK');
} catch {
  result.failurePhase = phase; result.failureCode = 'QA_LEASE_LIFECYCLE_FAILED';
  result.sessions = sessions.map(context => context.safeEvidence()); save('result.json', result);
  console.error('WINDOWS_WORKER_LEASE_QA_FAILED ' + phase); process.exitCode = 1;
} finally {
  for (const value of leases) value.release();
  const stopped = await Promise.allSettled(sessions.map(context => context.stop()));
  result.finalCleanup = stopped.map((value, index) => ({stopped: value.status === 'fulfilled', evidence: sessions[index].safeEvidence()}));
  if (broker) await broker.close();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  save('result.json', result);
}
