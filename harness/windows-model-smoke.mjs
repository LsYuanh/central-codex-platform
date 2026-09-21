// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real isolated Rust dispatcher and native pipe/TLS; synthetic model and device only.
// Persist only check names, counts and cleanup metadata, never model bodies or leases.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash, randomBytes} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {ModelCredentialBroker} from '../services/central-gateway/dist/model-credential-broker.js';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(['--launcher', '--runtime', '--output'].includes(key) && value && !options.has(key), 'Invalid QA arguments');
  options.set(key, value);
}
assert.equal(process.platform, 'win32', 'Windows-only QA');
for (const key of ['--launcher', '--runtime', '--output']) assert(options.has(key) && isAbsolute(options.get(key)), `${key} requires an absolute path`);
const launcher = realpathSync(options.get('--launcher')), runtime = realpathSync(options.get('--runtime'));
const requestedOutput = options.get('--output'), output = resolve(requestedOutput);
assert(!requestedOutput.split(/[\\/]/).some(part => part === '.' || part === '..'), 'Output cannot include dot segments');
assert(existsSync(dirname(output)) && !existsSync(output), 'Output must be new with an existing parent');
assert.equal(realpathSync(dirname(output)).toLowerCase(), dirname(output).toLowerCase(), 'Output parent cannot redirect through a link');
mkdirSync(output); assert.equal(realpathSync(output).toLowerCase(), output.toLowerCase(), 'Output parent cannot redirect through a link');
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const delay = ms => new Promise(done => setTimeout(done, ms));
async function deadline(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(condition, code, milliseconds = 45000) {
  const stop = Date.now() + milliseconds;
  while (Date.now() < stop) { if (condition()) return; await delay(25); }
  throw Error(code);
}
async function sha256(path) {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex');
}

const checks = [], sessions = [], leases = [], pendingUpstream = new Set();
let phase = 'setup', broker, fixtureError = false, scenario = 'tool-boundary', sequence = 0, dynamicCalls = 0;
let requestCount = 0, positiveRequests = 0, wrongCaRequests = 0, sawRefusedBuiltin = false, sawClientResult = false;
let toolsVerified = false, leakedCanary = false;
const brokerTlsFailures = [];
const brokerTransportEvents = [];
function transportCounts(events) {
  const result = {tlsSucceeded: 0, tlsFailed: 0, httpRequests: 0, tlsErrorCategories: {}};
  for (const event of events) {
    if (event.action === 'model.pipe_tls_handshake') {
      if (event.status === 'succeeded') result.tlsSucceeded++;
      else {
        result.tlsFailed++;
        result.tlsErrorCategories[event.errorCode] = (result.tlsErrorCategories[event.errorCode] ?? 0) + 1;
      }
    } else if (event.action === 'model.pipe_http_request') result.httpRequests++;
  }
  return result;
}
const syntheticKey = 'SYNTHETIC_MODEL_ONLY_' + randomBytes(24).toString('hex');
const syntheticCanary = 'SYNTHETIC_CENTRAL_BOUNDARY_' + randomBytes(12).toString('hex');
const generatedResult = 'SYNTHETIC_LOCAL_AGENT_RESULT_' + randomBytes(12).toString('hex');
const syntheticAnswer = 'Synthetic model fixture completed.\n' + 'a'.repeat(128 * 1024) + '\n尾部完整。';
const textEvidence = text => ({utf8Bytes: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text, 'utf8').digest('hex')});
const expectedAnswer = textEvidence(syntheticAnswer);
const safeResult = {scope: 'windows-appcontainer-native-pipe-tls-rust-synthetic-model', passed: false,
  realModelVerified: false, realDeviceVerified: false, deployable: false, checks};
