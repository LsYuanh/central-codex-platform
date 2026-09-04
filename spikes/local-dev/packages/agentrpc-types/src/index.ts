// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The protocol is deliberately independent from the Codex App Server protocol.
 * App Server messages are terminated by the central worker; only these messages
 * cross the device boundary.
 */
export const AGENTRPC_PROTOCOL = "agentrpc" as const;
export const AGENTRPC_VERSION = 1 as const;
export const AGENTRPC_MAX_MESSAGE_BYTES = 1024 * 1024;

export const AGENTRPC_MESSAGE_TYPES = [
  "agent.hello",
  "agent.hello_ack",
  "agent.heartbeat",
  "agent.request",
  "agent.response",
  "agent.event",
  "job.offer",
  "job.accept",
  "job.reject",
  "job.cancel",
  "job.cancel_ack",
  "approval.required",
  "approval.result",
  "workspace.changed",
  "certificate.rotate_required",
  "upgrade.required",
] as const;

export type AgentRpcMessageType = (typeof AGENTRPC_MESSAGE_TYPES)[number];

export type AgentRpcMethod =
  | "file/write_text"
  | "file/write_begin"
  | "file/write_chunk"
  | "file/write_commit"
  | "file/write_abort"
  | "file/copy"
  | "file/publish"
  | "file/output_paths"
  | "file/stat"
  | "file/read_text"
  | "file/read_image"
  | "file/read_chunk"
  | "file/close_transfer"
  | "workspace/list"
  | "workspace/stat"
  | "read_file"
  | "exec"
  | "fs/list_dir"
  | "fs/read_file"
  | "process/exec"
  | "process/cancel"
  | "git/status"
  | "git/diff";

export interface AgentRpcEnvelope<TPayload = unknown> {
  protocol: typeof AGENTRPC_PROTOCOL;
  version: typeof AGENTRPC_VERSION;
  type: AgentRpcMessageType;
  timestamp: string;
  nonce: string;
  requestId?: string;
  taskId?: string;
  traceId?: string;
  /** Message-specific, strongly typed by `type`. */
  payload: TPayload;
}

export interface AgentHelloPayload {
  deviceId?: string;
  agent: {
    deviceKey?: string;
    version: string;
    os: string;
    arch: string;
    capabilities: string[];
  };
}

export interface AgentHelloAckPayload {
  accepted: true;
  server: string;
  capabilities: string[];
  heartbeatIntervalMs: number;
}

export interface AgentHeartbeatPayload {
  state: "idle" | "busy" | "degraded";
  activeTaskId?: string;
  load?: number;
}

export interface AgentRequestPayload {
  method: AgentRpcMethod;
  params: Record<string, unknown>;
  /** A stable operation key makes a retry safe to deduplicate. */
  operationId?: string;
  idempotencyKey?: string;
}

export interface AgentResponsePayload {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  /** Agent echoes the request id in the envelope, but this is accepted for legacy bridges. */
  id?: string;
}

export type AgentRpcResponsePayload = AgentResponsePayload;

export interface AgentEventPayload {
  stream: "stdout" | "stderr" | "progress";
  chunk?: string;
  progress?: number;
  done?: boolean;
  /** Monotonic within one request, including the final done event. */
  sequence: number;
  /** The Agent stopped forwarding output after reaching its bounded stream budget. */
  truncated?: boolean;
}

export type AgentRpcRequest = AgentRpcEnvelope<AgentRequestPayload> & { type: "agent.request" };
export type AgentRpcResponse = AgentRpcEnvelope<AgentResponsePayload> & { type: "agent.response" };
export type AgentRpcEvent = AgentRpcEnvelope<AgentEventPayload> & { type: "agent.event"; requestId: string };

export type LegacyAgentRequest = {
  id: string;
  method: AgentRpcMethod;
  params: Record<string, unknown>;
};

