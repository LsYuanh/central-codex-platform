// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import { WebSocket, WebSocketServer } from "ws";

try {
  loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
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
const pendingRequests = new Map<string, WebSocket>();

let agentSocket: WebSocket | undefined;
let lastHeartbeatAt: string | undefined;

interface AgentRequest {
  id: string;
  method: "workspace/list" | "read_file" | "exec";
  params: Record<string, unknown>;
}

interface Envelope {
  type: string;
  [key: string]: unknown;
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToUi(message: unknown): void {
  for (const socket of uiClients) {
    send(socket, message);
  }
}

function statusMessage(): unknown {
  return {
    type: "gateway.status",
    gateway: "online",
    agent: agentSocket?.readyState === WebSocket.OPEN ? "online" : "offline",
    lastHeartbeatAt,
  };
}

function parseEnvelope(raw: WebSocket.RawData): Envelope | undefined {
  try {
    const parsed = JSON.parse(raw.toString()) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return undefined;
    }
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" ? (parsed as Envelope) : undefined;
  } catch {
    return undefined;
  }
}

function parseAgentRequest(message: Envelope): AgentRequest | undefined {
  if (message.type !== "agent.request" || typeof message.request !== "object" || message.request === null) {
    return undefined;
  }

  const request = message.request as Partial<AgentRequest>;
  const methods = new Set(["workspace/list", "read_file", "exec"]);
  if (
    typeof request.id !== "string" ||
    !request.id ||
    typeof request.method !== "string" ||
    !methods.has(request.method) ||
    typeof request.params !== "object" ||
    request.params === null
  ) {
    return undefined;
  }

  return request as AgentRequest;
}

function handleUiConnection(socket: WebSocket): void {
  uiClients.add(socket);
  send(socket, statusMessage());

  socket.on("message", (raw) => {
    const message = parseEnvelope(raw);
    const request = message ? parseAgentRequest(message) : undefined;
    if (!request) {
      send(socket, { type: "gateway.error", error: "invalid UI message" });
      return;
    }

    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      send(socket, {
        type: "agent.response",
        response: { id: request.id, ok: false, error: "Local Agent is offline" },
      });
      return;
    }

    pendingRequests.set(request.id, socket);
    send(agentSocket, { type: "agent.request", request });
  });

  socket.on("close", () => {
    uiClients.delete(socket);
    for (const [requestId, pendingSocket] of pendingRequests) {
      if (pendingSocket === socket) {
        pendingRequests.delete(requestId);
      }
    }
  });
}

function handleAgentConnection(socket: WebSocket): void {
  if (agentSocket?.readyState === WebSocket.OPEN) {
    socket.close(1013, "only one Local Agent is supported by this Spike");
    return;
  }

  agentSocket = socket;
  lastHeartbeatAt = new Date().toISOString();
  broadcastToUi(statusMessage());

  socket.on("message", (raw) => {
    const message = parseEnvelope(raw);
    if (!message) {
      return;
    }

    if (message.type === "agent.heartbeat" || message.type === "agent.hello") {
      lastHeartbeatAt = new Date().toISOString();
      broadcastToUi(statusMessage());
      return;
    }

    if (message.type === "agent.response" && typeof message.response === "object" && message.response !== null) {
      const response = message.response as { id?: unknown };
      if (typeof response.id !== "string") {
        return;
      }
      const uiSocket = pendingRequests.get(response.id);
      if (uiSocket) {
        send(uiSocket, message);
        pendingRequests.delete(response.id);
      }
    }
  });

  socket.on("close", () => {
    if (agentSocket === socket) {
      agentSocket = undefined;
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
    if (path === "/ws/ui") {
      handleUiConnection(websocket);
    } else {
      handleAgentConnection(websocket);
    }
  });
});

server.listen(port, host, () => {
  console.log(`Fake Central listening on http://${host}:${port}`);
});
