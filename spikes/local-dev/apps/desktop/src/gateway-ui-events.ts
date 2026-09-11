// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { AppServerMessage, JsonRpcId } from "./app-server-client";
import type { OutputArtifact } from "../../../packages/agentrpc-types/src/index";
import type { TurnTimingStatus } from "./turn-timing";
import type { MessageAttachment } from "./attachments";

export interface ChatMessage {
  id: string; role: "user" | "assistant" | "system"; content: string;
  createdAt?: string; turnId?: string; timingOnly?: boolean;
  attachments?: MessageAttachment[]; outputs?: OutputArtifact[];
  delivery?: "sending" | "sent" | "failed" | "unknown";
}
export interface ThreadSummary {
  id: string; name?: string; preview?: string; cwd?: string;
  updatedAt?: string; archived?: boolean; active?: boolean;
}
export interface ApprovalRequest {
  id: JsonRpcId; method: string; params: unknown;
  kind: "approval" | "user-input" | "tool-call" | "other"; threadId?: string;
}
export interface PlatformCapabilities {
  remoteWorkspace?: boolean; imageGeneration?: boolean; plugins?: boolean; subagents?: boolean;
}

// These domains are independent: a connected gateway does not prove a device
// is online, a finished Turn does not prove a process exited or a file saved.
export type ConnectionState = "connecting" | "online" | "reconnecting" | "offline" | "error";
export type DeviceState = ConnectionState;
export type CentralEngineState = "unknown" | "ready" | "unavailable";
export type FileSaveState = OutputArtifact["status"];
// Use the existing native Turn projection instead of inventing another task truth.
export type NativeTurnState = TurnTimingStatus;
export type ExecutionStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "denied" | "offline" | "unknown";
export interface ClientGitDiff {
  source: "client"; path: string; repositoryRoot: string; format: "git-unified-diff";
  stdout: string; stderr: string; exitCode: 0; truncated: boolean; staged: boolean;
}
export interface ClientPatchResult {
  outcome: "completed" | "failed" | "partial" | "unknown";
  applied: {path:string; version:string}[];
  failedPath?: string; error?: string; atomic: false; retrySafe: false;
}
function clientPatchResult(value: unknown): ClientPatchResult | undefined {
  const p = record(value);
  if (!["completed", "failed", "partial", "unknown"].includes(String(p.outcome))
    || p.atomic !== false || p.retrySafe !== false || !Array.isArray(p.applied)
    || !p.applied.every(row => typeof record(row).path === "string" && typeof record(row).version === "string")) return undefined;
  return p as unknown as ClientPatchResult;
}
export function clientGitDiff(value: unknown): ClientGitDiff {
  const p = record(value);
  if (p.source !== "client" || p.format !== "git-unified-diff" || p.exitCode !== 0
    || typeof p.path !== "string" || typeof p.repositoryRoot !== "string"
    || typeof p.stdout !== "string" || typeof p.stderr !== "string" || typeof p.truncated !== "boolean"
    || typeof p.staged !== "boolean") throw new Error("客户端 diff 响应不兼容，未展示未经核验的变更");
  return p as unknown as ClientGitDiff;
}
export interface ExecutionLogChunk { sequence: number; stream: "stdout" | "stderr" | "progress"; chunk: string }
export interface ExecutionActivity {
  requestId: string; threadId?: string; turnId?: string; deviceId?: string;
  tool: string; program?: string; cwd?: string; streaming: boolean;
  phase: "dispatched" | "executing" | "finished";
  status: ExecutionStatus; startedAt: number; durationMs?: number; exitCode?: number;
  error?: string; diff?: ClientGitDiff; patch?: ClientPatchResult; truncated?: boolean; lastSequence: number; logs: ExecutionLogChunk[];
}
type EventPayload =
  | { kind: "protocol" }
  | { kind: "invalid"; error: string }
  | { kind: "device"; state: DeviceState; deviceId?: string }
  | { kind: "capabilities"; capabilities: PlatformCapabilities }
  | { kind: "runtime-unavailable"; error: string }
  | { kind: "connection"; state: "offline" | "reconnecting" | "online"; attempt?: number; error?:string; retryable?:boolean }
  | { kind: "output"; output: OutputArtifact }
  | { kind: "approval"; approval: ApprovalRequest }
  | { kind: "approval-resolved"; requestId: JsonRpcId }
  | { kind: "execution-start"; execution: ExecutionActivity }
  | { kind: "execution-output"; requestId: string; log: ExecutionLogChunk; truncated: boolean }
  | { kind: "execution-end"; requestId: string; threadId?: string; turnId?: string; status: ExecutionStatus; durationMs?: number; exitCode?: number; error?: string; diff?: ClientGitDiff; patch?: ClientPatchResult; truncated: boolean };
