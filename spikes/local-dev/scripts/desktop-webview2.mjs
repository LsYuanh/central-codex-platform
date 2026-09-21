// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = join(root, "apps/desktop/src-tauri/windows");
export const runtimeSpec = JSON.parse(readFileSync(join(windows, "webview2-runtime.json"), "utf8"));
export const cliVersion = "2.11.4";

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function assertRuntimeSpec(spec) {
  const url = new URL(spec.url);
  if (spec.schema !== 1 || !/^\d+\.\d+\.\d+\.\d+$/.test(spec.version) || spec.architecture !== "x64"
    || !/^[a-f0-9]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.bytes) || spec.bytes <= 0
    || url.protocol !== "https:" || url.hostname !== "msedge.sf.dl.delivery.mp.microsoft.com"
    || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith(`/Microsoft.WebView2.FixedVersionRuntime.${spec.version}.x64.cab`)) {
    throw Error("Invalid pinned WebView2 distribution manifest");
  }
}

// No symlinks, NSIS variables, quoting, or traversal in paths passed to the compiler.
export function nsisPath(path) {
  const absolute = resolve(path);
  if (/[\r\n"$]/.test(absolute)) throw Error("Unsupported character in NSIS path");
  return absolute;
}

export function runtimeFiles(directory) {
  const files = [];
  function visit(dir, prefix = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (/[\r\n"$]/.test(entry.name) || entry.isSymbolicLink()) throw Error("Unsafe runtime entry");
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), relative + "/");
      else if (entry.isFile()) files.push(relative);
      else throw Error("Unsupported runtime entry");
    }
  }
  visit(directory);
  return files;
}

export function assertX64Runtime(directory) {
  for (const file of ["msedgewebview2.exe", "msedge.dll", "icudtl.dat", "resources.pak"]) {
    if (!statSync(join(directory, file)).isFile()) throw Error(`Missing WebView2 file: ${file}`);
  }
  const bytes = readFileSync(join(directory, "msedgewebview2.exe"));
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    throw Error("WebView2 runtime must be Windows x64");
  }
}

