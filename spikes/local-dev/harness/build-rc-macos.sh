#!/bin/bash
# Developer-only native build of this repository's isolated release candidate.
set -euo pipefail
TOKEN_QA=false
if [ "${1:-}" = "--token" ] && [ "$#" = 1 ]; then TOKEN_QA=true; elif [ "$#" != 0 ]; then exit 2; fi
QA=/Users/operator/central-harness-qa-20260909
cd "$QA/rc-client-source"
test "$(pwd -P)" = "$QA/rc-client-source"
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export CARGO_HOME=/Users/operator/central-codex-platform/artifacts/macos-tools/cargo
export RUSTUP_HOME=/Users/operator/central-codex-platform/artifacts/macos-tools/rustup
export PATH=/Users/operator/central-codex-platform/artifacts/macos-tools/node/bin:$CARGO_HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin
export CARGO_BUILD_JOBS=2
export CARGO_TARGET_DIR="$QA/rc-client-source/target/desktop-rc-20260909"
npm ci --ignore-scripts --no-audit --no-fund
npm run build --workspace @central-codex-spike/agentrpc-types
npm run build --workspace @central-codex-spike/test-gateway
npm run check --workspace @central-codex-spike/desktop
cargo fmt --all -- --check
cargo check -p desktop-spike --locked
cargo test -p platform-security -p local-agent --locked
cargo build -p platform-security --examples --locked
if "$TOKEN_QA"; then
  npm run package:desktop -- --rc --rc-version 0.2.0-rc.4
else
  npm run package:desktop -- --rc --rc-version 0.2.0-rc.1
fi
printf 'RC_MACOS_BUILD_OK\n'
