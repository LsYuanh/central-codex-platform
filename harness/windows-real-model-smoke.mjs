// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Opt-in real ChatGPT model -> AppContainer -> actual same-host Local Agent QA.
// Only the central broker reads the explicitly authorized existing login file.
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {hostname} from 'node:os';
import {ModelCredentialBroker} from '../services/central-gateway/dist/model-credential-broker.js';
import {WORKSPACE_TOOLS} from '../services/central-gateway/dist/remote-workspace.js';
import {createLocalAgentQa} from './local-agent-qa-adapter.mjs';
import {bounded, createWindowsRuntimeSession} from './windows-runtime-session.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert(['--launcher', '--runtime', '--agent', '--auth-file', '--model', '--output'].includes(key) && value && !args.has(key), 'Invalid QA arguments');
  args.set(key, value);
}
assert.equal(process.platform, 'win32');
for (const key of ['--launcher', '--runtime', '--agent', '--auth-file', '--output']) assert(isAbsolute(args.get(key) ?? ''), 'Absolute QA paths required');
const model = args.get('--model') ?? 'gpt-6-astra';
assert(/^[A-Za-z0-9._-]{1,128}$/.test(model), 'Invalid QA model name');
const launcher = realpathSync(args.get('--launcher')), runtime = realpathSync(args.get('--runtime'));
const agentBinary = realpathSync(args.get('--agent')), authFile = realpathSync(args.get('--auth-file'));
const output = resolve(args.get('--output'));
assert(!args.get('--output').split(/[\\/]/).some(part => part === '.' || part === '..'));
assert(!/^\\\\/.test(output) && !existsSync(output) && existsSync(dirname(output)), 'New local QA output required');
assert.equal(realpathSync(dirname(output)).toLowerCase(), dirname(output).toLowerCase());
mkdirSync(output);
const hash = value => createHash('sha256').update(value).digest('hex');
async function fileHash(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); }
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const checks = [], toolCalls = [], brokerCounts = {}, failures = new Set();
const result = {scope: 'windows-appcontainer-real-model-same-host-local-agent-qa', passed: false, model,
  realCredentialsUsed: false, realModelVerified: false, realLocalAgentLoopVerified: false,
  realRemoteDeviceVerified: false, productionDeviceBrokerVerified: false,
  productionWindowsWorkerEnabled: false, deployable: false, formal4510Modified: false, checks};
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let broker, lease, agent, session, phase = 'setup', taskId, threadId, proof, commandCalls = 0;
const callIds = new Set(), answerChecks = [];
let resolveTurnReady;
const turnReady = new Promise(resolve => { resolveTurnReady = resolve; });
let expired = false;
const controller = new AbortController();
const watchdog = setTimeout(() => {
  expired = true; controller.abort(); lease?.release();
}, 165000);
try {
  result.launcherSha256 = await fileHash(launcher); result.runtimeSha256 = await fileHash(runtime); result.agentSha256 = await fileHash(agentBinary);
  agent = await createLocalAgentQa({binary: agentBinary, newRoot: join(output, 'agent'), timeoutMs: 20000});
  const inputMarker = 'QA_INPUT_' + randomBytes(24).toString('hex');
  writeFileSync(join(agent.workspace, 'input.txt'), inputMarker);
  writeFileSync(join(agent.workspace, 'proof.ps1'), `$ErrorActionPreference='Stop'
[Console]::Out.WriteLine('QA_STREAM_BEGIN')
Start-Sleep -Milliseconds 300
$proof='QA_EXEC_' + [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'proof.txt'), $proof)
[Console]::Out.WriteLine((@{machine=[Environment]::MachineName;pid=$PID;proof=$proof} | ConvertTo-Json -Compress))
`);
  await agent.ready; pass('Actual Local Agent connects with the expected isolated workspace and device binding');
  save('bindings.json', {version: 1, users: {'real-qa': {providerId: 'existing-login', enabled: true}}, providers: {
    'existing-login': {id: 'existing-login', kind: 'chatgpt', credentialFile: authFile}}});
  broker = await ModelCredentialBroker.start({configFile: join(output, 'bindings.json'),
    forbiddenRoots: [join(output, 'worker'), join(output, 'agent')], maxConcurrent: 1, maxConcurrentPerUser: 1, timeoutMs: 100000,
    audit: event => {
      if (['model.request', 'model.pipe_tls_handshake', 'model.pipe_http_request'].includes(event.action)) {
        const key = event.action + ':' + event.status; brokerCounts[key] = (brokerCounts[key] ?? 0) + 1;
        if (/^MODEL_[A-Z0-9_]{1,100}$/.test(event.errorCode ?? '')) failures.add(event.errorCode);
      }
    }});
  phase = 'credential-status'; result.credentialStatus = broker.status('real-qa');
  assert.equal(result.credentialStatus.status, 'ready', 'Existing authorized login is not ready');
  lease = await broker.createPipeLease('real-qa', 'real-' + randomUUID());
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const commandArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'proof.ps1'];
  const contextTool = structuredClone(WORKSPACE_TOOLS.find(tool => tool.name === 'device_workspace_context'));
  contextTool.inputSchema = {type: 'object', properties: {}, additionalProperties: false};
  const readTool = structuredClone(WORKSPACE_TOOLS.find(tool => tool.name === 'device_workspace_read_text'));
  readTool.inputSchema = {type: 'object', properties: {path: {type: 'string', enum: ['input.txt', 'proof.txt']}}, required: ['path'], additionalProperties: false};
  const execTool = {type: 'function', name: 'device_exec', description: 'Run the single pre-approved QA PowerShell fixture on the bound client. All arguments must match the supplied command exactly.',
    inputSchema: {type: 'object', properties: {program: {type: 'string', enum: [powershell]}, args: {type: 'array', items: {type: 'string'}}, cwd: {type: 'string', enum: ['.']}}, required: ['program', 'args', 'cwd'], additionalProperties: false}};
  session = createWindowsRuntimeSession({launcher, runtime, root: join(output, 'worker'), lease, model,
    onAgentMessage(text, turnId) {
      assert(answerChecks.length < 64);
      answerChecks.push({turnId, input: text.includes(inputMarker), proof: typeof proof === 'string' && text.includes(proof)});
    },
    async onToolCall(params) {
      await bounded(turnReady, 10000, 'QA_TURN_BINDING_TIMEOUT');
      assert(threadId && taskId && params.threadId === threadId && params.turnId === taskId, 'QA_TOOL_TURN_MISMATCH');
      assert(params.namespace == null, 'QA_TOOL_NAMESPACE_DENIED');
      assert(typeof params.callId === 'string' && params.callId.length > 0 && params.callId.length <= 256 && !callIds.has(params.callId), 'QA_TOOL_CALL_ID_INVALID');
      callIds.add(params.callId); assert(callIds.size <= 8, 'QA_TOOL_CALL_LIMIT');
      const supplied = params.arguments;
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || controller.signal.aborted) throw Error('QA_TOOL_PARAMS_DENIED');
      let response, streamEvents = 0, stdoutChunks = 0, streamedStdout = '';
      const options = {taskId, signal: controller.signal, onEvent: event => {
        streamEvents++;
        if (event.stream === 'stdout' && typeof event.chunk === 'string' && event.chunk.length > 0) {
          stdoutChunks++; streamedStdout += event.chunk; assert(streamedStdout.length <= 16384, 'QA_STREAM_LIMIT');
        }
      }};
      if (params.tool === 'device_workspace_context') {
        assert.deepEqual(Object.keys(supplied), []); response = await agent.request('workspace.context', {}, options);
        assert.equal(response.result?.source, 'client'); assert.equal(response.result?.workspaceRoot, agent.binding.workspaceRoot);
      } else if (params.tool === 'device_workspace_read_text') {
        assert.deepEqual(Object.keys(supplied), ['path']); assert(['input.txt', 'proof.txt'].includes(supplied.path));
        if (supplied.path === 'proof.txt') assert(proof, 'Command must precede proof read');
        response = await agent.request('workspace.read_text', supplied, options);
        assert.equal(response.result?.content, supplied.path === 'input.txt' ? inputMarker : proof);
      } else if (params.tool === 'device_exec') {
        assert.equal(commandCalls++, 0, 'QA command may execute only once');
        assert.deepEqual(Object.keys(supplied).sort(), ['args', 'cwd', 'program']);
        assert.equal(supplied.program, powershell); assert.deepEqual(supplied.args, commandArgs); assert.equal(supplied.cwd, '.');
        response = await agent.request('command.exec', {...supplied, timeoutMs: 15000}, options);
        assert.equal(response.result?.exitCode, 0); assert(stdoutChunks >= 2, 'Real nonempty stdout events required');
        const execution = JSON.parse(response.result.stdout.trim().split(/\r?\n/).at(-1));
        assert.match(execution.proof, /^QA_EXEC_[a-f0-9]{32}$/); assert.equal(execution.machine.toLowerCase(), hostname().toLowerCase());
        assert(Number.isSafeInteger(execution.pid) && execution.pid > 0); proof = execution.proof;
        assert(streamedStdout.includes('QA_STREAM_BEGIN') && streamedStdout.includes(proof), 'QA_STREAM_CONTENT_MISSING');
        result.command = {pid: execution.pid, machineSha256: hash(execution.machine.toLowerCase()), proofSha256: hash(proof), streamEvents,
          nonemptyStdoutEvents: stdoutChunks, streamedStdoutSha256: hash(streamedStdout)};
      } else throw Error('QA_TOOL_DENIED');
      assert.equal(response.ok, true);
      toolCalls.push({name: params.tool, ...(supplied.path ? {path: supplied.path} : {}), succeeded: true, streamEvents});
      return {success: true, contentItems: [{type: 'inputText', text: JSON.stringify(response)}]};
    }});
  phase = 'initialize'; await session.initialize();
  for (const [method, params] of [['fs/readFile', {path: authFile}], ['command/exec', {command: ['cmd.exe', '/d', '/c', 'echo denied']}]] ) {
    const reply = await session.request(method, params); assert.equal(reply.error?.message, `REMOTE_WORKSPACE_UNSUPPORTED: ${method}`);
  }
  pass('Real AppContainer App Server initializes; central credential file and command RPCs remain denied');
  phase = 'real-model-turn';
  const started = await session.request('thread/start', {ephemeral: true, dynamicTools: [contextTool, readTool, execTool],
    developerInstructions: 'This is a bounded acceptance test. Use only the provided tools, exactly as requested. Never access another path or run another command. Do not ask for confirmation. Return the two observed markers verbatim.'});
  assert.equal(started.error, undefined); assert(started.result?.thread?.id);
  threadId = started.result.thread.id;
  const turn = await session.request('turn/start', {threadId, effort: 'low', input: [{type: 'text', text:
    `Perform these steps in order: (1) device_workspace_context with {}. (2) read input.txt with device_workspace_read_text. (3) call device_exec exactly with ${JSON.stringify({program: powershell, args: commandArgs, cwd: '.'})}. (4) read proof.txt with device_workspace_read_text. (5) final answer contains the exact input.txt marker and proof.txt marker, and nothing else. These are synthetic QA files. Do not rerun the command.`}]});
  assert.equal(turn.error, undefined); taskId = turn.result?.turn?.id; assert(taskId); resolveTurnReady();
  result.realCredentialsUsed = true;
  const terminal = await session.waitTurn(taskId, {timeoutMs: 130000});
  result.terminalStatus = ['completed', 'failed', 'interrupted'].includes(terminal.status) ? terminal.status : 'unexpected';
  phase = 'turn-terminal';
  assert.equal(terminal.status, 'completed'); assert(!expired); assert.equal(session.safeEvidence().failureCode, null);
  phase = 'final-answer-evidence';
  const finalAnswer = answerChecks.filter(answer => answer.turnId === taskId).at(-1);
  result.finalAnswer = {sameTurn: !!finalAnswer, inputMarkerMatched: finalAnswer?.input === true, commandMarkerMatched: finalAnswer?.proof === true};
  assert.equal(commandCalls, 1); assert(finalAnswer?.input && finalAnswer?.proof, 'Final model answer must reproduce both unpredictable Agent results');
  assert(toolCalls.some(call => call.name === 'device_workspace_context'));
  for (const path of ['input.txt', 'proof.txt']) assert(toolCalls.some(call => call.path === path));
  phase = 'broker-audit';
  assert((brokerCounts['model.request:succeeded'] ?? 0) >= 2); assert.equal(failures.size, 0);
  result.realModelVerified = true; result.realLocalAgentLoopVerified = true;
  result.markers = {inputSha256: hash(inputMarker), commandSha256: hash(proof), bothReproducedByModel: true};
  pass('Real model uses actual client context, reads a random fixture, executes the exact PowerShell test, reads its output and returns both markers');
  phase = 'lease-revoke-cleanup'; lease.release(); await session.closed;
  await agent.close(); await broker.close();
  assert(agent.safeEvidence().agentExited && agent.safeEvidence().listenerClosed);
  pass('Revoking the model lease terminates its Worker; Agent and temporary listeners are closed');
  result.passed = true;
} catch (error) {
  result.failedPhase = phase;
  result.failureCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message ?? '') ? error.message : error?.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'QA_OPERATION_FAILED';
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog); controller.abort(); resolveTurnReady(); lease?.release();
  for (const cleanup of [() => session?.stop(), () => agent?.close(), () => broker?.close()]) {
    try { await cleanup(); } catch { result.cleanupFailed = true; result.passed = false; process.exitCode = 1; }
  }
  result.realCredentialsUsed ||= (brokerCounts['model.request:succeeded'] ?? 0) > 0;
  result.broker = {counts: brokerCounts, failureCodes: [...failures]}; result.toolCalls = toolCalls;
  if (session) result.worker = session.safeEvidence(); if (agent) result.agent = agent.safeEvidence();
  save('result.json', result); console.log(JSON.stringify({passed: result.passed, checks: checks.length, failedPhase: result.failedPhase, failureCode: result.failureCode}));
}