export interface ProtocolError {
  code:
    | "invalid_json"
    | "invalid_envelope"
    | "unsupported_version"
    | "message_too_large"
    | "missing_field";
  message: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createEnvelope<TPayload>(
  type: AgentRpcMessageType,
  payload: TPayload,
  fields: Pick<AgentRpcEnvelope, "requestId" | "taskId" | "traceId"> = {},
): AgentRpcEnvelope<TPayload> {
  return {
    protocol: AGENTRPC_PROTOCOL,
    version: AGENTRPC_VERSION,
    type,
    timestamp: nowIso(),
    nonce: crypto.randomUUID(),
    ...fields,
    payload,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageType(value: unknown): value is AgentRpcMessageType {
  return typeof value === "string" && (AGENTRPC_MESSAGE_TYPES as readonly string[]).includes(value);
}

/** Runtime validation used at the transport boundary. It intentionally rejects unknown protocol versions. */
export function validateEnvelope(value: unknown): ProtocolError | undefined {
  if (!isRecord(value)) return { code: "invalid_envelope", message: "message must be an object" };
  if (value.protocol !== AGENTRPC_PROTOCOL) {
    return { code: "invalid_envelope", message: `protocol must be ${AGENTRPC_PROTOCOL}` };
  }
  if (value.version !== AGENTRPC_VERSION) {
    return { code: "unsupported_version", message: `unsupported AgentRPC version: ${String(value.version)}` };
  }
  if (!isMessageType(value.type)) return { code: "invalid_envelope", message: "unknown message type" };
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
    return { code: "invalid_envelope", message: "timestamp must be an ISO date-time" };
  }
  if (typeof value.nonce !== "string" || value.nonce.length < 8) {
    return { code: "missing_field", message: "nonce must be a non-empty value" };
  }
  if (!isRecord(value.payload)) return { code: "invalid_envelope", message: "payload must be an object" };
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || value.requestId.length === 0)) {
    return { code: "invalid_envelope", message: "requestId must be a non-empty string" };
  }
  if ((value.type === "agent.request" || value.type === "agent.response") && typeof value.requestId !== "string") {
    return { code: "missing_field", message: `${value.type} requires requestId` };
  }
  if (value.type === "agent.request") {
    const payload = value.payload;
    if (typeof payload.method !== "string" || !(AGENTRPC_METHODS as readonly string[]).includes(payload.method)) {
      return { code: "invalid_envelope", message: "agent.request payload has an unsupported method" };
    }
    if (!isRecord(payload.params)) return { code: "invalid_envelope", message: "agent.request params must be an object" };
  }
  if (value.type === "agent.response" && typeof value.payload.ok !== "boolean") {
    return { code: "invalid_envelope", message: "agent.response payload requires boolean ok" };
  }
  if (value.type === "agent.event") {
    if (typeof value.requestId !== "string") return { code: "missing_field", message: "agent.event requires requestId" };
    const payload = value.payload;
    if (!(["stdout", "stderr", "progress"] as const).includes(payload.stream as "stdout" | "stderr" | "progress")) {
      return { code: "invalid_envelope", message: "agent.event payload has an invalid stream" };
    }
    if (!Number.isSafeInteger(payload.sequence) || Number(payload.sequence) < 1) {
      return { code: "invalid_envelope", message: "agent.event payload requires a positive integer sequence" };
    }
    if (payload.chunk !== undefined && typeof payload.chunk !== "string") {
      return { code: "invalid_envelope", message: "agent.event chunk must be a string" };
    }
    if (payload.progress !== undefined && (typeof payload.progress !== "number" || payload.progress < 0 || payload.progress > 1)) {
      return { code: "invalid_envelope", message: "agent.event progress must be between 0 and 1" };
    }
    if (payload.done !== undefined && typeof payload.done !== "boolean") {
      return { code: "invalid_envelope", message: "agent.event done must be boolean" };
    }
    if (payload.truncated !== undefined && typeof payload.truncated !== "boolean") {
      return { code: "invalid_envelope", message: "agent.event truncated must be boolean" };
    }
  }
  return undefined;
}

export function parseEnvelope(raw: string | Uint8Array):
  | { envelope: AgentRpcEnvelope<Record<string, unknown>> }
  | { error: ProtocolError } {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
  if (bytes > AGENTRPC_MAX_MESSAGE_BYTES) {
    return { error: { code: "message_too_large", message: `message exceeds ${AGENTRPC_MAX_MESSAGE_BYTES} bytes` } };
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return { error: { code: "invalid_json", message: "message is not valid JSON" } };
  }
  const error = validateEnvelope(value);
  return error
    ? { error }
    : { envelope: value as AgentRpcEnvelope<Record<string, unknown>> };
}

/** Accept the pre-V1 Spike shape at the UI boundary only. Device messages use the versioned shape. */
export function legacyRequestFrom(value: unknown): LegacyAgentRequest | undefined {
  if (!isRecord(value)) return undefined;
  const request = isRecord(value.request) ? value.request : value;
  const id = request.id;
  const method = request.method;
  const params = request.params;
  if (typeof id !== "string" || id.length === 0 || typeof method !== "string" || !isRecord(params)) return undefined;
  if (!(AGENTRPC_METHODS as readonly string[]).includes(method)) return undefined;
  return { id, method: method as AgentRpcMethod, params };
}

export const AGENTRPC_METHODS: readonly AgentRpcMethod[] = [
  "file/write_text", "file/write_begin", "file/write_chunk", "file/write_commit", "file/write_abort", "file/copy", "file/publish", "file/output_paths",
  "file/stat", "file/read_text", "file/read_image", "file/read_chunk", "file/close_transfer",
  "workspace/list",
  "workspace/stat",
  "read_file",
  "exec",
  "fs/list_dir",
  "fs/read_file",
  "process/exec",
  "process/cancel",
  "git/status",
  "git/diff",
];

export interface AttachmentRef {
  id: string;
  source: "localFile" | "clipboardTemp";
  path: string;
  kind: "image" | "text" | "document" | "unknown";
  name: string;
  mimeType: string;
  bytes: number;
  version: string;
  modifiedAt?: string;
}
export interface MessageAttachment extends AttachmentRef {
  deviceId: string;
  state: "referenced" | "read" | "failed" | "unavailable";
}
export interface AttachmentSubmission {
  clientMessageId: string;
  turnId?: string;
  content: string;
  attachments: MessageAttachment[];
  status: "preparing" | "submitting" | "sent" | "failed" | "unknown";
  error?: string;
}

/** Verified output on the originating client; never a path on the central worker. */
export interface OutputArtifact {
  id: string;
  threadId: string;
  turnId?: string;
  deviceId: string;
  deviceKey?: string;
  source: "generatedImage" | "deviceFile";
  name: string;
  kind: "image" | "text" | "document" | "unknown";
  status: "saving" | "saved" | "failed";
  path?: string;
  mimeType?: string;
  bytes?: number;
  version?: string;
  sha256?: string;
  error?: string;
}