export type GatewayUiEvent = EventPayload & { message: AppServerMessage };

/** The single translation boundary for platform-owned events. Native Codex
 * conversation notifications remain a compatibility path during P1 migration. */
export function normalizeGatewayUiEvent(message: AppServerMessage, now = Date.now()): GatewayUiEvent {
  const p = record(message.params);
  const event = (payload: EventPayload): GatewayUiEvent => ({ ...payload, message });
  const invalid = () => event({kind: "invalid", error: `网关事件格式不兼容：${message.method}`});
  if (message.method === "gateway/runtimeUnavailable") return event({kind:"runtime-unavailable", error:`中央 Agent 引擎不可用：${(string(p.error) ?? "App Server 已停止").slice(0, 2000)}。${p.recoverable === true ? "请稍后重新连接并恢复对话；系统不会自动重发当前任务，执行结果需核对。" : "请联系管理员重启网关后重新连接；当前任务结果需核对。"}`});
  if (message.method === "gateway/capabilities") {
    const capabilities: PlatformCapabilities = {};
    for (const key of ["remoteWorkspace", "imageGeneration", "plugins", "subagents"] as const) {
      if (typeof p[key] === "boolean") capabilities[key] = p[key];
    }
    return event({kind:"capabilities", capabilities});
  }
  if (message.method === "serverRequest/resolved") {
    if (typeof p.requestId !== "string" && typeof p.requestId !== "number") return invalid();
    return event({kind:"approval-resolved", requestId:p.requestId});
  }
  if (message.id !== undefined && message.method && message.method !== "item/tool/call") {
    const kind = message.requestKind ?? (message.method.includes("requestApproval") ? "approval" : message.method === "item/tool/requestUserInput" ? "user-input" : "other");
    if (kind !== "other") return event({kind:"approval", approval:{id:message.id, method:message.method, params:message.params, kind, threadId:string(p.threadId)}});
  }
  if (message.method === "device/status") return event({kind:"device", state:p.agent === "online" ? "online" : "offline", deviceId:string(p.deviceId)});
  if (message.method?.startsWith("gateway/")) {
    const state = ({"gateway/disconnected":"offline", "gateway/reconnecting":"reconnecting", "gateway/reconnected":"online"} as const)[message.method as "gateway/disconnected"];
    if (state) return event({kind:"connection", state, attempt:number(p.attempt),error:string(p.error),retryable:typeof p.retryable==="boolean"?p.retryable:undefined});
  }
  if (message.method === "output/state") {
    const output = record(p.output);
    if (!["id", "threadId", "deviceId", "name"].every(key => typeof output[key] === "string")
      || !["saving", "saved", "failed"].includes(String(output.status))
      || !["generatedImage", "deviceFile"].includes(String(output.source))
      || !["image", "text", "document", "unknown"].includes(String(output.kind))) return invalid();
    return event({kind:"output", output:output as unknown as OutputArtifact});
  }
  if (message.method?.startsWith("device/tool/")) {
    const requestId = string(p.requestId);
    if (!requestId) return invalid();
    if (message.method === "device/tool/started") {
      const startedAt = typeof p.startedAt === "string" ? Date.parse(p.startedAt) : NaN;
      return event({kind:"execution-start", execution:{requestId, threadId:string(p.threadId), turnId:string(p.turnId), deviceId:string(p.deviceId), tool:string(p.tool) ?? "device_tool", program:string(p.program), cwd:string(p.cwd), streaming:p.streaming === true, phase:"dispatched", status:"running", startedAt:Number.isFinite(startedAt) ? startedAt : now, lastSequence:0, logs:[]}});
    }
    if (message.method === "device/tool/output") {
      const sequence = number(p.eventSequence);
      if (!sequence || !Number.isSafeInteger(sequence) || sequence < 1 || !["stdout", "stderr", "progress"].includes(String(p.stream))) return invalid();
      return event({kind:"execution-output", requestId, log:{sequence, stream:p.stream as ExecutionLogChunk["stream"], chunk:string(p.chunk) ?? ""}, truncated:p.truncated === true});
    }
    if (message.method === "device/tool/completed") {
      let error = (string(p.error) ?? string(record(p.error).message))?.slice(0, 2000);
      let diff: ClientGitDiff | undefined;
      if (record(p.result).format === "git-unified-diff") {
        try { diff = clientGitDiff(p.result); }
        catch (e) { error = e instanceof Error ? e.message : String(e); }
      }
      const code = string(p.errorCode) ?? string(record(p.error).code);
      const status: ExecutionStatus = p.status === "timed_out" || code === "COMMAND_TIMEOUT" || code === "TIMEOUT" ? "timed_out"
        : p.status === "denied" || code === "PERMISSION_DENIED" || code === "POLICY_DENIED" ? "denied"
        : p.status === "succeeded" || p.status === "failed" || p.status === "cancelled" || p.status === "offline" ? p.status : "unknown";
      return event({kind:"execution-end", requestId, threadId:string(p.threadId), turnId:string(p.turnId), status, durationMs:number(p.durationMs), exitCode:number(p.exitCode), error, diff, patch:clientPatchResult(p.result), truncated:p.truncated === true});
    }
  }
  return event({kind:"protocol"});
}

