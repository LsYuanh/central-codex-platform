<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# Local AgentRPC / Fake App Server round 1

## Live command execution (`exec-stream/v1`, 2026-09-04)

Agents advertising `exec-stream/v1` execute `exec` with piped stdout/stderr and emit bounded
`agent.event` frames before the final `agent.response`. Each event requires the original
`requestId`; `sequence` is strictly increasing across both streams so the gateway can reject
duplicates or reordering. Newline-terminated output is forwarded line by line. A partial line is
flushed after 250 ms and large lines are divided into frames no larger than 16 KiB of text.

```json
{
  "type": "agent.event",
  "requestId": "device-request-id",
  "taskId": "turn-id",
  "payload": {
    "stream": "stdout",
    "sequence": 4,
    "chunk": "Compiling local-agent v0.1.0\n",
    "done": false,
    "truncated": false
  }
}
```

Streaming is observational: the App Server tool call remains pending until exactly one final
`agent.response`. The Agent keeps at most 64 KiB per stream for that final response and forwards at
most 1 MiB per stream to the UI. It drains excess process output to avoid deadlock, emits
`truncated=true`, and does not persist raw command output in gateway audit records.

`timeoutMs` defaults to 30 minutes, is clamped to 1 second–2 hours by both gateway and Agent, and is
not reset merely because output arrives. `job.cancel` identifies the active request by `requestId`.
The Agent continues reading WebSocket frames and sending heartbeats while commands run, acknowledges
the cancellation, and terminates the process tree. Turn interruption cancels every matching active
device command before forwarding `turn/interrupt` upstream. A disconnect also cancels in-flight
local commands rather than leaving an orphan task.

The desktop renders gateway-owned `device/tool/started`, `device/tool/output`, and
`device/tool/completed` events in a separate execution card. Output never becomes assistant text.
Completed, failed, cancelled, timed-out and connection-unknown states are explicit. Older Agents
without `exec-stream/v1` retain final-response behavior and the UI labels the absence of live output.
Programs that buffer their own redirected stdout may still deliver late output; the Agent forwards
bytes promptly but cannot force another program to flush.

## Desktop configuration lifecycle (2026-09-03)

Desktop configuration is local Tauri control state, not a new gateway protocol.
`desktop_config`, `apply_desktop_config` and `select_workspace_directory` share the existing settings UI.
`attachment/identity` now also reports the canonical client `workspaceRoot`.
The inherited pipe adds **local-only** `runtime/prepare_restart`: it rejects active commands or live
attachment/output transfers with `AGENT_BUSY`, otherwise pauses admission for up to 10 seconds.
New requests during this lease return `AGENT_RECONFIGURING`. The bounded lease recovers automatically
if a reply is lost. No remote dynamic tool or inbound listener is added.
The desktop then replaces the Agent and its IPC together; configuration persistence failures restore
the prior Agent. UI also blocks switching during known Turns, unknown submission results and saves.

Packaged clients include the same Agent through Tauri `externalBin`; it remains managed through the
inherited pipe, with no shell plugin permissions added. `desktop_config` exposes the base gateway,
`userId`, `deviceId`, `workspaceRoot`, and the assembled UI/Agent endpoints. A fresh packaged install
prefills `userId` from the OS account name, `deviceId` from the computer name plus a persistent
installation UUID suffix, and `workspaceRoot` from the OS Documents directory plus
`Codexia Workspace`. All values remain editable. `needsSetup` remains true until the user saves this
first configuration, so prefilled values do not start the Agent, connect to the central gateway, or
create the directory. Saving the exact suggested workspace creates it if needed.

The persisted gateway is a base `/ws` URL without identity query values. The desktop URL adds both
encoded identity fields; the Agent URL adds only `deviceId`. Legacy saved URLs migrate their
`userId`/`deviceId` query values to the explicit fields and preserve existing identity/workspace
choices. App exit (including macOS application Quit) releases the child. Packaging does not change
the AgentRPC wire protocol.

## Command output decoding (2026-09-03)

Local Agent decodes stdout and stderr before returning `command/exec` results or
`COMMAND_FAILED`. Valid UTF-8 is preferred; UTF-8 and UTF-16LE/BE BOMs are recognized.
On Windows, non-UTF-8 output without a BOM falls back to the client's OEM code page
(`GetOEMCP`), using strict native conversion. Other systems retain UTF-8 decoding.
Each stream is bounded to 64 KiB of source and returned UTF-8 bytes, preserving whole
characters at truncation; success `truncated` also reports expansion beyond this cap.
This bounds response text, not the command's captured memory before decoding.
Custom/mixed encodings and UTF-16 without a BOM are not autodetected reliably.
No shell arguments, system code page, file-content contract or wire fields change.

## Output extension (`outputs/v1`, 2026-09-03)

All writes execute on Local Agent; the gateway only forwards data and retains output
metadata. The V1 envelope and 1 MiB frame limit are unchanged.

