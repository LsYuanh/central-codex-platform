<!-- SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial -->

# Local AgentRPC

## App Server 0.162.1 adaptation (2026-10-10, central deployed)

No Local Agent wire methods change. The gateway stamps authenticated UI goal
set/clear requests with upstream `origin: "user"`; explicit Stop also records a user
pause. Disconnect, cold-resume preparation and other lifecycle guards use
`origin: "automatic"`. Clients cannot supply this field. Existing Thread ownership,
device checks, plan restrictions and continuation quotas remain in force. The new
field is optional upstream and the goal probe also passes against embedded 0.156.1.
Mac hosted compilation/probes and signing publication passed. The central native
updater installed 0.162.1; real GPT-6.1 Sol and Windows Local Agent file/command,
reconnect and history acceptance passed. See the [release manual](docs/发布与回退手册.md).

## Native image generation (central deployed 2026-10-10; new desktop states unreleased)

`session.initialize` accepts the gateway-only `imageOutputStates: 1` opt-in;
the gateway strips it before native initialization. Opted-in clients receive
`generating` and `generationFailed` output states, alongside `saving`, `saved`
and `failed`. Other clients receive the legacy `saving`/`failed` equivalents.
Persisted statuses are not downgraded. Turn completion, Worker loss and restart
terminate unresolved generation states; completion cleanup is scoped to its turn.

`platformCapabilities.imageGeneration` is true only for the qualified Mac Harness
marker `yuan-zhou-image-generation/1` with ready ChatGPT Broker credentials.
The conditional built-in `yuan-zhou-imagegen` follows managed skill projection.
Native inline output bytes use existing `file/write_begin/chunk/commit/abort`
and `outputs/v1`; no new Local Agent methods or direct central filesystem access.
Only failed saves offer save retry; generation failures require a new request.

## Conversation history tool (2026-09-22, source only; not deployed)

`conversation_read({threadId,cursor?,includeTools?})` is a **central platform metadata tool**, not an Agent RPC. The gateway reads the calling user's App Server history after checking source/target ownership and live authorization, and rechecks before returning. Archived/other-device same-user history is readable without the target Agent; source/target device bindings are unchanged. No resume, command, file read, output collection or Agent dispatch is performed. Foreign, deleted and absent IDs share `CONVERSATION_UNAVAILABLE`.

The response includes `threadId,title,archived,inProgress,readAt,version,includeTools,omittedItems,fragments,nextCursor`. Fragments contain `turnId,itemId,role,status,phase?,text,offset,continued`. Pages contain at most 16,000 UTF-16 text units and 40 fragments; a version-bound cursor detects changed history/options. Only public message text, attachment names and optionally saved tool text are returned; reasoning/system instructions, raw attachments and host metadata are excluded. Results are reference data, never instructions or authorization. Failure codes include `CONVERSATION_ARGUMENTS_INVALID`, `CONVERSATION_CURSOR_INVALID`, `CONVERSATION_CHANGED`, `CONVERSATION_HISTORY_UNAVAILABLE`, `CONVERSATION_READ_TIMEOUT` and `CANCELLED`.

Harness must attest `yuan-zhou-conversation-read/1` and explicitly allowlist the tool. Gateway advertises `platformCapabilities.conversationRead` and registers it only for newly created Threads, persisting a `conversationRead` capability flag. Old reading Threads return `CONVERSATION_READ_NEW_THREAD_REQUIRED`; old Threads remain valid targets. No existing Agent capability or wire method changes. Full native Harness/model qualification remains pending; see the validation guide.

Current maintenance baseline: 2026-09-20. WSS plus `device-token-v1` is the deployed default. Sections explicitly marked historical describe legacy compatibility and protocol fixtures, not the current product startup path. See the [maintenance index](docs/README.md) for deployment and acceptance limits.

## Client projects (2026-09-20, central deployed; desktop installer pending)