const pass = name => { checks.push(name); console.log('PASS ' + name); };
function respondSse(response, item) {
  const id = `synthetic-response-${requestCount}`;
  const events = [{type: 'response.created', response: {id}}, {type: 'response.output_item.done', item},
    {type: 'response.completed', response: {id, usage: {input_tokens: 20, output_tokens: 10, total_tokens: 30}}}];
  response.writeHead(200, {'content-type': 'text/event-stream'});
  response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
}
const upstream = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer ' + syntheticKey);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 32 * 1024 * 1024); chunks.push(chunk); }
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw);
    requestCount++; if (scenario === 'wrong-ca') wrongCaRequests++; else positiveRequests++;
    leakedCanary ||= raw.includes(syntheticCanary);
    if (scenario === 'hold') {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: ' + JSON.stringify({type: 'response.created', response: {id: 'synthetic-interrupt'}}) + '\n\n');
      pendingUpstream.add(response); response.once('close', () => pendingUpstream.delete(response)); return;
    }
    if (scenario === 'tool-boundary') {
      sequence++;
      if (sequence === 1) {
        assert.deepEqual(body.tools.map(tool => tool.name), ['device_workspace_context']); toolsVerified = true;
        respondSse(response, {type: 'function_call', call_id: 'builtin-escape', name: 'exec_command',
          arguments: JSON.stringify({cmd: 'cmd.exe /d /c echo forbidden>FORBIDDEN-EXECUTED'})}); return;
      }
      if (sequence === 2) {
        sawRefusedBuiltin = /unsupported|REMOTE_WORKSPACE/i.test(JSON.stringify(body.input));
        respondSse(response, {type: 'function_call', call_id: 'client-tool', name: 'device_workspace_context', arguments: '{}'}); return;
      }
      if (sequence === 3) sawClientResult = JSON.stringify(body.input).includes(generatedResult);
    }
    respondSse(response, {type: 'message', id: 'synthetic-answer', role: 'assistant',
      content: [{type: 'output_text', text: syntheticAnswer}]});
  } catch { fixtureError = true; if (!response.headersSent) response.writeHead(500); response.end(); }
});

