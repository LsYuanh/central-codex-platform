// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Builds isolated, unsigned Debug installers. Never installs or launches them.
import { spawnSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPinnedService } from '../build/stage-central-service-resource.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = path.join(root, 'apps', 'central');
const tauri = path.join(app, 'src-tauri');
const packageId = 'windows-x64-node24-qa1-74b3e6f43896219f';
const manifestSha256 = '74b3e6f43896219f00d4e3fd8dffafe8f98ffc8c91c50e097a2d60d3f27a8449';
const identity = {
  productName: '远舟中央管理安装验收',
  identifier: 'com.yuanzhou.central.installqa20260911',
  mainBinaryName: 'yuanzhou-central-install-qa-20260911',
};
const usage = 'Usage: node scripts/release/package-central-qa.mjs --version 0.1.0|0.1.1 [--prepare-only]';
const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3 || args[0] !== '--version'
  || !['0.1.0', '0.1.1'].includes(args[1]) || (args.length === 3 && args[2] !== '--prepare-only')) throw Error(usage);
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('CENTRAL_QA_WINDOWS_X64_REQUIRED');
const version = args[1], prepareOnly = args[2] === '--prepare-only';
const qaRoot = path.join(root, 'target', 'central-install-qa');
const installDirectory = path.join(qaRoot, 'installed');
// Reuse the existing serial Cargo cache. Only immutable outputs are acceptance evidence.
const cargoTarget = path.join(root, 'target');
const runDirectory = path.join(qaRoot, version, `${Date.now()}-${randomUUID()}`);
const source = path.join(root, 'target', 'central-service', packageId);

async function noLinks(filename, allowMissing = false) {
  const absolute = path.resolve(filename); let prefix = path.parse(absolute).root;
  for (const part of absolute.slice(prefix.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, part);
    let stat;
    try { stat = await lstat(prefix); } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('CENTRAL_QA_PATH_UNSAFE');
  }
}
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function nsisString(value) {
  if (/[\r\n\0]/.test(value)) throw Error('CENTRAL_QA_PATH_UNSAFE');
  return value.replaceAll('$', '$$').replaceAll('"', '$\\"');
}
async function saveJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
const catalog = JSON.parse(await readFile(path.join(root, 'harness', 'central-service-catalog.json'), 'utf8'));
const trusted = catalog.packages?.find(entry => entry.id === packageId);
if (catalog.schemaVersion !== 1 || !trusted || trusted.qualified !== false
  || trusted.fileCount !== 864 || trusted.manifest.sha256 !== manifestSha256) throw Error('CENTRAL_QA_PIN_MISMATCH');
const manifest = await inspectPinnedService(source, trusted);
const base = JSON.parse(await readFile(path.join(tauri, 'tauri.conf.json'), 'utf8'));
const config = JSON.parse(await readFile(path.join(tauri, 'tauri.install-qa.conf.json'), 'utf8'));
for (const [key, value] of Object.entries(identity)) if (config[key] !== value) throw Error('CENTRAL_QA_IDENTITY_CHANGED');
if (base.identifier !== 'com.yuanzhou.central' || base.bundle?.active !== false
  || config.bundle?.windows?.nsis?.installMode !== 'currentUser'
  || config.bundle?.windows?.allowDowngrades !== false
  || config.bundle?.windows?.webviewInstallMode?.type !== 'skip') throw Error('CENTRAL_QA_CONFIGURATION_INVALID');
await noLinks(qaRoot, true); await noLinks(installDirectory, true); await noLinks(runDirectory, true);
await mkdir(runDirectory, { recursive: true });
const hook = path.join(runDirectory, 'installer-hooks.nsh');
await writeFile(hook, `!define CENTRAL_QA_INSTALL_DIR "${nsisString(installDirectory)}"\n!include "${nsisString(path.join(tauri, 'install-qa-hooks.nsh'))}"\n`, { flag: 'wx' });
config.version = version;
config.app = { windows: base.app.windows.map(window => ({ ...window, title: identity.productName })) };
config.bundle.externalBin = [];
config.bundle.resources = {};
// Explicit manifest entries prevent accidentally bundling fixtures, credentials,
// developer sources or newly added undeclared files in a resource directory.
for (const entry of [{ path: 'manifest.json' }, ...manifest.files]) {
  config.bundle.resources[path.join(source, ...entry.path.split('/'))] = `central-service/${packageId}/${entry.path}`;
}
config.bundle.windows.nsis.installerHooks = hook;
const generatedConfig = path.join(runDirectory, 'tauri.config.json');
await saveJson(generatedConfig, config);
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const commandArgs = [cli, 'build', '--ci', '--debug', '--bundles', 'nsis', '--config', generatedConfig, '--', '--locked', '--offline'];
const plan = {
  schemaVersion: 1, kind: 'central-install-qa', version, ...identity,
  profile: 'debug', qualified: false, signed: false, installMode: 'currentUser',
  packageId, manifestSha256, serviceFileCount: manifest.files.length,
  resourceFileCount: Object.keys(config.bundle.resources).length,
  installDirectory, appDataIdentifier: identity.identifier, runDirectory, cargoTarget,
  config: generatedConfig, command: process.execPath, arguments: commandArgs,
  configSha256: await digest(generatedConfig),
  hookWrapperSha256: await digest(hook),
  hookSourceSha256: await digest(path.join(tauri, 'install-qa-hooks.nsh')),
  prerequisites: ['Existing Microsoft Edge WebView2 Runtime'],
  behavior: { autoInstall: false, autoLaunch: false, systemService: false,
    downloadsWebview: false, appDataRetainedOnUninstall: true, runningAppBlocksMutation: true,
    downgradeAllowed: false, requiresExplicitInstallDirectory: true },
};
await saveJson(path.join(runDirectory, 'plan.json'), plan);
console.log(JSON.stringify(plan, null, 2));
if (prepareOnly) process.exit(0);

