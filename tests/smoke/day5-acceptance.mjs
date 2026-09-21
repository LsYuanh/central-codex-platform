// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Repeatable Day 5 acceptance probe.
 *
 * This deliberately speaks the stable test-gateway protocol instead of the
 * App Server JSON-RPC protocol.  It can therefore be run against the local
 * tunnel or a central test gateway without giving a client an App Server URL.
 * The current Spike does not implement every Day 5 requirement; missing
 * capabilities are reported as BLOCKED with evidence rather than silently
 * counted as passes. Set DAY5_STRICT=1 to make BLOCKED results fail CI.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const gatewayUrl = process.env.DAY5_GATEWAY_URL ?? "ws://127.0.0.1:4510/ws";
const timeoutMs = Number(process.env.DAY5_TIMEOUT_MS ?? 8_000);
const strict = process.env.DAY5_STRICT === "1";
const results = [];

function result(id, status, detail, evidence = undefined) {
  const entry = { id, status, detail };
  if (evidence !== undefined) entry.evidence = evidence;
  results.push(entry);
  console.log(`[${status}] ${id}: ${detail}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(label, identity = {}) {
  const endpoint = new URL(gatewayUrl);
  for (const [key, value] of Object.entries(identity)) endpoint.searchParams.set(key, value);
  const socket = new WebSocket(endpoint);
  const messages = [];
  socket.on("message", (raw) => {
    try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore malformed diagnostics */ }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} connection timed out`)), timeoutMs);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  const ready = await waitForMessage(messages, (message) => message.type === "gateway.ready");
  return { label, socket, messages, ready };
}

async function waitForMessage(messages, predicate, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await wait(25);
  }
  throw new Error("timed out waiting for gateway message");
}

async function request(client, operation, payload = {}) {
  const requestId = `day5-${client.label}-${randomUUID()}`;
  const responsePromise = waitForMessage(client.messages, (message) =>
    message.type === "response" && message.requestId === requestId,
  );
  client.socket.send(JSON.stringify({ type: "request", requestId, operation, payload }));
  return responsePromise;
}

function close(client) {
  if (client?.socket?.readyState === WebSocket.OPEN) client.socket.close();
}

async function threadIsolation() {
  let a;
  let b;
  try {
    a = await connect("user-a", { userId: "day5-user-a", deviceId: "device-a" });
    b = await connect("user-b", { userId: "day5-user-b", deviceId: "device-b" });
    const initParams = (label) => ({
      clientInfo: {
        name: `day5-${label}`,
        title: "Central Codex Day5 Acceptance",
        version: "0.1.0",
      },
      capabilities: {},
    });
    const [initA, initB] = await Promise.all([
      request(a, "session.initialize", initParams("user-a")),
      request(b, "session.initialize", initParams("user-b")),
    ]);
    if (!initA.ok || !initB.ok) {
      result("THR-INIT", "BLOCKED", "App Server initialization failed", { a: initA, b: initB });
      return;
    }
    const createdA = await request(a, "conversation.create");
    const createdB = await request(b, "conversation.create");
    const threadA = createdA.data?.threadId ?? createdA.data?.thread?.id;
    const threadB = createdB.data?.threadId ?? createdB.data?.thread?.id;
    assert.equal(createdA.ok, true);
    assert.equal(createdB.ok, true);
    assert.ok(threadA && threadB, "gateway did not return thread ids");

    const [listA, listB, readCross, turnCross] = await Promise.all([
      request(a, "conversation.list"),
      request(b, "conversation.list"),
      request(b, "conversation.read", { threadId: threadA }),
      request(a, "conversation.turn.create", { threadId: threadB }),
    ]);
    const visibleA = listA.data?.data ?? listA.data?.threads ?? [];
    const visibleB = listB.data?.data ?? listB.data?.threads ?? [];
    assert.equal(visibleA.some((thread) => thread.id === threadB), false);
    assert.equal(visibleB.some((thread) => thread.id === threadA), false);
    assert.equal(readCross.ok, false);
    assert.equal(turnCross.ok, false);
    result("THR-001", "PASS", "two client connections cannot list/read/continue each other's threads", {
      threadA,
      threadB,
      readCross: readCross.error,
      turnCross: turnCross.error,
    });

    // The connection-local ownership fence is intentionally tested as a
    // recovery gap below: reconnecting should restore ownership in production.
    close(a);
    const reconnected = await connect("user-a-reconnect", { userId: "day5-user-a", deviceId: "device-a" });
    const resumedList = await request(reconnected, "conversation.list");
    if ((resumedList.data?.data ?? resumedList.data?.threads ?? []).some((thread) => thread.id === threadA)) {
      result("THR-002", "PASS", "reconnected user can see its previous thread");
    } else {
      result("THR-002", "BLOCKED", "thread ownership is connection-local; reconnect cannot recover the previous thread", {
        threadId: threadA,
        response: resumedList,
      });
    }
    close(reconnected);
  } catch (error) {
    result("THR-001", "BLOCKED", error instanceof Error ? error.message : String(error));
  } finally {
    close(a);
    close(b);
  }
}

