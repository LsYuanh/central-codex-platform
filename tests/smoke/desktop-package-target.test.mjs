// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
function plan(...args) {
  return spawnSync(process.execPath, ["scripts/release/package-desktop.mjs", ...args, "--plan"], { cwd, encoding: "utf8" });
}

test("packaging rejects missing, duplicate and foreign-platform targets before building", () => {
  const foreign = process.platform === "darwin" ? "x86_64-pc-windows-msvc" : "x86_64-apple-darwin";
  for (const args of [["--target"], ["--target", "unknown"], ["--target", foreign], ["--target", foreign, "--target", foreign]]) {
    const result = plan(...args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Usage:|Unsupported package target|native Windows or macOS/);
  }
});

test("Mac cross-build plans select matching native resources and preserve ARM minimum", { skip: process.platform !== "darwin" }, () => {
  for (const [target, arch, minimum] of [["x86_64-apple-darwin", "x64", "13.0"], ["aarch64-apple-darwin", "arm64", "11.0"]]) {
    for (const flags of [[], ["--updater"], ["--rc"]]) {
      const result = plan("--target", target, ...flags);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.target, target);
      assert.equal(output.documentRuntimeArch, arch);
      assert.equal(output.config.bundle.macOS.minimumSystemVersion, minimum);
      assert.deepEqual(output.bundles, ["app", "dmg"]);
    }
  }
});
