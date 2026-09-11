// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// P0 contract/validation only. No listener, secret loading or process startup.
import { isIP } from "node:net";
import { win32, posix } from "node:path";

export const CENTRAL_PROTOCOL = "central-management/v1" as const;
export const CENTRAL_APP_ID = "com.yuanzhou.central" as const;
export type CentralPlatform = "win32" | "darwin";
export type CentralState = "unconfigured" | "stopped" | "starting" | "running" | "stopping" | "failed";
export type ComponentState = "unconfigured" | "stopped" | "starting" | "idle" | "ready" | "degraded" | "failed";
export type CentralErrorCode =
  | "CONFIG_INVALID" | "CONFIG_VERSION_UNSUPPORTED" | "CONFIG_REVISION_CONFLICT"
  | "CONFIG_STORAGE_UNSAFE" | "CONFIG_STORAGE_FULL" | "DATA_DIRECTORY_IN_USE" | "DATA_MIGRATION_REQUIRED"
  | "RUNTIME_MISSING" | "RUNTIME_HASH_MISMATCH" | "RUNTIME_PLATFORM_MISMATCH"
  | "WORKER_ISOLATION_UNSUPPORTED" | "PORT_IN_USE" | "TLS_INVALID"
  | "ADMIN_AUTH_REQUIRED" | "OPERATION_BUSY" | "OPERATION_TIMEOUT"
  | "MANAGED_PROCESS_IDENTITY_MISMATCH" | "SHUTDOWN_INCOMPLETE"
  | "SERVICE_ALREADY_ACTIVE" | "SERVICE_CLEANUP_UNVERIFIED" | "SERVICE_APP_CLOSING"
  | "OPERATION_NOT_FOUND" | "INTERNAL_ERROR";

// No credential paths, values, arbitrary argv, environment or QA mode flags.
// Secrets and trusted package resolution belong to the native layer.
export type CentralConfig = {
  schemaVersion: 1;
  revision: number;
  dataDirectory: string;
  listen: { host: string; port: number };
  clientUrl: string;
  tls: { certificateId: string };
  runtimePackageId: string;
  limits: { maxWorkers: number; perUserTurns: number; totalTurns: number };
  shutdown: { graceMs: number; forceMs: number };
};
export type ValidationIssue = { field: string; code: CentralErrorCode };
export type ConfigValidation =
  | { ok: true; config: CentralConfig }
  | { ok: false; issues: ValidationIssue[] };
export type PublicFailure = {
  code: CentralErrorCode;
  recoverable: boolean;
  // Correlates with a sanitized native diagnostic, never a raw exception string.
  diagnosticId: string;
};
export type Operation = {
  id: string;
  kind: "start" | "stop" | "apply-config";
  phase: "accepted" | "running" | "succeeded" | "failed" | "unknown";
  startedAt: number;
  deadlineAt: number;
  failure?: PublicFailure;
};
export type CentralSnapshot = {
  protocol: typeof CENTRAL_PROTOCOL;
  instanceId: string;
  sequence: number;
  observedAt: number;
  state: CentralState;
  acceptingTurns: boolean;
  components: { gateway: ComponentState; modelBroker: ComponentState; workers: ComponentState };
  counts: { onlineDevices: number; activeTurns: number; workers: number };
  operation?: Operation;
};
export type ManagementRequests = {
  "central.config.read": Record<string, never>;
  "central.config.validate": { config: CentralConfig };
  "central.config.save": { requestId: string; expectedRevision: number; config: CentralConfig };
  "central.runtime.inspect": Record<string, never>;
  "central.runtime.start": { requestId: string; expectedRevision: number };
  "central.runtime.stop": { requestId: string; expectedInstanceId: string };
  "central.operation.read": { operationId: string };
  "central.status.read": Record<string, never>;
};
export type RuntimeInspection = {
  platform: CentralPlatform;
  configRevision: number;
  inspectedAt: number;
  // A passed preflight does not establish model or device availability.
  checks: Array<{
    component: "package" | "system" | "port" | "tls" | "directory" | "isolation";
    state: "passed" | "failed" | "not-checked";
    failure?: PublicFailure;
  }>;
};
export type ManagementResponses = {
  "central.config.read": { initialized: boolean; config: CentralConfig | null };
  "central.config.validate": ConfigValidation;
  "central.config.save": { config: CentralConfig };
  "central.runtime.inspect": RuntimeInspection;
  "central.runtime.start": { operation: Operation };
  "central.runtime.stop": { operation: Operation };
  "central.operation.read": { operation: Operation };
  "central.status.read": CentralSnapshot;
};
// A failure envelope contains stable codes only, never an exception/message.
export type ManagementResult<K extends keyof ManagementResponses> =
  | { ok: true; value: ManagementResponses[K] }
  | { ok: false; failure: PublicFailure };

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(v);

