// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { localAgentExecutable, locationCommand, streamingCommand } from "./client-smoke-platform.mjs";

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEntry = path.join(spikeRoot, "services", "fake-central", "dist", "index.js");
const agentExecutable = localAgentExecutable(spikeRoot);
const workspaceRoot = path.join(spikeRoot, "fixtures", "workspace");
const children = [];
const port = await findFreePort(Number(process.env.SMOKE_PORT ?? "4310"));
const gatewayUrl = `ws://127.0.0.1:${port}/ws/agent`;
const healthUrl = `http://127.0.0.1:${port}/health`;
const uiUrl = `ws://127.0.0.1:${port}/ws/ui`;

function start(command, args) {
  const child = spawn(command, args, {
    cwd: spikeRoot,
    env: { ...process.env, CENTRAL_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function waitForAgent() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      const status = await response.json();
      if (status.agent === "online") return;
    } catch {
      // The gateway may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Local Agent did not connect within 15 seconds");
}

async function openUiSocket() {
  const socket = new WebSocket(uiUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("UI WebSocket timed out")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

function request(socket, method, params, envelopeType = "agent.request", responseType = "agent.response") {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`${method} timed out`));
    }, 5_000);

    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== responseType || message.response?.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message.response);
    };

    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ type: envelopeType, request: { id, method, params } }));
  });
}

try {
  start(process.execPath, [gatewayEntry]);
  start(agentExecutable, [
    "--workspace-root",
    workspaceRoot,
    "--gateway-url",
    gatewayUrl,
  ]);
  await waitForAgent();

  const socket = await openUiSocket();
  const initialized = await request(socket, "initialize", {}, "app.request", "app.response");
  assert.equal(initialized.ok, true);
  assert.equal(initialized.result.protocol, "fake-app-server");

  const thread = await request(socket, "thread/start", {}, "app.request", "app.response");
  assert.equal(thread.ok, true);
  assert.match(thread.result.threadId, /^thread_/);

  const bridgedFile = await request(
    socket,
    "turn/start",
    { threadId: thread.result.threadId, tool: "fs/read_file", arguments: { path: "README.md" } },
    "app.request",
    "app.response",
  );
  assert.equal(bridgedFile.ok, true);
  assert.equal(bridgedFile.result.response.ok, true);
  assert.match(bridgedFile.result.response.result.content, /安全测试工作区/);

  const listing = await request(socket, "workspace/list", { path: "." }, "app.request", "app.response");
  assert.equal(listing.ok, true);
  assert.ok(listing.result.entries.some((entry) => entry.name === "README.md"));

  const file = await request(socket, "read_file", { path: "README.md" });
  assert.equal(file.ok, true);
  assert.match(file.result.content, /安全测试工作区/);

  const command = await request(socket, "exec", { program: "git", args: ["--version"], cwd: "." });
  assert.equal(command.ok, true);
  assert.equal(command.result.exitCode, 0);
  assert.match(command.result.stdout, /git version/i);

  const streamEvents = [];
  const captureStream = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "agent.event") streamEvents.push(message.event);
  };
  socket.addEventListener("message", captureStream);
  const streamed = await request(socket, "exec", { ...streamingCommand, cwd: ".", timeoutMs: 5_000 });
  socket.removeEventListener("message", captureStream);
  assert.equal(streamed.ok, true);
  const streamedText = streamEvents.map((event) => event.chunk ?? "").join("");
  assert.match(streamedText, /stream-first/);
  assert.match(streamedText, /stream-error/);
  assert.match(streamedText, /stream-second/);
  assert.ok(streamEvents.some((event) => event.stream === "stderr"));
  assert.ok(streamEvents.some((event) => event.done === true));
  assert.deepEqual(streamEvents.map((event) => event.sequence), [...streamEvents.map((event) => event.sequence)].sort((left, right) => left - right));

  const traversal = await request(socket, "read_file", { path: "../README.md" });
  assert.equal(traversal.ok, false);
  assert.match(traversal.error, /forbidden/);

  const clientCommand = await request(socket, "exec", {
    ...locationCommand,
    cwd: ".",
  });
  // Exercise the native client's shell, while cwd remains workspace-bound.
  assert.equal(clientCommand.ok, true);
  assert.equal(clientCommand.result.exitCode, 0);
  assert.match(clientCommand.result.stdout, /fixtures[\\/]workspace/);
  const deniedCwd = await request(socket, "exec", { ...locationCommand, cwd: ".." });
  assert.equal(deniedCwd.ok, false);
  assert.match(deniedCwd.error, /forbidden/);

  socket.close();
  console.log("Integration smoke passed: list, read, streamed client shell, file/cwd traversal denial");
} finally {
  for (const child of children.reverse()) {
    child.kill();
  }
}

async function findFreePort(preferredPort) {
  for (let candidate = preferredPort; candidate < preferredPort + 100; candidate += 1) {
    const available = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (available) return candidate;
  }
  throw new Error(`no free smoke port in ${preferredPort}-${preferredPort + 99}`);
}
