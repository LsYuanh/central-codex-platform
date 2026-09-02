// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import { WebSocket, WebSocketServer } from "ws";
import {
  AGENTRPC_VERSION,
  createEnvelope,
  legacyRequestFrom,
  parseEnvelope,
  type AgentHelloPayload,
  type AgentRpcEnvelope,
  type AgentRpcMethod,
  type AgentRpcResponsePayload,
} from "@central-codex-spike/agentrpc-types";
import { RemoteWorkspaceBridge } from "./bridge.js";
import { FakeAppServerWorker, type FakeAppServerRequest } from "./fake-app-server.js";

try {
  loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const host = process.env.CENTRAL_HOST ?? "127.0.0.1";
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("CENTRAL_HOST must be 127.0.0.1 or localhost for this local Spike");
}
const configuredPort = Number(process.env.CENTRAL_PORT ?? "4310");
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("CENTRAL_PORT must be an integer between 1 and 65535");
}
const port = configuredPort;
const uiClients = new Set<WebSocket>();
const pendingRequests = new Map<
  string,
  { socket: WebSocket; resolve: (response: AgentRpcResponsePayload) => void; timer: NodeJS.Timeout }
>();

let agentSocket: WebSocket | undefined;
let agentReady = false;
let agentHello: AgentHelloPayload | undefined;
let lastHeartbeatAt: string | undefined;

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcastToUi(message: unknown): void {
  for (const socket of uiClients) send(socket, message);
}

function statusMessage(): unknown {
  return {
    type: "gateway.status",
    gateway: "online",
    agent: agentReady && agentSocket?.readyState === WebSocket.OPEN ? "online" : "offline",
    worker: worker.status(),
    agentInfo: agentHello?.agent,
    lastHeartbeatAt,
  };
}

/** Device Broker request API consumed by the Remote Workspace Bridge. */
function sendAgentRequest(
  method: AgentRpcMethod,
  params: Record<string, unknown>,
  metadata: { taskId?: string; traceId?: string; operationId?: string; idempotencyKey?: string } = {},
): Promise<AgentRpcResponsePayload> {
  const socket = agentSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN || !agentReady) {
    return Promise.resolve({ ok: false, error: "Local Agent is offline", errorCode: "AGENT_OFFLINE", retryable: true });
  }

  const requestId = randomUUID();
  const envelope = createEnvelope(
    "agent.request",
    {
      method,
      params,
      operationId: metadata.operationId,
      idempotencyKey: metadata.idempotencyKey,
    },
    { requestId, taskId: metadata.taskId, traceId: metadata.traceId },
  );

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ ok: false, error: "Local Agent request timed out", errorCode: "TIMEOUT", retryable: true });
    }, 10_000);
    pendingRequests.set(requestId, { socket, resolve, timer });
    send(socket, envelope);
  });
}

const bridge = new RemoteWorkspaceBridge(sendAgentRequest);
// A real deployment starts one isolated App Server worker per user. This
// worker is intentionally in-memory and never starts Codex or accesses OpenAI.
const worker = new FakeAppServerWorker(bridge);

function responsePayload(message: Record<string, unknown>): { id?: string; response?: AgentRpcResponsePayload } | undefined {
  const payload = isRecord(message.payload) ? message.payload : undefined;
  const legacy = isRecord(message.response) ? message.response : undefined;
  const response = payload ?? legacy;
  if (!response || typeof response.ok !== "boolean") return undefined;
  const id = typeof message.requestId === "string" ? message.requestId : typeof response.id === "string" ? response.id : undefined;
  return { id, response: response as unknown as AgentRpcResponsePayload };
}

function handleAgentMessage(socket: WebSocket, raw: WebSocket.RawData): void {
  const text = raw.toString();
  const parsed = parseEnvelope(text);
  if ("envelope" in parsed) {
    handleCanonicalAgentMessage(socket, parsed.envelope);
    return;
  }
  if (parsed.error.code === "unsupported_version" || parsed.error.code === "message_too_large") {
    send(socket, { type: "gateway.error", error: parsed.error.message, code: parsed.error.code });
    socket.close(1002, parsed.error.message);
    return;
  }

  // Compatibility for the original Stage 1 Fake Agent. It is normalized at
  // this boundary and never forwarded to the worker or another device.
  try {
    const legacy = JSON.parse(text) as unknown;
    if (!isRecord(legacy) || typeof legacy.type !== "string") return;
    if (legacy.type === "agent.hello" && isRecord(legacy.agent)) {
      acceptHello(socket, { agent: legacy.agent as AgentHelloPayload["agent"] });
    } else if (legacy.type === "agent.heartbeat") {
      lastHeartbeatAt = new Date().toISOString();
      broadcastToUi(statusMessage());
    } else if (legacy.type === "agent.response") {
      const response = responsePayload(legacy);
      if (response?.id && response.response) resolvePending(response.id, response.response);
    }
  } catch {
    // Invalid legacy frames are ignored; the canonical parser already enforces
    // the size limit and reports protocol errors to the connection owner.
  }
}

