# Central Codex harness fork

> 公开副本已脱敏：文中的示例主机、用户目录和私有部署路径不是可直接执行的现场配置；原始记录由维护者私有保管。测试结论与未验收项保持原意。

> Maintenance note (2026-09-20): build and probe details below include historical P0/QA stages. Windows central integration now exists; current deployment and unresolved qualification limits are in the [central manual](../docs/中央管理维护手册.md) and [validation guide](../docs/验证与已知限制.md).

This is a fixed-source dependency and an auditable patch for the existing gateway,
not another product entry point. The qualified runtime below is the **central Mac**.
Windows central qualification started in P0 on 2026-09-10; it is not enabled in the gateway.
The Windows/macOS work client still contains only Tauri/React and Local Agent.

`upstream.json` pins official `rust-v0.156.1`, commit
`b412ff32c417f855c2b2d1581b77058eed87c84b`, source archive SHA-256, patch SHA-256,
and protocol archives. `upstream/LICENSE`, `upstream/NOTICE` and
`upstream/Cargo.lock` preserve upstream license notices and the exact dependency inventory.
The source tar, extracted repository, build products and logs are excluded by `.gitignore`.

## Build and protocol

### v2 channel and native activation (2026-10-22)

Source `cde1b12` passed hosted run `39723948841` and protected signing publication.
The stable `central-runtime-update/v2` channel published 0.163.0 on 2026-10-22, sequence
`1792645257293`, package `macos-arm64-node24-qa1-ce2ce6aa6b976e91`.
Independent fixed-key signature, full archive and all 874 file hashes passed.
Central App 0.1.9 downloaded and activated it through the native updater:
`updated`, `pending=false`, matching running gateway, unchanged revision 19.
Real GPT-6.1 Sol and the Windows 0.3.1 packaged Agent passed file, command,
reconnect, history and project snapshot checks. App/configuration hashes and
VPN/Codex configuration hashes remained unchanged; backups are retained.
See `verification/runtime-v2-published-20261022.json`. Full Mac UI, real image
generation, forced token renewal and Windows central 0.163.0 remain outside this acceptance.

### 0.163.0 candidate adaptation (2026-10-20, published for Mac ARM64)

The scheduled run `39395265486` discovered 0.163.0 and stopped on
`UPSTREAM_PATCH_CONFLICT`. The new exact-commit/archive-pinned candidate reuses
the reviewed policy overlay and changes only three sections of the 0.162.1 base:
tool registry and dynamic tool contexts preserve upstream
`finishes_on_cancellation`, and the refactored default-shell initialization
still avoids host shell discovery in remote mode. Older patch bytes are unchanged.

The stable and experimental schemas were compared with the reviewed 0.162.1
snapshots. Optional metadata does not enable new execution capabilities;
`thread/items/read` and `thread/readState/update` remain denied, with native
boundary coverage. The candidate explicitly supports `darwin` only; Windows must
receive a separate reviewed transport adaptation before use.

On an isolated Mac QA directory, fresh online discovery and patch preparation
passed; all 32 patched/lock files matched the compiled source. Rust 1.95.0
compilation, 13 native/gateway probes and 15 local release/adaptation tests passed.
See `verification/runtime-adaptation-01630-20261020.json` for that initial local phase.
Commit `942e703` was subsequently pushed to main and passed hosted run
`39403895686`: all 16 builder command steps, including 13 probes and 10 central
updater Rust tests, then signing publication. At that publication, the stable channel pointed to
`runtime-0.163.0-1792490901637`. Independent fixed-key signature, public asset
digest, archive download and all 873 package file hashes passed.
See `verification/runtime-published-01630-20261020.json`.
No central installation or service switch was performed in this publication task;
native activation and real model/device acceptance were not verified in that task.
At that time the last confirmed deployment was 0.162.1; the 2026-10-22 acceptance above supersedes it. Windows 0.163.0 remains blocked.

### Platform capacity alignment (2026-10-19, source only)