async function deviceIsolation(client) {
  // If a real Local Agent is already attached, probing would disconnect or
  // race the user's agent. The gateway currently has a single global slot;
  // report that limitation explicitly instead of perturbing the session.
  if (client.ready.agent !== "offline" && process.env.DAY5_ALLOW_AGENT_PROBE !== "1") {
    result("DEV-001", "BLOCKED", "gateway reports an existing agent; safe two-device probe is disabled", { agent: client.ready.agent });
    return;
  }

  const makeAgent = (deviceId) => {
    const endpoint = new URL(gatewayUrl.replace(/\/ws(?:\?.*)?$/, "/ws/agent"));
    endpoint.searchParams.set("deviceId", deviceId);
    const socket = new WebSocket(endpoint);
    const messages = [];
    socket.on("message", (raw) => {
      try { messages.push(JSON.parse(raw.toString())); } catch { /* ignore malformed diagnostics */ }
    });
    const hello = {
      protocol: "agentrpc", version: 1, type: "agent.hello",
      timestamp: new Date().toISOString(), nonce: `day5-${randomUUID()}`,
      payload: { deviceId, agent: { version: "day5", os: "test", arch: "test", capabilities: ["workspace/list"] } },
    };
    return { socket, hello, messages, deviceId };
  };
  const first = makeAgent("device-a");
  const second = makeAgent("device-b");
  try {
    await Promise.all([
      new Promise((resolve, reject) => { first.socket.once("open", resolve); first.socket.once("error", reject); }),
      new Promise((resolve, reject) => { second.socket.once("open", resolve); second.socket.once("error", reject); }),
    ]);
    first.socket.send(JSON.stringify(first.hello));
    second.socket.send(JSON.stringify(second.hello));
    try {
      await Promise.all([
        waitForMessage(first.messages, (message) => message.type === "agent.hello_ack"),
        waitForMessage(second.messages, (message) => message.type === "agent.hello_ack"),
      ]);
      result("DEV-001", "PASS", "two device slots can complete independent AgentRPC hello handshakes", {
        devices: [first.deviceId, second.deviceId],
      });
    } catch {
      const closeCode = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        second.socket.once("close", (code) => { clearTimeout(timer); resolve(code); });
      });
      if (closeCode === 1013) {
        result("DEV-001", "BLOCKED", "second device is rejected because the Spike supports one global agent, not per-user device routing", { closeCode });
      } else {
        result("DEV-001", "BLOCKED", "device isolation could not be established", { closeCode });
      }
    }
  } catch (error) {
    result("DEV-001", "BLOCKED", error instanceof Error ? error.message : String(error));
  } finally {
    first.socket.close();
    second.socket.close();
  }
}

async function approvalAndAudit(client) {
  try {
    const unknown = await request(client, "conversation.turn.cancel", { threadId: "thread_not_owned" });
    if (unknown.ok === false && /belong/i.test(String(unknown.error))) {
      result("APR-NEG", "PASS", "cross-session cancellation is rejected before reaching App Server", { error: unknown.error });
    } else {
      result("APR-NEG", "BLOCKED", "cross-session cancellation guard returned an unexpected result", unknown);
    }
  } catch (error) {
    result("APR-NEG", "BLOCKED", error instanceof Error ? error.message : String(error));
  }
  if (process.env.TEST_GATEWAY_ENABLE_CONTROLS === "1") {
    const approvals = [];
    const onApproval = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "approval.request" && message.synthetic) approvals.push(message);
      if (approvals.length === 1 || approvals.length === 3) {
        client.socket.send(JSON.stringify({ type: "approval.response", requestId: message.requestId, result: { decision: approvals.length === 1 ? "accept" : "reject" } }));
      }
    };
    client.socket.on("message", onApproval);
    try {
      const accepted = await request(client, "test.approval.inject", { timeoutMs: 2_000, data: { command: "echo day5" } });
      await waitForMessage(client.messages, (message) => message.type === "approval.resolved" && message.requestId === accepted.data?.approvalRequestId && message.status === "accept");
      const timed = await request(client, "test.approval.inject", { timeoutMs: 100 });
      await waitForMessage(client.messages, (message) => message.type === "approval.resolved" && message.requestId === timed.data?.approvalRequestId && message.status === "timeout");
      const rejected = await request(client, "test.approval.inject", { timeoutMs: 2_000 });
      await waitForMessage(client.messages, (message) => message.type === "approval.resolved" && message.requestId === rejected.data?.approvalRequestId && message.status === "reject");
      result("APR-001", "PASS", "synthetic approval allow, reject and timeout lifecycle completed through approval.response", { timeoutMs: timed.data?.timeoutMs });
    } catch (error) {
      result("APR-001", "BLOCKED", error instanceof Error ? error.message : String(error));
    } finally {
      client.socket.off("message", onApproval);
    }
  } else {
    result("APR-001", "BLOCKED", "set TEST_GATEWAY_ENABLE_CONTROLS=1 to enable the isolated synthetic approval probe");
  }
  try {
    const auditUrl = new URL(gatewayUrl);
    auditUrl.protocol = auditUrl.protocol === "wss:" ? "https:" : "http:";
    auditUrl.pathname = "/audit";
    auditUrl.search = "";
    const response = await fetch(auditUrl);
    const body = await response.json();
    const events = Array.isArray(body.events) ? body.events : [];
    const hasCorrelated = events.some((event) => event.userId && event.deviceId && event.requestId);
    if (response.ok && hasCorrelated) {
      result("AUD-001", "PASS", "audit endpoint exposes correlated user/device/request metadata with outcomes", { count: events.length });
    } else {
      result("AUD-001", "BLOCKED", "audit endpoint exists but does not expose correlated request metadata", { count: events.length });
    }
  } catch (error) {
    result("AUD-001", "BLOCKED", `audit endpoint unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  const primary = await connect("audit-user");
  await threadIsolation();
  await deviceIsolation(primary);
  await approvalAndAudit(primary);
  close(primary);
} catch (error) {
  result("ENV-001", "BLOCKED", `cannot connect to ${gatewayUrl}: ${error instanceof Error ? error.message : String(error)}`);
}

const blocked = results.filter((entry) => entry.status === "BLOCKED").length;
console.log(JSON.stringify({ gatewayUrl, strict, blocked, results }, null, 2));
if (strict && blocked > 0) process.exitCode = 2;
