// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPortableWindowsRuntime } from "../build/windows-runtime-check.mjs";
import { prepareInstaller, runtimeSpec } from "../build/desktop-webview2.mjs";
import { prepareDocumentRuntime } from "../build/document-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktop = join(root, "apps", "desktop");
const args = process.argv.slice(2);
const usage = "Usage: node scripts/release/package-desktop.mjs [--target TARGET] [--debug] [--rc [--rc-version 0.2.0-rc.N]] [--updater [--release-version X.Y.Z]] [--with-webview2] [--plan]";
const flags = new Set();
let rcVersion;
let releaseVersion;
let requestedTarget;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (flags.has(arg) || !["--target", "--debug", "--rc", "--rc-version", "--plan", "--updater", "--release-version", "--with-webview2"].includes(arg)) throw new Error(usage);
  flags.add(arg);
  if (arg === "--rc-version") rcVersion = args[++i];
  if (arg === "--release-version") releaseVersion = args[++i];
  if (arg === "--target") requestedTarget = args[++i];
}
if (flags.has("--target") && (!requestedTarget || requestedTarget.startsWith("--"))) throw new Error(usage);
const rc = flags.has("--rc");
const updater = flags.has("--updater");
const withWebView2 = flags.has("--with-webview2");
if (withWebView2 && process.platform !== "win32") throw Error("--with-webview2 is Windows-only");
if (updater && (rc || flags.has("--debug"))) throw Error("Signed updates require a formal release build");
if (flags.has("--release-version") && (!updater || !/^\d+\.\d+\.\d+$/.test(releaseVersion ?? ""))) throw Error(usage);
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
if (updater) {
  const bundle = JSON.parse(readFileSync(join(desktop, config), "utf8"));
  config = JSON.stringify({ ...bundle, ...(releaseVersion ? { version: releaseVersion } : {}), bundle: { ...bundle.bundle, createUpdaterArtifacts: true } });
  delete env.TAURI_CONFIG;
  if (!flags.has("--plan")) {
    const localKey = join(root, "secrets", "updater.key");
    if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(localKey)) env.TAURI_SIGNING_PRIVATE_KEY = localKey;
    if (!env.TAURI_SIGNING_PRIVATE_KEY) throw Error("Set TAURI_SIGNING_PRIVATE_KEY to the release signing key; never distribute it with installers");
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
  }
}
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
const target = requestedTarget ?? host;
const supported = process.platform === "win32" ? ["x86_64-pc-windows-msvc"] : ["aarch64-apple-darwin", "x86_64-apple-darwin"];
if (!supported.includes(target)) throw new Error(`Unsupported package target: ${target}`);
// Native resources follow the output target, which can differ from Node on a Mac build host.
const targetArch = target.startsWith("aarch64-") ? "arm64" : "x64";
if (process.platform === "darwin") {
  const bundleConfig = config.startsWith("{") ? JSON.parse(config) : JSON.parse(readFileSync(join(desktop, config), "utf8"));
  // The Intel distribution targets Ventura; use the same floor for the app and sidecar.
  if (targetArch === "x64") bundleConfig.bundle.macOS.minimumSystemVersion = "13.0";
  env.MACOSX_DEPLOYMENT_TARGET = bundleConfig.bundle.macOS.minimumSystemVersion;
  config = JSON.stringify(bundleConfig);
  delete env.TAURI_CONFIG;
}
if (process.platform === "win32") {
  const bundleConfig = config.startsWith("{") ? JSON.parse(config) : JSON.parse(readFileSync(join(desktop, config), "utf8"));
  // Do not use Tauri's fixedRuntime mode: it unconditionally selects a private
  // runtime, including on machines whose users did not install the component.
  bundleConfig.bundle.windows.webviewInstallMode = { type: "downloadBootstrapper" };
  bundleConfig.bundle.windows.nsis.template = join(targetDir, "webview2-installer", "installer.nsi");
  config = JSON.stringify(bundleConfig);
  delete env.TAURI_CONFIG;
}
if (flags.has("--plan")) {
  console.log(JSON.stringify({ rc, host, target, documentRuntimeArch: targetArch, profile: debug ? "debug" : "release", targetDir,
    config: config.startsWith("{") ? JSON.parse(config) : config,
    ...(process.platform === "win32" ? { optionalWebView2: { ...runtimeSpec, bundled: withWebView2, defaultSelected: false, preserveOnUpgrade: true } } : {}),
    bundles: process.platform === "win32" ? ["nsis"] : ["app", "dmg"],
  }, null, 2));
  process.exit(0);
}
if (process.platform === "win32") await prepareInstaller(targetDir, { withWebView2 });
const documentRuntime = await prepareDocumentRuntime(join(targetDir, target, "document-runtime"), process.platform, targetArch);
const documentConfig = config.startsWith("{") ? JSON.parse(config) : JSON.parse(readFileSync(join(desktop, config), "utf8"));
documentConfig.bundle.resources = {
  ...(documentConfig.bundle.resources ?? {}),
  [documentRuntime.library]: documentRuntime.name,
  [documentRuntime.notices]: "PDFium-LICENSE",
};
config = JSON.stringify(documentConfig);
// Tauri sets static CRT flags for its own build; our separate Cargo sidecar build
// must do the same so fresh Windows machines do not need vc_redist installed.
const agentEnv = { ...env };
if (process.platform === "win32") {
  if (agentEnv.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    agentEnv.CARGO_ENCODED_RUSTFLAGS += `${agentEnv.CARGO_ENCODED_RUSTFLAGS ? "\x1f" : ""}-C\x1ftarget-feature=+crt-static`;
  } else {
    agentEnv.RUSTFLAGS = `${agentEnv.RUSTFLAGS ?? ""} -C target-feature=+crt-static`.trim();
  }
}
// --target prevents a user-level Cargo default target from producing a mismatched sidecar.
run("cargo", ["build", "-p", "local-agent", "--locked", "--target", target, ...(!debug ? ["--release"] : [])], { env: agentEnv });
const extension = process.platform === "win32" ? ".exe" : "";
const binary = join(targetDir, target, debug ? "debug" : "release", `local-agent${extension}`);
if (process.platform === "win32") assertPortableWindowsRuntime(binary);
const sidecar = rc ? join(targetDir, "sidecars", `local-agent-${target}${extension}`)
  : join(desktop, "src-tauri", "binaries", `local-agent-${target}${extension}`);