The gateway advertises `platformCapabilities.projects`. Platform operations are `project.list`, `project.save` and `project.remove`; the desktop RPC adapter exposes `project/list`, `project/save` and `project/remove`. Catalog entries `{id,name,folders,revision}` are scoped to authenticated user/device and retained in the existing atomic gateway state file. `folders[0]` is primary. Save validates 1–8 existing directories through the target Agent's `workspace/list`, stores canonical client paths, checks device installation identity and revision, and rejects duplicate folders. Creation accepts a stable `creationKey` for idempotent retries. Remove requires `{id,revision}`; it changes grouping only. Successful mutations emit `project/changed` to that user's connected clients on the same device.

`conversation.create` optionally accepts `projectId` and `projectRevision`. These gateway-only fields never reach the central App Server; the gateway captures a `clientProject` snapshot in Thread metadata and supplies primary-directory `workspace/context` from Local Agent as instructions. Existing-thread requests cannot override the snapshot. Read/resume/list return gateway-owned metadata. Editing or removing the catalog entry does not change existing Thread directories, rules or device binding.

For project Threads, the broker maps relative device paths, exec cwd, patch headers and expected-version keys to the captured primary client directory before dispatch/preview. It never resolves these paths against central disk. Absolute paths remain client paths; associated secondary directories use absolute paths. Name-only generated outputs retain the global output-directory behavior. Agent identity, patch destination/version checks and approvals remain active. Missing primary directories fail explicitly on create/resume/new turn and do not silently select another cwd. Projects require `client-paths/v1`; non-project and legacy-Agent behavior stays compatible. No new Agent wire method, local Codex, Git branch/worktree manager or task transfer is introduced.

## Client file access (`client-paths/v1`, 2026-09-14)

For Agents advertising `client-paths/v1`, this section supersedes the workspace-root access restrictions and Downloads/Codexia default-output rules below. Local Agent resolves ordinary absolute and relative client paths (including parents and explicit links) with OS account permissions, independent of LAN/TLS transport. `workspaceRoot` is retained as the default output directory and relative-path base, not a sandbox. `file/output_paths.outputDirectory` names the default destination for name-only document/image/copy output. Central system execution stays disabled.

Thread identity binds user/device/deviceKey, not the default output directory; each in-flight RPC still checks its captured configuration. Patch previews add `expectedPaths`, mapping patch paths to canonical client destinations. The gateway shows and forwards these alongside `expectedVersions`; apply rejects missing or changed destinations, including retargeted links. The gateway negotiates this behavior per connected device. Older Agents with `remote-workspace/v1` and stable device identity can still create/resume conversations and use their original workspace-relative tools and cwd. They retain the original workspace binding and native output defaults. Legacy patch previews use patchHash and expectedVersions without expectedPaths; the gateway only allows this fallback when client-paths/v1 is absent. New Agents must still provide canonical target paths. Agent reconnection during approval invalidates the preview. Older tool tables on resumed Threads receive capability-specific developer instructions. Missing authentication or remote-workspace identity capabilities remain unsupported. See [implementation and validation](docs/客户端维护手册.md).


## One-code bootstrap (2026-09-11)

The current client accepts `yzpair1.` plus base64url JSON containing exactly
`version: 1`, `gateway`, `caPem`, `token`, and `expiresAt` (Unix milliseconds).
The central native management bridge wraps the existing single-use five-minute
device pairing token with its owned WSS gateway and public CA. The client validates
the envelope and bootstraps HTTPS trust from that CA, retaining certificate chain
and hostname verification. Private keys, unknown fields, oversized or expired
payloads are rejected. No proxy, redirect or global root installation is used.
The CA and device token are committed together in private native storage; older
credentials without an embedded CA remain readable. UI and Local Agent reload
this trust automatically. The `/auth/device/pair` server protocol is unchanged.

Formal Mac 4510 has now migrated to WSS; Windows native one-code UI, persisted
Agent reconnect and real remote model/tool execution passed. Mac client packaging
passed, but Mac visual acceptance remains pending. Earlier migration statements
below are historical. See [current acceptance](docs/客户端维护手册.md).

## Device-token authentication

HTTPS/WSS, administrator-issued single-use pairing codes and revocable device tokens
are the current default. Formal Mac 4510 migrated on 2026-09-11; validation scope and
remaining platform/installer limits are maintained in the [validation guide](docs/验证与已知限制.md).

