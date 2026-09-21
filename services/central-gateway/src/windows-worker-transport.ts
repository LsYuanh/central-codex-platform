// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';
import type { ModelPipeLease } from './model-credential-broker.js';

export type WindowsWorkerMessage = Record<string, unknown> & { id?: number | string; method?: string };
export type WindowsWorkerTransportOptions = {
  hostPath: string; hostSha256: string; runtimePath: string; runtimeSha256: string;
  root: string; userKey: string; instanceId: string; model: string; lease: ModelPipeLease;
  startTimeoutMs?: number; stopTimeoutMs?: number; requestTimeoutMs?: number;
  maxFrameBytes?: number; maxPendingRequests?: number; maxPendingWriteBytes?: number;
  /** Optional diagnostics receive only a known fixed native code, never stderr. */
  onDiagnostic?: (code: string) => void;
};
type SpawnHost = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const protocol = 'windows-worker-host/v1';
const diagnosticCodes = new Set(['HOST_ACL_FAILED', 'HOST_ACL_UNSAFE', 'HOST_ARGUMENT_INVALID', 'HOST_BOOTSTRAP_INVALID',
  'HOST_CONFIG_FAILED', 'HOST_CONFIG_MIGRATION_REQUIRED', 'HOST_CREDENTIAL_MIGRATION_REQUIRED', 'HOST_DIRECTORY_FAILED',
  'HOST_FILE_CREATE_FAILED', 'HOST_HASH_FAILED', 'HOST_IDENTITY_INVALID', 'HOST_INTERNAL_ERROR', 'HOST_JOB_FAILED',
  'HOST_LAUNCH_FAILED', 'HOST_MODEL_PIPE_FAILED', 'HOST_PARENT_INVALID', 'HOST_PATH_UNSAFE', 'HOST_PROFILE_FAILED',
  'HOST_RUNTIME_HASH_MISMATCH', 'HOST_RUNTIME_INVALID', 'HOST_SHUTDOWN_INCOMPLETE', 'HOST_TRANSPORT_FAILED', 'HOST_USER_IN_USE']);
function bound(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw Error('WINDOWS_HOST_LIMIT_INVALID');
  return selected;
}
function trustedFile(filename: string, expectedHash: string): string {
  if (!isAbsolute(filename) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw Error('WINDOWS_HOST_ARTIFACT_INVALID');
  const canonical = realpathSync(filename);
  if (normalize(canonical).toLowerCase() !== normalize(resolve(filename)).toLowerCase()) throw Error('WINDOWS_HOST_ARTIFACT_LINK');
  let cursor = parse(canonical).root;
  for (const part of canonical.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw Error('WINDOWS_HOST_ARTIFACT_LINK');
  }
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1024 * 1024 * 1024) throw Error('WINDOWS_HOST_ARTIFACT_INVALID');
  const descriptor = openSync(canonical, 'r');
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) throw Error('WINDOWS_HOST_ARTIFACT_CHANGED');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(65536);
    let count = 0;
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      count += bytes;
      if (count > metadata.size) throw Error('WINDOWS_HOST_ARTIFACT_CHANGED');
      hash.update(buffer.subarray(0, bytes));
    }
    if (count !== metadata.size || hash.digest('hex') !== expectedHash) throw Error('WINDOWS_HOST_HASH_MISMATCH');
  } finally { closeSync(descriptor); }
  return canonical;
}
export function encodeWindowsWorkerBootstrap(lease: ModelPipeLease): Buffer {
  if (!Number.isInteger(lease.forwardPort) || lease.forwardPort < 1 || lease.forwardPort > 65535 || lease.serverName !== 'model-broker.invalid' || !/^[A-Za-z0-9_-]{32,256}$/.test(lease.token) || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) throw Error('WINDOWS_HOST_LEASE_INVALID');
  if (!/^[\x09\x0a\x0d\x20-\x7e]+$/.test(lease.certificatePem) || !lease.certificatePem.includes('-----BEGIN CERTIFICATE-----')) throw Error('WINDOWS_HOST_CA_INVALID');
  const token = Buffer.from(lease.token, 'ascii'), ca = Buffer.from(lease.certificatePem, 'ascii');
  if (!ca.length || ca.length > 16384) throw Error('WINDOWS_HOST_CA_INVALID');
  const output = Buffer.alloc(20 + token.length + ca.length);
  output.write('YZWH0001', 0, 'ascii'); output.writeUInt32LE(lease.forwardPort, 8);
  output.writeUInt32LE(token.length, 12); token.copy(output, 16);
  output.writeUInt32LE(ca.length, 16 + token.length); ca.copy(output, 20 + token.length);
  token.fill(0);
  return output;
}

