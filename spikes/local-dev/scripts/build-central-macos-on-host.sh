#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
set -eu
[ "$(uname -s):$(uname -m)" = Darwin:arm64 ] || exit 64
[ "$#" -eq 1 ] || { echo 'Usage: sh scripts/build-central-macos-on-host.sh /absolute/patched/codex-app-server' >&2; exit 64; }
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
WORKSPACE=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
REPOSITORY=$(CDPATH= cd -- "$WORKSPACE/../.." && pwd -P)
MAC_TOOLS="$REPOSITORY/artifacts/macos-tools"
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export CARGO_HOME="$MAC_TOOLS/cargo" RUSTUP_HOME="$MAC_TOOLS/rustup"
export PATH="$MAC_TOOLS/node/bin:$CARGO_HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CARGO_BUILD_JOBS=2
export TMPDIR="$WORKSPACE/target/central-macos/tmp"
mkdir -p "$TMPDIR"
chmod 700 "$TMPDIR"
cd "$WORKSPACE"
exec node scripts/package-central-macos.mjs --node-exe "$MAC_TOOLS/node/bin/node" --node-license "$MAC_TOOLS/node/LICENSE" --app-server "$1"
