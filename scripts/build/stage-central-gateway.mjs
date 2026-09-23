// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// A reproducible local candidate, not a trust anchor or production qualification.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localDev = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = path.join(localDev, 'target', 'central-gateway');
const run = promisify(execFile);
export function inside(root, relative) {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.split('/').some(x => !x || x === '.' || x === '..')) throw Error('UNSAFE_PATH');
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw Error('UNSAFE_PATH');
  return resolved;
}
async function safePath(filename, missing = false) {
  const absolute = path.resolve(filename);
  let prefix = path.parse(absolute).root;
  for (const component of absolute.slice(prefix.length).split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, component);
    let info;
    try { info = await lstat(prefix); } catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw Error('LINK_NOT_ALLOWED');
  }
}
export async function digestFile(filename) {
  await safePath(filename);
  const info = await lstat(filename);
  if (!info.isFile()) throw Error('REGULAR_FILE_REQUIRED');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    if (bytes > info.size) throw Error('SOURCE_CHANGED');
    hash.update(chunk);
  }
  if (bytes !== info.size) throw Error('SOURCE_CHANGED');
  return { bytes, sha256: hash.digest('hex') };
}
async function json(filename) { return JSON.parse(await readFile(filename, 'utf8')); }

export function dependencyClosure(lock, gateway) {
  const pending = [{ key: 'services/central-gateway', dependencies: gateway.dependencies ?? {} }];
  const selected = new Map();
  const omittedOptional = [];
  while (pending.length) {
    const current = pending.shift();
    for (const name of Object.keys(current.dependencies).sort()) {
      if (name === '@central-codex-spike/agentrpc-types') continue;
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw Error('INVALID_PACKAGE_NAME');
      let parent = current.key;
      let key;
      while (true) {
        const candidate = `${parent ? `${parent}/` : ''}node_modules/${name}`;
        if (lock.packages[candidate]) { key = candidate; break; }
        if (!parent) break;
        parent = path.posix.dirname(parent);
        if (parent === '.') parent = '';
      }
      if (!key) {
        if (current.optional?.includes(name)) { omittedOptional.push(name); continue; }
        throw Error(`MISSING_LOCK_DEPENDENCY:${name}`);
      }
      if (selected.has(key)) continue;
      const entry = lock.packages[key];
      if (entry.link || !entry.version || !entry.integrity) throw Error(`UNPINNED_DEPENDENCY:${name}`);
      selected.set(key, entry);
      const requiredPeers = Object.fromEntries(Object.entries(entry.peerDependencies ?? {}).filter(([peer]) => !entry.peerDependenciesMeta?.[peer]?.optional));
      pending.push({ key, dependencies: { ...entry.dependencies, ...requiredPeers, ...entry.optionalDependencies }, optional: Object.keys(entry.optionalDependencies ?? {}) });
      omittedOptional.push(...Object.keys(entry.peerDependencies ?? {}).filter(peer => entry.peerDependenciesMeta?.[peer]?.optional));
    }
  }
  return { selected, omittedOptional: [...new Set(omittedOptional)].sort() };
}

export async function verifyCandidate(directory) {
  await safePath(directory);
  const manifest = await json(path.join(directory, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'central-gateway-candidate' || manifest.entrypoint !== 'app/gateway/dist/index.js' || manifest.node?.path !== (manifest.node?.platform==='darwin'?'bin/node':'bin/node.exe') || manifest.ready !== false || manifest.qualified !== false || !Array.isArray(manifest.files)) throw Error('INVALID_MANIFEST');
  const known = new Set();
  for (const file of manifest.files) {
    if (known.has(file.path)) throw Error('DUPLICATE_PATH');
    known.add(file.path);
    const actual = await digestFile(inside(directory, file.path));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw Error(`INTEGRITY_MISMATCH:${file.path}`);
  }
  async function inventory(folder, relative = '') {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const key = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw Error('LINK_NOT_ALLOWED');
      if (item.isDirectory()) await inventory(path.join(folder, item.name), key);
      else if (!item.isFile() || (key !== 'manifest.json' && !known.has(key))) throw Error(`UNDECLARED_FILE:${key}`);
    }
  }
  await inventory(directory);
  return manifest;
}

