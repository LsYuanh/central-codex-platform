// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--debug")) throw new Error("Usage: npm run package:desktop -- [--debug]");
if (!["win32", "darwin"].includes(process.platform)) throw new Error("Package on a native Windows or macOS build host");
const debug = args.includes("--debug");
// Keep packaging outputs separate from the executable used by dev:desktop.
const targetDir = resolve(root, process.env.CARGO_TARGET_DIR ?? "target/desktop-package");
const env = { ...process.env, CARGO_TARGET_DIR: targetDir,
  // DMG creation must not depend on Finder automation / desktop permissions.
  CI: process.env.CI ?? "true",
  TAURI_BUNDLER_DMG_IGNORE_CI: process.env.TAURI_BUNDLER_DMG_IGNORE_CI ?? "false",
};
function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { cwd: root, env, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result;
}
const host = run("rustc", ["--print", "host-tuple"], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).stdout.trim();
const supported = process.platform === "win32" ? ["x86_64-pc-windows-msvc"] : ["aarch64-apple-darwin", "x86_64-apple-darwin"];
if (!supported.includes(host)) throw new Error(`Unsupported package target: ${host}`);
// --target prevents a user-level Cargo default target from producing a mismatched sidecar.
run("cargo", ["build", "-p", "local-agent", "--locked", "--target", host, ...(!debug ? ["--release"] : [])]);
const extension = process.platform === "win32" ? ".exe" : "";
const binary = join(targetDir, host, debug ? "debug" : "release", `local-agent${extension}`);
const sidecar = join(desktop, "src-tauri", "binaries", `local-agent-${host}${extension}`);
mkdirSync(dirname(sidecar), { recursive: true });
copyFileSync(binary, sidecar);
if (process.platform !== "win32") chmodSync(sidecar, 0o755);
run(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build",
  "--ci", "--config", "src-tauri/tauri.bundle.conf.json", "--target", host,
  "--bundles", process.platform === "win32" ? "nsis" : "app,dmg", ...(debug ? ["--debug"] : []), "--", "--locked"], { cwd: desktop });
console.log(`DESKTOP_PACKAGE_OK: ${join(targetDir, host, debug ? "debug" : "release", "bundle")}`);