mkdirSync(dirname(sidecar), { recursive: true });
copyFileSync(binary, sidecar);
if (process.platform !== "win32") chmodSync(sidecar, 0o755);
run(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build",
  "--ci", "--config", config, "--target", target,
  "--bundles", process.platform === "win32" ? "nsis" : "app,dmg", ...(debug ? ["--debug"] : []), "--", "--locked"], { cwd: desktop });
if (process.platform === "win32") {
  const binaryName = config.startsWith("{") ? JSON.parse(config).mainBinaryName ?? "desktop-spike" : "desktop-spike";
  const desktopBinary = join(targetDir, target, debug ? "debug" : "release", `${binaryName}.exe`);
  assertPortableWindowsRuntime(desktopBinary);
  // Debug installers must be GUI applications too; a console-subsystem binary
  // opens an unwanted terminal when launched from the installed shortcut.
  const appBinary = readFileSync(desktopBinary);
  const pe = appBinary.readUInt32LE(0x3c);
  if (appBinary.readUInt32LE(pe) !== 0x00004550 || appBinary.readUInt16LE(pe + 24 + 68) !== 2) {
    throw new Error("DESKTOP_PACKAGE_REJECTED: Windows desktop executable must use the GUI subsystem");
  }
  const installers = join(targetDir, target, debug ? "debug" : "release", "bundle", "nsis");
  for (const name of readdirSync(installers).filter(name => name.endsWith(".exe"))) {
    if (statSync(join(installers, name)).size > 512 * 1024 * 1024) {
      throw Error("Windows installer exceeds the client's 512 MiB update limit");
    }
  }
}
console.log(`DESKTOP_PACKAGE_OK: ${join(targetDir, target, debug ? "debug" : "release", "bundle")}`);