export async function stageGateway({ sourceRoot, nodeExe, nodeLicense, workerHost, appServer, nativeHelper, seatbeltProfile, upstream }) {
  const mac=process.platform==='darwin';
  if(mac&&(workerHost||nativeHelper))throw Error('MACOS_NATIVE_ARTIFACTS_INVALID');
  const nativePaths=mac?[appServer,seatbeltProfile]:[workerHost,appServer,nativeHelper];
  if(nativePaths.some(Boolean)&&!nativePaths.every(value=>typeof value==='string'&&path.isAbsolute(value)))throw Error('ALL_NATIVE_ARTIFACT_PATHS_REQUIRED');
  if (![sourceRoot, nodeExe, nodeLicense].every(value => typeof value === 'string' && path.isAbsolute(value))) throw Error('EXPLICIT_ABSOLUTE_SOURCES_REQUIRED');
  const source = realpathSync(sourceRoot);
  // An explicitly selected NVM alias is resolved once; copied files themselves
  // must be regular files and are checked again after copying.
  const executable = realpathSync(nodeExe);
  const license = realpathSync(nodeLicense);
  if ((mac?path.dirname(path.dirname(executable)):path.dirname(executable)) !== path.dirname(license) || path.basename(license).toUpperCase() !== 'LICENSE') throw Error('NODE_DISTRIBUTION_LICENSE_REQUIRED');
  if (!(await readFile(license, 'utf8')).startsWith('Node.js is licensed for use as follows:')) throw Error('NODE_LICENSE_UNRECOGNIZED');
  const minimalEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)));
  const { stdout } = await run(executable, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { env: minimalEnv, timeout: 10000, windowsHide: true, maxBuffer: 4096 });
  const node = JSON.parse(stdout);
  if (!/^v24\.\d+\.\d+$/.test(node.version) || node.platform !== (mac?'darwin':'win32') || node.arch !== (mac?'arm64':'x64')) throw Error('NATIVE_NODE24_REQUIRED');
  const nodePath=mac?'bin/node':'bin/node.exe';
  const workspace = source;
  const gateway = await json(inside(workspace, 'services/central-gateway/package.json'));
  const lock = await json(inside(workspace, 'package-lock.json'));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw Error('LOCKFILE_V3_REQUIRED');
  if (JSON.stringify(gateway.dependencies) !== JSON.stringify(lock.packages['services/central-gateway']?.dependencies)) throw Error('GATEWAY_LOCK_MISMATCH');
  const closure = dependencyClosure(lock, gateway);
  await safePath(outputRoot, true);
  await mkdir(outputRoot, { recursive: true });
  const temporary = inside(outputRoot, `.stage-${randomUUID()}`);
  await mkdir(temporary);
  const files = [];
  async function copy(sourceFile, relative) {
    const expected = await digestFile(sourceFile);
    const target = inside(temporary, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourceFile, target, constants.COPYFILE_EXCL);
    const actual = await digestFile(target);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw Error('SOURCE_CHANGED');
    // Ad-hoc sign only the package copy before computing the compiled trust pin.
    // Never mutate the operator's existing Node/App Server executable.
    if(mac&&relative.startsWith('bin/')) {
      await run('/usr/bin/codesign',['--force','--sign','-',target],{timeout:120000,maxBuffer:4096});
    }
    files.push({ path: relative, ...await digestFile(target) });
  }
  async function copyTree(from, to, skipNestedDependencies = false) {
    await safePath(from);
    for (const item of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipNestedDependencies && item.name === 'node_modules') continue;
      if (item.isSymbolicLink()) throw Error('LINK_NOT_ALLOWED');
      if (item.isDirectory()) await copyTree(path.join(from, item.name), `${to}/${item.name}`, skipNestedDependencies);
      else if (item.isFile()) await copy(path.join(from, item.name), `${to}/${item.name}`);
      else throw Error('REGULAR_FILE_REQUIRED');
    }
  }
  try {
    await copy(executable, nodePath);
    await copy(license, 'licenses/Node-LICENSE');
    await copy(inside(source, 'THIRD_PARTY_NOTICES.md'), 'licenses/PROJECT-THIRD-PARTY-NOTICES.md');
    if(appServer){
      if(mac){
        await copy(appServer,'bin/codex-app-server');
        await copy(seatbeltProfile,'harness/worker-isolated.sb');
      }else{
        await copy(workerHost,'bin/windows-worker-host.exe');
        await copy(appServer,'bin/codex-app-server.exe');
        await copy(nativeHelper,'bin/central-native-helper.exe');
      }
      await copy(inside(workspace,'harness/upstream/LICENSE'),'licenses/Codex-LICENSE');
      await copy(inside(workspace,'harness/upstream/NOTICE'),'licenses/Codex-NOTICE');
    }
    await copy(inside(workspace, 'services/central-gateway/package.json'), 'app/gateway/package.json');
    await copyTree(inside(workspace, 'services/central-gateway/dist'), 'app/gateway/dist');
    await copy(inside(workspace, 'packages/agentrpc-types/package.json'), 'app/node_modules/@central-codex-spike/agentrpc-types/package.json');
    await copyTree(inside(workspace, 'packages/agentrpc-types/dist'), 'app/node_modules/@central-codex-spike/agentrpc-types/dist');
    for (const [key, entry] of [...closure.selected].sort(([a], [b]) => a.localeCompare(b))) {
      const folder = inside(workspace, key);
      const installed = await json(path.join(folder, 'package.json'));
      if (installed.version !== entry.version) throw Error(`INSTALLED_VERSION_MISMATCH:${key}`);
      // Installed package bytes are inventoried, not misrepresented as verified
      // against the lockfile's tarball integrity. Root must pin the final output.
      await copyTree(folder, `app/${key.replace(/^services\/test-gateway\//, 'gateway/')}`, true);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      schemaVersion: 1, kind: 'central-gateway-candidate', ready: false, qualified: false,
      upstream: upstream ?? JSON.parse(await readFile(path.join(source,'harness/upstream.json'),'utf8')),
      node: { ...node, ...files.find(file => file.path === nodePath) },
      ...(mac&&appServer?{nativeWorker:{protocol:'macos-seatbelt/v1',mode:'macos-seatbelt-v1',
        appServer:files.find(file=>file.path==='bin/codex-app-server'),
        seatbeltProfile:files.find(file=>file.path==='harness/worker-isolated.sb')}}:{}),
      ...(workerHost?{nativeWorker:{protocol:'windows-worker-host/v1',mode:'windows-appcontainer-v1',
        host:files.find(file=>file.path==='bin/windows-worker-host.exe'),
        appServer:files.find(file=>file.path==='bin/codex-app-server.exe'),
        privateFileHelper:files.find(file=>file.path==='bin/central-native-helper.exe')}}:{}),
      entrypoint: 'app/gateway/dist/index.js',
      lockfile: await digestFile(inside(workspace, 'package-lock.json')),
      packages: [...closure.selected].map(([key, entry]) => ({ path: `app/${key}`, version: entry.version, lockIntegrity: entry.integrity })).sort((a, b) => a.path.localeCompare(b.path)),
      omittedOptionalPeers: closure.omittedOptional,
      blockers: ['FINAL_PACKAGE_TRUST_PIN_PENDING', 'PRODUCTION_WORKER_INTEGRATION_PENDING', 'AUTHENTICATED_RUNTIME_ACCEPTANCE_PENDING', 'PROJECT_LICENSE_DISTRIBUTION_REVIEW_PENDING'],
      files,
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = createHash('sha256').update(serialized).digest('hex');
    const packageId = `${mac?'macos-arm64':'windows-x64'}-node24-qa1-${manifestSha256.slice(0, 16)}`;
    await writeFile(path.join(temporary, 'manifest.json'), serialized, { flag: 'wx' });
    const destination = inside(outputRoot, packageId);
    let reused = false;
    try {
      const previous = await readFile(path.join(destination, 'manifest.json'), 'utf8');
      if (previous !== serialized) throw Error('EXISTING_CANDIDATE_MISMATCH');
      await verifyCandidate(destination);
      reused = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!reused) await rename(temporary, destination);
    return { packageId, destination, manifestSha256, fileCount: files.length, dependencyCount: closure.selected.size, reused, ready: false, qualified: false };
  } finally {
    if (path.dirname(temporary) !== outputRoot || !path.basename(temporary).startsWith('.stage-')) throw Error('UNSAFE_CLEANUP');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (![6,12].includes(args.length) || args[0] !== '--source-root' || args[2] !== '--node-exe' || args[4] !== '--node-license'
    ||(args.length===12&&(args[6]!=='--worker-host'||args[8]!=='--app-server'||args[10]!=='--native-helper'))) {
    console.error('Usage: node scripts/build/stage-central-gateway.mjs --source-root <absolute repository> --node-exe <explicit Node24 executable> --node-license <same distribution LICENSE> [--worker-host <absolute exe> --app-server <absolute exe> --native-helper <absolute exe>]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await stageGateway({ sourceRoot: args[1], nodeExe: args[3], nodeLicense: args[5],workerHost:args[7],appServer:args[9],nativeHelper:args[11] }), null, 2)); }
    catch (error) { console.error(`Gateway staging failed: ${error.message}`); process.exitCode = 1; }
  }
}