function session(root, lease, certificatePem) {
  const environment = {};
  for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH'])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, {YUAN_QA_MODEL_PORT: String(lease.forwardPort), YUAN_QA_MODEL_CA_PEM: certificatePem, YUAN_QA_MODEL_LEASE: lease.token});
  const child = spawn(launcher, [root, '--model-runtime-binary', runtime],
    {cwd: output, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const pending = new Map(), terminals = new Map(), agentMessages = new Map();
  const terminalStatuses = [];
  let nextId = 0, fatal, stopping = false, stderrBytes = 0, stdoutBytes = 0, cleanupEvidence;
  const diagnosticCategories = new Set();
  const observeDiagnostics = text => {
    for (const code of text.match(/\b(?:MODEL_PIPE|REMOTE_WORKSPACE)_[A-Z0-9_]{1,80}\b/g) ?? []) diagnosticCategories.add(code);
    if (/\bMODEL_PIPE_TLS_CERTIFICATE_REJECTED\b/.test(text)) diagnosticCategories.add('TLS_CERTIFICATE_REJECTED');
    if (/UnknownIssuer|unknown issuer|unable to get local issuer/i.test(text)) diagnosticCategories.add('TLS_UNTRUSTED_ISSUER');
    if (/invalid peer certificate|certificate verify failed/i.test(text)) diagnosticCategories.add('TLS_CERTIFICATE_REJECTED');
  };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  function fail(code) {
    fatal ??= Error(code);
    for (const entry of pending.values()) entry.reject(fatal);
    pending.clear();
  }
  child.on('error', () => fail('LAUNCHER_SPAWN_FAILED'));
  child.stdin.on('error', () => { if (!stopping) fail('LAUNCHER_STDIN_CLOSED'); });
  child.on('exit', () => { if (!stopping) fail('LAUNCHER_EXITED_DURING_TEST'); });
  child.stderr.on('data', bytes => { stderrBytes += bytes.length; observeDiagnostics(bytes.toString('utf8')); });
  child.stdout.on('data', bytes => { stdoutBytes += bytes.length; if (stdoutBytes > 16 * 1024 * 1024) fail('RUNTIME_STDOUT_LIMIT'); });
  const send = message => { if (fatal) throw fatal; child.stdin.write(JSON.stringify(message) + '\n'); };
  createInterface({input: child.stdout}).on('line', line => {
    try {
      if (line.length > 4 * 1024 * 1024) return fail('RUNTIME_LINE_LIMIT');
      let message;
      try { message = JSON.parse(line); } catch { if (!stopping) fail('RUNTIME_NON_JSON_STDOUT'); return; }
      if (message.error || message.method === 'error' || message.method === 'turn/completed') observeDiagnostics(JSON.stringify(message));
      if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
        assert.equal(typeof message.params.item.text, 'string');
        const messages = agentMessages.get(message.params.turnId) ?? [];
        messages.push(textEvidence(message.params.item.text)); agentMessages.set(message.params.turnId, messages);
      }
      if (message.method === 'item/tool/call') {
        assert.equal(message.params?.tool, 'device_workspace_context'); dynamicCalls++;
        send({id: message.id, result: {success: true, contentItems: [{type: 'inputText',
          text: JSON.stringify({source: 'simulated-local-agent-fixture', value: generatedResult})}]}});
      } else if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); entry.resolve(message);
      } else if (message.method === 'turn/completed') {
        const status = message.params.turn.status;
        terminalStatuses.push(['completed', 'interrupted', 'failed'].includes(status) ? status : 'unexpected');
        terminals.set(message.params.turn.id, message.params.turn);
      }
    } catch { fail('RUNTIME_PROTOCOL_ASSERTION'); }
  });
  const context = {root, child, terminals, exited, agentMessages,
    observations: () => ({terminalStatuses: [...terminalStatuses], diagnosticCategories: [...diagnosticCategories], stderrBytes, stdoutBytes,
      agentMessages: [...agentMessages.values()].flat(),
      ...(cleanupEvidence ? {cleanup: cleanupEvidence} : {})}),
    async rpc(method, params = {}) {
      if (fatal) throw fatal;
      const id = `qa-${++nextId}`;
      let timer;
      return new Promise((resolve, reject) => {
        const clear = () => clearTimeout(timer);
        pending.set(id, {resolve: value => { clear(); resolve(value); }, reject: error => { clear(); reject(error); }});
        timer = setTimeout(() => { pending.delete(id); reject(Error('RUNTIME_RPC_TIMEOUT')); }, 30000);
        try { send({id, method, params}); } catch (error) { pending.delete(id); clear(); reject(error); }
      });
    },
    notify: send,
    async completed(turnId) {
      await until(() => { if (fatal) throw fatal; return terminals.has(turnId); }, 'TURN_TERMINAL_TIMEOUT');
      return terminals.get(turnId);
    },
    async stop() {
      if (stopping) return;
      stopping = true; child.stdin.end();
      let exit;
      try { exit = await deadline(exited, 15000, 'LAUNCHER_SHUTDOWN_TIMEOUT'); }
      catch { child.kill(); await deadline(exited, 5000, 'LAUNCHER_FORCED_EXIT_TIMEOUT'); throw Error('LAUNCHER_SHUTDOWN_TIMEOUT'); }
      assert.equal(exit.code, 0, 'Launcher cleanup failed');
      const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
      cleanupEvidence = {expectedScope: summary.scope === 'model-runtime-transport-verify-separately',
        profileCleaned: summary.profileCleaned === true, jobCloseVerified: summary.jobCloseVerified === true,
        modelPipeConnections: Number.isSafeInteger(summary.modelPipeConnections) ? summary.modelPipeConnections : null,
        modelPipeTailDrains: Number.isSafeInteger(summary.modelPipeTailDrains) ? summary.modelPipeTailDrains : null,
        modelPipeTailDrainCancels: Number.isSafeInteger(summary.modelPipeTailDrainCancels) ? summary.modelPipeTailDrainCancels : null};
      assert.equal(summary.scope, 'model-runtime-transport-verify-separately');
      assert.equal(summary.profileCleaned, true); assert.equal(summary.jobCloseVerified, true);
      assert(Number.isSafeInteger(summary.modelPipeConnections) && summary.modelPipeConnections > 0, 'No native pipe connection evidence');
      return {scope: summary.scope, profileCleaned: true, jobCloseVerified: true,
        modelPipeConnections: summary.modelPipeConnections,
        modelPipeTailDrains: cleanupEvidence.modelPipeTailDrains,
        modelPipeTailDrainCancels: cleanupEvidence.modelPipeTailDrainCancels, ...context.observations()};
    }};
  sessions.push(context); return context;
}
async function initialize(context) {
  const reply = await context.rpc('initialize', {clientInfo: {name: 'yuan_windows_model_pipe_qa', version: '1'}, capabilities: {experimentalApi: true}});
  assert.equal(reply.error, undefined); assert.match(reply.result?.userAgent ?? '', /yuan-zhou-remote-workspace\/1/);
  assert(!/SYNTHETIC_.*FIXTURE/.test(reply.result.userAgent), 'Real patched App Server required');
  context.notify({method: 'initialized', params: {}});
}
async function startThread(context) {
  const result = await context.rpc('thread/start', {ephemeral: true, dynamicTools: [
    {type: 'function', name: 'device_workspace_context', description: 'Synthetic Local Agent fixture context.', inputSchema: {type: 'object', properties: {}, additionalProperties: false}},
    {type: 'function', name: 'device_bad_plugin', description: 'Must be filtered.', inputSchema: {type: 'object', properties: {}}}]});
  assert.equal(result.error, undefined); assert(result.result?.thread?.id); return result.result.thread.id;
}
async function startTurn(context, threadId) {
  const result = await context.rpc('turn/start', {threadId, input: [{type: 'text', text: 'Run the explicitly synthetic boundary fixture.'}]});
  assert.equal(result.error, undefined); assert(result.result?.turn?.id); return result.result.turn.id;
}

