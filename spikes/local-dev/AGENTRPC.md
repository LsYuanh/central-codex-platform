<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# Local AgentRPC / Fake App Server round 1

This round establishes the smallest versioned device protocol needed by the
local vertical Spike. It is a platform-owned contract and must not be confused
with, or exposed as, the Codex App Server protocol.

```text
UI WebSocket (/ws/ui)
    -> Fake App Server Worker (per-user in-memory stand-in)
    -> Remote Workspace Bridge (tool/policy boundary)
    -> Device Broker (pending request + timeout)
    -> AgentRPC WebSocket (/ws/agent)
    -> Rust Local Agent (workspace sandbox)
```

## Envelope

Every device frame has the following fields:

```json
{
  "protocol": "agentrpc",
  "version": 1,
  "type": "agent.request",
  "timestamp": "2026-09-01T12:00:00.000Z",
  "nonce": "…",
  "requestId": "…",
  "taskId": "…",
  "traceId": "…",
  "payload": {
    "method": "read_file",
    "params": { "path": "README.md" },
    "operationId": "…",
    "idempotencyKey": "…"
  }
}
```

`requestId` is required for request/response correlation. A retry of a
side-effecting operation reuses `operationId` and `idempotencyKey`; the first
round does not retry writes automatically. `nonce`, timestamp, and the fixed
version provide the hooks for replay and downgrade checks in the mTLS broker.
The current local implementation caps a frame at 1 MiB.

Supported first-round device methods are `workspace/list`, `read_file`, and the
existing safe `exec` version command. The schema also reserves names for the
next file/process/Git round; the bridge returns `NOT_IMPLEMENTED` for those
instead of silently widening the Local Agent permission surface.

## Fake App Server worker

`FakeAppServerWorker` is an in-memory per-user worker. It implements
`initialize`, `thread/start`, `turn/start`, `tool/call`, and a small set of
direct tool aliases. `turn/start` with a `tool` exercises the complete worker →
bridge → AgentRPC path. The worker never starts Codex, reads `CODEX_HOME`, or
uses OpenAI credentials. `/worker/status` exposes only health metadata for
local tests.

The UI may send the old Stage 1 `agent.request` frame; Fake Central normalizes
it at the UI boundary. No legacy frame is sent across the AgentRPC device
connection.

## Test-gateway isolation probe

The development test gateway binds a WebSocket client principal from query
parameters (`/ws?userId=user-a&deviceId=device-a`). These values stand in for
the authenticated platform session and device certificate in the Spike only;
production must derive them from the access token and mTLS identity. Agent
connections use the matching `/ws/agent?deviceId=device-a` parameter and must
repeat the same `deviceId` in `agent.hello` when present. Thread ownership is
retained for the lifetime of the gateway process, so reconnecting with the
same `userId` can recover its previous Thread list. `/audit` exposes the
redacted in-memory audit records for acceptance probes.

When `TEST_GATEWAY_ENABLE_CONTROLS=1` is set, the UI WebSocket also accepts
`test.approval.inject` with `{method?, data?, timeoutMs?}`. It emits a synthetic
`approval.request` and completes through the normal `approval.response` path;
`timeoutMs` is clamped to 100–10,000 ms. This operation never writes to Codex
App Server stdin and is disabled by default, so it is only a Day 5 test hook.