The fixed base and the 0.162.1 adaptation no longer impose the platform's
32 KiB/102-entry managed skill catalog quotas. Catalog syntax, membership,
hashes and device boundaries remain enforced. Patch SHA-256 pins and the fixed
patched source inventory are updated together. Targeted patch application and
gateway regressions are local source validation, not a new Harness binary or
central deployment. Plugins, MCP and subagent policy are unchanged.

### 0.162.1 candidate adaptation (2026-10-10, published and deployed on Mac)

`candidatePatches["0.162.1"].basePatch` selects an exact-commit, byte-pinned
replacement base patch. It differs from the fixed base only in three file sections:
dynamic tools retain upstream third-party metadata alongside remote-safe dispatch;
session warmup retains the Guardian source check and skips host discovery in remote
mode; the broker catalog exception now covers the shared refresh/cache gate while
preserving provider identity checks. The existing 0.159.2 overlay is reused for the
cloud skill rename and isolated Mac policy inputs. Other versions use their original
base patch. A regression verifies all other patch sections remain identical.

Both exact schema snapshots were reviewed. Gateway UI goal mutations and Stop carry
user provenance; automatic lifecycle pauses carry automatic provenance. New upstream
routes remain denied. Mac ARM64 Rust 1.95.0 compilation and 13 native/gateway probes
passed; the goal probe also passed against the older embedded 0.156.1 binary.
See `verification/runtime-adaptation-01621-20261010.json` for evidence and the initial
test-fixture correction. The separate Windows adaptation is described below.
Commit `7785ab3` subsequently passed all 16 hosted builder steps and signing publication
in run `38031874184`. The existing central App 0.1.6 automatically installed 0.162.1;
real GPT-6.1 Sol and Windows Local Agent file/command, reconnect and history acceptance
passed. See `verification/runtime-published-01621-20261010.json`. The embedded fixed
baseline remains 0.156.1.

### Windows 0.162.1 transport adaptation (local QA, not released)

`candidatePatches["0.162.1"].windowsModelPatch` pins a separate overlay and five-file
integrity manifest to the exact upstream commit and archive. The new upstream
route-aware transport retains its normal behavior; Windows remote model requests
use a dedicated `ModelPipe` branch. Every request is checked before body preparation,
requires a direct named-pipe client, disables request logging and preserves typed
TLS certificate rejection. The existing AppContainer, per-worker CA, fixed POST
endpoint, no-proxy/no-redirect/no-retry and no-WebSocket requirements remain intact.
The SSE cancellation regression is inserted against the new source context.
Mac patch bytes and older Windows version selections are unchanged.

