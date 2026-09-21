// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Stage only the pinned QA candidate. This never starts a binary or certifies a
// production runtime; the native application independently verifies every file.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localDev = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(localDev, 'harness', 'central-runtime-catalog.json');
const outputRoot = path.join(localDev, 'target', 'central-runtime');

// Keep the pinned catalog byte-for-byte intact; only its historical source
// location for upstream license files moved with the source workspace.
export function runtimeSource(sourceRoot, sourcePath) {
  const relocated = sourcePath.replace(/^spikes\/local-dev\/harness\/upstream\//, 'harness/upstream/');
  return contained(sourceRoot, relocated);
}

export function contained(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes(':') ||
      relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('RUNTIME_PATH_UNSAFE');
  }
  const destination = path.resolve(root, relative);
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('RUNTIME_PATH_UNSAFE');
  return destination;
}

async function noLinks(candidate, allowMissing = false) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let prefix = parsed.root;
  for (const piece of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, piece);
    let metadata;
    try {
      metadata = await lstat(prefix);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error('RUNTIME_PATH_UNSAFE');
  }
}

export async function verifyFile(filename, expected) {
  await noLinks(filename);
  const metadata = await lstat(filename);
  if (!metadata.isFile()) throw new Error('RUNTIME_PATH_UNSAFE');
  if (metadata.size !== expected.bytes) throw new Error('RUNTIME_SIZE_MISMATCH');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    if (bytes > expected.bytes) throw new Error('RUNTIME_SIZE_MISMATCH');
    digest.update(chunk);
  }
  if (bytes !== expected.bytes) throw new Error('RUNTIME_SIZE_MISMATCH');
  if (digest.digest('hex') !== expected.sha256) throw new Error('RUNTIME_HASH_MISMATCH');
}

export async function stageRuntime(sourceRoot, id) {
  if (!path.isAbsolute(sourceRoot)) throw new Error('--source-root 必须是显式绝对路径。');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (catalog.schemaVersion !== 1) throw new Error('RUNTIME_CATALOG_INVALID');
  const spec = catalog.packages.find(candidate => candidate.id === id);
  if (!spec || spec.qualified !== false) throw new Error('RUNTIME_UNKNOWN_QA_CANDIDATE');
  // An explicit root names the repository containing the recorded build and
  // licenses. No arbitrary file mapping, manifest or output path is accepted.
  for (const file of spec.files) await verifyFile(runtimeSource(sourceRoot, file.sourcePath), file);
  await noLinks(outputRoot, true);
  await mkdir(outputRoot, { recursive: true });
  await noLinks(outputRoot);
  const destination = contained(outputRoot, spec.id);
  try {
    await lstat(destination);
    await noLinks(destination);
    for (const file of spec.files) await verifyFile(contained(destination, file.path), file);
    return { packageId: spec.id, destination, reused: true, qualified: false, ready: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // An existing partial destination must not be replaced or repaired silently.
    try {
      await lstat(destination);
      throw new Error('RUNTIME_DESTINATION_EXISTS_INCOMPLETE');
    } catch (missing) {
      if (missing.code !== 'ENOENT') throw missing;
    }
  }
  const temporary = contained(outputRoot, `.stage-${randomUUID()}`);
  await mkdir(temporary);
  try {
    for (const file of spec.files) {
      const staged = contained(temporary, file.path);
      await mkdir(path.dirname(staged), { recursive: true });
      await copyFile(runtimeSource(sourceRoot, file.sourcePath), staged, 1); // COPYFILE_EXCL
      await verifyFile(staged, file);
    }
    // rename is atomic within this volume; existing nonempty candidates are not
    // overwritten. Only this invocation's random staging directory is cleaned.
    await rename(temporary, destination);
    return { packageId: spec.id, destination, reused: false, qualified: false, ready: false };
  } finally {
    if (path.dirname(temporary) !== outputRoot || !path.basename(temporary).startsWith('.stage-')) {
      throw new Error('RUNTIME_PATH_UNSAFE');
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--source-root' || args[2] !== '--package-id') {
    console.error('Usage: node scripts/build/stage-central-runtime.mjs --source-root <absolute repository root> --package-id windows-x64-codex-0.153.4-qa1');
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await stageRuntime(args[1], args[3]), null, 2));
    } catch (error) {
      console.error(`Runtime staging failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