The implemented module contract is `device-token-v1`: administrator-session
`POST /auth/admin/pair-code {userId}` returns a code valid for five minutes;
unauthenticated `POST /auth/device/pair {code,name}` consumes it once and returns the
device secret to the native client. UI and Agent WSS use that device-bound bearer in
the Authorization header. `/auth/device/status` and `/auth/device/disconnect` apply only
to that device. Device tokens have role user, including devices belonging to an admin;
they cannot issue codes or enumerate/revoke sibling devices. Revocation closes existing
channels. No secret is accepted in URL query parameters and there is no TLS bypass.

Native storage uses current-user DPAPI plus protected ACLs on Windows, and owned
0700 directories / 0600 files on macOS. macOS contents are not encrypted. The renderer
receives public state only. This replaces the pending legacy Mac Keychain acceptance;
old records below are historical. Re-pairing does not transfer existing Thread bindings.
Worker process isolation is independent of device authentication; current platform
qualification limits are recorded separately in the validation guide.
See [implementation and remaining acceptance](docs/中央管理维护手册.md).

## Device certificates (P5 fourth batch historical mode, 2026-09-09)

The following describes the previous `legacy-mtls-v1` path, not the approved new default.

Real authenticated gateways require `PLATFORM_DEVICE_CA_CONFIG` outside all Worker roots.
Pairing adds `tlsPublicKey` (base64 DER SPKI) and returns `certificate` with public PEM,
SHA-256 fingerprint, `expiresAt` and `renewAfter` in Unix milliseconds. Client TLS private
keys remain in separate native credential vault entries; they are never uploaded.
The HTTPS listener requests client certificates; bootstrap and UI routes remain available
without them. `/ws/agent` additionally requires an authorized, non-resumed TLS connection,
a present clientAuth certificate issued by the device CA, and a fingerprint bound to the
same registered device as the signed one-use upgrade ticket.

`POST /auth/device/renew` requires that mTLS identity plus `{sessionId,deviceId}` matching
an active platform session and unrevoked device. It reuses the registered TLS public key.
Before the renewal window, the current certificate is returned unchanged. Success extends
the authorization lease of existing Agent connections only for the same device, session
and previous certificate. This is explicit application reauthorization, not a replacement
TLS handshake; subsequent reconnects use the new certificate. Old certificates keep their
original expiry. Without renewal, certificate expiry closes the channel and cancels work.
Device revoke, session logout and user disablement still invalidate active connections.

`DEVICE_CERTIFICATE_REQUIRED`, `DEVICE_CERTIFICATE_INVALID`,
`DEVICE_CERTIFICATE_EXPIRED` and `DEVICE_REVOKED` are terminal device states with explicit
repair via pairing. `AUTH_REQUIRED` asks for platform login. Transient renewal failures
retry only while the current certificate remains valid. No failed command is replayed.

## Authenticated Worker model access (P5 third batch, 2026-09-09)

Authenticated model Workers require the pinned macOS sandbox and a central model credential
broker. Worker environment contains only its own revocable loopback capability, never the
provider credential, gateway login/session, SSH agent or inherited proxy/loader settings.
Model access bindings are resolved centrally from the verified platform user. GET `/model-access`
returns only the caller's safe status; a query userId cannot select a foreign account.
Binding disable/rebind aborts that user's model stream and Worker; reconnect after repair
creates a fresh capability and can restore its history without replaying the previous Turn.
Unknown central approval request types are rejected; the existing user-input RPC remains allowed.
Device execution still uses the existing outbound AgentRPC route. SSH is only a developer QA tool.
See [configuration and acceptance](docs/中央管理维护手册.md).

## Authenticated TLS connections (P5 first batch, 2026-09-09)

When `PLATFORM_AUTH_FILE` is set, gateway HTTPS APIs authenticate platform accounts and
WSS upgrades derive the principal from opaque bearer tokens, never a supplied userId.
AgentRPC remains V1; the authenticated Agent's hello must match its assigned deviceId and
the SHA-256 of its registered Ed25519 public key. A one-use 30-second signed challenge binds
sessionId and deviceId; successful proof yields a one-use 15-second upgrade ticket in the
Authorization header. Neither tokens nor private keys are carried in URL parameters.

