#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
# Build in an explicitly supplied isolated directory on the central machine.
set -eu
: "${1:?usage: build-central.sh /absolute/isolated-build-directory}"
case "$1" in /*) ;; *) echo 'Use an absolute isolated build directory' >&2; exit 64;; esac
[ "$(uname -s)" = Darwin ] || { echo 'Only the central macOS target has been qualified' >&2; exit 64; }
HARNESS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
HARNESS_BUILD_ROOT=$1
mkdir -p "$HARNESS_BUILD_ROOT/source" "$HARNESS_BUILD_ROOT/cargo" "$HARNESS_BUILD_ROOT/target"
export CARGO_HOME="$HARNESS_BUILD_ROOT/cargo"
export CARGO_TARGET_DIR="$HARNESS_BUILD_ROOT/target"
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
# Select the reviewed Rust toolchain through PATH before invoking this script.
rustc --version
node "$HARNESS_DIR/fetch-source.mjs" "$HARNESS_BUILD_ROOT/source"
HARNESS_COMMIT=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).commit" "$HARNESS_DIR/upstream.json")
cd "$HARNESS_BUILD_ROOT/source/codex-$HARNESS_COMMIT/codex-rs"
cargo check -p codex-app-server --locked
cargo build -p codex-app-server --bin codex-app-server --locked
shasum -a 256 "$CARGO_TARGET_DIR/debug/codex-app-server"
printf 'Built the isolated harness. No service or installer was replaced.\n'