/** Synchronous construction reserves ownership immediately. Never await ready in
 * a factory that rejects on startup failure: closed may still be unverified.
 * This class does not enable Windows admission or attest App Server initialize.
 */
export class WindowsWorkerTransport {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;
  private child: ChildProcessWithoutNullStreams;
  private options: WindowsWorkerTransportOptions;
  private listeners = new Set<(message: WindowsWorkerMessage) => void>();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = Buffer.alloc(0);
  private workerBuffer = Buffer.alloc(0);
  private readySeen = false;
  private stopping = false;
  private closeSeen = false;
  private closedSettled = false;
  private protocolFailed = false;
  private runtimePid: number | undefined;
  private startTimer: NodeJS.Timeout;
  private stopTimer: NodeJS.Timeout | undefined;
  private requestSequence = 0;
  private frameLimit: number;
  private pendingLimit: number;
  private writeLimit: number;
  private requestTimeout: number;
  private stopTimeout: number;
  private stderrBytes = 0;
  private diagnosticBuffer = '';

  /** Second argument is dependency injection for protocol fixtures only. */
  constructor(options: WindowsWorkerTransportOptions, spawnHost: SpawnHost = spawn as SpawnHost) {
    if (process.platform !== 'win32') throw Error('WINDOWS_HOST_PLATFORM_UNSUPPORTED');
    if (!isAbsolute(options.root) || !/^[a-f0-9]{64}$/.test(options.userKey) || !/^[a-f0-9]{32}$/.test(options.instanceId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(options.model)) throw Error('WINDOWS_HOST_OPTIONS_INVALID');
    const host = trustedFile(options.hostPath, options.hostSha256);
    const runtime = trustedFile(options.runtimePath, options.runtimeSha256);
    const bootstrap = encodeWindowsWorkerBootstrap(options.lease);
    const startTimeout = bound(options.startTimeoutMs, 30000, 25, 300000);
    this.stopTimeout = bound(options.stopTimeoutMs, 20000, 25, 60000);
    this.requestTimeout = bound(options.requestTimeoutMs, 60000, 25, 300000);
    this.frameLimit = bound(options.maxFrameBytes, 8 * 1024 * 1024, 1024, 32 * 1024 * 1024);
    this.pendingLimit = bound(options.maxPendingRequests, 64, 1, 1024);
    this.writeLimit = bound(options.maxPendingWriteBytes, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024);
    this.options = options;
    this.ready = new Promise((done, reject) => { this.resolveReady = done; this.rejectReady = reject; });
    this.closed = new Promise((done, reject) => { this.resolveClosed = done; this.rejectClosed = reject; });
    void this.ready.catch(() => {}); void this.closed.catch(() => {});
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (/^(SystemRoot|WINDIR)$/i.test(key)) env[key] = value;
    // Native host owns creation/ACL validation of root/user directories.
    this.child = spawnHost(host, ['--root', resolve(options.root), '--runtime', runtime, '--sha256', options.runtimeSha256,
      '--user-key', options.userKey, '--instance', options.instanceId, '--model', options.model, '--parent-pid', String(process.pid)],
    { cwd: dirname(host), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.startTimer = setTimeout(() => this.fail('WINDOWS_HOST_START_TIMEOUT'), startTimeout);
    this.child.stdout.on('data', (chunk: Buffer) => this.acceptOutput(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      // Do not expose untrusted stderr or retain it in gateway memory/logs.
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > 65536) this.fail('WINDOWS_HOST_STDERR_LIMIT');
      if (this.stderrBytes <= 65536) {
        this.diagnosticBuffer += chunk.toString('ascii');
        let end: number;
        while ((end = this.diagnosticBuffer.indexOf('\n')) >= 0) {
          const code = this.diagnosticBuffer.slice(0, end).trim();
          this.diagnosticBuffer = this.diagnosticBuffer.slice(end + 1);
          if (diagnosticCodes.has(code) || /^HOST_RUNTIME_EXIT_[0-9A-F]{8}$/.test(code)) { try { options.onDiagnostic?.(code); } catch {} }
        }
      }
    });
    this.child.stdin.on('error', () => this.fail('WINDOWS_HOST_INPUT_FAILED'));
    this.child.on('error', () => this.fail('WINDOWS_HOST_PROCESS_ERROR'));
    this.child.on('close', (code, signal) => this.finish(code, signal));
    this.child.stdin.write(bootstrap, error => {
      bootstrap.fill(0);
      if (error) this.fail('WINDOWS_HOST_BOOTSTRAP_FAILED');
    });
    void options.lease.closed.then(() => this.close(), () => this.fail('WINDOWS_HOST_LEASE_CLEANUP_UNKNOWN'));
  }
  get alive() { return !this.stopping && !this.closedSettled; }
  get pid() { return this.runtimePid; }
  get hostPid() { return this.child.pid; }
  subscribe(listener: (message: WindowsWorkerMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(message: WindowsWorkerMessage) {
    for (const listener of this.listeners) { try { listener(message); } catch { this.fail('WINDOWS_HOST_CONSUMER_FAILED'); } }
  }
  private acceptOutput(chunk: Buffer) {
    if (this.protocolFailed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (line.length > this.frameLimit) { this.fail('WINDOWS_HOST_FRAME_LIMIT', true); return; }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
        const message: unknown = JSON.parse(text);
        if (!record(message) || this.closeSeen) throw Error();
        const params = record(message.params) ? message.params : {};
        if (message.method === 'host/ready') {
          if (this.readySeen || params.protocol !== protocol || params.instanceId !== this.options.instanceId || params.userKey !== this.options.userKey || !Number.isSafeInteger(params.pid) || (params.pid as number) <= 0) throw Error();
          this.readySeen = true; this.runtimePid = params.pid as number;
          clearTimeout(this.startTimer); this.resolveReady();
        } else if (message.method === 'host/closed') {
          if (params.protocol !== protocol || params.instanceId !== this.options.instanceId || params.jobCloseVerified !== true) throw Error();
          this.closeSeen = true;
          if (!this.stopping) this.notifyFailure('WINDOWS_HOST_EXITED');
          this.close();
        } else if (message.method === 'host/data') {
          if (!this.readySeen || params.protocol !== protocol || params.instanceId !== this.options.instanceId || typeof params.base64 !== 'string' || !params.base64.length || params.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.base64)) throw Error();
          const decoded = Buffer.from(params.base64, 'base64');
          if (decoded.toString('base64') !== params.base64) throw Error();
          this.acceptWorkerOutput(decoded);
          if (this.protocolFailed) return;
        } else throw Error();
      } catch { this.fail('WINDOWS_HOST_PROTOCOL_INVALID', true); return; }
    }
    if (this.buffer.length > this.frameLimit) this.fail('WINDOWS_HOST_FRAME_LIMIT', true);
  }
  private acceptWorkerOutput(chunk: Buffer) {
    this.workerBuffer = Buffer.concat([this.workerBuffer, chunk]);
    let end: number;
    while ((end = this.workerBuffer.indexOf(10)) >= 0) {
      const line = this.workerBuffer.subarray(0, end);
      this.workerBuffer = this.workerBuffer.subarray(end + 1);
      if (line.length > this.frameLimit) throw Error('WINDOWS_WORKER_FRAME_LIMIT');
      const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!record(message) || (typeof message.method === 'string' && message.method.startsWith('host/'))) throw Error('WINDOWS_WORKER_RESERVED_METHOD');
      if (typeof message.id === 'string' && this.pending.has(message.id) && !message.method) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if ('error' in message) pending.reject(Error('WINDOWS_WORKER_RPC_FAILED'));
        else pending.resolve(message.result);
      } else if (!this.stopping) this.notify(message as WindowsWorkerMessage);
    }
    if (this.workerBuffer.length > this.frameLimit) throw Error('WINDOWS_WORKER_FRAME_LIMIT');
  }
  write(message: WindowsWorkerMessage) {
    if (!this.alive || !this.readySeen) throw Error('WINDOWS_HOST_NOT_READY');
    const payload = Buffer.from(`${JSON.stringify(message)}\n`);
    if (payload.length > this.frameLimit || this.child.stdin.writableLength + payload.length > this.writeLimit) {
      this.fail('WINDOWS_HOST_WRITE_LIMIT'); throw Error('WINDOWS_HOST_WRITE_LIMIT');
    }
    this.child.stdin.write(payload, error => { if (error) this.fail('WINDOWS_HOST_INPUT_FAILED'); });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    await this.ready;
    if (!this.alive) throw Error('WINDOWS_HOST_NOT_READY');
    if (this.pending.size >= this.pendingLimit) throw Error('WINDOWS_HOST_REQUEST_LIMIT');
    const id = `native-${++this.requestSequence}`;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('WINDOWS_WORKER_RPC_TIMEOUT: result unknown')); }, this.requestTimeout);
      this.pending.set(id, { resolve: done, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  close(_idle?: boolean) {
    if (this.stopping || this.closedSettled) return;
    this.stopping = true; clearTimeout(this.startTimer);
    this.rejectReady(Error('WINDOWS_HOST_STOPPING'));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('WINDOWS_HOST_STOPPED: result unknown')); }
    this.pending.clear();
    try { this.options.lease.release(); } catch { /* Closed evidence is still required. */ }
    this.child.stdin.end();
    this.stopTimer = setTimeout(() => {
      if (this.closedSettled) return;
      this.protocolFailed = true; this.child.kill();
      this.settleClosed(Error('WINDOWS_HOST_CLEANUP_UNKNOWN'));
    }, this.stopTimeout);
  }
  private fail(code: string, invalidProtocol = false) {
    if (invalidProtocol) {
      this.protocolFailed = true;
      this.buffer = Buffer.alloc(0); this.workerBuffer = Buffer.alloc(0);
    }
    this.rejectReady(Error(code));
    if (!this.stopping) this.notifyFailure(code);
    this.close();
  }
  private notifyFailure(code: string) {
    for (const listener of this.listeners) { try { listener({ method: 'gateway/runtimeUnavailable', params: { error: code } }); } catch {} }
  }
  private finish(code: number | null, signal: NodeJS.Signals | null) {
    clearTimeout(this.startTimer); if (this.stopTimer) clearTimeout(this.stopTimer);
    if (!this.stopping) this.notifyFailure('WINDOWS_HOST_EXITED');
    this.close();
    if (this.stopTimer) clearTimeout(this.stopTimer);
    const noProcessSpawned = this.child.pid === undefined;
    const verified = !this.protocolFailed && this.closeSeen && this.buffer.length === 0 && this.workerBuffer.length === 0 && code === 0 && signal === null;
    this.settleClosed(noProcessSpawned || verified ? undefined : Error('WINDOWS_HOST_CLEANUP_UNKNOWN'));
  }
  private settleClosed(error?: Error) {
    if (this.closedSettled) return;
    this.closedSettled = true;
    if (error) this.rejectClosed(error); else this.resolveClosed();
  }
}
