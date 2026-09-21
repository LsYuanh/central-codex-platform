// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Synthetic HTTPS broker fixtures only: no native pipe, AppContainer, account or model.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {randomBytes, X509Certificate} from 'node:crypto';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelCredentialBroker} from '../../services/central-gateway/dist/model-credential-broker.js';
import {protectSyntheticFixture} from './windows-private-fixture.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'model-pipe-lease-')));
protectSyntheticFixture(root);
const checks = [], audit = [], received = [], pending = new Set(), sockets = new Set(), leases = [];
const secrets = {alice: 'SYNTHETIC_A_' + randomBytes(24).toString('hex'), bob: 'SYNTHETIC_B_' + randomBytes(24).toString('hex')};
const configFile = join(root, 'bindings.json');
const save = (path, value) => { writeFileSync(path, JSON.stringify(value), {mode: 0o600}); protectSyntheticFixture(root, [path]); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function until(condition, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (condition()) return; await pause(20); }
  throw Error(message || 'Fixture deadline exceeded');
}
async function bounded(promise, message = 'Fixture operation timed out') {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 5000); })]); }
  finally { clearTimeout(timer); }
}

const upstream = http.createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    received.push({authorization: request.headers.authorization, path: request.url, body});
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    if (['terminal-hold', 'partial-terminal', 'non-success-terminal', 'nested-terminal-error', 'terminal-late-error'].includes(body.mode)) {
      pending.add(response); response.once('close', () => pending.delete(response));
      if (body.mode === 'partial-terminal') response.write('data: {"type":"response.completed","response":{"status":"completed"}');
      else if (body.mode === 'non-success-terminal') response.write('data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n');
      else if (body.mode === 'nested-terminal-error') response.write('data: {"type":"response.completed","response":{"status":"completed","error":{"code":"synthetic_error"}}}\n\n');
      else response.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      if (body.mode === 'terminal-late-error') setTimeout(() => {
        if (!response.destroyed) response.write('data: {"type":"error","message":"synthetic late failure"}\n\n');
      }, 30);
      return;
    }
    if (body.mode === 'hold') {
      pending.add(response); response.once('close', () => pending.delete(response)); return;
    }
    if (body.mode === 'buffered-end') {
      // The provider finishes while the downstream deliberately does not read.
      const frame = 'data: ' + JSON.stringify({type: 'response.output_text.delta', delta: 'x'.repeat(256 * 1024)}) + '\n\n';
      for (let i = 0; i < 64; i++) response.write(frame);
      response.end('data: {"type":"response.completed"}\n\n');
      return;
    }
    // Split a CRLF delimiter and a UTF-8 character over separate writes.
    response.write('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"');
    const unicode = Buffer.from('中央'); response.write(unicode.subarray(0, 1));
    setTimeout(() => {
      response.write(unicode.subarray(1));
      response.end('"}\r\n\r\ndata: {"type":"response.completed"}\n\n');
    }, 15);
  } catch { response.destroy(); }
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
const config = {version: 1, users: {}, providers: {}};
for (const user of ['alice', 'bob']) {
  const credentialFile = join(root, user + '.json'); save(credentialFile, {apiKey: secrets[user]});
  config.users[user] = {providerId: user, enabled: true};
  config.providers[user] = {id: user, kind: 'api-key', credentialFile, baseUrl};
}
config.users.charlie = {providerId: 'alice', enabled: true};
save(configFile, config);