export async function prepareRuntime(cache = join(root, "target/webview2-cache")) {
  if (process.platform !== "win32") throw Error("Prepare WebView2 on Windows");
  assertRuntimeSpec(runtimeSpec);
  cache = resolve(cache);
  mkdirSync(cache, { recursive: true });
  const cab = join(cache, `${runtimeSpec.version}.x64.cab`);
  if (!existsSync(cab)) {
    const response = await fetch(runtimeSpec.url, { redirect: "error", signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw Error(`WebView2 download failed: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(cab + ".partial"));
    if (statSync(cab + ".partial").size !== runtimeSpec.bytes || await sha256(cab + ".partial") !== runtimeSpec.sha256) {
      throw Error("WebView2 download size/hash mismatch; not using partial download");
    }
    renameSync(cab + ".partial", cab);
  }
  if (statSync(cab).size !== runtimeSpec.bytes || await sha256(cab) !== runtimeSpec.sha256) {
    throw Error("Cached WebView2 CAB size/hash mismatch; replace it with the pinned Microsoft CAB");
  }
  // Fresh extraction each time: no trust in a previously expanded, mutable tree.
  const extraction = join(cache, `verified-${Date.now()}`);
  mkdirSync(extraction);
  const expanded = spawnSync("expand.exe", [cab, "-F:*", extraction], { encoding: "utf8", windowsHide: true });
  if (expanded.error || expanded.status !== 0) throw Error(`WebView2 extraction failed: ${expanded.error ?? expanded.status}`);
  const directory = join(extraction, `Microsoft.WebView2.FixedVersionRuntime.${runtimeSpec.version}.x64`);
  assertX64Runtime(directory);
  const files = runtimeFiles(directory);
  const manifest = { schema: 1, version: runtimeSpec.version, architecture: "x64", cabSha256: runtimeSpec.sha256 };
  writeFileSync(join(directory, "yuan-zhou-runtime.json"), JSON.stringify(manifest) + "\n");
  files.push("yuan-zhou-runtime.json");
  return { directory, bytes: files.reduce((size, file) => size + statSync(join(directory, file)).size, 0),
    sizeKiB: files.reduce((size, file) => size + Math.ceil(statSync(join(directory, file)).size / 1024), 0), manifest };
}

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error(`NSIS template anchor changed: ${from}`);
  return source.replace(from, to);
}

// Used with the pinned Handlebars template and, in tests, an existing rendered NSIS script.
export function customizeTemplate(source, { include, runtimeDirectory, runtimeKiB = 0, withWebView2 = false }) {
  source = source.replaceAll("\r\n", "\n");
  source = replaceOnce(source, "; Installer pages, must be ordered as they appear", `${withWebView2 ? `!define YZ_WEBVIEW_SOURCE "${nsisPath(runtimeDirectory)}"` : ""}
!define YZ_WEBVIEW_PAYLOAD ${withWebView2 ? 1 : 0}
!define YZ_WEBVIEW_KIB ${runtimeKiB}
!include "${nsisPath(include)}"

; Installer pages, must be ordered as they appear`);
  source = replaceOnce(source, "!insertmacro MUI_PAGE_DIRECTORY", "!insertmacro MUI_PAGE_DIRECTORY\nPage custom YzWebViewPage YzWebViewPageLeave");
  source = replaceOnce(source, "\n\nSection EarlyChecks", "\n\nSection EarlyChecks\n  Call YzEnsureSelection");
  source = replaceOnce(source, "Function .onInit\n", "!insertmacro YZ_LANGUAGE_STRINGS\n\nFunction .onInit\n");
  // Cache the choice before the reinstall page can invoke the previous uninstaller.
  source = replaceOnce(source, '\nFunctionEnd\n\n\nSection EarlyChecks', '\n  Call YzEnsureSelection\n!if ${YZ_WEBVIEW_PAYLOAD} == 0\n  Call YzValidateRetainedRuntime\n!endif\nFunctionEnd\n\n\nSection EarlyChecks');
  // 0.2.4's old uninstaller removes the private runtime unless /UPDATE is passed.
  // This also covers interactive upgrades that elect to remove the old app first.
  source = replaceOnce(source, '      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE',
    '      !insertmacro YZ_PREVIOUS_UNINSTALL_ARGS');
  source = replaceOnce(source, "Section WebView2\n", "Section WebView2\n  ${If} $YzWebViewSelected == 1\n    Goto yz_system_webview_done\n  ${EndIf}\n");
  source = replaceOnce(source, "SectionEnd\n\nSection Install", "yz_system_webview_done:\nSectionEnd\n\nSection Install");
  source = replaceOnce(source, "Section Install\n", "Section Install YZ_MAIN_SECTION\n");
  source = replaceOnce(source, '  ; Copy main executable\n  File "${MAINBINARYSRCPATH}"', '  !insertmacro YZ_INSTALL_WEBVIEW\n  SetOutPath $INSTDIR\n\n  ; Copy main executable\n  File "${MAINBINARYSRCPATH}"');
  source = replaceOnce(source, '  IntOp $0 $0 + ${ESTIMATEDSIZE}', '  IntOp $0 $0 + ${ESTIMATEDSIZE}\n  ${If} $YzWebViewSelected == 1\n    IntOp $0 $0 + ${YZ_WEBVIEW_KIB}\n  ${EndIf}');
  source = replaceOnce(source, '  ; Delete the app directory and its content from disk\n', '  !insertmacro YZ_UNINSTALL_WEBVIEW\n\n  ; Delete the app directory and its content from disk\n');
  return source + "\n!insertmacro YZ_SIZE_FUNCTIONS\n";
}

export async function prepareInstaller(targetDir, { withWebView2 = false } = {}) {
  const installed = JSON.parse(readFileSync(join(root, "node_modules/@tauri-apps/cli/package.json"), "utf8")).version;
  if (installed !== cliVersion) throw Error("Review the WebView2 NSIS template when upgrading Tauri CLI");
  // A normal client update must not download, extract, or package the runtime.
  const runtime = withWebView2 ? await prepareRuntime() : undefined;
  const directory = join(targetDir, "webview2-installer");
  mkdirSync(directory, { recursive: true });
  const template = join(directory, "installer.nsi");
  writeFileSync(template, customizeTemplate(readFileSync(join(windows, "nsis/upstream-installer.nsi"), "utf8"), {
    include: join(windows, "nsis/webview2-component.nsh"), withWebView2,
    runtimeDirectory: runtime?.directory, runtimeKiB: runtime?.sizeKiB,
  }));
  return { template, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--prepare") throw Error("Usage: node scripts/desktop-webview2.mjs --prepare");
  console.log(JSON.stringify(await prepareRuntime(), null, 2));
}
