# Central QA authentication lifecycle

> 公开副本已脱敏：文中的示例主机、用户目录和私有部署路径不是可直接执行的现场配置；原始记录由维护者私有保管。测试结论与未验收项保持原意。

> This describes the historical read-only QA authentication mode. Current managed central authentication and shared-login renewal are documented in the [model authentication manual](../docs/模型认证维护手册.md).

This is the 2026-09-09 fixed-source follow-up, not production credential management.
The 4510 service and its auth file are outside the QA mutation boundary.

## Source finding

In pinned `codex-rs/login/src/auth/manager.rs`, `refresh_and_persist_chatgpt_token`
calls the authority first (line 3017) and only then calls `persist_tokens` (line 3019).
`persist_tokens` updates `last_refresh` and calls the storage backend.
`login/src/auth/storage.rs` opens `CODEX_HOME/auth.json` with write/create/truncate;
this follows a symlink. Therefore an OS denial of writes to the shared target does
**not** prevent the earlier network refresh from rotating that credential.

The same manager refreshes proactively when the access JWT expires within five
minutes, or, without a usable expiry, when `last_refresh` is older than eight days.
An unauthorized response also enters the native refresh recovery path. Guarded
reload can adopt credentials refreshed by the owning login without issuing another
refresh when the on-disk identity still matches.

## Safe modes

`launch-central.sh` keeps its existing arguments and defaults. A non-`/dev/null`
`CODEX_REMOTE_AUTH_FILE` selects **shared-readonly**. The launcher unconditionally
overwrites `CODEX_REMOTE_AUTH_MODE`, `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and
`CODEX_REVOKE_TOKEN_URL_OVERRIDE`; a caller cannot point shared refresh back at the
real authority. The forced `disabled://read-only-shared-auth` scheme fails in the
HTTP client before any network request. The exact shared file stays read-only in
the unchanged `worker.sb`. The launcher emits a clear diagnosis to stderr.

With `CODEX_REMOTE_AUTH_FILE=/dev/null`, the mode is **isolated-file**: credentials
owned by the independent writable CODEX_HOME can use upstream refresh/persistence.
This mode has only been qualified with generated fake credentials here. A dedicated
real login and credential ownership must be established before treating it as a
long-running production service. QA never copies, prints, logs out, revokes, or
forces refresh of the 4510 shared credential.

Shared-readonly mode deliberately has a finite authentication lifetime. Expiry is
a terminal failure requiring renewal by the credential's owning login; it cannot
honestly be described as autonomous long-running authentication. The native failed
Turn includes `disabled://read-only-shared-auth`, which the gateway can translate
into an actionable user-facing error. No retry loop or central execution fallback
is added by this protection.

## Actual compiled-Rust verification

`auth-refresh-smoke.mjs` creates all its credential bytes under its new QA fixture
directory. It uses the actual pinned compiled App Server and the actual strict
macOS profile against a loopback OAuth/Responses fixture, never an official auth
endpoint. `HARNESS_AUTH_REFRESH_OK` passed at
`/Users/operator/central-harness-qa-20260909/auth-refresh-GTq3FU/result.json`:

| Case | Verified result |
| --- | --- |
| Unguarded external fake auth link | Authority refresh occurs once; write is denied and old disk token remains, reproducing the risk |
| Independent owned fake auth | Refresh occurs once, new token and last_refresh persist; process restart reloads them without another refresh |
| Protected expired external fake auth | Caller endpoint override is defeated; zero refresh requests, original file unchanged, two model 401 requests, failed Turn after 119 ms |

This proves local semantics and failure behavior, not a real shared-token refresh,
keychain login, a multi-day soak, or every possible TLS/proxy condition. The native
binary and OS profile were unchanged by the protection; only the launcher and QA
tooling changed. Runtime failure artifacts contain only generated fixture tokens.

## Controlled QA restart and failure injection

Run `qa-control.mjs` only on the central Mac with its existing Node 24 runtime.
It is pinned to the authorized QA root, 4529 LAN listener and compiled fork hash.
It sets controls/history-fixture flags only for this QA listener; it never starts
or stops 4510. Commands are `start`, `status`, `stop`, and `crash-runtime`.

`start` refuses an occupied port or existing tracked gateway, retains logs/data,
and records PID, process start time, command, cwd, direct fork identity and formal
service baseline in `qa-control-state.json`. `stop` revalidates these identities
and the listener before TERM, then verifies exit and reports 4510 health. It refuses
untracked or unexpected children. `crash-runtime` performs the same checks and sends
SIGKILL to only the recorded QA fork for a specifically coordinated fault test;
it does not kill the gateway or any client process. To restart, stop the old gateway
then start with the same isolated session data. No files or auth links are removed.