Session logout/expiry, account disablement and device revocation invalidate existing sockets;
per-message and dispatch checks refuse stale identities, and Agent disconnection cancels its
commands. UI and Agent use TLS server certificate/hostname validation. This is device signature
authentication over TLS, not a completed client X.509/mTLS enrollment implementation.
Legacy ws connections are available only on gateways without platform authentication enabled.
See [implementation and acceptance](docs/中央管理维护手册.md).

## Enforced remote workspace extension (2026-09-09)

AgentRPC remains V1. New Agents advertise `remote-workspace/v1`, `agent.workspaceRoot`,
and `workspace/context`, `workspace/search`, `workspace/read_text`, `workspace/git_status`,
`workspace/git_diff`, `workspace/apply_patch`. The gateway pins user/device/installation key/
workspace/policy to each Thread and injects `params.__remoteWorkspace` for workspace and exec
requests. UI/model-supplied binding fields are rejected; Agent checks actual identity/root again.
Legacy attachment/output methods retain their explicitly documented LAN path permissions.

Patch dry run returns a hash and exact path-to-SHA256/missing preconditions. The gateway presents
the actual device/root/patch and accepts approval only for that invocation. Apply rechecks after
approval and returns completed/failed/partial/unknown with committed paths; it is not a multi-file
transaction. Do not replay unknown mutations. Workspace Git results have `source:client`, actual
stdout/stderr/exitCode and truncation. See [full Agent contract](docs/harness-agent-implementation.md).

Broker responses/events must match request ID, target device and the original WebSocket. Identity
cannot change via a second hello. A lost response or disconnect returns a non-retryable unknown
result; timeout requests cancellation without falsely claiming the process has exited. Stopping
a Turn also cancels its pending patch approvals. Platform file saves, native Turns and device
executions remain separate status domains. Native unadapted execution/plugin/subtask entry points
are refused by the pinned central harness, not merely by approval interception.

Windows Agent startup installs a non-breakaway, kill-on-close process Job before spawning
commands; failure is explicit `AGENT_JOB_SETUP_FAILED`. Forced Agent termination also terminates
command descendants. Bound exec cwd must be relative to the workspace (or omitted), including
legacy tool tables. Runtime loss cancels pending device execution and reports unknown outcomes.
Gateway state uses an atomic durable replacement; corrupt state fails before inference starts,
and persistence failure stops inference. Reconnection retains submission IDs; a recorded `sent`
status means accepted, not successfully executed, and must not cause replay after restart.
See [P4 acceptance](docs/验证与已知限制.md).

## Mid-turn user input (2026-09-07)

`conversation.turn.steer` is a desktop-to-central platform operation, not an AgentRPC method.
It accepts `threadId`, `expectedTurnId`, `clientMessageId` and nonempty text-only `input`.
The gateway enforces Thread ownership and source-device association, strips platform fields,
and forwards `turn/steer` to the central App Server. Model/cwd/policy overrides are rejected.
Its result includes `turnId`, `started` (true only for a confirmed normal-completion fallback),
and the durable submission record. Repeated identical accepted IDs return the same result
without forwarding another input. An ID cannot be reused with changed content or target Turn.

Submission records add optional `kind: start | steer` and `expectedTurnId`; old records remain
compatible. `conversation.message.status` and Thread history reconcile uncertain delivery.
Only a definitive no-active-turn rejection plus a normally completed expected Turn and no
new active Turn permits `turn/start` fallback. Cancellation versions suppress fallback after
a stop request. Interruptions, mismatches and uncertain outcomes never trigger automatic retry.
Local Agent wire formats, inbound networking and system-execution boundaries are unchanged.

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

## Authenticated central per-user Workers (P5 second batch)

With `PLATFORM_AUTH_FILE`, the real gateway derives Worker identity from the verified user,
starts one App Server per active user, and gives it separate central runtime/state directories.
This does not change the AgentRPC envelope or move Codex onto the client. Thread ownership
is checked both on client requests and on messages from the originating Worker. Pending
approvals carry the exact Worker instance and a fresh platform request ID; a restarted
Worker reusing its upstream JSON-RPC ID cannot accept a stale approval response.

