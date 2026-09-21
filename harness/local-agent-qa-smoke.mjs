// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real local Agent, isolated QA workspace; no model, production gateway or Cargo.
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {hostname} from 'node:os';
import {createLocalAgentQa} from './local-agent-qa-adapter.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert(['--agent', '--output'].includes(key) && value && !args.has(key), 'Invalid QA arguments'); args.set(key, value);
}
for (const key of ['--agent', '--output']) assert(args.has(key) && isAbsolute(args.get(key)), 'Absolute QA arguments required');
const output = resolve(args.get('--output'));
assert(!args.get('--output').split(/[\\/]/).some(part => part === '.' || part === '..'));
assert(!/^\\\\/.test(output) && !existsSync(output) && existsSync(dirname(output)), 'New local QA output required');
assert.equal(realpathSync(dirname(output)).toLowerCase(), dirname(output).toLowerCase(), 'Output parent cannot redirect');
mkdirSync(output);
const hash = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, code, ms = 10000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (predicate()) return; await wait(30); }
  throw Error(code);
}
function processExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
const checks = [], results = {scope: 'real-windows-local-agent-loopback-qa', passed: false, realLocalAgentVerified: false,
  realModelVerified: false, realRemoteDeviceVerified: false, productionDeviceBrokerVerified: false, deployable: false, checks};