/** No replay: late start/output cannot revive terminal executions. Unknown
 * outcomes may be reconciled by a later authoritative completion. */
export function reduceExecutions(current: ExecutionActivity[], event: GatewayUiEvent, now = Date.now()): ExecutionActivity[] {
  if (event.kind === "execution-start") {
    if (current.some(row => row.requestId === event.execution.requestId)) return current;
    return [...current, event.execution].slice(-24);
  }
  if (event.kind === "execution-output") return current.map(row => {
    if (row.requestId !== event.requestId || row.status !== "running" || event.log.sequence <= row.lastSequence) return row;
    const appended = appendBoundedLog(row.logs, event.log);
    return {...row, phase:event.log.stream === "progress" ? row.phase : "executing", lastSequence:event.log.sequence, logs:appended.logs, truncated:row.truncated || event.truncated || appended.truncated};
  });
  if (event.kind === "execution-end") {
    // Completion may be the first observed event after reconnect. Retain it so
    // a delayed start never creates a permanently running card.
    const rows = current.some(row => row.requestId === event.requestId) ? current : [...current, {requestId:event.requestId, threadId:event.threadId, turnId:event.turnId, tool:"device_tool", streaming:false, phase:"dispatched" as const, status:"unknown" as const, startedAt:now, lastSequence:0, logs:[]}];
    return rows.map(row => row.requestId !== event.requestId || !["running", "unknown"].includes(row.status) ? row : {...row, phase:event.status === "unknown" ? row.phase : "finished" as const, status:event.status, durationMs:event.durationMs ?? Math.max(0, now-row.startedAt), exitCode:event.exitCode, error:event.error, diff:event.diff, patch:event.patch, truncated:row.truncated || event.truncated}).slice(-24);
  }
  if (event.kind === "runtime-unavailable" || (event.kind === "connection" && event.state === "offline") || (event.kind === "device" && event.state === "offline")) {
    return current.map(row => row.status !== "running" ? row : {...row, status:"unknown", durationMs:Math.max(0,now-row.startedAt), error:event.kind === "runtime-unavailable" ? event.error : "连接已断开，客户端操作结果未知；请核对后再重试"});
  }
  return current;
}

function appendBoundedLog(logs: ExecutionLogChunk[], entry: ExecutionLogChunk): {logs:ExecutionLogChunk[]; truncated:boolean} {
  const encoder = new TextEncoder();
  const limit = 1024 * 1024;
  let truncated = false;
  if (encoder.encode(entry.chunk).length > limit) {
    // Bound even one malicious oversized frame without cutting UTF-8 bytes.
    let chars = Array.from(entry.chunk); let bytes = encoder.encode(entry.chunk).length;
    let start = 0;
    while (bytes > limit) bytes -= encoder.encode(chars[start++]).length;
    entry = {...entry, chunk:chars.slice(start).join("")}; truncated = true;
  }
  const next = [...logs, entry];
  let bytes = next.reduce((sum, row) => sum+encoder.encode(row.chunk).length, 0);
  while (bytes > limit && next.length > 1) { bytes -= encoder.encode(next.shift()!.chunk).length; truncated = true; }
  return {logs:next, truncated};
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