`gateway/runtimeUnavailable` only goes to the affected user's clients, with `recoverable:true`.
The affected device tools are cancelled and unfinished results require reconciliation.
Reconnection starts a replacement after backoff; no failed Turn or tool is automatically replayed.
Capacity failures use `WORKER_CAPACITY`, `WORKER_REQUEST_LIMIT`, `TURN_LIMIT`, or `THREAD_BUSY`.
Authenticated `/audit` and `/workers` views are admin-only. Audit records persist across restart;
audit storage failure stops Workers and closes authenticated connections.

The sections below describe the earlier protocol-only Fake Central and legacy LAN probe.

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

## Client application updates (2026-09-14)

Client updates use authenticated native HTTPS routes under `/client-updates/`, not AgentRPC model tools. Before installation, the gateway checks active work and fences new requests for that device with a 60-second maintenance lease. The desktop stops and joins its Local Agent through the existing `runtime/prepare_restart` local IPC before invoking the installer. Only the installed expected version can resume the lease without its in-memory UUID; lease expiry recovers interrupted installs. Other devices remain available. See [implementation and acceptance](docs/发布与回退手册.md) for routes and deployment requirements.

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

## Managed personal skills (`skills/v1`, Mac central deployed 2026-09-21)

The authenticated UI uses platform operations `skill.list/read/draft/preview/save/update/remove/discard`. These are gateway-owned, not native App Server passthrough. `skill.draft` takes an idempotent creationKey and optional skillId; preview takes a draft id; save takes its expiring previewId; update/remove require id and revision. UI cannot supply a native skill path. `conversation.turn.create` may supply up to four `{id, revision}` entries in `skills`, or known `$name` mentions in text; skill selections are not accepted for steering.

A Local Agent advertising `skills/v1` additionally accepts the following gateway-only RPCs. All require the gateway-selected user `scope` and draft/cache `id`; neither is taken from model-supplied ownership fields.

| RPC | Parameters beyond scope/id | Result |
| --- | --- | --- |
| `skills/create` | none | client directory and OS |
| `skills/inspect` | none | bounded manifest of regular files: path/bytes/SHA-256 |
| `skills/read` | relative file, SHA-256, offset | base64 chunk, nextOffset, done; rejects changed source |
| `skills/check` | programs (at most 12 basenames) | missing client PATH commands; never executes them |

Full package limit is 64 files/8 MiB, depth six; each transfer chunk is at most 256 KiB. The gateway validates portable paths, metadata and hashes, then uses existing `file/write_begin/chunk/commit/abort` for client preparation and re-inspects the final manifest. Transfers bind to the same live Agent session; disconnect, re-pair, cancellation and checksum failure are errors. Native RPC skill input uses only gateway-resolved managed paths. The new exact dynamic tool `device_skill_load({name})` resolves from the turn's user catalog snapshot, checks current enabled membership, single-flights the selected version, and returns instructions plus verified **client** directory/resources. It grants no new system permissions. Existing command approval/transport boundaries remain intact.

### Built-in Yuan Zhou skill creator (2026-09-22, source only)

Skill summaries optionally add `source: "personal" | "builtin"`, `displayName`, and `nameConflict`. The read-only `yuan-zhou-skill-creator` is platform-owned; its only mutable setting is automatic invocation. It uses the same managed projection and client preparation as personal skills, with no access to central system skill discovery. Personal names cannot shadow it.

New Threads receive `device_skill_draft({requestKey, skillId?})`. The gateway hashes authenticated user, bound installation, Thread and stable requestKey into a draft ID and uses existing `skills/create` and file-transfer RPCs. No Agent RPC or new Agent capability is introduced. The response contains `{draft:{id,path,skillId?,revision?},next}`. This registers a draft, not a saved skill; preview/save remain UI operations. Requests share the per-user mutation fence, authorization, cancellation, timeout and live-session checks. A retry of an already saved new draft fails explicitly rather than replacing a saved skill. Built-in edit/delete and caller-supplied ownership or paths are rejected.

Existing Threads retain their tool snapshots; attempting creator loading or draft creation without the persisted creator capability returns `SKILL_CREATOR_NEW_THREAD_REQUIRED`. UI exposes recovery to a new conversation without auto-sending. Catalog capacity is 101 only in the updated pinned Harness; personal quota remains 100.