/** Pure checks are not filesystem, ACL, DNS, certificate or package verification. */
export function validateCentralConfig(input: unknown, platform: CentralPlatform): ConfigValidation {
  const issues: ValidationIssue[] = [];
  const bad = (field: string, code: CentralErrorCode = "CONFIG_INVALID") => { issues.push({ field, code }); };
  const fields = (value: unknown, keys: string[], field: string): value is Record<string, unknown> => {
    if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { bad(field); return false; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length
      || keys.some(key => {
        const descriptor = descriptors[key];
        return !Object.hasOwn(descriptors, key) || !descriptor || !("value" in descriptor) || !descriptor.enumerable;
      })) {
      bad(field); return false;
    }
    return true;
  };
  if (!fields(input, ["schemaVersion", "revision", "dataDirectory", "listen", "clientUrl", "tls", "runtimePackageId", "limits", "shutdown"], "config"))
    return { ok: false, issues };
  if (input.schemaVersion !== 1) bad("schemaVersion", "CONFIG_VERSION_UNSUPPORTED");
  if (!integer(input.revision, 0, Number.MAX_SAFE_INTEGER)) bad("revision");
  const directory = input.dataDirectory;
  const path = platform === "win32" ? win32 : posix;
  if (typeof directory !== "string" || directory.length > 4096 || /[\x00-\x1f]/.test(directory)
    || !path.isAbsolute(directory) || path.normalize(directory) === path.parse(directory).root
    || directory.split(platform === "win32" ? /[\\/]/ : /\//).some(part => part === "." || part === "..")
    || (platform === "win32" && (!/^[a-zA-Z]:[\\/]/.test(directory) || /[<>"|?*]/.test(directory)
      || directory.slice(2).includes(":") || directory.slice(3).split(/[\\/]/).some(part =>
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))))) bad("dataDirectory");
  const listen = input.listen;
  const validListen = fields(listen, ["host", "port"], "listen");
  if (validListen) {
    if (typeof listen.host !== "string" || isIP(listen.host) === 0) bad("listen.host");
    if (!integer(listen.port, 1024, 65535)) bad("listen.port");
  }
  try {
    if (typeof input.clientUrl !== "string" || input.clientUrl.length > 2048 || /[\x00-\x20\x7f\\]/.test(input.clientUrl)) throw Error();
    const url = new URL(input.clientUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "wss:" || url.pathname !== "/ws" || url.search || url.hash || url.username || url.password
      || ["localhost", "0.0.0.0", "::", "::1"].includes(hostname) || hostname.endsWith(".localhost")
      || /^127\./.test(hostname) || hostname.startsWith("::ffff:")) throw Error();
    // V1 has no reverse proxy or remote node management. The advertised port
    // is the local gateway port; native preflight must verify address ownership.
    if (!validListen || Number(url.port || 443) !== listen.port) throw Error();
  } catch { bad("clientUrl"); }
  if (fields(input.tls, ["certificateId"], "tls") && !id(input.tls.certificateId)) bad("tls.certificateId");
  if (!id(input.runtimePackageId)) bad("runtimePackageId");
  if (fields(input.limits, ["maxWorkers", "perUserTurns", "totalTurns"], "limits")) {
    if (!integer(input.limits.maxWorkers, 1, 128)) bad("limits.maxWorkers");
    if (!integer(input.limits.perUserTurns, 1, 32)) bad("limits.perUserTurns");
    if (!integer(input.limits.totalTurns, 1, 128)) bad("limits.totalTurns");
    if (typeof input.limits.perUserTurns === "number" && typeof input.limits.totalTurns === "number"
      && input.limits.perUserTurns > input.limits.totalTurns) bad("limits.perUserTurns");
  }
  if (fields(input.shutdown, ["graceMs", "forceMs"], "shutdown")) {
    if (!integer(input.shutdown.graceMs, 0, 60000)) bad("shutdown.graceMs");
    if (!integer(input.shutdown.forceMs, 1000, 15000)) bad("shutdown.forceMs");
  }
  // All fields are own data properties; clone to detach mutable renderer input.
  return issues.length ? { ok: false, issues } : { ok: true, config: structuredClone(input) as CentralConfig };
}

/** Timeout means unknown outcome; it never authorizes a second start/stop. */
export function operationAt(operation: Operation, now: number): Operation {
  if (["accepted", "running"].includes(operation.phase) && now >= operation.deadlineAt)
    return { ...operation, phase: "unknown", failure: { code: "OPERATION_TIMEOUT", recoverable: true, diagnosticId: operation.id } };
  return operation;
}

/** A restarted instance requires a fresh snapshot, not ordering old events by sequence. */
export function acceptStatusEvent(current: CentralSnapshot, next: CentralSnapshot): CentralSnapshot {
  if (next.protocol !== CENTRAL_PROTOCOL || next.instanceId !== current.instanceId
    || !integer(next.sequence, 0, Number.MAX_SAFE_INTEGER) || next.sequence <= current.sequence) return current;
  return next;
}
