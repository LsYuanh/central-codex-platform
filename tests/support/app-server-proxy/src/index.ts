// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const listenHost = process.env.APP_SERVER_PROXY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.APP_SERVER_PROXY_PORT ?? 4501);
const targetUrl = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500";

const httpServer = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }
  response.writeHead(404);
  response.end();
});

const websocketServer = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/" && request.url !== "/ws") {
    socket.destroy();
    return;
  }

  websocketServer.handleUpgrade(request, socket, head, (client) => {
    proxyConnection(client);
  });
});

function proxyConnection(client: WebSocket): void {
  const upstream = new WebSocket(targetUrl);
  const queuedMessages: string[] = [];
  let clientClosed = false;

  client.on("message", (data) => {
    const message = toText(data);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
    else if (upstream.readyState === WebSocket.CONNECTING) queuedMessages.push(message);
  });

  upstream.on("open", () => {
    for (const message of queuedMessages.splice(0)) upstream.send(message);
  });
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(toText(data));
  });
  upstream.on("error", () => {
    if (!clientClosed && client.readyState === WebSocket.OPEN) client.close(1011, "App Server upstream unavailable");
  });
  upstream.on("close", (code, reason) => {
    if (!clientClosed && client.readyState === WebSocket.OPEN) client.close(code || 1000, reason);
  });

  client.on("close", () => {
    clientClosed = true;
    upstream.close();
  });
  client.on("error", () => upstream.close());
}

function toText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

httpServer.listen(listenPort, listenHost, () => {
  console.log(`App Server proxy listening on ws://${listenHost}:${listenPort} -> ${targetUrl}`);
});
