// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  AGENTRPC_VERSION,
  createEnvelope,
  parseEnvelope,
  type AgentHelloPayload,
  type AgentRpcMethod,
  type AgentRpcResponsePayload,
} from "@central-codex-spike/agentrpc-types";

type JsonObject = Record<string, unknown>;
type JsonRpcMessage = JsonObject & { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

type GatewayRequest = {
  type: "request";
  requestId: string;
  operation:
    | "session.initialize"
    | "conversation.create"
    | "conversation.resume"
    | "conversation.read"
    | "conversation.archive"
    | "conversation.unarchive"
    | "conversation.delete"
    | "conversation.rename"
    | "conversation.turn.create"
    | "conversation.turn.cancel"
    | "conversation.list"
    | "device.workspace.list"
    | "device.read_file"
    | "device.exec"
    | "test.approval.inject";
  payload?: JsonObject;
};

type GatewayApprovalResponse = {
  type: "approval.response";
  requestId: string;
  result: unknown;
};

type GatewayMessage = GatewayRequest | GatewayApprovalResponse;

type ConnectedClient = {
  id: string;
  socket: WebSocket;
  userId: string;
  deviceId: string;
};

type PendingServerRequest = {
  clientId: string;
  upstreamId: number | string;
  userId: string;
  method: string;
  data: unknown;
  timer: NodeJS.Timeout;
};

type PendingAgentRequest = {
  resolve: (payload: AgentRpcResponsePayload) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
};

type PendingSyntheticApproval = {
  clientId: string;
  userId: string;
  deviceId: string;
  timer: NodeJS.Timeout;
};

type AgentSession = {
  socket: WebSocket;
  deviceId: string;
  ready: boolean;
  hello?: AgentHelloPayload;
  lastHeartbeatAt?: string;
};

type AuditEvent = {
  id: string;
  at: string;
  action: string;
  status: "started" | "succeeded" | "failed" | "requested" | "resolved" | "connected" | "disconnected";
  userId?: string;
  deviceId?: string;
  requestId?: string;
  errorCode?: string;
};

const listenHost = process.env.TEST_GATEWAY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.TEST_GATEWAY_PORT ?? 4510);
const codexCommand = process.env.CODEX_BIN ?? "codex";
const stateFile = resolve(process.env.TEST_GATEWAY_STATE_FILE ?? "data/test-gateway-state.json");

// The central worker is for reasoning only. System operations are exposed as
// dynamic tools so app-server asks the connected desktop client to execute
// them through its Local Agent instead of touching the Mac worker filesystem.
const CLIENT_DEVICE_TOOLS = [
  {
    type: "function",
    name: "device_workspace_list",
    description: "List entries in the user's approved local workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative workspace path; defaults to the workspace root." } } },
  },
  {
    type: "function",
    name: "device_read_file",
    description: "Read a UTF-8 text file from the user's approved local workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "device_exec",
    description: "Run an approved, non-shell command on the user's local device. Never use this for arbitrary shell syntax.",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["program"],
    },
  },
] as const;

const CLIENT_DEVICE_INSTRUCTIONS = [
  "You are the central reasoning worker for a remote desktop client.",
  "The central machine is never the user's computer.",
  "Never use built-in shell, filesystem, process, git, or other host-system tools for user-device work.",
  "For files, Git, commands, disk, or other system information, use the provided device_* dynamic tools; they execute on the connected user's device through Local Agent.",
  "If a required device_* tool is unavailable or rejects an operation, explain that limitation instead of inspecting the central worker.",
].join(" ");

const BLOCKED_CENTRAL_OPERATION_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

class CodexStdioBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();
  private initializedResult: unknown = undefined;
  private hasInitialized = false;
  private initializePromise: Promise<unknown> | undefined;

  public constructor() {
    this.child = spawn(codexCommand, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.warn(`[codex-app-server] ${message}`);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Codex App Server exited (${code ?? "signal"} ${signal ?? ""})`.trim()));
    });
  }

  public subscribe(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public request(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      // App Server initializes once per process. Reconnects and additional UI
      // clients reuse the negotiated result instead of sending initialize again.
      if (this.hasInitialized) return Promise.resolve(this.initializedResult);
      if (this.initializePromise) return this.initializePromise;
      this.initializePromise = this.sendRequest(method, params).then(
        (result) => {
          this.initializedResult = result;
          this.hasInitialized = true;
          this.initializePromise = undefined;
          return result;
        },
        (error) => {
          this.initializePromise = undefined;
          throw error;
        },
      );
      return this.initializePromise;
    }
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  public respond(id: number | string, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  public close(): void {
    this.rejectAll(new Error("Gateway shutting down"));
    this.child.kill();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      console.warn("[codex-app-server] ignored non-JSON stdout line");
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = Number.isFinite(numericId) ? this.pending.get(numericId) : undefined;
      if (pending) {
        this.pending.delete(numericId);
        if (message.error) pending.reject(new Error(`App Server request failed: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
        return;
      }
    }

    for (const listener of this.listeners) listener(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const bridge = new CodexStdioBridge();
const clients = new Map<string, ConnectedClient>();
const pendingServerRequests = new Map<string, PendingServerRequest>();
const pendingAgentRequests = new Map<string, PendingAgentRequest>();
const pendingSyntheticApprovals = new Map<string, PendingSyntheticApproval>();
// Durable-for-process ownership fence: reconnects using the same userId retain
// their Thread ownership, while a different user cannot enumerate or mutate it.
const ownedThreadIdsByUser = new Map<string, Set<string>>();
const threadOwnerById = new Map<string, string>();
const threadSummaryById = new Map<string, JsonObject>();
const agents = new Map<string, AgentSession>();
const auditEvents: AuditEvent[] = [];
let lastAppClientId: string | undefined;
let sequence = 0;
const controlsEnabled = process.env.TEST_GATEWAY_ENABLE_CONTROLS === "1";

type GatewayState = {
  version: 1;
  users: Record<string, Array<{ id: string; summary: JsonObject }>>;
};

function loadState(): void {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<GatewayState>;
    if (parsed.version !== 1 || !isRecord(parsed.users)) return;
    for (const [userId, entries] of Object.entries(parsed.users)) {
      if (!Array.isArray(entries)) continue;
      const owned = new Set<string>();
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.summary)) continue;
        owned.add(entry.id);
        threadOwnerById.set(entry.id, userId);
        threadSummaryById.set(entry.id, entry.summary);
      }
      ownedThreadIdsByUser.set(userId, owned);
    }
  } catch {
    // A missing or partially written state file should not prevent the gateway
    // from starting; the next mutation will create a fresh file.
  }
}

