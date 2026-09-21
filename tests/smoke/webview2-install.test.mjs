// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Opt-in native NSIS fixtures: no product binaries, real runtime, or user profiles.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nsisPath } from "../../scripts/build/desktop-webview2.mjs";
import { componentScript } from "../../scripts/release/package-webview2.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compiler = process.env.YZ_NSIS_COMPILER ?? join(process.env.LOCALAPPDATA ?? "", "tauri/NSIS/makensis.exe");
const enabled = process.platform === "win32" && process.env.YZ_RUN_NSIS_INSTALL_TESTS === "1";
test("native component install, lean update, repair, removal and uninstall preserve owned data", { skip: !enabled, timeout: 120000 }, async () => {
  assert(existsSync(compiler), "NSIS compiler is required");
  const parent = join(root, "target/webview2-install-tests"); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "run-")), install = join(directory, "installed"), runtime = join(directory, "payload");
  mkdirSync(runtime);
  const key = `Software\\YuanZhouRuntimeTests\\${directory.split(/[\\/]/).pop()}`;
  const include = join(root, "apps/desktop/src-tauri/windows/nsis/webview2-component.nsh");
  const required = ["msedgewebview2.exe", "msedge.dll", "icudtl.dat", "resources.pak", "yuan-zhou-runtime.json"];
  for (const file of required) writeFileSync(join(runtime, file), `synthetic fixture: ${file}`);
  const compile = (name, source) => {
    const script = join(directory, `${name}.nsi`);writeFileSync(script, source);
    const r = spawnSync(compiler, ["/V2", "/INPUTCHARSET", "UTF8", script], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return join(directory, `${name}.exe`);
  };
  const definitions = values => Object.entries(values).map(([k,v]) => `!define ${k} "${v}"`).join("\n") + "\n";
  const host = readFileSync(join(root, "tests/fixtures/webview2-install.nsi"), "utf8");
  const fixture = mode => compile(mode, definitions({ YZ_TEST_OUTFILE: nsisPath(join(directory, `${mode}.exe`)),
    YZ_TEST_INSTALLDIR: nsisPath(install), YZ_TEST_INCLUDE: nsisPath(include), MANUPRODUCTKEY: key,
    YZ_WEBVIEW_PAYLOAD: mode === "lean" ? 0 : 1, YZ_WEBVIEW_KIB: mode === "lean" ? 0 : 5,
    ...(mode === "lean" ? {} : { YZ_WEBVIEW_SOURCE: nsisPath(runtime) }) }) + host);
  const seed = fixture("legacy"), lean = fixture("lean");
  const component = compile("component", componentScript({ identity: { productName: "Yuan Zhou fixture", mainBinaryName: "fixture-client", registryKey: key, rc: false },
    runtimeDirectory: runtime, runtimeKiB: 5, outfile: join(directory, "component.exe") }));
  const run = (exe, args = [], expected = 0) => {
    const r = spawnSync(exe, ["/S", ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(r.status, expected, `${exe}: ${r.error ?? r.stderr ?? r.status}`);
  };
  const snapshot = () => Object.fromEntries(readdirSync(join(install, "WebView2Fixed")).map(name => {
    const file = join(install, "WebView2Fixed", name);
    return [name, { hash: createHash("sha256").update(readFileSync(file)).digest("hex"), mtime: statSync(file).mtimeMs }];
  }));
  const profile = () => assert.equal(readFileSync(join(install, "profile-sentinel.txt"), "utf8"), "pairing-and-history-fixture");
  try {
    run(component, [], 2); // No installed client: never create a stray runtime.
    run(seed, ["/SEED"]);
    run(lean);
    assert(!existsSync(join(install, "WebView2Fixed")));
    run(component);
    const before = snapshot();
    // Model a running/inaccessible executable using a real Windows deny-write lock.
    const lock = spawn("powershell.exe", ["-NoProfile", "-Command",
      "$held = [IO.File]::Open($env:YZ_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine('READY'); try { Start-Sleep -Seconds 30 } finally { $held.Dispose() }"],
    { env: { ...process.env, YZ_LOCK_FILE: join(install, "fixture-client.exe") }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const [ready] = await once(lock.stdout, "data", { signal: AbortSignal.timeout(10000) });
      assert.match(ready.toString(), /READY/);
      run(component, [], 2);assert.deepEqual(snapshot(), before);
    } finally {
      const exited = once(lock, "exit");lock.kill();await exited;
    }
    // A manual replacement invokes the previous uninstaller; /UPDATE must be appended.
    run(lean, ["/UPGRADE"]);assert.deepEqual(snapshot(), before);profile();
    run(lean, ["/UPDATE"]);assert.deepEqual(snapshot(), before);profile();
    run(lean, ["/WEBVIEW2=0"], 2);assert.deepEqual(snapshot(), before);
    unlinkSync(join(install, "WebView2Fixed/icudtl.dat"));
    writeFileSync(join(install, "fixture-client.exe"), "must-not-overwrite-on-failure");
    run(lean, ["/UPGRADE"], 2);
    assert.equal(readFileSync(join(install, "fixture-client.exe"), "utf8"), "must-not-overwrite-on-failure");
    run(component);assert.deepEqual(Object.keys(snapshot()), Object.keys(before));profile();
    run(component, ["/WEBVIEW2=0"]);
    assert(!existsSync(join(install, "WebView2Fixed")));assert(!existsSync(join(install, "webview2-component.enabled")));
    run(lean, ["/UPDATE"]);assert(!existsSync(join(install, "WebView2Fixed")));profile();
    run(component);
  } finally {
    if (existsSync(join(install, "uninstall.exe"))) {
      run(join(install, "uninstall.exe"), [`_?=${install}`]);
      assert(!existsSync(join(install, "WebView2Fixed")));profile();
    }
  }
  writeFileSync(join(directory, "verified.json"), JSON.stringify({ passed: true, syntheticOnly: true,
    cases: ["missing-client", "system-only", "component-add", "locked-client", "manual-replacement-retains-bytes-and-mtime", "update-retains-bytes-and-mtime", "lean-refuses-removal", "corrupt-blocks-before-overwrite", "repair", "component-remove", "uninstall-retains-profile"] }, null, 2));
});
