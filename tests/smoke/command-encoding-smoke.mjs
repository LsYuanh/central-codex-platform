// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Windows Agent + real gateway. No model turn and no encoding workaround
// in the default PowerShell/cmd cases that originally produced garbled output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { localAgentExecutable } from "./client-smoke-platform.mjs";

if (process.platform !== "win32") throw new Error("Run this Windows encoding acceptance probe on a Windows client");
const temp = mkdtempSync(join(tmpdir(), "codexia-command-encoding-"));
const root = join(temp, "中文工作区"); mkdirSync(root);
const deviceId = `encoding-smoke-${randomUUID()}`;
const url = new URL(process.env.DEVICE_GATEWAY_URL ?? "ws://192.0.2.10:4510/ws");
url.searchParams.set("userId", deviceId); url.searchParams.set("deviceId", deviceId);
const agentUrl = new URL(url); agentUrl.pathname = "/ws/agent";
const agent = spawn(localAgentExecutable(), ["--workspace-root", root, "--gateway-url", agentUrl.href, "--allow-insecure-lan"], { stdio:"ignore", windowsHide:true, detached:true });
const socket = new WebSocket(url);
const pending = new Map(); let next = 0; let onlineResolve;
const online = new Promise(resolve => { onlineResolve = resolve; });
let abort;
const aborted = new Promise((_, reject) => { abort = reject; });
const deadline = setTimeout(() => abort(new Error("COMMAND_ENCODING_SMOKE_TIMEOUT")), 45000);
socket.on("error", abort); agent.on("error", abort);
socket.on("message", raw => {
  const message = JSON.parse(String(raw));
  if (message.type === "device.status" && message.agent === "online") onlineResolve();
  const handler = pending.get(message.requestId);
  if (message.type === "response" && handler) {
    pending.delete(message.requestId);
    message.ok ? handler.resolve(message.data) : handler.reject(new Error(message.error));
  }
});
const request = payload => new Promise((resolve, reject) => {
  const requestId = String(++next); pending.set(requestId, {resolve, reject});
  socket.send(JSON.stringify({type:"request", requestId, operation:"device.exec", payload:{...payload, cwd:"."}}));
});
const powershell = command => request({program:"powershell", args:["-NoProfile", "-Command", command]});
try {
  await Promise.race([aborted, (async () => {
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); agent.once("error", reject); });
  await online;
  const cwd = await powershell("(Get-Location).Path");
  assert(cwd.ok, JSON.stringify(cwd)); assert.equal(cwd.result.stdout.trim().toLowerCase(), root.toLowerCase());
  const streams = await powershell("[Console]::Write('中文输出'); [Console]::Error.Write('中文错误')");
  assert.equal(streams.result.stdout, "中文输出"); assert.equal(streams.result.stderr, "中文错误");
  const legacy = await powershell("[Console]::OutputEncoding=[Text.Encoding]::GetEncoding((Get-WinSystemLocale).TextInfo.OEMCodePage); [Console]::Write('中文输出'); [Console]::Error.Write('中文错误')");
  assert.equal(legacy.result.stdout, "中文输出"); assert.equal(legacy.result.stderr, "中文错误");
  const cmd = await request({program:process.env.ComSpec ?? "cmd.exe", args:["/d", "/c", "echo 中文命令"]});
  assert.equal(cmd.result.stdout.trim(), "中文命令");
  const failed = await powershell("[Console]::Error.Write('失败中文'); exit 3");
  assert.equal(failed.ok, false); assert.match(failed.error, /COMMAND_FAILED.*失败中文/);
  const utf8 = await powershell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Console]::Write('中文🙂')");
  assert.equal(utf8.result.stdout, "中文🙂");
  const utf16 = await powershell("$bytes=[Text.Encoding]::Unicode.GetPreamble()+[Text.Encoding]::Unicode.GetBytes('中文🙂'); [Console]::OpenStandardOutput().Write($bytes,0,$bytes.Length)");
  assert.equal(utf16.result.stdout, "中文🙂");
  const large = await powershell("[Console]::Write(('中' * 40000))");
  assert.equal(large.result.truncated, true); assert.match(large.result.stdout, /^中+$/);
  assert(Buffer.byteLength(large.result.stdout) <= 64 * 1024);
  const page = await powershell("[Console]::OutputEncoding.CodePage");
  const oem = await powershell("(Get-WinSystemLocale).TextInfo.OEMCodePage");
  console.log(JSON.stringify({result:"COMMAND_ENCODING_SMOKE_OK",codePage:page.result.stdout.trim(),oemCodePage:oem.result.stdout.trim(),chineseCwd:true,stdout:true,stderr:true,legacyStreams:true,cmd:true,commandFailure:true,utf8Emoji:true,utf16Bom:true,boundedUnicode:true}));
  })()]);
} finally {
  clearTimeout(deadline); socket.close(); agent.kill();
  if (!temp.startsWith(join(tmpdir(), "codexia-command-encoding-"))) throw new Error("Refusing to clean an unexpected fixture path");
  rmSync(temp, {recursive:true, force:true});
}
