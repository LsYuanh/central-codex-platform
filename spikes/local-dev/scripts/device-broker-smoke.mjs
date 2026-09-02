// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { WebSocket } from "ws";

const gatewayUrl = process.env.DEVICE_GATEWAY_URL ?? "ws://127.0.0.1:4510/ws";
const agentUrl = process.env.DEVICE_AGENT_URL ?? gatewayUrl.replace(/\/ws(?:\?.*)?$/, "/ws/agent");
const workspaceRoot = resolve(process.env.DEVICE_WORKSPACE_ROOT ?? "fixtures/workspace");
const allowInsecureLan = process.env.ALLOW_INSECURE_LAN === "1" || !/^ws:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(agentUrl);
const agentArgs = ["--workspace-root", workspaceRoot, "--gateway-url", agentUrl, ...(allowInsecureLan ? ["--allow-insecure-lan"] : [])];

const agent = spawn(
  process.env.LOCAL_AGENT_BIN ?? "cargo",
  process.env.LOCAL_AGENT_BIN
    ? agentArgs
    : ["run", "-p", "local-agent", "--", ...agentArgs],
  { stdio: "inherit", windowsHide: true },
);

const ui = new WebSocket(gatewayUrl);
let nextRequestId = 1;
const pending = new Map();
let agentOnlineResolve;
const agentOnline = new Promise((resolvePromise) => { agentOnlineResolve = resolvePromise; });

ui.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "device.status" && message.agent === "online") agentOnlineResolve();
  if (message.type === "response" && typeof message.requestId === "string") {
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    message.ok === false ? request.reject(new Error(message.error ?? "gateway request failed")) : request.resolve(message.data);
  }
});

function request(operation, payload) {
  const requestId = `device-smoke-${nextRequestId++}`;
  return new Promise((resolvePromise, reject) => {
    pending.set(requestId, { resolve: resolvePromise, reject });
    ui.send(JSON.stringify({ type: "request", requestId, operation, payload }));
  });
}

try {
  await new Promise((resolvePromise, reject) => {
    ui.once("open", resolvePromise);
    ui.once("error", reject);
  });
  await Promise.race([
    agentOnline,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Local Agent did not connect within 20 seconds")), 20_000)),
  ]);

  const listed = await request("device.workspace.list", { path: "." });
  if (!listed?.ok || !listed.result?.entries?.some((entry) => entry.name === "README.md")) throw new Error(`workspace/list failed: ${JSON.stringify(listed)}`);
  const file = await request("device.read_file", { path: "README.md" });
  if (!file?.ok || !String(file.result?.content ?? "").includes("安全测试工作区")) throw new Error(`read_file failed: ${JSON.stringify(file)}`);
  const command = await request("device.exec", { program: "git", args: ["--version"], cwd: "." });
  if (!command?.ok || command.result?.exitCode !== 0) throw new Error(`exec failed: ${JSON.stringify(command)}`);
  console.log("DEVICE_BROKER_SMOKE_OK");
} finally {
  ui.close();
  agent.kill();
}
