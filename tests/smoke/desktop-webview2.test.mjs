// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRuntimeSpec, assertX64Runtime, customizeTemplate, nsisPath, runtimeSpec, prepareInstaller } from "../../scripts/build/desktop-webview2.mjs";
import { componentIdentity, componentScript } from "../../scripts/release/package-webview2.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const windows = join(root, "apps/desktop/src-tauri/windows");
const component = join(windows, "nsis/webview2-component.nsh");

test("pin accepts only the intended Microsoft x64 CAB", () => {
  assertRuntimeSpec(runtimeSpec);
  for (const change of [{ architecture: "x86" }, { sha256: "bad" }, { url: "https://example.com/runtime.cab" }, { version: "../other" }]) {
    assert.throws(() => assertRuntimeSpec({ ...runtimeSpec, ...change }));
  }
  assert.throws(() => nsisPath('C:/test/$INSTDIR'));
  assert.throws(() => nsisPath('C:/test/"bad'));
});

test("runtime architecture validation rejects mismatched executables", () => {
  const directory = mkdtempSync(join(tmpdir(), "yz-webview-pe-"));
  const pe = Buffer.alloc(256);
  pe.write("MZ"); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128); pe.writeUInt16LE(0x8664, 132);
  for (const file of ["msedge.dll", "icudtl.dat", "resources.pak"]) writeFileSync(join(directory, file), "fixture");
  writeFileSync(join(directory, "msedgewebview2.exe"), pe);
  assertX64Runtime(directory);
  pe.writeUInt16LE(0x14c, 132);
  writeFileSync(join(directory, "msedgewebview2.exe"), pe);
  assert.throws(() => assertX64Runtime(directory), /x64/);
});

test("pinned upstream template applies all integration points and rejects drift", () => {
  const template = readFileSync(join(windows, "nsis/upstream-installer.nsi"), "utf8").replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(template).digest("hex"), "20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079");
  const options = { include: component, runtimeDirectory: tmpdir(), runtimeKiB: 100 };
  const result = customizeTemplate(template, options);
  assert.ok(result.indexOf("Call YzEnsureSelection") < result.indexOf("Section EarlyChecks"));
  assert.match(result, /MUI_PAGE_DIRECTORY\nPage custom YzWebViewPage/);
  assert.match(result, /Section WebView2\n.*\n.*Goto yz_system_webview_done/);
  assert.match(result, /YZ_INSTALL_WEBVIEW/);
  assert.match(result, /YZ_UNINSTALL_WEBVIEW/);
  assert.match(result, /YZ_PREVIOUS_UNINSTALL_ARGS/);
  assert.match(result, /YZ_WEBVIEW_PAYLOAD 0/);
  assert.doesNotMatch(result, /!define YZ_WEBVIEW_SOURCE/);
  assert.match(customizeTemplate(template, { ...options, withWebView2: true }), /YZ_WEBVIEW_PAYLOAD 1/);
  assert.match(result, /NSIS_HOOK_PREINSTALL/);
  assert.throws(() => customizeTemplate(template.replace("Section WebView2", "Section Renamed"), options), /anchor changed/);
});

test("Windows release/RC plans keep optional behavior and existing RC hooks without downloading", { skip: process.platform !== "win32" }, () => {
  for (const flags of [[], ["--rc"], ["--updater"], ["--with-webview2"], ["--rc", "--with-webview2"]]) {
    const command = spawnSync(process.execPath, ["scripts/release/package-desktop.mjs", ...flags, "--plan"], { cwd: root, encoding: "utf8" });
    assert.equal(command.status, 0, command.stderr);
    const plan = JSON.parse(command.stdout);
    assert.equal(plan.optionalWebView2.defaultSelected, false);
    assert.equal(plan.optionalWebView2.preserveOnUpgrade, true);
    assert.equal(plan.optionalWebView2.bundled, flags.includes("--with-webview2"));
    assert.equal(plan.config.bundle.windows.webviewInstallMode.type, "downloadBootstrapper");
    assert.match(plan.config.bundle.windows.nsis.template, /webview2-installer/);
    if (flags.includes("--rc")) assert.equal(plan.config.bundle.windows.nsis.installerHooks, "rc-installer-hooks.nsh");
  }
});

test("lean template preparation needs no runtime or CAB", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yz-webview-lean-"));
  const result = await prepareInstaller(directory);
  assert.equal(result.runtime, undefined);
  assert.doesNotMatch(readFileSync(result.template, "utf8"), /!define YZ_WEBVIEW_SOURCE/);
});

test("standalone component targets the existing formal/RC identity", () => {
  assert.equal(componentIdentity().registryKey, "Software\\centralcodex\\远舟");
  assert.equal(componentIdentity(true).registryKey, "Software\\Central Codex RC QA\\远舟 RC 20260909");
  assert.equal(componentIdentity(true).mainBinaryName, "yuan-zhou-rc");
  const script = componentScript({ identity: componentIdentity(), runtimeDirectory: tmpdir(), runtimeKiB: 100,
    outfile: join(tmpdir(), "component-setup.exe") });
  assert.match(script, /ReadRegStr \$INSTDIR HKCU/);
  assert.doesNotMatch(script, /WriteUninstaller/);
  assert.throws(() => componentScript({ identity: { ...componentIdentity(), productName: "$INSTDIR" },
    runtimeDirectory: tmpdir(), runtimeKiB: 100, outfile: join(tmpdir(), "component.exe") }), /Unsafe NSIS/);
});

const makensis = process.env.YZ_NSIS_COMPILER ?? join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");
test("native NSIS preprocessor validates component macros without creating an installer", { skip: process.platform !== "win32" || !existsSync(makensis) }, () => {
  const directory = mkdtempSync(join(tmpdir(), "yz-webview-nsis-"));
  writeFileSync(join(directory, "runtime-fixture.txt"), "Preprocess only, not a runnable runtime");
  const script = `Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!define MANUPRODUCTKEY "Software\\YuanZhouWebViewPreprocess"
!define YZ_WEBVIEW_SOURCE "${nsisPath(directory)}"
!define YZ_WEBVIEW_KIB 100
Var PassiveMode
Var UpdateMode
!include "${nsisPath(component)}"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro YZ_LANGUAGE_STRINGS
Page custom YzWebViewPage YzWebViewPageLeave
Function .onInit
Call YzEnsureSelection
FunctionEnd
Section Install YZ_MAIN_SECTION
!insertmacro YZ_INSTALL_WEBVIEW
SectionEnd
Section Uninstall
!insertmacro YZ_UNINSTALL_WEBVIEW
SectionEnd
!insertmacro YZ_SIZE_FUNCTIONS
`;
  const scriptPath = join(directory, "component.nsi");
  writeFileSync(scriptPath, script);
  const result = spawnSync(makensis, ["/INPUTCHARSET", "UTF8", "/PPO", scriptPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WebView2Fixed/);
  assert.doesNotMatch(result.stdout, /\$\{LANG_/);
  assert.equal(existsSync(join(directory, "setup.exe")), false);
});
