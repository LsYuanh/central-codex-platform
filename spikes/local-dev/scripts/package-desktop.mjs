// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const args = process.argv.slice(2);
const usage = "Usage: node scripts/package-desktop.mjs [--debug] [--rc [--rc-version 0.2.0-rc.N]] [--plan]";
const flags = new Set();
let rcVersion;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (flags.has(arg) || !["--debug", "--rc", "--rc-version", "--plan"].includes(arg)) throw new Error(usage);
  flags.add(arg);
  if (arg === "--rc-version") rcVersion = args[++i];
}
const rc = flags.has("--rc");
if (flags.has("--rc-version") && (!rc || !/^0\.2\.0-rc\.[1-9]\d{0,3}$/.test(rcVersion ?? ""))) throw new Error(usage);
if (!["win32", "darwin"].includes(process.platform)) throw new Error("Package on a native Windows or macOS build host");
const debug = flags.has("--debug");
// Keep packaging outputs separate from the executable used by dev:desktop.
// RC builds must never reuse a caller's dev/formal target directory or TAURI_CONFIG.
const targetDir = resolve(root, rc ? "target/desktop-rc-20260909" : process.env.CARGO_TARGET_DIR ?? "target/desktop-package");
const env = { ...process.env, CARGO_TARGET_DIR: targetDir,
  // DMG creation must not depend on Finder automation / desktop permissions.
  CI: process.env.CI ?? "true",
  TAURI_BUNDLER_DMG_IGNORE_CI: process.env.TAURI_BUNDLER_DMG_IGNORE_CI ?? "false",
};
let config = "src-tauri/tauri.bundle.conf.json";
if (rc) {
  const base = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.bundle.conf.json"), "utf8"));
  const candidate = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.rc.conf.json"), "utf8"));
  const merged = { ...bundle, ...candidate,
    app: { windows: base.app.windows.map(window => ({ ...window, title: candidate.productName })) },
    bundle: { ...bundle.bundle, ...candidate.bundle,
      externalBin: [join(targetDir, "sidecars", "local-agent")],
      windows: { ...bundle.bundle.windows, ...candidate.bundle.windows,
        nsis: { ...bundle.bundle.windows.nsis, ...candidate.bundle.windows.nsis } },
      macOS: { ...bundle.bundle.macOS, ...candidate.bundle.macOS },
    },
  };
  if (rcVersion) merged.version = rcVersion;
  config = JSON.stringify(merged);
  delete env.TAURI_CONFIG;
  // RC artifacts are deliberately unsigned (macOS uses ad-hoc signing). Never consume
  // a developer's release/notarization credentials inherited from the shell.
  for (const key of Object.keys(env)) {
    if (/^(APPLE_|TAURI_SIGNING_)/i.test(key)) delete env[key];
  }
}
function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, { cwd: root, env, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result;
}
const host = run("rustc", ["--print", "host-tuple"], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).stdout.trim();
const supported = process.platform === "win32" ? ["x86_64-pc-windows-msvc"] : ["aarch64-apple-darwin", "x86_64-apple-darwin"];
if (!supported.includes(host)) throw new Error(`Unsupported package target: ${host}`);
if (flags.has("--plan")) {
  console.log(JSON.stringify({ rc, host, profile: debug ? "debug" : "release", targetDir,
    config: rc ? JSON.parse(config) : config,
    bundles: process.platform === "win32" ? ["nsis"] : ["app", "dmg"],
  }, null, 2));
  process.exit(0);
}
// --target prevents a user-level Cargo default target from producing a mismatched sidecar.
run("cargo", ["build", "-p", "local-agent", "--locked", "--target", host, ...(!debug ? ["--release"] : [])]);
const extension = process.platform === "win32" ? ".exe" : "";
const binary = join(targetDir, host, debug ? "debug" : "release", `local-agent${extension}`);
const sidecar = rc ? join(targetDir, "sidecars", `local-agent-${host}${extension}`)
  : join(desktop, "src-tauri", "binaries", `local-agent-${host}${extension}`);
mkdirSync(dirname(sidecar), { recursive: true });
copyFileSync(binary, sidecar);
if (process.platform !== "win32") chmodSync(sidecar, 0o755);
run(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build",
  "--ci", "--config", config, "--target", host,
  "--bundles", process.platform === "win32" ? "nsis" : "app,dmg", ...(debug ? ["--debug"] : []), "--", "--locked"], { cwd: desktop });
if (process.platform === "win32") {
  // Debug installers must be GUI applications too; a console-subsystem binary
  // opens an unwanted terminal when launched from the installed shortcut.
  const appBinary = readFileSync(join(targetDir, host, debug ? "debug" : "release", "desktop-spike.exe"));
  const pe = appBinary.readUInt32LE(0x3c);
  if (appBinary.readUInt32LE(pe) !== 0x00004550 || appBinary.readUInt16LE(pe + 24 + 68) !== 2) {
    throw new Error("DESKTOP_PACKAGE_REJECTED: Windows desktop executable must use the GUI subsystem");
  }
}
console.log(`DESKTOP_PACKAGE_OK: ${join(targetDir, host, debug ? "debug" : "release", "bundle")}`);