const env = { ...process.env, CARGO_TARGET_DIR: cargoTarget, CI: 'true' };
// Do not inherit another App's configuration, signing credentials or build profile.
for (const key of Object.keys(env)) if (/^(TAURI_CONFIG$|TAURI_SIGNING_|APPLE_|CARGO_PROFILE_|CARGO_BUILD_TARGET$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_BUILD_RUSTFLAGS$)/i.test(key)) delete env[key];
const result = spawnSync(process.execPath, commandArgs, { cwd: app, env, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  await saveJson(path.join(runDirectory, 'build-result.json'), { ok: false, version, exitCode: result.status,
    error: result.error?.code ?? 'TAURI_BUILD_FAILED', installed: false, qualified: false });
  throw result.error ?? Error(`TAURI_BUILD_FAILED:${result.status ?? result.signal}`);
}
try {
// The rendered template is the reviewable source of the shipped NSIS policy.
const nsi = path.join(cargoTarget, 'debug', 'nsis', 'x64', 'installer.nsi');
const nsiText = await readFile(nsi, 'utf8');
for (const literal of [
  `!define PRODUCTNAME "${identity.productName}"`,
  `!define MAINBINARYNAME "${identity.mainBinaryName}"`,
  `!define BUNDLEID "${identity.identifier}"`,
  `!define VERSION "${version}"`, '!define ARCH "x64"',
  // Tauri renders webviewInstallMode=skip as an empty mode. Every download or
  // embedded-installer branch in the local template matches a nonempty mode.
  '!define INSTALLMODE "currentUser"', '!define ALLOWDOWNGRADES "false"', '!define INSTALLWEBVIEW2MODE ""',
  '!define MINIMUMWEBVIEW2VERSION ""', '!define WEBVIEW2BOOTSTRAPPERPATH ""', '!define WEBVIEW2INSTALLERPATH ""',
]) if (!nsiText.includes(literal)) throw Error('CENTRAL_QA_RENDERED_INSTALLER_MISMATCH');
const bundleDirectory = path.join(cargoTarget, 'debug', 'bundle', 'nsis');
const expectedName = `${identity.productName}_${version}_x64-setup.exe`;
const entries = await readdir(bundleDirectory);
if (!entries.includes(expectedName)) throw Error('CENTRAL_QA_INSTALLER_MISSING');
const binary = path.join(cargoTarget, 'debug', `${identity.mainBinaryName}.exe`);
const artifacts = [];
for (const filename of [path.join(bundleDirectory, expectedName), binary, nsi,
  path.join(cargoTarget, 'debug', 'nsis', 'x64', 'utils.nsh'), path.join(tauri, 'install-qa-hooks.nsh')]) {
  await noLinks(filename);
  const destination = path.join(runDirectory, path.basename(filename));
  await copyFile(filename, destination, constants.COPYFILE_EXCL);
  artifacts.push({ file: path.basename(destination), bytes: (await lstat(destination)).size, sha256: await digest(destination) });
}
// Catch mutable staging changes made while compilation was running.
await inspectPinnedService(source, trusted);
await saveJson(path.join(runDirectory, 'build-result.json'), {
  schemaVersion: 1, ok: true, version, packageId, manifestSha256, artifacts,
  serviceFileCount: 864, profile: 'debug', qualified: false, installed: false,
});
console.log(`CENTRAL_QA_PACKAGE_OK: ${runDirectory}`);
} catch (error) {
  await saveJson(path.join(runDirectory, 'build-result.json'), {
    schemaVersion: 1, ok: false, version, installed: false, qualified: false,
    error: error.message, stage: 'post_build_verification',
  });
  throw error;
}
