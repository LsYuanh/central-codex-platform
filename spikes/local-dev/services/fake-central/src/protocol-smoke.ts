// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import assert from "node:assert/strict";
import { createEnvelope, validateEnvelope } from "@central-codex-spike/agentrpc-types";
import { RemoteWorkspaceBridge } from "./bridge.js";
import { FakeAppServerWorker } from "./fake-app-server.js";

const request = createEnvelope(
  "agent.request",
  { method: "read_file", params: { path: "README.md" }, operationId: "op-1" },
  { requestId: "req-1", taskId: "task-1", traceId: "trace-1" },
);
assert.equal(validateEnvelope(request), undefined);
assert.equal(validateEnvelope({ ...request, version: 2 })?.code, "unsupported_version");
assert.equal(validateEnvelope({ ...request, requestId: undefined })?.code, "missing_field");
assert.equal(validateEnvelope({ ...request, payload: { method: "not-allowed", params: {} } })?.code, "invalid_envelope");

const streamEvent = createEnvelope(
  "agent.event",
  { stream: "stdout", sequence: 1, chunk: "building…\n", done: false },
  { requestId: "req-1", taskId: "task-1" },
);
assert.equal(validateEnvelope(streamEvent), undefined);
assert.equal(validateEnvelope({ ...streamEvent, requestId: undefined })?.code, "missing_field");
assert.equal(validateEnvelope({ ...streamEvent, payload: { stream: "stdout", sequence: 0 } })?.code, "invalid_envelope");

const bridge = new RemoteWorkspaceBridge(async (method, params) => ({
  ok: true,
  result: { method, params, fixture: true },
}));
const worker = new FakeAppServerWorker(bridge, "worker-test", "user-test");
const thread = await worker.handle({ id: "start", method: "thread/start", params: {} });
assert.equal(thread.ok, true);
const threadId = (thread.result as { threadId: string }).threadId;
const turn = await worker.handle({
  id: "turn",
  method: "turn/start",
  params: { threadId, tool: "fs/read_file", arguments: { path: "README.md" } },
});
assert.equal(turn.ok, true);
assert.equal((turn.result as { response: { result: { fixture: boolean } } }).response.result.fixture, true);

const denied = await bridge.callTool("fs/read_file", { path: "README.md", deviceId: "other-device" });
assert.equal(denied.ok, false);
assert.equal(denied.errorCode, "FORBIDDEN_SCOPE");
console.log("AgentRPC protocol smoke passed: envelope validation and worker bridge");
