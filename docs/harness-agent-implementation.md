# Harness Local Agent implementation and verification — 2026-09-09

> Historical implementation reference. For client-paths/v1 Agents, workspaceRoot is a default output directory, not an access boundary. Current path/patch negotiation is specified in [AgentRPC](../AGENTRPC.md) and the [client manual](客户端维护手册.md).

Implementation is integrated into the existing `crates/local-agent`.
The synchronized current product baseline remains intact, including attachment/output
permissions and Tauri-managed lifecycle. New changes are `workspace.rs`, the main
dispatcher/hello/strict binding additions, the vendored text patch core, its path
dependency and lockfile entry, and `tests/smoke/harness-workspace-smoke.mjs`.

## Capability and RPC contract

The existing AgentRPC V1 envelope and 1 MiB frame limit remain. Hello advertises
`remote-workspace/v1`, all following workspace methods, and `agent.workspaceRoot`.
Only Local Agent reads the rules/files or runs Git/Shell. No client Codex/CLI/helper
or inbound networking has been added.

| Method | Parameters | Result |
| --- | --- | --- |
| `workspace/context` | `path?` (relative directory/file, default `.`) | `source:client`, `workspaceRoot`, `os`, `arch`, `shell`, ordered `rules:[{path,content,version}]` |
| `workspace/read_text` | `path`, byte `offset?`, `version?` | UTF-8 `content`, SHA-256 `version`, `bytes`, `offset`, `nextOffset`, `truncated` |
| `workspace/search` | `path?`, `mode:files\|text`, literal case-sensitive `query`, string `cursor?`, `limit?` | `matches`, `nextCursor`, `scanTruncated`, `scannedEntries`, `skippedEntries`, limits |
| `workspace/git_status` | relative directory `path?` | real Git `stdout`, `stderr`, `exitCode`, `truncated`, `repositoryRoot`, `format:git-short` |
| `workspace/git_diff` | relative directory `path?`, `staged?` | same fields with `format:git-unified-diff`, `staged` |
| `workspace/apply_patch` | `patch`, `dryRun:true` | `patchHash`, `expectedVersions`, `changes:[{path,operation}]`; no writes |
| `workspace/apply_patch` | `patch`, `patchHash`, `expectedVersions`, `dryRun:false` | `outcome`, `applied:[{path,version}]`, optional `failedPath/error`, `atomic:false`, `retrySafe:false` |

Rules follow root-to-target order, preferring the first nonempty `AGENTS.override.md`
then `AGENTS.md` in each directory. Working outside the configured workspace is not
used to discover global rules. Response says `globalRulesIncluded:false` and
`ruleScope:workspace-root-to-target`; global rules and arbitrary fallback filenames
are not silently implied. More than 64 KiB of combined rules is an explicit error.
`shell` describes the supported default (`powershell` on Windows, `sh` otherwise),
not a probe of every installed or interactive shell.

Text reads hash a bounded snapshot (1 MiB maximum) and serve 64 KiB UTF-8 pages.
Search returns at most 200 entries / 64 KiB per page, visits at most 10,000 entries,
reads at most 8 MiB of text with 1 MiB per file, and checks a 5-second deadline and
cancellation. Search excludes `.git`, skips symlinks/reparse entries, binary and
oversized files; skipped counts and scan truncation are explicit. The cursor is a
live rescan offset (maximum 10,000), not a snapshot; changing files can reorder
results. Narrow `path` when `scanTruncated` is true. No regex engine or unbounded
whole-workspace indexing is introduced.

## Identity, paths and Git boundaries

For requests carrying `params.__remoteWorkspace`, Agent verifies fixed policy
`remote-workspace/v1`, nonempty user ID, device ID/key and exact canonical display
workspace root against its own configuration. Mismatch returns
`WORKSPACE_BINDING_MISMATCH` before dispatch. The gateway owns user authorization;
Agent's user field check is not authentication.

New workspace operations require relative paths, reject traversal/absolute paths,
Windows alternate streams and ambiguous trailing-dot/space components, and reject
symlinks and Windows reparse points in every requested component. Paths are checked
again before file access and patch commit. Patches cannot change `.git` metadata.
This is application path validation for the trusted LAN phase; it is not a proof
against hostile concurrent filesystem renames, hardlink aliasing or an OS sandbox.
The client OS account still defines the underlying permissions.

Bound `exec` uses the same strict cwd resolver and the existing process-tree,
stdout/stderr, timeout and cancellation implementation. This confines its initial
directory and execution device, not arbitrary shell access: a shell command can
still access absolute paths allowed to the client OS account. P5 account/OS
isolation remains required before claiming adversarial workspace or tenant isolation.
Legacy user-selected attachments and generated output methods retain their existing
trusted LAN absolute-path permissions; they are not newly restricted to the code
workspace or falsely advertised as such.

