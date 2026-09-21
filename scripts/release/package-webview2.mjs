// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nsisPath, prepareRuntime, runtimeSpec, sha256 } from "../build/desktop-webview2.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const windows = join(root, "apps/desktop/src-tauri/windows");
function literal(value) {
  if (typeof value !== "string" || !value || /[\r\n"$]/.test(value)) throw Error("Unsafe NSIS value");
  return value;
}

export function componentIdentity(rc = false) {
  const desktop = join(root, "apps/desktop/src-tauri");
  const base = JSON.parse(readFileSync(join(desktop, "tauri.conf.json"), "utf8"));
  const bundle = JSON.parse(readFileSync(join(desktop, "tauri.bundle.conf.json"), "utf8"));
  const candidate = rc ? JSON.parse(readFileSync(join(desktop, "tauri.rc.conf.json"), "utf8")) : {};
  const config = { ...base, ...candidate, bundle: { ...base.bundle, ...bundle.bundle, ...candidate.bundle,
    windows: { ...bundle.bundle.windows, ...candidate.bundle?.windows,
      nsis: { ...bundle.bundle.windows.nsis, ...candidate.bundle?.windows?.nsis } } } };
  if (config.bundle.windows.nsis.installMode !== "currentUser") throw Error("Review component installation when changing the client install mode");
  // Match Tauri's publisher fallback and existing 0.2.4 registry identity.
  const publisher = config.bundle.publisher ?? config.identifier.split(".")[1];
  return { productName: config.productName, mainBinaryName: config.mainBinaryName ?? "desktop-spike",
    registryKey: `Software\\${publisher}\\${config.productName}`, rc };
}

export function componentScript({ identity, runtimeDirectory, runtimeKiB, version = runtimeSpec.version, outfile }) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(runtimeKiB) || runtimeKiB <= 0) throw Error("Invalid component metadata");
  const definitions = { PRODUCTNAME: identity.productName, MAINBINARYNAME: identity.mainBinaryName,
    MANUPRODUCTKEY: identity.registryKey, YZ_RUNTIME_VERSION: version,
    YZ_COMPONENT_OUTFILE: nsisPath(outfile), YZ_COMPONENT_INCLUDE: join(windows, "nsis/webview2-component.nsh"),
    YZ_WEBVIEW_SOURCE: nsisPath(runtimeDirectory) };
  return Object.entries(definitions).map(([name, value]) => `!define ${name} "${literal(value)}"`).join("\n")
    + `\n!define YZ_WEBVIEW_KIB ${runtimeKiB}\n${identity.rc ? "!define YZ_RC_DIRECTORY\n" : ""}`
    + readFileSync(join(windows, "nsis/webview2-standalone.nsi"), "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => !["--rc", "--plan"].includes(a)) || new Set(args).size !== args.length) throw Error("Usage: node scripts/release/package-webview2.mjs [--rc] [--plan]");
  if (process.platform !== "win32") throw Error("Package WebView2 on Windows x64");
  const identity = componentIdentity(args.includes("--rc"));
  const output = join(root, "target", identity.rc ? "webview2-component-rc" : "webview2-component");
  const outfile = join(output, `yuanzhou-webview2${identity.rc ? "-rc" : ""}-${runtimeSpec.version}-x64-setup.exe`);
  if (args.includes("--plan")) {
    console.log(JSON.stringify({ identity, runtime: runtimeSpec, outfile, clientPayload: false }, null, 2));
    return;
  }
  const compiler = process.env.YZ_NSIS_COMPILER ?? join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");
  if (!existsSync(compiler)) throw Error("NSIS compiler not found. Install the existing Tauri NSIS toolchain or set YZ_NSIS_COMPILER.");
  const runtime = await prepareRuntime();
  mkdirSync(output, { recursive: true });
  const script = join(output, "component.nsi");
  writeFileSync(script, componentScript({ identity, runtimeDirectory: runtime.directory, runtimeKiB: runtime.sizeKiB, outfile }));
  const result = spawnSync(compiler, ["/INPUTCHARSET", "UTF8", script], { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw Error(`Component compiler failed: ${result.error ?? result.status}`);
  const report = { version: runtimeSpec.version, architecture: "x64", file: outfile, bytes: statSync(outfile).size, sha256: await sha256(outfile) };
  writeFileSync(outfile + ".sha256", `${report.sha256}  ${outfile.split(/[\\/]/).pop()}\n`);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