function persistState(): void {
  const users: GatewayState["users"] = {};
  for (const [userId, ids] of ownedThreadIdsByUser) {
    users[userId] = [...ids].map((id) => ({ id, summary: threadSummaryById.get(id) ?? { id } }));
  }
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ version: 1, users } satisfies GatewayState, null, 2), "utf8");
  } catch (error) {
    console.warn(`[gateway-state] failed to persist ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

loadState();

function audit(action: string, status: AuditEvent["status"], fields: Omit<AuditEvent, "id" | "at" | "action" | "status"> = {}): void {
  auditEvents.push({ id: randomUUID(), at: new Date().toISOString(), action, status, ...fields });
  if (auditEvents.length > 1000) auditEvents.splice(0, auditEvents.length - 1000);
}

bridge.subscribe((message) => {
  if (message.id !== undefined && message.method && BLOCKED_CENTRAL_OPERATION_REQUESTS.has(message.method)) {
    // A central worker must never receive permission to mutate or inspect the
    // user's device. The model should use a device_* dynamic tool instead.
    bridge.respond(message.id, { decision: "decline", reason: "central_system_operations_disabled" });
    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const ownerUserId = threadId ? threadOwnerById.get(threadId) : undefined;
    audit("central.operation.blocked", "failed", { userId: ownerUserId, errorCode: "CENTRAL_SYSTEM_OPERATION_DISABLED" });
    return;
  }
  if (message.id !== undefined && message.method === "item/tool/call") {
    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const ownerUserId = threadId ? threadOwnerById.get(threadId) : undefined;
    const client = [...clients.values()].find((candidate) => ownerUserId && candidate.userId === ownerUserId)
      ?? (lastAppClientId ? clients.get(lastAppClientId) : undefined);
    if (!client) {
      bridge.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "No connected desktop client is available for this device operation." }] });
      return;
    }
    const requestId = `${client.id}:${String(message.id)}`;
    const timer = setTimeout(() => {
      const timedOut = pendingServerRequests.get(requestId);
      if (!timedOut) return;
      pendingServerRequests.delete(requestId);
      bridge.respond(timedOut.upstreamId, { success: false, contentItems: [{ type: "inputText", text: "Local device tool request timed out." }] });
      audit("device.tool.response", "failed", { userId: timedOut.userId, deviceId: client.deviceId, requestId, errorCode: "DEVICE_TOOL_TIMEOUT" });
    }, 60_000);
    pendingServerRequests.set(requestId, { clientId: client.id, upstreamId: message.id, userId: client.userId, method: message.method, data: message.params, timer });
    audit("device.tool.request", "requested", { userId: client.userId, deviceId: client.deviceId, requestId });
    send(client.socket, {
      type: "approval.request",
      requestId,
      kind: "tool-call",
      method: message.method,
      data: message.params,
      sequence: ++sequence,
    });
    return;
  }
  if (message.id !== undefined && message.method) {
    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const ownerUserId = threadId ? threadOwnerById.get(threadId) : undefined;
    const client = [...clients.values()].find((candidate) => ownerUserId && candidate.userId === ownerUserId)
      ?? (lastAppClientId ? clients.get(lastAppClientId) : undefined);
    if (!client) return;
    const requestId = `${client.id}:${String(message.id)}`;
    const timer = setTimeout(() => {
      const timedOut = pendingServerRequests.get(requestId);
      if (!timedOut) return;
      pendingServerRequests.delete(requestId);
      bridge.respond(timedOut.upstreamId, { decision: "reject", reason: "approval_timeout" });
      audit("approval.response", "failed", { userId: timedOut.userId, requestId, errorCode: "APPROVAL_TIMEOUT" });
      const target = clients.get(timedOut.clientId);
      if (target) send(target.socket, { type: "approval.resolved", requestId, status: "timeout", sequence: ++sequence });
    }, 120_000);
    pendingServerRequests.set(requestId, { clientId: client.id, upstreamId: message.id, userId: client.userId, method: message.method, data: message.params, timer });
    audit("approval.request", "requested", { userId: client.userId, requestId });
    send(client.socket, {
      type: "approval.request",
      requestId,
      kind: message.method === "item/tool/requestUserInput" ? "user-input" : "approval",
      method: message.method,
      data: message.params,
      sequence: ++sequence,
    });
    return;
  }

  const event = normalizeNotification(message);
  if (!event) return;
  const threadId = isRecord(event.data) && typeof event.data.threadId === "string" ? event.data.threadId : undefined;
  for (const client of clients.values()) {
    if (threadId ? threadOwnerById.get(threadId) === client.userId : client.id === lastAppClientId) send(client.socket, event);
  }
});

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`);
  if (url.pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      service: "central-test-gateway",
      appServer: "stdio",
      clients: clients.size,
      devices: [...agents.values()].filter((agent) => agent.ready && agent.socket.readyState === WebSocket.OPEN).length,
      controlsEnabled,
      sequence,
    });
    return;
  }
  if (url.pathname === "/audit") {
    writeJson(response, 200, { ok: true, events: auditEvents });
    return;
  }
  response.writeHead(404);
  response.end();
});

