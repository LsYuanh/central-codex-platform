// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEntry = path.join(spikeRoot, "services", "fake-central", "dist", "index.js");
const agentExecutable = path.join(spikeRoot, "target", "debug", "local-agent.exe");
const workspaceRoot = path.join(spikeRoot, "fixtures", "workspace");
const children = [];

function start(command, args) {
  const child = spawn(command, args, {
    cwd: spikeRoot,
    env: process.env,
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
      const response = await fetch("http://127.0.0.1:4310/health");
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
  const socket = new WebSocket("ws://127.0.0.1:4310/ws/ui");
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

function request(socket, method, params) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`${method} timed out`));
    }, 5_000);

    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== "agent.response" || message.response?.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message.response);
    };

    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ type: "agent.request", request: { id, method, params } }));
  });
}

try {
  start(process.execPath, [gatewayEntry]);
  start(agentExecutable, [
    "--workspace-root",
    workspaceRoot,
    "--gateway-url",
    "ws://127.0.0.1:4310/ws/agent",
  ]);
  await waitForAgent();

  const socket = await openUiSocket();
  const listing = await request(socket, "workspace/list", { path: "." });
  assert.equal(listing.ok, true);
  assert.ok(listing.result.entries.some((entry) => entry.name === "README.md"));

  const file = await request(socket, "read_file", { path: "README.md" });
  assert.equal(file.ok, true);
  assert.match(file.result.content, /安全测试工作区/);

  const command = await request(socket, "exec", { program: "git", args: ["--version"], cwd: "." });
  assert.equal(command.ok, true);
  assert.equal(command.result.exitCode, 0);
  assert.match(command.result.stdout, /git version/i);

  const traversal = await request(socket, "read_file", { path: "../README.md" });
  assert.equal(traversal.ok, false);
  assert.match(traversal.error, /forbidden/);

  const deniedCommand = await request(socket, "exec", {
    program: "powershell",
    args: ["-Command", "Get-Location"],
    cwd: ".",
  });
  assert.equal(deniedCommand.ok, false);
  assert.match(deniedCommand.error, /only permits/);

  socket.close();
  console.log("Integration smoke passed: list, read, exec, traversal denial, command denial");
} finally {
  for (const child of children.reverse()) {
    child.kill();
  }
}