try {
  safeResult.launcherSha256 = await sha256(launcher); safeResult.runtimeSha256 = await sha256(runtime);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  save('synthetic-credential.json', {apiKey: syntheticKey});
  save('synthetic-bindings.json', {version: 1, users: {fixture: {providerId: 'fixture', enabled: true}}, providers: {
    fixture: {id: 'fixture', kind: 'api-key', credentialFile: join(output, 'synthetic-credential.json'), baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`}}});
  broker = await ModelCredentialBroker.start({configFile: join(output, 'synthetic-bindings.json'), allowLoopbackTestProviders: true,
    maxConcurrent: 1, maxConcurrentPerUser: 1, timeoutMs: 60000,
    audit: event => {
      if (['model.pipe_tls_handshake', 'model.pipe_http_request'].includes(event.action)
        && ['succeeded', 'failed'].includes(event.status)) {
        const errorCode = ['MODEL_PIPE_TLS_UNTRUSTED_ISSUER', 'MODEL_PIPE_TLS_CERTIFICATE_REJECTED', 'MODEL_PIPE_TLS_HANDSHAKE_FAILED'].includes(event.errorCode)
          ? event.errorCode : event.errorCode === undefined ? 'NONE' : 'UNRECOGNIZED_CATEGORY';
        brokerTransportEvents.push({action: event.action, status: event.status, errorCode});
      }
      if (event.action !== 'model.pipe_tls_handshake' || event.status !== 'failed') return;
      if (event.errorCode === 'MODEL_PIPE_TLS_CERTIFICATE_REJECTED') brokerTlsFailures.push('TLS_CERTIFICATE_REJECTED');
      if (event.errorCode === 'MODEL_PIPE_TLS_UNTRUSTED_ISSUER') brokerTlsFailures.push('TLS_UNTRUSTED_ISSUER');
    }});
  const positiveLease = await broker.createPipeLease('fixture', 'model-runtime-positive'); leases.push(positiveLease);
  phase = 'positive-initialize';
  const positive = session(join(output, 'positive'), positiveLease, positiveLease.certificatePem);
  await initialize(positive); pass('Real patched App Server initializes inside the native AppContainer launcher');
  // The launcher created this new synthetic file with the intended denied ACL.
  // Replacing its contents in place preserves that ACL and makes the canary non-vacuous.
  assert(existsSync(join(output, 'positive', 'central-canary')));
  writeFileSync(join(output, 'positive', 'central-canary'), syntheticCanary);
  phase = 'host-rpc-boundary';
  for (const [method, params] of [['command/exec', {command: ['cmd.exe', '/d', '/c', 'echo forbidden>FORBIDDEN-EXECUTED']}],
    ['fs/readFile', {path: join(output, 'positive', 'central-canary')}], ['skills/list', {}]]) {
    const reply = await positive.rpc(method, params); assert.equal(reply.result, undefined);
    assert.equal(reply.error?.code, -32602); assert.equal(reply.error?.message, `REMOTE_WORKSPACE_UNSUPPORTED: ${method}`);
  }
  const override = await positive.rpc('thread/start', {cwd: output});
  assert.match(override.error?.message ?? '', /REMOTE_WORKSPACE_OVERRIDE_DENIED/);
  pass('Host command/filesystem/skills RPCs and workspace override remain denied');
  phase = 'tool-model-turn';
  const threadId = await startThread(positive), first = await startTurn(positive, threadId);
  assert.equal((await positive.completed(first)).status, 'completed');
  assert.deepEqual(positive.agentMessages.get(first), [expectedAnswer], 'Final agent message must preserve all synthetic UTF-8 response bytes');
  assert.equal(fixtureError, false); assert.equal(sequence, 3); assert.equal(dynamicCalls, 1);
  assert(toolsVerified && sawRefusedBuiltin && sawClientResult); assert.equal(leakedCanary, false);
  assert(!existsSync(join(output, 'positive', 'alice', 'FORBIDDEN-EXECUTED')));
  assert(!existsSync(join(output, 'positive', 'FORBIDDEN-EXECUTED')));
  pass('Native pipe/TLS model requests reject builtin escape, round-trip the synthetic dynamic tool, and complete');
  phase = 'silent-stream-interrupt'; scenario = 'hold';
  const beforeHold = requestCount, heldTurn = await startTurn(positive, threadId);
  await until(() => pendingUpstream.size === 1, 'SILENT_UPSTREAM_NOT_REACHED');
  const interrupted = await positive.rpc('turn/interrupt', {threadId, turnId: heldTurn}); assert.equal(interrupted.error, undefined);
  assert.equal((await positive.completed(heldTurn)).status, 'interrupted');
  await until(() => pendingUpstream.size === 0, 'INTERRUPT_DID_NOT_CLOSE_UPSTREAM', 5000);
  assert.equal(requestCount, beforeHold + 1);
  pass('Turn interruption closes a silent SSE through Rust, native pipe, TLS broker and upstream without replay');
  phase = 'post-interrupt-recovery'; scenario = 'recovery';
  const recovery = await startTurn(positive, threadId); assert.equal((await positive.completed(recovery)).status, 'completed');
  assert.deepEqual(positive.agentMessages.get(recovery), [expectedAnswer], 'Recovery agent message must preserve all synthetic UTF-8 response bytes');
  assert.equal(requestCount, beforeHold + 2); assert.equal(fixtureError, false);
  pass('A new Turn succeeds after interruption with the broker concurrency slot restored');
  phase = 'positive-cleanup'; safeResult.positiveCleanup = await positive.stop();
  assert(safeResult.positiveCleanup.modelPipeTailDrains > 0, 'Positive responses must exercise native EOF tail drain');
  assert(Number.isSafeInteger(safeResult.positiveCleanup.modelPipeTailDrainCancels)
    && safeResult.positiveCleanup.modelPipeTailDrainCancels >= 0, 'Tail drain cancellation evidence missing');
  safeResult.expectedAnswer = expectedAnswer;
  positiveLease.release(); await deadline(positiveLease.closed, 5000, 'POSITIVE_LEASE_CLOSE_TIMEOUT');
  pass('Positive Worker Job, AppContainer profile and scoped TLS lease close cleanly');
  phase = 'wrong-ca'; scenario = 'wrong-ca';
  const tlsFailureBaseline = brokerTlsFailures.length;
  const transportEventBaseline = brokerTransportEvents.length;
  safeResult.positiveTransportCounts = transportCounts(brokerTransportEvents);
  const wrongLease = await broker.createPipeLease('fixture', 'model-runtime-wrong-ca'); leases.push(wrongLease);
  const foreignLease = await broker.createPipeLease('fixture', 'model-runtime-foreign-ca'); leases.push(foreignLease);
  const negative = session(join(output, 'wrong-ca'), wrongLease, foreignLease.certificatePem);
  await initialize(negative); const negativeThread = await startThread(negative), failedTurn = await startTurn(negative, negativeThread);
  assert.equal((await negative.completed(failedTurn)).status, 'failed');
  await delay(500); assert.equal(wrongCaRequests, 0, 'Wrong CA reached the synthetic provider');
  safeResult.wrongCaCleanup = await negative.stop();
  safeResult.wrongCaTransportCounts = transportCounts(brokerTransportEvents.slice(transportEventBaseline));
  safeResult.wrongCaTlsEvidence = [...new Set([...safeResult.wrongCaCleanup.diagnosticCategories, ...brokerTlsFailures.slice(tlsFailureBaseline)])]
    .filter(value => ['TLS_CERTIFICATE_REJECTED', 'TLS_UNTRUSTED_ISSUER'].includes(value));
  assert(safeResult.wrongCaTlsEvidence.length > 0, 'Wrong CA requires explicit TLS certificate rejection evidence');
  pass('Wrong per-lease CA fails the model Turn before provider dispatch and its Worker cleans up');
  phase = 'final-cleanup';
  for (const value of leases) value.release(); await Promise.all(leases.map(value => deadline(value.closed, 5000, 'LEASE_CLOSE_TIMEOUT')));
  await broker.close();
  safeResult.requests = {positive: positiveRequests, wrongCa: wrongCaRequests}; safeResult.dynamicCalls = dynamicCalls;
  safeResult.passed = true; safeResult.syntheticUpstream = true; safeResult.syntheticLocalAgent = true;
} catch (error) {
  safeResult.failedPhase = phase;
  safeResult.errorCategory = error?.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'QA_OPERATION_FAILED';
  safeResult.failureMessage = error?.code === 'ERR_ASSERTION' ? 'Required QA assertion failed; inspect phase and bounded observations.'
    : typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'QA_OPERATION_FAILED';
  process.exitCode = 1;
} finally {
  for (const context of sessions) {
    try { await context.stop(); } catch { safeResult.passed = false; safeResult.cleanupFailure = true; process.exitCode = 1; }
  }
  safeResult.runtimeObservations = sessions.map(context => context.observations());
  safeResult.requests = {positive: positiveRequests, wrongCa: wrongCaRequests}; safeResult.dynamicCalls = dynamicCalls;
  safeResult.brokerTlsCertificateRejections = brokerTlsFailures.length;
  safeResult.brokerTransportCounts = transportCounts(brokerTransportEvents);
  for (const value of leases) value.release();
  if (broker) await broker.close();
  for (const response of pendingUpstream) response.destroy();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  save('result.json', safeResult); console.log(JSON.stringify(safeResult));
}