Nonzero process completion keeps top-level `ok:false` and the legacy error text,
and now also returns `result:{exitCode,stdout,stderr,truncated,program,args}` with
the actual `ExitStatus` and bounded captures. This is typed process data, not an
exit code parsed back out of an error string. Timeout/cancel failures also include
the observed post-cleanup process result when available; no process start means
there is no fabricated exit code. An already-cancelled request is checked before
spawning the child.

Git operations disable optional locks, fsmonitor, hooks, external diff, textconv,
submodule traversal, inherited Git variables and global/system configuration. They
only inspect a repository rooted at or beneath the workspace. External `.git`
worktree pointers, configuration includes/worktree relocation, alternate object
stores, shared common directories, symlink metadata, and repositories exceeding
10,000 metadata entries are explicitly rejected as unsupported. Git runs with a
15-second command timeout and returns bounded actual output (64 KiB per stream).
`git_status` is short text; filenames are Git-quoted when necessary. Diff excludes
untracked files (shown by status), and default diff compares tracked working tree
files to the index; `staged:true` compares the index to HEAD. It is not synthetic
content derived from the requested patch.

## Upstream patch reuse and side effects

The text component is pinned to openai/codex `rust-v0.153.4`, commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`. Its grammar, streaming parser, fuzzy
line matching and line-ending reconstruction are reused; the I/O wrapper accepts
an Agent-verified snapshot. Extraction details and Apache-2.0 LICENSE/NOTICE are
under `crates/local-agent/vendor/codex-patch-core/UPSTREAM.md`. There is no custom
replacement patch language or client Codex runtime.

Preview computes a patch hash and SHA-256 preconditions for every source and
destination (`missing` for additions). Apply requires the exact hash and exact
precondition map, checks them after approval and again immediately before each
commit. Changed content returns `VERSION_CONFLICT`; changed patch content returns
`PATCH_APPROVAL_MISMATCH`. New parent directories must already exist; additions
and moves cannot overwrite existing destinations. Existing updates retain file
permissions and preserve CRLF through upstream reconstruction. Limits are 100
hunks, 256 KiB patch input, 1 MiB each resulting file and 8 MiB combined new text.

Writes use an adjacent temporary file and per-file rename; files are verified by
reading their actual committed bytes. Multi-file patches are **not a transaction**:
operations are sequential, moves write destination then delete source, and later
failure/cancellation returns `failed` or `partial` with already committed paths.
Post-commit verification disagreement returns `unknown`. Agent does not silently
roll back files that may have been edited elsewhere. The gateway must treat every
outcome other than `completed` as a tool failure or unknown result, and retain the
applied-path evidence. A network-lost response is unknown, never permission to
replay; read versions/Git first. No durable idempotency claim is made for patches.

## Verification and rollback

Commands executed in the existing `.` directory:

```powershell
cargo fmt -p local-agent -p codex-patch-core --check
cargo test --offline -p local-agent -p codex-patch-core --target-dir target/harness-agent
cargo check --offline -p local-agent --target-dir target/harness-agent
cargo build --offline -p local-agent --target-dir target/harness-agent
node tests/smoke/harness-workspace-smoke.mjs
```

20 upstream text component tests and 19 Agent tests passed, including existing
attachment/output/encoding/process regressions plus new rule, search, cancellation,
preview/version and CRLF cases. Cargo uses an isolated target directory because
existing Cargo processes were observed; no unrelated process was killed.
Optional pretty-assertions fetching hit the environment's Schannel credentials
failure; test assertions use the standard equivalent, and offline builds passed.

The real Windows Agent was launched as an independent test device against a local
loopback AgentRPC peer. Smoke passed rules, search, wrong-device rejection,
traversal and actual Windows junction escape rejection, preview without writes,
post-preview conflict, CRLF patch application, actual Git status/diff, actual test
stdout/exit code, structured nonzero exit 7 with both streams, timeout, user
cancellation, and a deliberately discarded mutation
reply followed by reconnect/read reconciliation without replay. Small retained
fixtures are under `%TEMP%/codex-harness-workspace-*`; no product files were edited.
The two-file partial-patch scenario sets only a fixture's second file to read-only
and restores it in `finally`: first file is committed and returned in `applied`,
second file remains unchanged with `PERMISSION_DENIED`, and `outcome:partial` is
explicit. The latest full 15-check fixture was
`C:\Users\developer\AppData\Local\Temp\codex-harness-workspace-ImfVy9`.
This validates the actual client and protocol, not central model/fork integration.

Native QA subsequently found Git diff and even `git --version` hanging when Agent
was Tauri-launched with `--attachment-stdio`; the same binary's direct Agent launch
had passed. An unchanged old binary reproduced `COMMAND_TIMEOUT` at the Git diff
step when the smoke enabled attachment stdio and kept its stdin pipe open. The
command runner had inherited the desktop's attachment IPC stdin. Noninteractive
commands now explicitly use `stdin(null)` and Windows `CREATE_NO_WINDOW`; the
process-tree cancellation helper uses the same closed input/hidden launch policy.
The smoke now always uses attachment stdio with open stdin/stdout pipes, matching
the Tauri launch rather than testing only the direct CLI case. The rebuilt Agent
passed all 20 + 19 Rust tests, check/build/fmt, and all 15 smoke checks in this
configuration; fixture `C:\Users\developer\AppData\Local\Temp\codex-harness-workspace-QQTZ65`.
No Tauri/runtime lifecycle code changed for this fix. UI QA confirmed the old
desktop, its Agent and both observed Git PIDs disappeared on window close without
manual process cleanup; native UI revalidation with the rebuilt binary is tracked
by the main task's UI acceptance record.

The subsequent native Git diff returned an immediate nonrepository error instead
of timing out. Read-only diagnosis through that same Agent showed `git status`
and `git rev-parse` exit 128 with explicit dubious-ownership stderr: the original
QA fixture and `.git` belonged to `EXAMPLE-PC\CodexSandboxOffline`, while the native
Agent's `whoami` was `example-pc\developer`. This was a test-account ownership mismatch,
not a cwd defect. Git's safety check was retained; no global `safe.directory`
exception or product authorization change was made. The real Agent created only
the new isolated subfixture
`target/harness-qa-workspace/native-owner-1788930308099`; read-only ACL checks
confirmed its root and `.git` belong to `EXAMPLE-PC\developer`. The same native Agent's
`workspace/git_diff` for that subdirectory then returned exit 0, empty stderr and
the actual `+NATIVE_CLIENT_DIFF_VERIFIED` addition. UI was given this directory
for its final displayed-diff acceptance. Original fixture files were preserved.

Pending independent acceptance: central fork → gateway → Windows end-to-end model
cycle, actual ACL-denied I/O beyond the verified read-only-file policy, malicious
concurrent directory replacement/OS isolation, macOS-specific paths/processes, and
installation lifecycle regression. Formal 4510 service and installed desktop were
not replaced. Main task's integration record owns additional central/UI evidence.

`tests/smoke/harness-live-smoke.mjs` is prepared for that independent real-model chain.
It requires explicit `HARNESS_GATEWAY_URL`, refuses production port 4510, launches
a new Windows test Agent and Git fixture, and only approves the exact fixture
patch once. It asks the central model to read client rules/search/read, patch,
obtain real Git diff and execute success/nonzero tests; assertions verify actual
files, execution events and native Turn completion. It has passed Node syntax
checking; running it is recorded separately once the isolated central build is ready.

Rollback removes the new capability advertisement and strict-workspace callers,
rebuilds the previous Agent from the preserved baseline, and restores only these
source/dependency changes. It does not revert arbitrary user workspace files or
permit central execution fallback. Review `applied` versions and real Git diff
before manually reverting any test or user patch; unknown mutations are not replayed.

## P4 Windows Agent termination and descendants

The real transport fault test found that externally killing the Agent could leave
an executing Node child alive: graceful cancellation and `taskkill /T` do not run
after `TerminateProcess`. `src/windows_job.rs` now creates an unnamed Windows Job
at Agent startup, before any command can spawn, enables
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and assigns the Agent itself. New child and
grandchild processes inherit membership. The Job handle uses null security
attributes (not inheritable) and remains in static owned storage until Windows
closes the process handles; an ordinary local guard would close the Job early and
terminate the Agent itself. No breakaway flag is enabled. Creation, limit setup
or assignment failure stops startup with `AGENT_JOB_SETUP_FAILED`; there is no
silent fallback. Unix process handling is unchanged.

This uses the already pinned `windows-sys 0.61.2` with Foundation, Security,
JobObjects and Threading features, without adding a new dependency version. The
parent integration task owns the real forced-Agent-exit regression. Agent/upstream
tests passed (19 + 20), as did `cargo fmt --check`, `cargo check`, the Agent build,
and all 15 workspace-smoke checks with attachment stdio open (fixture
`C:\Users\developer\AppData\Local\Temp\codex-harness-workspace-GjenUH`). The resulting
binary SHA256 is
`3CCF62FD08A79EBE0B35ACC7186BC86556E381E2275200C492AB75908571C0E8`.
The parent task's real-central transport regression also passed all five checks
(fixture `C:\Users\developer\AppData\Local\Temp\harness-fault-2N1vFR`), including
forced Agent process exit followed by confirmation that its executing command
was gone. The UI task also verified native window closure during execution:
desktop PID 19500, Agent 15876 and Node descendants 18532 → 21148 → 20876 all
exited, with no completion marker after 32 seconds and QA clients/devices 0/0.
The uncertain tool result remained `AGENT_DISCONNECTED`, `retryable:false`.
