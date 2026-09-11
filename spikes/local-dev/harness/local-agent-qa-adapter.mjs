// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Import-only loopback QA adapter. This is not the production Device Broker.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, realpathSync, statSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {WebSocket, WebSocketServer} from 'ws';
import {AGENTRPC_MAX_MESSAGE_BYTES, createEnvelope, parseEnvelope} from '@central-codex-spike/agentrpc-types';
import {REMOTE_WORKSPACE_POLICY, assertBinding} from '../services/test-gateway/dist/remote-workspace.js';

export const LOCAL_AGENT_QA_METHODS = Object.freeze({
  'workspace.context': 'workspace/context', 'workspace/context': 'workspace/context',
  'workspace.read_text': 'workspace/read_text', 'workspace/read_text': 'workspace/read_text',
  'command.exec': 'exec', exec: 'exec',
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (errorCode, error = errorCode) => ({ok: false, errorCode, error, retryable: false});
const bounded = (promise, ms, code) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(code)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
function newDirectory(path) {
  if (!isAbsolute(path) || path.split(/[\\/]/).some(part => part === '.' || part === '..')
      || /^\\\\/.test(path) || existsSync(path) || !existsSync(dirname(path))
      || realpathSync(dirname(path)).toLowerCase() !== resolve(dirname(path)).toLowerCase()) throw Error('QA_NEW_DIRECTORY_REQUIRED');
  mkdirSync(path);
  if (realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()) throw Error('QA_DIRECTORY_REDIRECTED');
}

export async function createLocalAgentQa({binary, newRoot, deviceId = `harness-${randomUUID()}`, timeoutMs = 20000}) {
  if (process.platform !== 'win32') throw Error('QA_WINDOWS_REQUIRED');
  if (typeof binary !== 'string' || !isAbsolute(binary) || !statSync(binary).isFile()) throw Error('QA_EXISTING_AGENT_BINARY_REQUIRED');
  if (!/^harness-[a-zA-Z0-9-]{1,90}$/.test(deviceId)) throw Error('QA_DEVICE_ID_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw Error('QA_TIMEOUT_INVALID');
  binary = realpathSync(binary); newDirectory(newRoot);
  const workspace = join(newRoot, 'workspace'), identity = join(newRoot, 'identity'), temporary = join(newRoot, 'temp');
  for (const path of [workspace, identity, temporary]) mkdirSync(path);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw Error('QA_SYSTEM_ROOT_REQUIRED');
  const environment = {
    SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: systemRoot.slice(0, 2),
    COMSPEC: join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', LOCALAPPDATA: identity, APPDATA: identity, USERPROFILE: identity,
    HOME: identity, TEMP: temporary, TMP: temporary,
  };
  const evidence = {scope: 'local-agent-loopback-qa-adapter', realLocalAgent: true, productionDeviceBroker: false,
    connections: 0, requests: 0, responses: 0, streamEvents: 0, cancelSent: 0, cancelAccepted: 0,
    rejectedFrames: 0, duplicateResponses: 0, unknownResults: 0, replayedRequests: 0,
    stderrBytes: 0, stdoutBytes: 0, agentExited: false, listenerClosed: false, pendingRequests: 0};
  const server = new WebSocketServer({host: '127.0.0.1', port: 0, maxPayload: AGENTRPC_MAX_MESSAGE_BYTES});
  let socket, binding, closing, child, online = false, started = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Readiness may reject while the caller is still creating fixture files.
  void ready.catch(() => {});
  const pending = new Map();
  const settle = (id, value) => {
    const entry = pending.get(id); if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); entry.unlisten?.(); entry.resolve(value);
  };
  const unknownAll = () => {
    for (const id of pending.keys()) { evidence.unknownResults++; settle(id, failure('RESULT_UNKNOWN')); }
  };
  const cancel = (id, taskId) => {
    if (socket?.readyState !== WebSocket.OPEN || !pending.has(id)) return;
    evidence.cancelSent++;
    socket.send(JSON.stringify(createEnvelope('job.cancel', {reason: 'qa_cancel'}, {requestId: id, ...(taskId ? {taskId} : {})})));
  };
  const handshakeTimer = setTimeout(() => readyReject(Error('QA_AGENT_READY_TIMEOUT')), timeoutMs);
  server.on('connection', candidate => {
    evidence.connections++;
    if (socket || closing) { candidate.close(1008, 'QA_SINGLE_CONNECTION'); return; }
    socket = candidate;
    candidate.on('error', () => {});
    candidate.on('close', () => { online = false; unknownAll(); readyReject(Error('QA_AGENT_DISCONNECTED')); });
    candidate.on('message', data => {
      const parsed = parseEnvelope(data);
      if ('error' in parsed) { evidence.rejectedFrames++; candidate.close(1002, 'QA_PROTOCOL_INVALID'); return; }
      const envelope = parsed.envelope, value = envelope.payload;
      if (envelope.type === 'agent.hello') {
        const agent = value.agent;
        evidence.helloChecks = {
          firstHello: !online, validKey: record(agent) && typeof agent.deviceKey === 'string' && Boolean(agent.deviceKey),
          workspaceMatches: record(agent) && typeof agent.workspaceRoot === 'string' && realpathSync(workspace).replace(/^\\\\\?\\/, '').toLowerCase() === agent.workspaceRoot.replace(/\//g, '\\').toLowerCase(),
          windows: record(agent) && agent.os === 'windows', absolutePathsDisabled: record(agent) && agent.absolutePaths === false,
          missingCapabilities: ['remote-workspace/v1', 'workspace/context', 'workspace/read_text', 'exec', 'exec-stream/v1', 'job.cancel'].filter(capability => !Array.isArray(agent?.capabilities) || !agent.capabilities.includes(capability)),
        };
        if (online || !record(agent) || typeof agent.deviceKey !== 'string' || !agent.deviceKey
            || typeof agent.workspaceRoot !== 'string' || realpathSync(workspace).replace(/^\\\\\?\\/, '').toLowerCase() !== agent.workspaceRoot.replace(/\//g, '\\').toLowerCase()
            || agent.os !== 'windows' || agent.absolutePaths !== false
            || !Array.isArray(agent.capabilities) || !['remote-workspace/v1', 'workspace/context', 'workspace/read_text', 'exec', 'exec-stream/v1', 'job.cancel'].every(capability => agent.capabilities.includes(capability))
            || (value.deviceId !== undefined && value.deviceId !== deviceId)) {
          evidence.rejectedFrames++; candidate.close(1008, 'QA_IDENTITY_MISMATCH'); return;
        }
        binding = Object.freeze({policy: REMOTE_WORKSPACE_POLICY, userId: 'harness-local-agent', deviceId, deviceKey: agent.deviceKey, workspaceRoot: agent.workspaceRoot});
        online = true; clearTimeout(handshakeTimer);
        candidate.send(JSON.stringify(createEnvelope('agent.hello_ack', {accepted: true, server: 'local-agent-qa-adapter',
          capabilities: ['agent.request', 'agent.response', 'agent.event', 'job.cancel'], heartbeatIntervalMs: 10000})));
        readyResolve(); return;
      }
      if (!online) return;
      const entry = pending.get(envelope.requestId);
      if (envelope.type === 'agent.event' && entry) {
        if (value.sequence <= entry.lastSequence) return;
        entry.lastSequence = value.sequence; evidence.streamEvents++;
        try { entry.onEvent?.(value); } catch { cancel(envelope.requestId, entry.taskId); settle(envelope.requestId, failure('QA_EVENT_HANDLER_FAILED')); }
      } else if (envelope.type === 'agent.response') {
        if (!entry) { evidence.duplicateResponses++; return; }
        evidence.responses++; settle(envelope.requestId, value);
      } else if (envelope.type === 'job.cancel_ack' && entry && value.accepted === true) evidence.cancelAccepted++;
    });
  });
  server.on('error', () => { readyReject(Error('QA_LISTENER_FAILED')); unknownAll(); });
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const gateway = `ws://127.0.0.1:${server.address().port}/ws/agent?deviceId=${encodeURIComponent(deviceId)}`;
    child = spawn(binary, ['--workspace-root', workspace, '--gateway-url', gateway],
      {cwd: workspace, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    started = true;
  } catch {
    clearTimeout(handshakeTimer); server.close(); throw Error('QA_AGENT_START_FAILED');
  }
  const exited = new Promise(resolve => {
    child.once('exit', () => { evidence.agentExited = true; online = false; unknownAll(); clearTimeout(handshakeTimer); readyReject(Error('QA_AGENT_EXITED')); resolve(); });
    child.once('error', () => { evidence.agentExited = true; readyReject(Error('QA_AGENT_SPAWN_FAILED')); clearTimeout(handshakeTimer); resolve(); });
  });
  child.stderr.on('data', bytes => { evidence.stderrBytes += bytes.length; });
  child.stdout.on('data', bytes => { evidence.stdoutBytes += bytes.length; });

  async function requestWithBinding(method, params, options = {}, wrongBinding = false) {
    await ready;
    if (closing || !online || socket?.readyState !== WebSocket.OPEN) return failure('AGENT_OFFLINE');
    const actualMethod = Object.hasOwn(LOCAL_AGENT_QA_METHODS, method) ? LOCAL_AGENT_QA_METHODS[method] : undefined;
    if (!actualMethod || !record(params)) return failure('QA_METHOD_OR_PARAMS_DENIED');
    if (['deviceId', 'workspaceId', 'workspaceRoot', '__remoteWorkspace'].some(key => key in params)) return failure('QA_BINDING_OVERRIDE_DENIED');
    if (pending.size >= 16) return failure('QA_REQUEST_LIMIT');
    if (options.signal?.aborted) return failure('COMMAND_CANCELLED');
    if (options.taskId !== undefined && (typeof options.taskId !== 'string' || !options.taskId || options.taskId.length > 160)) return failure('QA_TASK_ID_INVALID');
    const pinned = {...binding}; assertBinding(pinned, binding);
    if (wrongBinding) pinned.deviceKey = 'qa-deliberately-invalid-device-key';
    const id = randomUUID(), envelope = createEnvelope('agent.request', {method: actualMethod,
      params: {...params, __remoteWorkspace: pinned}, operationId: id, idempotencyKey: id},
      {requestId: id, ...(options.taskId ? {taskId: options.taskId} : {})});
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded) > AGENTRPC_MAX_MESSAGE_BYTES) return failure('QA_REQUEST_TOO_LARGE');
    return new Promise(resolve => {
      const entry = {resolve, taskId: options.taskId, onEvent: options.onEvent, lastSequence: 0};
      entry.timer = setTimeout(() => { cancel(id, entry.taskId); evidence.unknownResults++; settle(id, failure('RESULT_UNKNOWN')); }, timeoutMs);
      if (options.signal) { const abort = () => cancel(id, entry.taskId); options.signal.addEventListener('abort', abort, {once: true}); entry.unlisten = () => options.signal.removeEventListener('abort', abort); }
      pending.set(id, entry); evidence.requests++;
      socket.send(encoded, error => { if (error) { evidence.unknownResults++; settle(id, failure('RESULT_UNKNOWN')); } });
    });
  }
  return {
    ready,
    get binding() { return binding ? {...binding} : undefined; },
    get workspace() { return workspace; },
    request: (method, params, options) => requestWithBinding(method, params, options),
    // A single fixed protocol-negative probe, never an arbitrary routing override.
    verifyBindingRejection: () => requestWithBinding('workspace/context', {}, {}, true),
    cancelTurn(taskId) { for (const [id, entry] of pending) if (entry.taskId === taskId) cancel(id, taskId); },
    close() {
      if (closing) return closing;
      closing = (async () => {
        clearTimeout(handshakeTimer); readyReject(Error('QA_ADAPTER_CLOSED')); online = false;
        for (const [id, entry] of pending) cancel(id, entry.taskId);
        unknownAll(); socket?.terminate();
        for (const connection of server.clients) connection.terminate();
        const stoppedListener = new Promise(resolve => server.close(() => { evidence.listenerClosed = true; resolve(); }));
        if (started && !evidence.agentExited) child.kill();
        await bounded(Promise.all([exited, stoppedListener]), 10000, 'QA_AGENT_CLEANUP_TIMEOUT');
      })();
      return closing;
    },
    safeEvidence() { return {...evidence, pendingRequests: pending.size}; },
  };
}