let agent, phase = 'setup';
const commandPids = new Set();
const watchdog = setTimeout(() => { process.exitCode = 1; void agent?.close(); }, 90000);
const pass = message => { checks.push(message); console.log('PASS ' + message); };
try {
  const binary = realpathSync(args.get('--agent')); results.agentBinarySha256 = hash(readFileSync(binary));
  agent = await createLocalAgentQa({binary, newRoot: join(output, 'agent'), timeoutMs: 20000});
  const marker = 'QA_AGENT_ONLY_' + randomBytes(24).toString('hex');
  writeFileSync(join(agent.workspace, 'input.txt'), marker);
  writeFileSync(join(output, 'outside.txt'), 'QA_OUTSIDE_WORKSPACE');
  writeFileSync(join(agent.workspace, 'proof.ps1'), `param([string]$Marker)
$ErrorActionPreference='Stop'
[Console]::Out.WriteLine('QA_STREAM_BEGIN')
Start-Sleep -Milliseconds 400
[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'agent-created.txt'), $Marker)
[Console]::Out.WriteLine((@{machine=[Environment]::MachineName;pid=$PID;marker=$Marker} | ConvertTo-Json -Compress))
`);
  writeFileSync(join(agent.workspace, 'hold.ps1'), `[Console]::Out.WriteLine(('QA_PID:' + $PID))
[Console]::Out.Flush()
Start-Sleep -Seconds 45
[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'SHOULD_NOT_COMPLETE'), 'unexpected')
`);
  await agent.ready;
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = (file, extra = []) => ({program: powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...extra], cwd: '.', timeoutMs: 15000});
  phase = 'read-context';
  const context = await agent.request('workspace.context', {});
  assert.equal(context.ok, true); assert.equal(context.result.source, 'client'); assert.equal(context.result.os, 'windows');
  assert.equal(context.result.workspaceRoot, agent.binding.workspaceRoot);
  const file = await agent.request('workspace.read_text', {path: 'input.txt'});
  assert.equal(file.ok, true); assert.equal(file.result.content, marker); assert.equal(file.result.version, 'sha256:' + hash(marker));
  pass('Real Agent reports its bound workspace and reads the randomized QA fixture');

  phase = 'command-stream-and-write';
  const events = [];
  const execution = await agent.request('command.exec', command('proof.ps1', ['-Marker', marker]), {taskId: 'qa-proof', onEvent: event => events.push(event)});
  assert.equal(execution.ok, true); assert.equal(execution.result.exitCode, 0);
  assert(events.filter(event => event.stream === 'stdout' && event.chunk).length >= 2, 'Multiple real stdout events required');
  assert(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence));
  const proof = JSON.parse(execution.result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(proof.marker, marker); assert.equal(proof.machine.toLowerCase(), hostname().toLowerCase());
  assert(Number.isSafeInteger(proof.pid) && proof.pid > 0); commandPids.add(proof.pid);
  await until(() => !processExists(proof.pid), 'QA_COMPLETED_COMMAND_STILL_RUNNING');
  const created = await agent.request('workspace.read_text', {path: 'agent-created.txt'});
  assert.equal(created.ok, true); assert.equal(created.result.content, marker);
  results.execution = {machineSha256: hash(proof.machine.toLowerCase()), commandPid: proof.pid, outputSha256: hash(created.result.content), streamedEvents: events.length};
  pass('Agent executes PowerShell, streams output, writes the QA marker and reports the actual machine and process');

  phase = 'boundary-denials';
  const crossing = await agent.request('workspace.read_text', {path: '../../outside.txt'});
  assert.equal(crossing.ok, false); assert.equal(crossing.errorCode, 'WORKSPACE_PATH_DENIED');
  const bindingProbe = await agent.verifyBindingRejection();
  assert.equal(bindingProbe.ok, false); assert.equal(bindingProbe.errorCode, 'WORKSPACE_BINDING_MISMATCH');
  const beforeRejected = agent.safeEvidence().requests;
  const override = await agent.request('workspace.context', {__remoteWorkspace: {deviceId: 'other'}});
  assert.equal(override.errorCode, 'QA_BINDING_OVERRIDE_DENIED'); assert.equal(agent.safeEvidence().requests, beforeRejected);
  pass('Actual Agent rejects workspace traversal and wrong binding; adapter rejects caller binding injection');

  async function held(taskId, options = {}) {
    let output = '', pid;
    const response = agent.request('command.exec', command('hold.ps1'), {taskId, ...options, onEvent: event => {
      output += event.chunk ?? ''; const match = /QA_PID:(\d+)/.exec(output);
      if (match) { pid = Number(match[1]); commandPids.add(pid); }
    }});
    await until(() => Number.isSafeInteger(pid), 'QA_HOLD_COMMAND_NOT_STARTED');
    assert(processExists(pid), 'Hold command must be alive before cancellation');
    return {response, pid};
  }
  phase = 'turn-cancel';
  const heldTurn = await held('qa-cancel'); agent.cancelTurn('qa-cancel');
  const cancelled = await heldTurn.response;
  assert.equal(cancelled.ok, false); assert.equal(cancelled.errorCode, 'COMMAND_CANCELLED');
  await until(() => !processExists(heldTurn.pid), 'QA_CANCELLED_COMMAND_STILL_RUNNING');
  assert(!existsSync(join(agent.workspace, 'SHOULD_NOT_COMPLETE')));
  assert.equal((await agent.request('workspace.read_text', {path: 'input.txt'})).ok, true);
  pass('Turn cancellation reaches job.cancel, terminates the command and allows a new request');

  phase = 'abort-signal';
  const controller = new AbortController(), heldAbort = await held('qa-abort', {signal: controller.signal}); controller.abort();
  const aborted = await heldAbort.response;
  assert.equal(aborted.errorCode, 'COMMAND_CANCELLED');
  await until(() => !processExists(heldAbort.pid), 'QA_ABORTED_COMMAND_STILL_RUNNING');
  pass('AbortSignal sends actual Agent cancellation and releases its command process');

  phase = 'disconnect';
  const heldDisconnect = await held('qa-disconnect'), beforeClose = agent.safeEvidence().requests;
  await agent.close(); const disconnected = await heldDisconnect.response;
  assert.equal(disconnected.ok, false); assert.equal(disconnected.errorCode, 'RESULT_UNKNOWN'); assert.equal(disconnected.retryable, false);
  await until(() => !processExists(heldDisconnect.pid), 'QA_DISCONNECTED_COMMAND_STILL_RUNNING');
  assert(!existsSync(join(agent.workspace, 'SHOULD_NOT_COMPLETE')));
  assert.equal((await agent.request('workspace.context', {})).errorCode, 'AGENT_OFFLINE');
  await wait(2200); assert.equal(agent.safeEvidence().requests, beforeClose); assert.equal(agent.safeEvidence().connections, 1);
  pass('Disconnect produces unknown execution status, kills the command tree and never reconnects or replays');
  phase = 'cleanup';
  const evidence = agent.safeEvidence();
  assert(evidence.agentExited && evidence.listenerClosed && evidence.pendingRequests === 0);
  assert([...commandPids].every(pid => !processExists(pid))); assert.equal(evidence.replayedRequests, 0);
  assert(evidence.cancelAccepted >= 2); assert.equal(evidence.rejectedFrames, 0);
  results.realLocalAgentVerified = true; results.passed = true;
  pass('Agent, command processes, pending requests and ephemeral listener are fully closed');
} catch (error) {
  results.failedPhase = phase; results.errorCategory = error?.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'QA_OPERATION_FAILED';
  results.failureCode = /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message : results.errorCategory;
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { await agent?.close(); } catch { results.passed = false; results.cleanupFailed = true; process.exitCode = 1; }
  if (agent) results.adapter = agent.safeEvidence();
  results.commandProcessesGone = [...commandPids].every(pid => !processExists(pid));
  if (!results.commandProcessesGone) { results.passed = false; process.exitCode = 1; }
  writeFileSync(join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
}