Use `node harness/check-upstream.mjs NEW_OUTPUT_DIRECTORY 0.162.1` to prepare the
candidate, then require `status: ready-for-validation` in its report. Verify the
prepared source with `node harness/prepare-windows-model.mjs SOURCE --verify 0.162.1
092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. To regenerate the reviewed overlay, use
`node harness/generate-windows-model-patch.mjs PINNED_ARCHIVE 0.162.1`; this validates
the archive hash and updates only the candidate patch and manifest.

Compile from the prepared `codex-rs` directory with an isolated `CARGO_TARGET_DIR`
and `cargo +stable build --locked -p codex-app-server --bin codex-app-server -j 2`.
The existing `build-central-windows.ps1` still builds the embedded 0.156.1 baseline;
it does not select this candidate. Local QA uses installed Rust 1.98.0 on MSVC,
not the candidate's Mac-tested Rust 1.95.0. Test the `windows_model_transport` and
`model_pipe_transport_tests` filters in `codex-http-client`, and
`receiver_drop_releases_silent_sse_body_without_waiting_idle_timeout` in `codex-api`.
Then run `windows-model-smoke.mjs` with the native isolation probe and candidate
binary. Synthetic fixtures do not qualify a real Windows central deployment.
Local compilation, nine Rust tests, seven native pipe/TLS checks, eleven selection/
release tests and thirteen source integrity checks passed. The native fixture uses
the existing memory credential bootstrap and checks the current managed-skill and
planning/goal registry; it does not test credential-file ACL/DPAPI. See
`verification/windows-runtime-01621-20261010.json` for final hashes and retained
fixture failures. No Windows runtime package was signed, published or deployed.

### Native image generation (2026-10-10, central deployed)

The pinned 0.156.1 extension is installed with no filesystem executor in remote
mode. Only `image_gen.imagegen` is allowed, gated by macOS, remote mode, Broker
authentication and `CODEX_REMOTE_IMAGE_GENERATION=1`; initialization advertises
`yuan-zhou-image-generation/1`. Central reference paths and both native save paths
are blocked. Inline conversation references (1–5) remain available. The gateway
Broker handles only the pinned JSON image contract using existing ChatGPT login;
Local Agent receives result bytes through the established output transfer flow.

Run `node harness/image-generation-smoke.mjs BINARY` on Mac: the deterministic
probe checks generation, inline-history editing, path/namespace/plan denial,
failure, history and absence of host image writes. The release build gate runs
this probe. The managed catalog limit is now 102 (100 personal and two built-in
skills), superseding the 101-entry historical note below. Patch/source hashes
were updated together; upstream version and other extension denials are unchanged.

Fresh Mac compilation, native boundary regressions and a real ChatGPT → Windows
Local Agent image save passed. See `verification/image-generation-20261009.json`.
This capability supersedes the initial blanket image denial described below.
Central App 0.1.4 / revision 15 was deployed on 2026-10-10 and passed real model
generation, Windows Agent persistence and history resume. See
`verification/image-generation-deploy-20261010.json` (later central 0.1.5 evidence
is in `verification/image-edit-deploy-20261010.json`). The 0.159.2 candidate now
passes hosted Mac compilation and all 16 builder steps, including native image
generation/editing, host file denial and gateway image regressions. Image patch
context was narrowed without changing inserted/deleted source lines. Trial and
release entry points share `.github/workflows/runtime-validate.yml`; the trial
has no signing secrets or write permission. See `verification/runtime-hosted-20261010.json`.
This is deterministic candidate QA, not a signed release or live central upgrade.
The deployed baseline remains 0.156.1 and the client installer is unchanged.

### Native plan and goals (2026-09-24, not deployed)

`yuan-zhou-plan-goal/1` advertises built-in collaboration modes and native goal
RPCs. The remote registry retains plan/question handlers and native goal tools;
the remote App Server branch installs the goal extension before returning. Only
the Goals feature is enabled for this extension. Native goal state, token usage,
budget boundaries and cross-turn continuation remain upstream responsibilities.
The gateway reserves capacity across automatic turns and pauses goals before
interrupting by Turn ID on stop or disconnect. Plan mode rejects mutating device
tools and skill projection in both gateway and native dispatcher.

Run `node harness/plan-goal-smoke.mjs /absolute/path/to/codex-app-server` against a
fresh compiled pinned runtime. It uses isolated histories and a deterministic
local Responses fixture to prove plan write denial, questions, a native plan
item, goal continuation/completion, usage, budget stop, pause/interrupt and explicit
resume. This check is part of `build-runtime-update.mjs`, alongside gateway task
control regressions. Real model plus Windows Agent verification is separately
recorded in `verification/plan-goal-20260924.json`; protocol fixtures alone do not
qualify the real execution boundary. Production revision 13 remains unchanged.

### 0.156.1 adaptation (2026-09-23)

The patch generator now reads the pinned version and commit. Global instruction
loading moved into `codex-home`; the remote guard covers its per-turn refresh.
The minimal skills registry preserves the upstream turn-admission hook, and the
App Server entry point now returns `AppServerExit`. The broker catalog bypasses
the new API-key discovery gate only with all three remote/broker/catalog flags;
provider identity checks and cache identity remain intact. Windows transport
construction follows the new route builder; upstream now implements SSE receiver
cancellation, so the overlay retains only the regression test for that behavior.

Both schema archives were reviewed and advanced with this pin. Existing supported
request fields remain compatible. Removed `thread/rollback` was never allowed;
new queue, configuration, review and MCP routes remain outside the remote
allowlist. Image URLs remain supported alongside the new file-ID variant. Model
access programs, rate-limit aliases, optional thread settings and collaboration
metadata are additive. New `Thread.environments` and `runtimeWorkspaceRoots` are
removed by the gateway, alongside existing central path metadata.

`model-catalog-smoke.mjs BINARY MODELS_JSON [VERSION]` exercises the compiled Mac
runtime against a synthetic authenticated catalog, checks the actual version and
authoritative remote-only model list, and repeats the lookup to exercise reuse.
It runs in the update build gate, in addition to the native dispatcher boundary,
history deletion, OS isolation, broker and native update/restore checks.

2026-09-23: the central Mac now runs `macos-arm64-node24-qa1-945b2f84e73d9282` (App 0.1.2, App Server 0.156.1, revision 13). Native boundary, deletion, OS isolation, broker, copied-history and 66 native tests passed. GPT-6 Sol completed a real Windows Local Agent read/PowerShell/read-back task and history resume. The previous app and full data snapshot are retained; an initial startup-lock failure exercised full rollback before the bounded startup retry fix was deployed. Signed update publishing infrastructure remains unconfigured. See the release and validation manuals.

The remote request policy now includes `thread/delete` (2026-09-23 source fix).
It delegates to the pinned App Server's history deletion implementation, accepts
only a Thread ID in the policy validator, and retains the gateway's ownership check.
It does not expose client filesystem deletion or local command execution. Deploying
only the desktop client cannot fix an older central binary's allowlist rejection.

Run the deletion regression against a newly built binary:

```powershell
node harness/thread-delete-smoke.mjs /absolute/path/to/codex-app-server.exe
```

The script creates isolated synthetic histories and an independent `CODEX_HOME`,
uses the real remote-mode App Server, archives/deletes a test Thread, restarts it,
and verifies history removal and preservation of other histories and file canaries.
It does not call a model, read real credentials, or delete user conversations.
It runs the application policy directly; OS sandbox qualification and deployment
acceptance remain separate. Gateway authorization and client error behavior use
`tests/smoke/worker-routing-smoke.mjs`, `thread-delete-client-smoke.mjs`, and
`thread-delete-ui-smoke.mjs`.

Windows P0 build (PowerShell 7, Node 24, Git/tar, Rust/MSVC build tools):

```powershell
./harness/build-central-windows.ps1 -BuildDirectory C:/Workplace/central-codex-platform/target/p0w-new
# Resume only a recorded, verified prepared source tree:
./harness/build-central-windows.ps1 -BuildDirectory C:/Workplace/central-codex-platform/target/p0w-new -Resume
```

Use a short isolated path for Cargo's deep dependency trees. Source and dependencies
stay pinned; the selected `stable` compiler is recorded, not claimed to be a fixed
toolchain. The build uses its own Cargo cache and Git settings, keeps TLS verification
enabled, and never starts a model, reads login files, or installs a service. A built
binary is **not** proof of runtime confinement or real model/device acceptance.

Windows source preparation additionally applies the separately pinned
`windows-home.patch` from `upstream.json.windowsPatch`. It changes only the
Windows remote AppContainer `CODEX_HOME` canonicalization path: on DOS-name
access denial, a normalized NT path is obtained from an opened directory handle,
reopened, and checked for the same volume/file identity. It does not accept a
lexical fallback, relax ACLs, or change the qualified Mac base patch.
Windows additionally applies `windows-model.patch` from `upstream.json.windowsModelPatch`.
Its model-only reqwest client uses authenticated TLS over the Worker's named pipe,
requires complete AppContainer/broker configuration, and rejects TCP fallback,
alternate routes, retries and WebSockets. SSE receiver cancellation drops the body.
The build record stores all three patch hashes (schema 4).

For a previously verified base-only P0 build, explicitly apply this overlay once,
then resume. Existing records without an overlay hash are archived as the prior
attempt; records with a different nonempty overlay hash are rejected.

```powershell
node harness/prepare-windows-home.mjs C:/ABSOLUTE/BUILD/source/codex-3d2ee51ca2d5db578f328aa75e20aa22c0197c9a
node harness/prepare-windows-model.mjs C:/ABSOLUTE/BUILD/source/codex-3d2ee51ca2d5db578f328aa75e20aa22c0197c9a
./harness/build-central-windows.ps1 -BuildDirectory C:/ABSOLUTE/BUILD -Resume
```

`generate-windows-home-patch.mjs PINNED_ARCHIVE` regenerates the Windows overlay
from the verified archive and `windows_home.rs`; source preparation verifies both
complete overlay files as well as the 25 base files. New builds apply it automatically.
`generate-windows-model-patch.mjs PINNED_ARCHIVE` regenerates the five-file model
overlay; all 32 prepared files are checked. Prefer a new build directory for a
new revision. A deliberately replaced and fully verified model overlay can use
`-Resume -RefreshModelOverlay`: only the model hash mismatch is permitted, the
prior record/hash is archived, and base/home/commit/platform/source checks remain
mandatory. Default resume still rejects a different nonempty model hash.

The Windows QA launcher now supports `--model-runtime-binary`. Build it in an
x64 MSVC developer environment using the command in `windows-probes.md`, then run:

```powershell
node harness/windows-model-smoke.mjs --launcher C:/ABSOLUTE/windows-isolation-probe.exe --runtime C:/ABSOLUTE/codex-app-server.exe --output C:/ABSOLUTE/NEW_QA_DIRECTORY
```

This test starts scoped TLS endpoints and a real AppContainer runtime with a
synthetic model and synthetic dynamic tool. It checks streamed output hashes,
interruption/recovery, certificate rejection and Job/profile cleanup; it never
replaces the formal service or enables the production Windows Worker. See
`verification/windows-model-runtime-2026-09-10.json` and
`../docs/验证与已知限制.md` for the current result and limits.

Source preparation now isolates Git from the enclosing project and verifies actual
patch application: `git apply` can otherwise skip all hunks inside a parent repository
while returning zero. The pinned Windows license symlink is materialized as a byte
copy of `COPYING`. All 24 patched files and the added module have full-file hash
postconditions, normalizing CRLF to LF without modifying the source during checks.
No third-party dependency version is updated for this adjustment.

```powershell
node harness/prepare-patch-smoke.mjs /absolute/path/to/pinned/upstream.tar.gz
```

The source-preparation regression and the Windows OS probes are QA tools, separate
from the gateway's production launcher. See the P0 design and acceptance record in `docs/`.

On the central Mac, select Rust and Node through the current process's PATH, then:

```sh
sh harness/build-central.sh /absolute/new-isolated-build-directory
```

The destination must be new. `fetch-source.mjs` checks both source and patch hashes
before extraction/application and refuses to overwrite an existing source tree.
The upstream toolchain file requests Rust 1.95.0. This round actually built with the
central machine's existing Rust 1.98.0; exact 1.95.0 and release builds are not yet qualified.
The release tag changed `workspace.version` to the pinned version but left source-less lockfile
packages at 0.0.0. The patch normalizes **only those local package versions** so
`--locked` succeeds; no registry/git dependency version, source or checksum changes.
The Bazel lock/update workflow and full upstream nextest/Clippy suite are not qualified.

The runtime artifact is upstream `codex-app-server`, not the full Codex CLI.
`launch-central.sh` accepts the existing gateway's `app-server` argument and invokes
this binary over stdio. No additional port is opened.

```sh
export CODEX_REMOTE_BINARY=/absolute/build/target/debug/codex-app-server
export CODEX_HOME=/absolute/independent-runtime-home
export CODEX_REMOTE_WORKER_DIR=/absolute/independent-worker-directory
sh harness/launch-central.sh app-server
```

Create those two independent directories first. The launcher enforces
`CODEX_REMOTE_WORKSPACE=1`, uses `worker.sb` with `sandbox-exec`, and refuses an
unconfined fallback. Never set either directory to an actual project or the whole HOME.
If a QA model call requires an existing auth.json, an operator may link that exact file
into independent CODEX_HOME and set `CODEX_REMOTE_AUTH_FILE` to its canonical target;
the launcher permits only that file for reading. It does not copy, print or read credentials.
The credential-free probe does not qualify authentication. A subsequent separately authorized
4529 QA run completed a real model and Windows Local Agent turn with this exact auth link
and unchanged strict profile; token refresh and keychain login remain unqualified.
Follow-up source review found that authority refresh precedes auth-file persistence.
The launcher now forces **shared-readonly** mode for an external auth-file allowance:
refresh/revoke endpoints are overwritten with a non-network URI even when the caller
supplies an override. Existing access tokens remain usable; expiry fails and requires
the owning login to renew them. `CODEX_REMOTE_AUTH_FILE=/dev/null` selects
**isolated-file** mode for credentials owned by the writable independent CODEX_HOME.
The real Rust fake-token refresh, persistence, restart and 401 tests are documented in
[`auth-lifecycle.md`](auth-lifecycle.md); no real shared token was forcibly refreshed.

`initialize.result.userAgent` contains `yuan-zhou-remote-workspace/1` only when the
compiled process-wide boundary is active. The gateway must require this marker,
pin the executable and launch through the OS profile. A marker alone proves neither
the executable's provenance nor OS confinement.

The protocol JSON/TypeScript generated exports are embedded by the fixed upstream
`app-server-protocol/src/precomputed_exports.rs`. We archive those exact stable and
experimental zstd payloads. The following uses the same decompression/export data;
it **does not invoke Codex on the client**:

```sh
node harness/export-schema.mjs
node harness/export-schema.mjs --experimental
```

The exports and per-file SHA-256 manifests go to `.cache/schema`. Stable exports
contain 1,010 files; experimental exports contain 1,243. Dynamic tools are experimental.
The fork adds no protocol fields: the existing userAgent field carries the marker.

## Runtime contract

Windows real-model QA is opt-in and uses an explicitly authorized existing ChatGPT login file.
It never copies that file into a Worker or Agent directory. Build the gateway and current
Local Agent first; provide absolute paths to the compiled launcher, App Server and Agent.
Every `--output` must be a new directory with an existing local parent.

```powershell
node harness/local-agent-qa-smoke.mjs --agent C:/PATH/local-agent.exe --output C:/PATH/NEW_AGENT_QA
node harness/windows-worker-lease-smoke.mjs --launcher C:/PATH/windows-isolation-probe.exe --runtime C:/PATH/codex-app-server.exe --output C:/PATH/NEW_LEASE_QA
node harness/windows-worker-expiry-smoke.mjs --launcher C:/PATH/windows-isolation-probe.exe --runtime C:/PATH/codex-app-server.exe --output C:/PATH/NEW_EXPIRY_QA
node harness/windows-real-model-smoke.mjs --launcher C:/PATH/windows-isolation-probe.exe --runtime C:/PATH/codex-app-server.exe --agent C:/PATH/local-agent.exe --auth-file C:/PATH/authorized-auth.json --model gpt-6-astra --output C:/PATH/NEW_REAL_QA
```

The import-only `local-agent-qa-adapter.mjs` owns a loopback listener and independent Agent
workspace/identity. It is not the production Device Broker. `windows-runtime-session.mjs`
binds lease closure to the exact native Worker instance. The real-model smoke permits only
the exact synthetic PowerShell fixture; it checks Thread/Turn ownership and an unpredictable
file/command result in the final model answer. Output evidence excludes credentials and raw
model content. Same-host acceptance does not qualify remote devices, full network denial,
production credential ACLs, the Windows Worker gate, or installation lifecycle.
The expiry smoke waits for the real broker TTL (65 seconds with its explicit 5-second
request timeout), then observes lease closure, active upstream cancellation and exact
Worker cleanup. It never advances a test clock or explicitly revokes the tested lease
before those observations. A later-issued sibling remains usable.

`windows-network-smoke.mjs` runs only numeric TCP checks. It requires a host-success
echo endpoint for each case; a timeout is recorded as inconclusive. The 2026-09-10
controlled-LAN run had host echo success and AppContainer `WSAEACCES (10013)` with
`NETISO_ERROR_TYPE_INTERNET_CLIENT`, while IPv4/IPv6 loopback remained timeout-only.
It does not test DNS/UDP or change firewall and loopback exemptions.
See `../docs/验证与已知限制.md` for results and limitations.

- The whole worker uses one immutable remote mode. UI/config cannot turn it off.
- No native executor is created, regardless of environments.toml, exec-server URL or noise settings.
- Only exact allowlisted `device_*` tools implemented by the upstream DynamicToolHandler
  are advertised and accepted. Namespaced tools, forged built-ins, plugins, child agents,
  code mode, shell, patch, file, search, environment and Git RPCs have no central fallback.
- Rules/context/search/patch/Git/test execution come from the bound Local Agent through
  the existing Device Broker. Dynamic tool call IDs retain upstream Thread/Turn ownership.
- Config/permissions/sandbox/approval/environment/path overrides are rejected. A supplied
  `cwd` must equal the central worker's current directory. Client paths are tool parameters.
- Turn input accepts text, inline `data:image/`, and gateway-resolved managed skill input. Central localImage and arbitrary skill paths are rejected.
- Upstream Thread/Turn state, streaming, context, dynamic tool result handling and interrupts
  remain the agent engine. Device cancellation, idempotency and uncertain delivery stay platform-owned.
- Feature-flagged behavior is conservatively off for this initial mode. Native image generation,
  web search, plugins, hooks, queue/goals/history-note extensions, and subagents are
  unavailable in this fork. Existing attachment input remains supported; do not claim image
  generation feature parity until a reviewed extension path is enabled.

## Managed personal skills (Mac central deployed, 2026-09-21)

The fixed upstream version is now 0.156.1. `yuan-zhou-managed-skills/1` is an additional initialization marker, required with platform authentication before the gateway advertises skills. This is a selective restoration of the upstream skills extension/provider, discovery and skill input, not a general feature-flag change.

`managed-skills-host.rs.inc` is inserted by `apply-fork.mjs`. It reads a fresh `runtime/managed-skills/catalog.json` on every snapshot and permits only listed `<skill-id>/<revision>/SKILL.md` plus gateway-generated `agents/openai.yaml` invocation policy. Paths must be canonical and within the worker root. User/project/system scanning, installation of system skills, arbitrary extra roots, plugin and orchestrator sources remain disabled. `skills/list` accepts only an empty `cwds` and optional `forceReload`. Input skill paths must be current catalog members. Do not re-enable the former host scanner to add support for more resources.

The authenticated gateway owns full packages outside worker directories. It projects normalized name/description and instruction body only; scripts, templates and references never enter the native discovery directory. Explicit selections are converted from platform IDs/revisions or known `$name` mentions to genuine native skill inputs. `device_skill_load` prepares and hashes resources through the bound Local Agent before the model uses them. `device_skill_draft` registers a draft on that client and must appear in the exact native tool allowlist as well as the gateway's dynamic tools. Instructions direct the model to client resource paths. Native executors and all other existing restrictions remain enforced.

Reproduce the patch from clean pinned upstream with `node harness/apply-fork.mjs <source>`, and update the patch SHA-256 in `upstream.json`. The patch is byte-pinned with a Git attribute preserving line endings. The authorized LAN Mac deployment now uses `macos-arm64-node24-qa1-945b2f84e73d9282` (config revision 13, 2026-09-23). Real central-model/Windows-Agent skill execution and history verification passed; the Windows AppContainer build, Mac client, and multi-machine matrix remain unqualified. Client installers were not republished.

## Verification and rollback

`runtime-smoke.mjs` runs the **compiled Rust App Server** under the actual macOS profile,
with an independent empty auth directory and loopback Responses fixture. It verifies
initialize, thread creation with no executor, exact advertised tools, a forged built-in
rejection, dynamic tool result return, completed Turn, rejected host RPCs, and suppressed
central AGENTS/notify. It also checks 101 managed skills, rejection of overflow, and
native advertisement/dispatch of `device_skill_draft`; a gateway-only fixture cannot
detect a missing native allowlist entry. Its simulated device/model is not real end-to-end acceptance.

`os-boundary-probe.c` separately proves that `worker.sb` allows worker data reads/writes
while denying a central sentinel read/write and `/bin/sh` execution. Only the system root
directory itself is readable for dyld startup; `/` is never a recursive read allowance.

Qualification results and remaining upstream/real-chain tests are in
`../docs/harness-source-audit.md`. No production 4510 service or installed desktop
is changed. Rollback means reverting the isolated launch configuration to a previously
qualified **remote-enforcing** binary; an ordinary upstream binary is rejected by the gateway.

The separately authorized 2026-09-09 live QA uses
`/Users/operator/central-harness-qa-20260909` and listens only on the central LAN address,
port 4529. Its gateway environment is:

```sh
qa=/Users/operator/central-harness-qa-20260909
export TEST_GATEWAY_HOST=192.0.2.10 TEST_GATEWAY_PORT=4529
export TEST_GATEWAY_STATE_FILE="$qa/live-data/state.json"
export CODEX_BIN="$qa/launch-central.sh"
export CODEX_REMOTE_BINARY="$qa/codex-3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/target/debug/codex-app-server"
export CODEX_HOME="$qa/live-home"
export CODEX_REMOTE_WORKER_DIR="$qa/live-data/remote-worker"
export CODEX_REMOTE_AUTH_FILE=/Users/operator/.codex/auth.json
```

The worker directory must match the gateway's state-file sibling `remote-worker`.
The operator-created `live-home/auth.json` link points only at the exact existing
auth file; no production config or credential content was copied. Runtime dependencies
were installed from the uploaded lockfile using `npm ci --omit=dev --ignore-scripts`
for only the gateway and agentrpc-types workspaces. The gateway runs its packaged
`services/central-gateway/dist/index.js` with the existing central Node 24 runtime.
QA health is `http://192.0.2.10:4529/healthz`; log and PID files are
`live-gateway.log` and `live-gateway.pid` under the QA root. Stop only the recorded
QA process after verifying its command and 4529 listener; never target the 4510 service.

