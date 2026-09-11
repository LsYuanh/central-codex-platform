// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Read-only verification of one isolated NSIS install against an immutable build.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPinnedService } from './stage-central-service-resource.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qaRoot = path.join(root, 'target', 'central-install-qa');
const installDirectory = path.join(qaRoot, 'installed');
const productName = '远舟中央管理安装验收';
const identifier = 'com.yuanzhou.central.installqa20260911';
const mainBinaryName = 'yuanzhou-central-install-qa-20260911';
const packageId = 'windows-x64-node24-qa1-74b3e6f43896219f';
const manifestSha256 = '74b3e6f43896219f00d4e3fd8dffafe8f98ffc8c91c50e097a2d60d3f27a8449';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--build') throw Error('Usage: node scripts/verify-central-qa-installed.mjs --build <successful run directory>');
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('CENTRAL_QA_WINDOWS_X64_REQUIRED');
const build = path.resolve(args[1]);
const version = path.basename(path.dirname(build));
if (!['0.1.0', '0.1.1'].includes(version) || path.dirname(path.dirname(build)) !== qaRoot
  || !/^\d{13}-[a-f0-9-]{36}$/.test(path.basename(build))) throw Error('CENTRAL_QA_BUILD_PATH_INVALID');

async function noLinks(filename) {
  const absolute = path.resolve(filename); let prefix = path.parse(absolute).root;
  for (const part of absolute.slice(prefix.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, part);
    if ((await lstat(prefix)).isSymbolicLink()) throw Error('CENTRAL_QA_PATH_UNSAFE');
  }
}
async function fileStat(filename, maxBytes) {
  await noLinks(filename);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw Error('CENTRAL_QA_FILE_INVALID');
  return stat;
}
async function json(filename) {
  await fileStat(filename, 1024 * 1024);
  return JSON.parse(await readFile(filename, 'utf8'));
}
async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function hashBuffer(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
async function checkArtifact(result, filename) {
  const entries = result.artifacts.filter(entry => entry.file === filename);
  if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256)
    || !Number.isSafeInteger(entries[0].bytes) || entries[0].bytes <= 0) throw Error('CENTRAL_QA_ARTIFACT_INVALID');
  const target = path.join(build, filename), expected = entries[0];
  const stat = await fileStat(target, 1024 * 1024 * 1024);
  if (stat.size !== expected.bytes || await hashFile(target) !== expected.sha256) throw Error('CENTRAL_QA_ARTIFACT_HASH_MISMATCH');
  return target;
}

const plan = await json(path.join(build, 'plan.json'));
const result = await json(path.join(build, 'build-result.json'));
if (plan.schemaVersion !== 1 || plan.kind !== 'central-install-qa' || plan.version !== version
  || plan.productName !== productName || plan.identifier !== identifier || plan.mainBinaryName !== mainBinaryName
  || plan.installDirectory !== installDirectory || plan.appDataIdentifier !== identifier || plan.runDirectory !== build
  || plan.profile !== 'debug' || plan.qualified !== false || plan.signed !== false || plan.installMode !== 'currentUser'
  || plan.packageId !== packageId || plan.manifestSha256 !== manifestSha256 || plan.serviceFileCount !== 864
  || plan.resourceFileCount !== 865 || result.schemaVersion !== 1 || result.ok !== true || result.version !== version
  || result.packageId !== packageId || result.manifestSha256 !== manifestSha256 || result.serviceFileCount !== 864
  || result.profile !== 'debug' || result.qualified !== false || !Array.isArray(result.artifacts)) throw Error('CENTRAL_QA_BUILD_NOT_VERIFIED');
const installer = await checkArtifact(result, `${productName}_${version}_x64-setup.exe`);
const artifact = await checkArtifact(result, `${mainBinaryName}.exe`);
const installed = path.join(installDirectory, `${mainBinaryName}.exe`);
await fileStat(installed, 1024 * 1024 * 1024);
const original = await readFile(artifact), actual = await readFile(installed);
const unknownMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const nsisMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
const offset = original.indexOf(unknownMarker);
if (offset < 0 || original.indexOf(unknownMarker, offset + 1) !== -1) throw Error('CENTRAL_QA_BUNDLE_MARKER_INVALID');
// Tauri's NSIS bundler patches this used static marker while packaging, then the
// CLI leaves the original executable in the Cargo output. Permit only that exact
// in-memory transformation; even one additional byte difference rejects the install.
const normalized = Buffer.from(original);
nsisMarker.copy(normalized, offset);
if (!normalized.equals(actual)) throw Error('CENTRAL_QA_INSTALLED_BINARY_MISMATCH');
const catalog = await json(path.join(root, 'harness', 'central-service-catalog.json'));
const trusted = catalog.packages?.find(entry => entry.id === packageId);
if (catalog.schemaVersion !== 1 || trusted?.qualified !== false || trusted.fileCount !== 864
  || trusted.manifest?.sha256 !== manifestSha256) throw Error('CENTRAL_QA_PIN_MISMATCH');
await inspectPinnedService(path.join(installDirectory, 'central-service', packageId), trusted);
console.log(JSON.stringify({
  schemaVersion: 1, version, verified: true, qualified: false,
  installedBinarySha256: hashBuffer(actual), artifactBinarySha256: hashBuffer(original),
  installerSha256: await hashFile(installer), markerNormalized: true, markerOffset: offset,
  packageId, manifestSha256, serviceFileCount: 864, resourceFileCount: 865,
}, null, 2));
