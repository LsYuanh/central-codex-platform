// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Repackage only the native App; preserve the inventoried base runtime resources.
// Does not install, modify the profile, or change the signed runtime selection.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectPinnedService} from '../build/stage-central-service-resource.mjs';
import {digestFile} from '../build/stage-central-gateway.mjs';

assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [resources, packageId] = process.argv.slice(2);
assert.equal(process.argv.length, 4); assert(path.isAbsolute(resources));
assert(/^macos-arm64-node24-qa1-[a-f0-9]{16}$/.test(packageId));
const catalog = JSON.parse(await readFile(path.join(root, 'harness/central-service-catalog.json'), 'utf8'));
const pin = catalog.packages.find(p => p.id === packageId); assert(pin);
const service = path.join(resources, 'central-service', packageId);
await inspectPinnedService(service, pin);
const manifest = JSON.parse(await readFile(path.join(service, 'manifest.json'), 'utf8'));
const mapped = Object.fromEntries([{path: 'manifest.json'}, ...manifest.files]
  .map(f => [path.join(service, f.path), `central-service/${packageId}/${f.path}`]));
const output = path.join(root, 'target/central-app-only');
await mkdir(output, {recursive: true});
const overlay = path.join(output, 'tauri.config.json');
await writeFile(overlay, JSON.stringify({bundle: {active: true, targets: ['app'], resources: mapped,
  macOS: {minimumSystemVersion: '12.0', signingIdentity: '-'}}}));
function run(binary, args, cwd = root) {
  const r = spawnSync(binary, args, {cwd, env: process.env, stdio: 'inherit'});
  if (r.error || r.status !== 0) throw Error('APP_BUILD_FAILED');
}
run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--ci',
  '--debug', '--bundles', 'app', '--config', overlay, '--', '--locked', '--offline'], path.join(root, 'apps/central'));
const app = path.join(root, 'target/debug/bundle/macos/远舟中央管理.app');
await inspectPinnedService(path.join(app, 'Contents/Resources/central-service', packageId), pin);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const version = JSON.parse(await readFile(path.join(root, 'apps/central/src-tauri/tauri.conf.json'), 'utf8')).version;
const report = {app, version, packageId, baseRuntimePreserved: true, build: 'debug',
  signature: 'ad-hoc', notarized: false, binary: await digestFile(path.join(app, 'Contents/MacOS/central-app'))};
await writeFile(path.join(output, 'build-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({built: true, version, baseRuntimePreserved: true}));