function options(lease, body, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {hostname: '127.0.0.1', port: lease.forwardPort, servername: lease.serverName,
    ca: lease.certificatePem, rejectUnauthorized: true, agent: false, method: 'POST', path: '/v1/responses',
    headers: {'content-type': 'application/json', 'content-length': String(bytes.length), authorization: 'Bearer ' + lease.token},
    ...overrides};
}
function request(lease, body = {}, overrides = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(options(lease, body, overrides), response => {
      const bytes = []; response.on('data', chunk => bytes.push(chunk));
      response.once('end', () => resolve({status: response.statusCode, text: Buffer.concat(bytes).toString('utf8')}));
      response.once('error', reject); response.once('aborted', () => reject(Error('Fixture response aborted')));
    });
    sockets.add(request); request.once('close', () => sockets.delete(request));
    request.setTimeout(5000, () => request.destroy(Error('Fixture request timeout')));
    request.once('error', reject); request.end(JSON.stringify(body));
  });
}
function stream(lease, mode = 'hold', read = true) {
  return new Promise((resolve, reject) => {
    const request = https.request(options(lease, {mode, stream: true}), response => {
      let firstResolve, terminalResolve, seen = '';
      const first = new Promise(done => { firstResolve = done; });
      const terminal = new Promise(done => { terminalResolve = done; });
      const closed = new Promise(done => {
        response.once('end', () => done('end'));
        response.once('error', () => done('error'));
        response.once('close', () => done('close'));
      });
      if (read) response.on('data', chunk => {
        firstResolve(chunk); seen += chunk.toString('utf8');
        if (seen.includes('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')) terminalResolve();
      });
      else response.pause();
      resolve({request, response, closed, first, terminal, receivedText: () => seen});
    });
    sockets.add(request); request.once('close', () => sockets.delete(request));
    request.setTimeout(5000, () => request.destroy(Error('Fixture stream timeout')));
    request.once('error', reject); request.end(JSON.stringify({mode, stream: true}));
  });
}
let broker;
async function lease(user, instance) { const result = await broker.createPipeLease(user, instance); leases.push(result); return result; }
const isTlsRejection = error => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE'].includes(error.code);
try {
  broker = await ModelCredentialBroker.start({configFile, allowLoopbackTestProviders: true,
    maxConcurrent: 2, maxConcurrentPerUser: 1, timeoutMs: 15000, audit: event => audit.push(event)});
  const alice = await lease('alice', 'alice-instance-1'), bob = await lease('bob', 'bob-instance-1');
  for (const value of [alice, bob]) {
    assert.equal(value.serverName, 'model-broker.invalid');
    assert(Number.isSafeInteger(value.forwardPort) && value.forwardPort > 0 && value.forwardPort <= 65535);
    assert(value.expiresAt > Date.now()); assert(value.closed instanceof Promise);
    const certificate = new X509Certificate(value.certificatePem);
    assert.equal(certificate.ca, true); // Returned public certificate is the lease's dedicated CA.
    assert(Math.abs(Date.parse(certificate.validTo) - value.expiresAt) < 1000);
    assert(!JSON.stringify(value).includes('PRIVATE KEY'));
  }
  assert.notEqual(alice.forwardPort, bob.forwardPort); assert.notEqual(alice.token, bob.token);
  assert.notEqual(new X509Certificate(alice.certificatePem).publicKey.export({type: 'spki', format: 'pem'}),
    new X509Certificate(bob.certificatePem).publicKey.export({type: 'spki', format: 'pem'}));
  pass('Each lease has a distinct port, token and TLS key; public DTO contains no private key');

  const success = await request(alice, {stream: true});
  assert.equal(success.status, 200); assert(success.text.includes('中央')); assert(success.text.includes('response.completed'));
  assert.equal(received.at(-1).authorization, 'Bearer ' + secrets.alice);
  assert.equal((await request(bob)).status, 200); assert.equal(received.at(-1).authorization, 'Bearer ' + secrets.bob);
  pass('Unique trust anchor and server name authenticate each endpoint and preserve split SSE/UTF-8');

  let before = received.length;
  await assert.rejects(() => request(alice, {}, {ca: bob.certificatePem}), isTlsRejection);
  await assert.rejects(() => request(bob, {}, {ca: alice.certificatePem}), isTlsRejection);
  await assert.rejects(() => request(alice, {}, {ca: []}), isTlsRejection);
  await assert.rejects(() => request(alice, {}, {servername: 'incorrect.invalid'}), isTlsRejection);
  assert.equal(received.length, before);
  pass('Wrong lease CA, empty trust store and wrong server name fail before provider dispatch');

  assert.equal((await request(alice, {}, {headers: {'content-type': 'application/json', authorization: 'Bearer ' + bob.token}})).status, 401);
  assert.equal((await request(bob, {}, {headers: {'content-type': 'application/json', authorization: 'Bearer ' + alice.token}})).status, 401);
  const direct = broker.createLease('alice');
  assert.equal((await request(alice, {}, {headers: {'content-type': 'application/json', authorization: 'Bearer ' + direct.token}})).status, 401);
  const bypass = await fetch(broker.url + '/v1/responses', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + alice.token}, body: '{}'});
  assert.equal(bypass.status, 401); assert.equal(received.length, before); direct.release();
  pass('Scoped endpoint rejects foreign/sibling-mode tokens and pipe token cannot bypass via generic HTTP');

  for (const path of ['/v1/responses?userId=bob', '/v1/models', 'http://elsewhere.invalid/v1/responses', '/oauth/token'])
    assert.equal((await request(alice, {}, {path})).status, 404);
  assert.equal((await request(alice, {}, {method: 'GET'})).status, 404);
  assert.equal((await request(alice, {}, {headers: {'content-type': 'application/json'}})).status, 401);
  assert.equal((await request(alice, {}, {headers: {'content-type': 'application/json', authorization: 'Bearer malformed'}})).status, 401);
  assert.equal(received.length, before);
  pass('Alternate routes, absolute URLs, methods and missing/malformed auth are denied');

  const duplicate = await request(alice, {}, {headers: ['Host', alice.serverName, 'Content-Type', 'application/json', 'Content-Length', '2',
    'Authorization', 'Bearer ' + alice.token, 'Authorization', 'Bearer ' + bob.token]});
  assert([400, 401].includes(duplicate.status)); assert.equal(received.length, before);
  pass('Duplicate Authorization is rejected rather than selecting one of competing tokens');

  const activeA = await stream(alice); await bounded(activeA.first); await until(() => pending.size === 1);
  assert.equal((await request(alice)).status, 429); assert.equal((await request(bob)).status, 200);
  const directSibling = broker.createLease('alice');
  try {
    const sharedLimit = await fetch(broker.url + '/v1/responses', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer ' + directSibling.token}, body: '{}'});
    assert.equal(sharedLimit.status, 429); await sharedLimit.text();
  } finally { directSibling.release(); }
  const secondActive = await stream(bob); await bounded(secondActive.first); await until(() => pending.size === 2);
  const thirdUser = await lease('charlie', 'charlie-instance-1');
  before = received.length; assert.equal((await request(thirdUser)).status, 429); assert.equal(received.length, before);
  secondActive.response.destroy(); secondActive.request.destroy(); await bounded(secondActive.closed);
  await until(() => pending.size === 1); assert.equal((await request(thirdUser)).status, 200);
  thirdUser.release(); await bounded(thirdUser.closed);
  pass('Global and per-user limits are shared across scoped endpoints and the generic listener');
  activeA.response.destroy(); activeA.request.destroy(); await bounded(activeA.closed); await until(() => pending.size === 0);
  assert.equal((await request(alice)).status, 200);
  pass('Silent upstream cancels on downstream disconnect and user concurrency immediately recovers');

  const activeB = await stream(bob); await bounded(activeB.first); await until(() => pending.size === 1);
  bob.release(); await bounded(activeB.closed); await bounded(bob.closed); await until(() => pending.size === 0);
  await assert.rejects(() => request(bob)); assert.equal((await request(alice)).status, 200);
  pass('Release cancels an active SSE and closes its listener while another user stays available');

  const sibling = await lease('alice', 'alice-instance-2');
  before = received.length;
  assert.equal((await request(alice, {}, {headers: {'content-type': 'application/json', authorization: 'Bearer ' + sibling.token}})).status, 401);
  assert.equal(received.length, before);
  sibling.release(); sibling.release(); await bounded(sibling.closed);
  assert.equal((await request(alice)).status, 200);
  pass('Same-user sibling token cannot cross endpoints; repeated release leaves the sibling available');

  const rebound = await lease('bob', 'bob-instance-2');
  assert.notEqual(rebound.certificatePem, bob.certificatePem); assert.notEqual(rebound.token, bob.token);
  await assert.rejects(() => request(rebound, {}, {ca: bob.certificatePem}), isTlsRejection);
  assert.equal((await request(rebound, {}, {headers: {'content-type': 'application/json', authorization: 'Bearer ' + bob.token}})).status, 401);
  assert.equal((await request(rebound)).status, 200);
  pass('Replacement Worker rejects the previous TLS identity and previous lease token');

  const disabled = await stream(rebound); await bounded(disabled.first);
  config.users.bob.enabled = false; save(configFile, config); broker.reload();
  await bounded(disabled.closed); await bounded(rebound.closed); await until(() => pending.size === 0);
  await assert.rejects(() => request(rebound)); assert.equal((await request(alice)).status, 200);
  pass('Binding disablement tears down the scoped TLS listener and its active stream');

  const buffered = await stream(alice, 'buffered-end', false);
  await until(() => received.at(-1)?.body.mode === 'buffered-end');
  await pause(100); buffered.response.destroy(); buffered.request.destroy(); await bounded(buffered.closed);
  let recovered = false;
  const recoveryDeadline = Date.now() + 5000;
  while (Date.now() < recoveryDeadline) {
    const result = await request(alice);
    if (result.status === 200) { recovered = true; break; }
    assert.equal(result.status, 429); await pause(20);
  }
  assert(recovered, 'Buffered stream concurrency did not recover');
  pass('Downstream abort while the provider has buffered its final response releases concurrency');

  let auditStart = audit.length;
  const terminalHold = await stream(alice, 'terminal-hold'); await bounded(terminalHold.terminal);
  assert.equal(pending.size, 1, 'Provider must remain open after the complete successful terminal');
  terminalHold.response.destroy(); terminalHold.request.destroy(); await bounded(terminalHold.closed);
  await until(() => pending.size === 0);
  assert.equal((await request(alice)).status, 200, 'Completed consumer close must release the user slot');
  assert(!audit.slice(auditStart).some(event => event.status === 'failed'), 'Delivered terminal followed by consumer close is successful');
  pass('Delivered successful terminal permits consumer close while provider stays open and releases concurrency');

  for (const mode of ['hold', 'partial-terminal', 'non-success-terminal']) {
    auditStart = audit.length;
    const partial = await stream(alice, mode); await bounded(partial.first);
    if (mode === 'non-success-terminal') await until(() => partial.receivedText().includes('"status":"incomplete"'));
    partial.response.destroy(); partial.request.destroy(); await bounded(partial.closed);
    await until(() => pending.size === 0 && audit.slice(auditStart).some(event => event.errorCode === 'MODEL_REQUEST_CANCELLED'));
    assert.equal((await request(alice)).status, 200);
  }
  pass('Absent, incomplete or non-success terminal frames remain cancellations and release concurrency');

  auditStart = audit.length;
  const nestedError = await stream(alice, 'nested-terminal-error'); await bounded(nestedError.closed);
  await until(() => pending.size === 0 && audit.slice(auditStart).some(event => event.errorCode === 'MODEL_PROVIDER_SSE_RESPONSE_ERROR'));
  assert.equal((await request(alice)).status, 200);
  pass('A completed event with nested response.error remains failure and releases concurrency');

  auditStart = audit.length;
  const lateError = await stream(alice, 'terminal-late-error'); await bounded(lateError.terminal); await bounded(lateError.closed);
  await until(() => pending.size === 0 && audit.slice(auditStart).some(event => event.errorCode === 'MODEL_PROVIDER_SSE_ERROR_EVENT'));
  assert.equal((await request(alice)).status, 200);
  pass('An observed provider error after the terminal remains failure and releases concurrency');

  const text = JSON.stringify(audit);
  for (const secret of [...Object.values(secrets), ...leases.map(value => value.token)]) assert(!text.includes(secret));
  assert(!text.includes('PRIVATE KEY')); pass('Audit excludes model credentials, lease tokens and TLS private keys');
  await broker.close(); await Promise.all(leases.map(value => bounded(value.closed)));
  await assert.rejects(() => request(alice));
  pass('Broker shutdown closes all scoped listeners and resolves lease cleanup');
  save(join(root, 'result.json'), {ok: true, fixtureOnly: true, nativePipeVerified: false, checks});
  console.log(JSON.stringify({ok: true, checks: checks.length, fixtureOnly: true, nativePipeVerified: false, root}));
} finally {
  for (const socket of sockets) socket.destroy();
  for (const value of leases) value.release();
  await broker?.close();
  for (const response of pending) response.destroy();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