const websocketServer = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`).pathname;
  if (path !== "/ws" && path !== "/ws/agent") {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (client) => {
    if (path === "/ws/agent") handleAgentConnection(client, request);
    else handleClient(client, request);
  });
});

function handleClient(socket: WebSocket, _request: IncomingMessage): void {
  const query = new URL(_request.url ?? "/", `http://${listenHost}:${listenPort}`).searchParams;
  const userId = query.get("userId")?.trim() || `session-${randomUUID()}`;
  const deviceId = query.get("deviceId")?.trim() || "default-device";
  const client: ConnectedClient = { id: randomUUID(), socket, userId, deviceId };
  clients.set(client.id, client);
  if (!ownedThreadIdsByUser.has(userId)) ownedThreadIdsByUser.set(userId, new Set());
  audit("client.connect", "connected", { userId, deviceId });
  send(socket, {
    type: "gateway.ready",
    protocol: "central-gateway-v1",
    appServerTransport: "stdio",
    deviceBroker: "agentrpc-v1",
    agent: agentState(deviceId) === "online" ? "online" : "offline",
    userId,
    deviceId,
  });

  socket.on("message", (data) => {
    void handleGatewayMessage(client, parseMessage(data));
  });
  socket.on("close", () => {
    rehomePendingApprovals(client);
    clients.delete(client.id);
    audit("client.disconnect", "disconnected", { userId, deviceId });
  });
  socket.on("error", () => {
    rehomePendingApprovals(client);
    clients.delete(client.id);
    audit("client.error", "failed", { userId, deviceId });
  });
}

function rehomePendingApprovals(disconnected: ConnectedClient): void {
  const replacement = [...clients.values()].find((candidate) => candidate.id !== disconnected.id && candidate.userId === disconnected.userId && candidate.socket.readyState === WebSocket.OPEN);
  for (const [requestId, pending] of pendingServerRequests) {
    if (pending.clientId !== disconnected.id) continue;
    if (!replacement) {
      pendingServerRequests.delete(requestId);
      clearTimeout(pending.timer);
      bridge.respond(pending.upstreamId, { decision: "reject", reason: "client_disconnected" });
      audit("approval.response", "failed", { userId: disconnected.userId, deviceId: disconnected.deviceId, requestId, errorCode: "CLIENT_DISCONNECTED" });
      continue;
    }
    pending.clientId = replacement.id;
    send(replacement.socket, {
      type: "approval.request",
      requestId,
      kind: pending.method === "item/tool/requestUserInput" ? "user-input" : "approval",
      method: pending.method,
      data: pending.data,
      sequence: ++sequence,
      recovered: true,
    });
    audit("approval.rehome", "requested", { userId: replacement.userId, deviceId: replacement.deviceId, requestId });
  }
  for (const [requestId, pending] of pendingSyntheticApprovals) {
    if (pending.clientId !== disconnected.id) continue;
    pendingSyntheticApprovals.delete(requestId);
    clearTimeout(pending.timer);
    audit("approval.response", "failed", { userId: pending.userId, deviceId: pending.deviceId, requestId, errorCode: "CLIENT_DISCONNECTED" });
  }
}