function handleCanonicalAgentMessage(socket: WebSocket, envelope: AgentRpcEnvelope): void {
  switch (envelope.type) {
    case "agent.hello": {
      if (!isRecord(envelope.payload) || !isRecord(envelope.payload.agent)) {
        send(socket, { type: "gateway.error", error: "invalid agent hello payload" });
        return;
      }
      acceptHello(socket, envelope.payload as unknown as AgentHelloPayload);
      return;
    }
    case "agent.heartbeat":
      if (!agentReady) return;
      lastHeartbeatAt = new Date().toISOString();
      broadcastToUi(statusMessage());
      return;
    case "agent.response": {
      const response = responsePayload(envelope as unknown as Record<string, unknown>);
      if (response?.id && response.response) resolvePending(response.id, response.response);
      return;
    }
    case "agent.event":
      broadcastToUi({ type: "agent.event", event: envelope.payload, requestId: envelope.requestId, taskId: envelope.taskId });
      return;
    default:
      // Device-to-central job/approval messages are reserved for the next
      // round; accepting them as no-ops would hide protocol mistakes.
      return;
  }
}

function acceptHello(socket: WebSocket, payload: AgentHelloPayload): void {
  if (!isRecord(payload.agent) || typeof payload.agent.version !== "string" || !Array.isArray(payload.agent.capabilities)) {
    send(socket, { type: "gateway.error", error: "invalid agent hello" });
    socket.close(1002, "invalid hello");
    return;
  }
  agentReady = true;
  agentHello = payload;
  lastHeartbeatAt = new Date().toISOString();
  send(
    socket,
    createEnvelope("agent.hello_ack", {
      accepted: true,
      server: "fake-central",
      capabilities: ["agent.request", "agent.response", "agent.heartbeat"],
      heartbeatIntervalMs: 10_000,
      protocolVersion: AGENTRPC_VERSION,
    }),
  );
  broadcastToUi(statusMessage());
}

function resolvePending(requestId: string, response: AgentRpcResponsePayload): void {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);
  pending.resolve({ ...response, id: response.id ?? requestId });
}

function rejectPendingForSocket(socket: WebSocket): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.socket !== socket) continue;
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.resolve({ ok: false, error: "Local Agent connection closed", errorCode: "AGENT_DISCONNECTED", retryable: true });
  }
}

function handleUiConnection(socket: WebSocket): void {
  uiClients.add(socket);
  send(socket, statusMessage());

  socket.on("message", (raw) => {
    const parsed = parseUiRequest(raw.toString());
    if (!parsed) {
      send(socket, { type: "gateway.error", error: "invalid UI message" });
      return;
    }
    const responseType = parsed.envelopeType === "app.request" || parsed.envelopeType === "app.tool_call" ? "app.response" : "agent.response";
    void worker.handle(parsed.request).then((response) => send(socket, { type: responseType, response }));
  });

  socket.on("close", () => {
    uiClients.delete(socket);
    for (const [requestId, pending] of pendingRequests) {
      if (pending.socket === socket) {
        clearTimeout(pending.timer);
        pendingRequests.delete(requestId);
      }
    }
  });
}

function parseUiRequest(raw: string): { envelopeType: string; request: FakeAppServerRequest } | undefined {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || typeof message.type !== "string") return undefined;
  if (message.type !== "agent.request" && message.type !== "app.request" && message.type !== "app.tool_call") return undefined;
  const requestValue = isRecord(message.request) ? message.request : message;
  if (message.type === "app.request" || message.type === "app.tool_call") {
    if (!isRecord(requestValue) || typeof requestValue.id !== "string") {
      return undefined;
    }
    const method = typeof requestValue.method === "string" ? requestValue.method : typeof requestValue.tool === "string" ? requestValue.tool : undefined;
    if (!method) return undefined;
    const params = isRecord(requestValue.params)
      ? requestValue.params
      : isRecord(requestValue.arguments)
        ? requestValue.arguments
        : {};
    return {
      envelopeType: message.type,
      request:
        message.type === "app.tool_call"
          ? { id: requestValue.id, method: "tool/call", params: { tool: method, arguments: params } }
          : { id: requestValue.id, method, params },
    };
  }
  const request = legacyRequestFrom(requestValue);
  if (!request) return undefined;
  return { envelopeType: message.type, request };
}

function handleAgentConnection(socket: WebSocket): void {
  if (agentSocket?.readyState === WebSocket.OPEN) {
    socket.close(1013, "only one Local Agent is supported by this Spike");
    return;
  }

  agentSocket = socket;
  agentReady = false;
  agentHello = undefined;
  lastHeartbeatAt = undefined;
  socket.on("message", (raw) => handleAgentMessage(socket, raw));
  socket.on("close", () => {
    rejectPendingForSocket(socket);
    if (agentSocket === socket) {
      agentSocket = undefined;
      agentReady = false;
      agentHello = undefined;
      lastHeartbeatAt = undefined;
      broadcastToUi(statusMessage());
    }
  });
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(statusMessage()));
    return;
  }
  if (request.url === "/worker/status") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(worker.status()));
    return;
  }
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "not found" }));
});

const websocketServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
  if (path !== "/ws/ui" && path !== "/ws/agent") {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    if (path === "/ws/ui") handleUiConnection(websocket);
    else handleAgentConnection(websocket);
  });
});

server.listen(port, host, () => {
  console.log(`Fake Central listening on http://${host}:${port} (worker=${worker.workerId})`);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