The next authorized fault/compatibility round uses `qa-control.mjs start|status|stop`.
`crash-runtime` is available only for an explicitly coordinated QA runtime fault.
The script fixes the QA paths/port, revalidates PID identity and cwd before signals,
preserves evidence, and enables the QA-only controls/history fixture flags. See
`auth-lifecycle.md` for its scope and `verification/long-running-qa.json` for results.

### Built-in creator catalog capacity (2026-09-22, not deployed)

The managed host catalog limit is now 101: the existing 100 personal skills plus the single platform-owned `yuan-zhou-skill-creator`. The insertion source, pinned patch and source/patch hashes were updated together. The upstream version and the managed-only scan boundary are unchanged; central native `skill-creator` remains excluded. Deploy with the matching newly built Harness, not only a gateway update. Patch preparation and tamper checks pass locally; this change has not yet had binary/model QA or been deployed to the LAN central host.

### Native device approvals (2026-10-26, published and activated on Mac)

The version-pinned `deviceApprovalPatch` overlays for 0.162.1 and 0.163.0 install only the synchronous Guardian reviewer in remote mode. They do not enable host executors, general subagents or plugins. The dynamic handler reviews remote side effects through a private prepare/complete exchange; specific read tools remain direct. Managed reviewer constraints are retained. Windows remote reviewer retries must stay at zero because the authenticated pipe transport rejects replay.

`node harness/device-approval-smoke.mjs ABSOLUTE_APP_SERVER [WINDOWS_ISOLATION_LAUNCHER]` exercises the actual native Guardian against synthetic model/device fixtures, including auto allow/deny, ask/full, client-path context and central command denial. Windows uses the existing AppContainer launcher and broker pipe/TLS. This verifies the native integration, not real-model risk classification. Mac candidate packaging runs this probe when the pinned overlay exists. Mac 0.163.0 native compilation, real Guardian allow, and all three modes against the formal central host with the Windows 0.3.2 packaged Agent have passed. The published v2 sequence is 1792989794737, package macos-arm64-node24-qa1-95108a512f5c44ef; native activation completed with pending=false. See verification/permissions-published-20261026.json and the separate prepublication record. Windows central 0.163.0 remains unsupported.