async function handleGatewayMessage(client: ConnectedClient, message: GatewayMessage | undefined): Promise<void> {
  if (!message) return;
  if (message.type === "approval.response") {
    const synthetic = pendingSyntheticApprovals.get(message.requestId);
    if (synthetic) {
      if (synthetic.clientId !== client.id) {
        audit("approval.response", "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "UNKNOWN_APPROVAL" });
        send(client.socket, { type: "error", requestId: message.requestId, message: "unknown approval request" });
        return;
      }
      pendingSyntheticApprovals.delete(message.requestId);
      clearTimeout(synthetic.timer);
      const decision = isRecord(message.result) && typeof message.result.decision === "string" ? message.result.decision : "resolved";
      audit("approval.response", "resolved", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId });
      send(client.socket, { type: "approval.resolved", requestId: message.requestId, status: decision, sequence: ++sequence, synthetic: true });
      return;
    }
    const pending = pendingServerRequests.get(message.requestId);
    if (!pending || pending.clientId !== client.id) {
      audit("approval.response", "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "UNKNOWN_APPROVAL" });
      send(client.socket, { type: "error", requestId: message.requestId, message: "unknown approval request" });
      return;
    }
    pendingServerRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    bridge.respond(pending.upstreamId, message.result);
    audit("approval.response", "resolved", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId });
    send(client.socket, { type: "approval.resolved", requestId: message.requestId, sequence: ++sequence });
    return;
  }

  if (message.operation === "test.approval.inject") {
    if (!controlsEnabled) {
      audit(message.operation, "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "CONTROLS_DISABLED" });
      send(client.socket, { type: "response", requestId: message.requestId, ok: false, error: "test controls are disabled" });
      return;
    }
    const payload = message.payload ?? {};
    const approvalRequestId = `${client.id}:synthetic:${randomUUID()}`;
    const method = typeof payload.method === "string" && payload.method ? payload.method : "item/command/approval";
    const timeoutMs = Math.min(10_000, Math.max(100, typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 5_000));
    const timer = setTimeout(() => {
      const pending = pendingSyntheticApprovals.get(approvalRequestId);
      if (!pending) return;
      pendingSyntheticApprovals.delete(approvalRequestId);
      audit("approval.response", "failed", { userId: pending.userId, deviceId: pending.deviceId, requestId: approvalRequestId, errorCode: "APPROVAL_TIMEOUT" });
      const target = clients.get(pending.clientId);
      if (target) send(target.socket, { type: "approval.resolved", requestId: approvalRequestId, status: "timeout", sequence: ++sequence, synthetic: true });
    }, timeoutMs);
    pendingSyntheticApprovals.set(approvalRequestId, { clientId: client.id, userId: client.userId, deviceId: client.deviceId, timer });
    audit(message.operation, "requested", { userId: client.userId, deviceId: client.deviceId, requestId: approvalRequestId });
    send(client.socket, { type: "approval.request", requestId: approvalRequestId, kind: "approval", method, data: payload.data ?? {}, sequence: ++sequence, synthetic: true, timeoutMs });
    send(client.socket, { type: "response", requestId: message.requestId, ok: true, data: { approvalRequestId, timeoutMs, synthetic: true } });
    return;
  }

  const method = operationMethod(message.operation);
  const agentMethod = deviceOperationMethod(message.operation);
  if (!method && !agentMethod) {
    audit(message.operation, "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "UNSUPPORTED_OPERATION" });
    send(client.socket, { type: "response", requestId: message.requestId, ok: false, error: "unsupported operation" });
    return;
  }
  try {
    lastAppClientId = client.id;
    audit(message.operation, "started", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId });
    if (["conversation.resume", "conversation.read", "conversation.archive", "conversation.unarchive", "conversation.delete", "conversation.rename", "conversation.turn.create", "conversation.turn.cancel"].includes(message.operation)) {
      assertOwnedThread(client, message.payload ?? {});
    }
    const appPayload = message.operation === "conversation.create"
      ? {
          ...(message.payload ?? {}),
          approvalPolicy: "untrusted",
          developerInstructions: CLIENT_DEVICE_INSTRUCTIONS,
          dynamicTools: CLIENT_DEVICE_TOOLS,
        }
      : message.operation === "session.initialize"
        ? {
            ...(message.payload ?? {}),
            capabilities: {
              ...(isRecord(message.payload) && isRecord(message.payload.capabilities) ? message.payload.capabilities : {}),
              // Dynamic client-device tools are an experimental App Server API.
              experimentalApi: true,
            },
          }
        : message.payload ?? {};
    const result = agentMethod
      ? await sendAgentRequest(client.deviceId, agentMethod, validateDeviceParams(message.payload ?? {}))
      : await bridge.request(method as string, appPayload);
    if (message.operation === "conversation.list") rememberListedThreads(client.userId, result);
    const visibleResult = message.operation === "conversation.list"
      ? filterOwnedThreads(result, ownedThreadIdsByUser.get(client.userId) ?? new Set(), client.userId)
      : result;
    if (message.operation === "conversation.create") {
      const createdId = threadIdFromResult(result);
      if (createdId) {
        ownedThreadIdsByUser.get(client.userId)?.add(createdId);
        threadOwnerById.set(createdId, client.userId);
        const createdRecord = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
        threadSummaryById.set(createdId, createdRecord ?? { id: createdId });
        persistState();
      }
    }
    if (["conversation.rename", "conversation.archive", "conversation.unarchive"].includes(message.operation)) {
      const changedId = typeof message.payload?.threadId === "string" ? message.payload.threadId : undefined;
      if (changedId) {
        const current = threadSummaryById.get(changedId) ?? { id: changedId };
        const returned = isRecord(result) && isRecord(result.thread) ? result.thread : isRecord(result) && typeof result.id === "string" ? result : undefined;
        const next = { ...current, ...(returned ?? {}) };
        if (message.operation === "conversation.rename" && typeof message.payload?.name === "string") next.name = message.payload.name;
        if (message.operation === "conversation.archive") {
          next.isArchived = true;
          next.archivedAt = next.archivedAt ?? new Date().toISOString();
        }
        if (message.operation === "conversation.unarchive") {
          next.isArchived = false;
          delete next.archivedAt;
        }
        threadSummaryById.set(changedId, next);
        persistState();
      }
    }
    if (message.operation === "conversation.delete") {
      const deletedId = typeof message.payload?.threadId === "string" ? message.payload.threadId : undefined;
      if (deletedId) {
        ownedThreadIdsByUser.get(client.userId)?.delete(deletedId);
        threadOwnerById.delete(deletedId);
        threadSummaryById.delete(deletedId);
        persistState();
      }
    }
    const operationFailed = agentMethod && isRecord(result) && result.ok === false;
    audit(message.operation, operationFailed ? "failed" : "succeeded", {
      userId: client.userId,
      deviceId: client.deviceId,
      requestId: message.requestId,
      ...(operationFailed && typeof result.errorCode === "string" ? { errorCode: result.errorCode } : {}),
    });
    send(client.socket, { type: "response", requestId: message.requestId, ok: true, data: visibleResult });
  } catch (error) {
    audit(message.operation, "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "REQUEST_FAILED" });
    send(client.socket, { type: "response", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function operationMethod(operation: GatewayRequest["operation"]): string | undefined {
  const methods: Partial<Record<GatewayRequest["operation"], string>> = {
    "session.initialize": "initialize",
    "conversation.create": "thread/start",
    "conversation.resume": "thread/resume",
    "conversation.read": "thread/read",
    "conversation.archive": "thread/archive",
    "conversation.unarchive": "thread/unarchive",
    "conversation.delete": "thread/delete",
    "conversation.rename": "thread/name/set",
    "conversation.turn.create": "turn/start",
    "conversation.turn.cancel": "turn/interrupt",
    "conversation.list": "thread/list",
  };
  return methods[operation];
}

function deviceOperationMethod(operation: GatewayRequest["operation"]): AgentRpcMethod | undefined {
  const methods: Partial<Record<GatewayRequest["operation"], AgentRpcMethod>> = {
    "device.workspace.list": "workspace/list",
    "device.read_file": "read_file",
    "device.exec": "exec",
  };
  return methods[operation];
}

function validateDeviceParams(params: JsonObject): JsonObject {
  for (const forbidden of ["deviceId", "workspaceId", "workspaceRoot"]) {
    if (forbidden in params) throw new Error(`${forbidden} is selected by the central broker and cannot be supplied by the client`);
  }
  return params;
}

function agentState(deviceId: string): "online" | "offline" {
  const agent = agents.get(deviceId);
  return agent?.ready && agent.socket.readyState === WebSocket.OPEN ? "online" : "offline";
}

function sendAgentRequest(deviceId: string, method: AgentRpcMethod, params: JsonObject): Promise<AgentRpcResponsePayload> {
  const session = agents.get(deviceId);
  const socket = session?.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN || !session.ready) {
    return Promise.resolve({ ok: false, error: "Local Agent is offline", errorCode: "AGENT_OFFLINE", retryable: true });
  }

  const requestId = randomUUID();
  const envelope = createEnvelope(
    "agent.request",
    { method, params, operationId: requestId, idempotencyKey: requestId },
    { requestId },
  );
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAgentRequests.delete(requestId);
      resolve({ ok: false, error: "Local Agent request timed out", errorCode: "TIMEOUT", retryable: true });
    }, 10_000);
    pendingAgentRequests.set(requestId, { resolve, timer, deviceId });
    send(socket, envelope as unknown as JsonObject);
  });
}

function handleAgentConnection(socket: WebSocket, request: IncomingMessage): void {
  const query = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`).searchParams;
  const requestedDeviceId = query.get("deviceId")?.trim() || "default-device";
  const previous = agents.get(requestedDeviceId);
  if (previous?.socket.readyState === WebSocket.OPEN) {
    socket.close(1013, "device already connected");
    return;
  }
  const session: AgentSession = { socket, deviceId: requestedDeviceId, ready: false };
  agents.set(requestedDeviceId, session);
  audit("device.connect", "connected", { deviceId: requestedDeviceId });
  socket.on("message", (data) => handleAgentMessage(socket, data, requestedDeviceId, session));
  socket.on("close", () => {
    rejectAgentRequestsForDevice(requestedDeviceId, "Local Agent connection closed", "AGENT_DISCONNECTED");
    if (agents.get(requestedDeviceId)?.socket === socket) {
      agents.delete(requestedDeviceId);
      audit("device.disconnect", "disconnected", { deviceId: requestedDeviceId });
      broadcastDeviceStatus(requestedDeviceId);
    }
  });
  socket.on("error", () => undefined);
}

function handleAgentMessage(socket: WebSocket, data: WebSocket.RawData, requestedDeviceId: string, session: AgentSession): void {
  const parsed = parseEnvelope(toText(data));
  if ("error" in parsed) {
    send(socket, { type: "gateway.error", code: parsed.error.code, error: parsed.error.message });
    return;
  }
  const envelope = parsed.envelope;
  if (envelope.type === "agent.hello") {
    const payload = envelope.payload as unknown as Record<string, unknown>;
    const agent = payload.agent;
    if (!isRecord(agent) || typeof agent.version !== "string" || !Array.isArray(agent.capabilities)) {
      send(socket, { type: "gateway.error", code: "INVALID_HELLO", error: "invalid agent hello" });
      socket.close(1002, "invalid agent hello");
      return;
    }
    const helloDeviceId = typeof payload.deviceId === "string" && payload.deviceId.trim() ? payload.deviceId.trim() : requestedDeviceId;
    if (helloDeviceId !== requestedDeviceId) {
      send(socket, { type: "gateway.error", code: "DEVICE_MISMATCH", error: "agent deviceId does not match connection" });
      socket.close(1008, "device mismatch");
      return;
    }
    session.hello = payload as unknown as AgentHelloPayload;
    session.ready = true;
    session.lastHeartbeatAt = new Date().toISOString();
    send(socket, createEnvelope("agent.hello_ack", {
      accepted: true,
      server: "central-test-gateway",
      capabilities: ["agent.request", "agent.response", "agent.heartbeat"],
      heartbeatIntervalMs: 10_000,
    }) as unknown as JsonObject);
    audit("device.hello", "succeeded", { deviceId: requestedDeviceId });
    broadcastDeviceStatus(requestedDeviceId);
    return;
  }
  if (envelope.type === "agent.heartbeat") {
    if (!session.ready) return;
    session.lastHeartbeatAt = new Date().toISOString();
    broadcastDeviceStatus(requestedDeviceId);
    return;
  }
  if (envelope.type === "agent.response") {
    const payload = envelope.payload as unknown as AgentRpcResponsePayload;
    if (typeof payload.ok !== "boolean" || !envelope.requestId) return;
    const pending = pendingAgentRequests.get(envelope.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAgentRequests.delete(envelope.requestId);
    pending.resolve({ ...payload, id: payload.id ?? envelope.requestId });
  }
}

function rejectAgentRequestsForDevice(deviceId: string, error: string, errorCode: string): void {
  for (const [requestId, pending] of pendingAgentRequests) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    pendingAgentRequests.delete(requestId);
    pending.resolve({ ok: false, error, errorCode, retryable: true, id: requestId });
  }
}

function rejectAllAgentRequests(error: string, errorCode: string): void {
  for (const deviceId of agents.keys()) rejectAgentRequestsForDevice(deviceId, error, errorCode);
}

function broadcastDeviceStatus(deviceId: string): void {
  const session = agents.get(deviceId);
  for (const client of clients.values()) {
    if (client.deviceId !== deviceId) continue;
    send(client.socket, {
      type: "device.status",
      agent: agentState(deviceId),
      agentInfo: session?.hello?.agent,
      lastHeartbeatAt: session?.lastHeartbeatAt,
      deviceId,
    });
  }
}

function threadIdFromResult(result: unknown): string | undefined {
  const record = isRecord(result) ? result : undefined;
  const thread = record && isRecord(record.thread) ? record.thread : undefined;
  if (thread && typeof thread.id === "string") return thread.id;
  return record && typeof record.threadId === "string" ? record.threadId : undefined;
}

function assertOwnedThread(client: ConnectedClient, payload: JsonObject): void {
  const requestedThreadId = payload.threadId;
  const owned = ownedThreadIdsByUser.get(client.userId);
  if (typeof requestedThreadId !== "string" || !owned?.has(requestedThreadId)) {
    throw new Error("thread does not belong to this platform session");
  }
}

function filterOwnedThreads(result: unknown, ownedThreadIds: Set<string>, userId: string): unknown {
  if (!isRecord(result)) return result;
  const known = [...threadSummaryById.entries()]
    .filter(([id]) => ownedThreadIds.has(id) && threadOwnerById.get(id) === userId)
    .map(([, summary]) => summary);
  const filter = (value: unknown): unknown[] => {
    const visible = Array.isArray(value)
      ? value.filter((item) => isRecord(item) && typeof item.id === "string" && ownedThreadIds.has(item.id))
      : [];
    const visibleIds = new Set(visible.map((item) => isRecord(item) && typeof item.id === "string" ? item.id : ""));
    return [...visible, ...known.filter((item) => typeof item.id === "string" && !visibleIds.has(item.id))];
  };
  if (Array.isArray(result.data)) return { ...result, data: filter(result.data) };
  if (Array.isArray(result.threads)) return { ...result, threads: filter(result.threads) };
  return result;
}

function rememberListedThreads(userId: string, result: unknown): void {
  if (!isRecord(result)) return;
  const values = Array.isArray(result.data) ? result.data : Array.isArray(result.threads) ? result.threads : [];
  let changed = false;
  for (const value of values) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    if (threadOwnerById.get(value.id) !== userId) continue;
    threadSummaryById.set(value.id, value);
    changed = true;
  }
  if (changed) persistState();
}

function normalizeNotification(message: JsonRpcMessage): JsonObject | undefined {
  const params = isRecord(message.params) ? message.params : {};
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (message.method === "item/agentMessage/delta") {
    return { type: "event", eventType: "assistant.delta", data: { threadId, delta: params.delta ?? params.text ?? "" }, sequence: ++sequence };
  }
  if (message.method === "turn/completed") {
    return { type: "event", eventType: "turn.completed", data: { threadId, turn: params.turn }, sequence: ++sequence };
  }
  if (!message.method) return undefined;
  return { type: "event", eventType: "codex.notification", name: message.method, data: params, sequence: ++sequence };
}

function parseMessage(data: WebSocket.RawData): GatewayMessage | undefined {
  try {
    const value = JSON.parse(toText(data)) as GatewayMessage;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function send(socket: WebSocket, value: JsonObject): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function writeJson(response: ServerResponse, status: number, value: JsonObject): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function toText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

httpServer.listen(listenPort, listenHost, () => {
  console.log(`Central test gateway listening on ws://${listenHost}:${listenPort}/ws (App Server via stdio)`);
});

process.on("SIGINT", () => {
  rejectAllAgentRequests("Gateway shutting down", "GATEWAY_SHUTDOWN");
  for (const session of agents.values()) session.socket.close();
  bridge.close();
  httpServer.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  rejectAllAgentRequests("Gateway shutting down", "GATEWAY_SHUTDOWN");
  for (const session of agents.values()) session.socket.close();
  bridge.close();
  httpServer.close();
  process.exit(0);
});
