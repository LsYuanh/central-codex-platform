// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copy an independently pinned complete service candidate into Tauri resources.
// No program is started. The native App checks the compiled pin independently.
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localDev = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(localDev, 'target', 'central-service');
const catalogPath = path.join(localDev, 'harness', 'central-service-catalog.json');
export function contained(root, key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || key.includes(':') || key.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw Error('RUNTIME_PATH_UNSAFE');
  const target = path.resolve(root, key);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw Error('RUNTIME_PATH_UNSAFE');
  return target;
}
async function noLinks(filename, allowMissing = false) {
  const absolute = path.resolve(filename); let prefix = path.parse(absolute).root;
  for (const part of absolute.slice(prefix.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, part);
    let stat;
    try { stat = await lstat(prefix); } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('RUNTIME_PATH_UNSAFE');
  }
}
async function verifyFile(filename, expected) {
  await noLinks(filename);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1) throw Error('RUNTIME_PATH_UNSAFE');
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 1024 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw Error('RUNTIME_MANIFEST_INVALID');
  if (stat.size !== expected.bytes) throw Error('RUNTIME_SIZE_MISMATCH');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length; if (bytes > expected.bytes) throw Error('RUNTIME_SIZE_MISMATCH'); hash.update(chunk);
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw Error('RUNTIME_HASH_MISMATCH');
}
export async function inspectPinnedService(directory, trusted) {
  await noLinks(directory);
  if (trusted.manifest.path !== 'manifest.json' || trusted.manifest.bytes > 2 * 1024 * 1024 || trusted.qualified !== false) throw Error('RUNTIME_CATALOG_INVALID');
  // Check the external trust anchor before parsing any manifest field/path.
  await verifyFile(path.join(directory, 'manifest.json'), trusted.manifest);
  const chunks = []; let manifestBytes = 0;
  for await (const chunk of createReadStream(path.join(directory, 'manifest.json'))) {
    manifestBytes += chunk.length;
    if (manifestBytes > trusted.manifest.bytes) throw Error('RUNTIME_SIZE_MISMATCH');
    chunks.push(chunk);
  }
  const manifestBuffer = Buffer.concat(chunks);
  if (manifestBytes !== trusted.manifest.bytes || createHash('sha256').update(manifestBuffer).digest('hex') !== trusted.manifest.sha256) throw Error('RUNTIME_HASH_MISMATCH');
  const manifest = JSON.parse(manifestBuffer.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'central-gateway-candidate' || manifest.ready !== false || manifest.qualified !== false || manifest.entrypoint !== trusted.entrypoint || manifest.files.length !== trusted.fileCount) throw Error('RUNTIME_MANIFEST_INVALID');
  const files = new Set(['manifest.json']), lower = new Set(['manifest.json']), folders = new Set();
  let bytes = 0;
  for (const item of manifest.files) {
    contained(directory, item.path);
    if (lower.has(item.path.toLowerCase())) throw Error('RUNTIME_PATH_UNSAFE');
    lower.add(item.path.toLowerCase()); files.add(item.path);
    let parent = path.posix.dirname(item.path);
    while (parent !== '.') { folders.add(parent); parent = path.posix.dirname(parent); }
    bytes += item.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > 1024 * 1024 * 1024) throw Error('RUNTIME_MANIFEST_INVALID');
    await verifyFile(contained(directory, item.path), item);
  }
  for (const key of [trusted.node, trusted.entrypoint, trusted.appServer, ...(trusted.platform==='darwin'?[trusted.seatbeltProfile]:[trusted.host,trusted.privateHelper])]) if (!files.has(key)) throw Error('RUNTIME_MANIFEST_INVALID');
  async function walk(folder, prefix = '') {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const key = `${prefix}${item.name}`;
      if (item.isSymbolicLink()) throw Error('RUNTIME_PATH_UNSAFE');
      if (item.isDirectory()) {
        if (!folders.has(key)) throw Error('RUNTIME_UNDECLARED_FILE');
        await walk(path.join(folder, item.name), `${key}/`);
      } else if (!item.isFile() || !files.has(key)) throw Error('RUNTIME_UNDECLARED_FILE');
    }
  }
  await walk(directory);
  return manifest;
}
export async function stageService(source, packageId) {
  if (!path.isAbsolute(source)) throw Error('EXPLICIT_ABSOLUTE_SOURCE_REQUIRED');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (catalog.schemaVersion !== 1) throw Error('RUNTIME_CATALOG_INVALID');
  const trusted = catalog.packages.find(entry => entry.id === packageId);
  if (!trusted) throw Error('RUNTIME_UNKNOWN_PACKAGE');
  const manifest = await inspectPinnedService(source, trusted);
  await noLinks(outputRoot, true); await mkdir(outputRoot, { recursive: true });
  const destination = contained(outputRoot, trusted.id);
  try {
    await lstat(destination);
    await inspectPinnedService(destination, trusted);
    return { packageId, destination, manifestSha256: trusted.manifest.sha256, fileCount: manifest.files.length, reused: true, ready: false, qualified: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await lstat(destination); throw Error('RUNTIME_DESTINATION_EXISTS_INCOMPLETE'); } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
  }
  const temporary = contained(outputRoot, `.stage-${randomUUID()}`); await mkdir(temporary);
  try {
    for (const entry of [trusted.manifest, ...manifest.files]) {
      const target = contained(temporary, entry.path); await mkdir(path.dirname(target), { recursive: true });
      await copyFile(contained(source, entry.path), target, constants.COPYFILE_EXCL);
    }
    await inspectPinnedService(temporary, trusted);
    await rename(temporary, destination);
    return { packageId, destination, manifestSha256: trusted.manifest.sha256, fileCount: manifest.files.length, reused: false, ready: false, qualified: false };
  } finally {
    if (path.dirname(temporary) !== outputRoot || !path.basename(temporary).startsWith('.stage-')) throw Error('UNSAFE_CLEANUP');
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--package-id') {
    console.error('Usage: node scripts/stage-central-service-resource.mjs --source <absolute staged gateway> --package-id <compiled service catalog ID>'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await stageService(args[1], args[3]), null, 2)); }
    catch (error) { console.error(`Service resource staging failed: ${error.message}`); process.exitCode = 1; }
  }
}
