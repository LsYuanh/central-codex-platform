#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
# Central macOS only. No installation, production replacement, credential copying or port binding.
set -eu
if [ "$(uname -s)" != Darwin ]; then
  echo 'This launcher requires the reviewed macOS sandbox profile; no unconfined fallback.' >&2
  exit 64
fi
: "${CODEX_REMOTE_BINARY:?absolute path to the built, patched central codex binary}"
: "${CODEX_HOME:?independent central runtime data directory}"
: "${CODEX_REMOTE_WORKER_DIR:?independent empty central worker directory}"
case "$CODEX_REMOTE_BINARY:$CODEX_HOME:$CODEX_REMOTE_WORKER_DIR" in
  *'"'*|*'\'* ) echo 'Unsupported path characters' >&2; exit 64;;
esac
for path in "$CODEX_REMOTE_BINARY" "$CODEX_HOME" "$CODEX_REMOTE_WORKER_DIR"; do
  case "$path" in /*) ;; *) echo 'All runtime paths must be absolute' >&2; exit 64;; esac
done
[ -x "$CODEX_REMOTE_BINARY" ] || { echo 'Patched binary is missing' >&2; exit 66; }
# The configured executable is the small upstream codex-app-server binary.
# Accept the existing gateway's `app-server` argument without adding a second product entry point.
if [ "${1:-}" = app-server ]; then shift; fi
[ "$#" -eq 0 ] || { echo 'Only stdio app-server startup is supported by this launcher' >&2; exit 64; }
[ -d "$CODEX_HOME" ] && [ -d "$CODEX_REMOTE_WORKER_DIR" ] || { echo 'Create independent runtime directories first' >&2; exit 66; }
CODEX_HOME=$(cd "$CODEX_HOME" && pwd -P)
CODEX_REMOTE_WORKER_DIR=$(cd "$CODEX_REMOTE_WORKER_DIR" && pwd -P)
case "$CODEX_HOME:$CODEX_REMOTE_WORKER_DIR" in /:*|*:/) echo 'Root is not an allowed runtime directory' >&2; exit 64;; esac
if [ "$CODEX_HOME" = "$HOME" ] || [ "$CODEX_REMOTE_WORKER_DIR" = "$HOME" ]; then
  echo 'Whole user home cannot be a runtime allowlist' >&2; exit 64
fi
HARNESS_PROFILE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
AUTH_FILE=${CODEX_REMOTE_AUTH_FILE:-/dev/null}
case "$AUTH_FILE" in /*) ;; *) echo 'AUTH_FILE must be absolute' >&2; exit 64;; esac
# An optional existing auth.json may be symlinked by the operator into independent CODEX_HOME.
# Only its exact canonical target receives read permission; this script does not copy/read it.
# Upstream refresh rotates at the authority before saving auth.json. A read-only
# symlink alone cannot protect the shared credential from that network side effect.
# An unsupported URI scheme fails in the HTTP client before any request is sent.
if [ "$AUTH_FILE" != /dev/null ]; then
  export CODEX_REMOTE_AUTH_MODE=shared-readonly
  export CODEX_REFRESH_TOKEN_URL_OVERRIDE=disabled://read-only-shared-auth
  export CODEX_REVOKE_TOKEN_URL_OVERRIDE=disabled://read-only-shared-auth
  echo 'Remote harness auth: shared-readonly; refresh/revoke disabled before network. Expired credentials require renewal by their owning login; QA must not rotate them.' >&2
else
  export CODEX_REMOTE_AUTH_MODE=isolated-file
fi
mkdir -p "$CODEX_REMOTE_WORKER_DIR/tmp"
export CODEX_HOME
export CODEX_REMOTE_WORKSPACE=1
export CODEX_EXEC_SERVER_URL=none
export TMPDIR="$CODEX_REMOTE_WORKER_DIR/tmp"
cd "$CODEX_REMOTE_WORKER_DIR"
exec /usr/bin/sandbox-exec -f "$HARNESS_PROFILE_DIR/worker.sb" \
  -D "HARNESS_BINARY=$CODEX_REMOTE_BINARY" -D "CODEX_HOME=$CODEX_HOME" \
  -D "WORKER_DIR=$CODEX_REMOTE_WORKER_DIR" -D "AUTH_FILE=$AUTH_FILE" \
  "$CODEX_REMOTE_BINARY" "$@"