| Method | Parameters | Result |
|---|---|---|
| `file/output_paths` | none | Actual client downloads/Codexia, workspace, absolutePaths |
| `file/write_text` | `content`, `path` or `name`, optional `overwrite`, `expectedVersion` | Verified file metadata, SHA-256 (UTF-8 up to 256 KiB) |
| `file/write_begin` | `totalBytes`, `sha256`, `path` or `name`, optional overwrite/version/image | transferId, chunkBytes |
| `file/write_chunk` | transferId, offset, Base64 data | nextOffset; identical repeated chunk is accepted |
| `file/write_commit` | transferId | Length/hash verification, atomic commit, verified file metadata |
| `file/write_abort` | transferId | Idempotent closed=true |
| `file/copy` | sourcePath, path or name, optional overwrite/version | Verified destination metadata |
| `file/publish` | path | Metadata with verified=true and SHA-256 after actual client read |

Output files are limited to 20 MiB, chunks to 256 KiB, and active writes to four with
80 MiB reserved total. Idle transfers expire after 60 seconds. Image saves stop starting
new requests after 45 seconds, with the current bounded RPC and cleanup allowed to finish.
Conflicting existing destinations require overwrite=true and expectedVersion; matching
content is idempotent even after a lost commit response. Version checks use the existing
file size/mtime token; SHA-256 checks the transmitted and committed bytes.

Trusted LAN mode permits absolute client paths (including command cwd); relative paths
remain workspace-bound. UNC, drive-relative paths, parent traversal and nonregular write
targets are rejected. OS access failures are returned, never upgraded to success. Native
command nonzero exit codes return COMMAND_FAILED.

Local pipe only: `attachment/output_preview` creates a 960×720 JPEG preview;
`file/reveal` opens the containing folder. Local `file/read_image` permits output images
up to 20 MiB for the large preview; remote attachment input retains its 5 MiB limit.

App Server imageGeneration.result is consumed as inline image bytes; savedPath is never
read by this broker. `output/state` events and history `outputs` contain metadata only,
with saving/saved/failed states, source device ID/key and verified client paths. Native
image result/savedPath fields are stripped from UI history. The original device loads
preview bytes via IPC. `conversation.output.retry` retries a failed generated image from
App Server history; a gateway restart turns interrupted saves into retryable failures.

Dynamic tools: device_write_file, device_copy_file, device_publish_file,
device_output_paths and device_list_outputs. Older threads use device_exec with
program=codexia.files and args=[operation, JSON parameters]; supported operations are
write_text, copy, publish, paths and list_outputs. This reserved program is routed by the
gateway, never spawned as an executable. Both interfaces share device identity checks.

## Attachment extension (`attachments/v1`, 2026-09-03)

The wire envelope stays V1 and retains a **1 MiB** frame limit. New Agents advertise
`attachments/v1`, `file/stat`, `file/read_text`, `file/read_image`, `file/read_chunk`,
and `file/close_transfer`; the broker reports `AGENT_UPGRADE_REQUIRED` for unsupported
methods. `agent.deviceKey` identifies the client installation independently of the
configured device routing name. The desktop obtains its effective device ID through
inherited anonymous pipes. No client network listener is added.

| Method | Parameters | Result |
|---|---|---|
| `file/stat` | `path` | Canonical client path, name, kind, MIME, bytes, version, mtime, symlink flag |
| `file/read_text` | `path`, optional `offset`, `version` | UTF-8 `content`, byte `nextOffset`, `truncated`, `version` (64 KiB page) |
| `file/read_image` | `path`, optional `version` | `transferId`, `totalBytes`, `chunkBytes`, MIME, width, height, version |
| `file/read_chunk` | `transferId`, `offset` (256 KiB aligned) | Base64 `data`, offset, sequence, totalBytes, done |
| `file/close_transfer` | `transferId` | Idempotent `{closed:true}` |

Image streams are validated snapshots in bounded Agent memory; the file size/mtime
version is rechecked before each chunk. The gateway validates ID, byte count, sequence,
offset, canonical Base64 and final flag. It reserves at most four submissions until the
upstream request settles; per-turn source bytes are capped at 10 MiB. Base64/JSON and
runtime copies add overhead, so this is not a promise that RSS is only 40 MiB.
Transfers are closed in `finally`, explicitly canceled before `turn/start`, or expire
after 60 seconds idle. Read-only chunks may be retried; turns and writes are never
automatically retried on uncertain outcomes.

Existing relative workspace calls keep their old boundary. With the explicit trusted
LAN flag, attachment/output file methods and command cwd accept absolute local paths. Drive-relative
Windows paths, UNC input, missing files, non-files, unsupported encodings, image decode
errors, source changes and expired transfers return errors. Document parsing is not
implemented; binary files are not forced through UTF-8.

Local-only pipe methods are `attachment/identity`, `attachment/preview`,
`attachment/import_begin`, `attachment/import_chunk`, `attachment/import_commit`.
Import chunks use the same 256 KiB limit. Only Agent creates clipboard files, and only
registered UUID files are eligible for 7-day expiry. Tauri obtains paths using the OS
picker and forwards requests; it does not implement file reading itself.

The UI payload adds `clientMessageId`, `attachments` and optional `deviceKey`. These are
platform fields and are stripped before App Server. `conversation.message.status` and
`conversation.message.cancel` correlate by Thread and message ID. The gateway persists
submission states and metadata in its existing state file, and returns
`attachmentSubmissions` with Thread history. Internal message markers allow an uncertain
submission to be reconciled. Raw image URLs are removed from downstream UI history and
notifications; the UI recreates previews locally, on the original device only.

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
