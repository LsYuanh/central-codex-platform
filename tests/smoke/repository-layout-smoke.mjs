// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dependencyClosure } from '../../scripts/build/stage-central-gateway.mjs';
import { runtimeSource, verifyFile } from '../../scripts/build/stage-central-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = json('package.json');
const lock = json('package-lock.json');
assert.deepEqual(lock.packages[''].workspaces, manifest.workspaces);
for (const workspace of manifest.workspaces) {
  const member = json(`${workspace}/package.json`);
  assert(lock.packages[workspace], `Lockfile missing workspace: ${workspace}`);
  assert.deepEqual(lock.packages[workspace].dependencies, member.dependencies);
  const link = resolve(root, 'node_modules', member.name);
  assert.equal(realpathSync(link), realpathSync(resolve(root, workspace)), `Stale workspace link: ${member.name}`);
}
const entrypoints = new Set();
for (const [name, command] of Object.entries(manifest.scripts)) {
  for (const match of command.matchAll(/(?:scripts|tests|harness)\/[\w./-]+\.(?:mjs|cjs|ts|ps1|sh|py)\b/g)) {
    assert(existsSync(resolve(root, match[0])), `Missing entry for ${name}: ${match[0]}`);
    entrypoints.add(match[0]);
  }
  for (const match of command.matchAll(/npm run ([\w:-]+)/g)) {
    // Workspace commands are owned by their corresponding package.json.
    if (!command.includes('--workspace')) assert(manifest.scripts[match[1]], `Unknown command in ${name}: ${match[1]}`);
  }
}
const ignored = spawnSync('git', ['check-ignore', '--no-index', '--', ...entrypoints], {cwd: root, encoding: 'utf8', windowsHide: true});
assert.equal(ignored.status, 1, `Script entrypoints must be versioned, not ignored: ${ignored.stdout || ignored.stderr}`);
const cargo = readFileSync(resolve(root, 'Cargo.toml'), 'utf8');
const members = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/)[1];
for (const match of members.matchAll(/"([^"]+)"/g)) {
  assert(existsSync(resolve(root, match[1], 'Cargo.toml')), `Missing Cargo member: ${match[1]}`);
}
const gateway = json('services/central-gateway/package.json');
assert(dependencyClosure(lock, gateway).selected.size > 0, 'Gateway runtime dependency closure is empty');
for (const entry of json('harness/central-runtime-catalog.json').packages) {
  for (const file of entry.files.filter(file => file.sourcePath.startsWith('spikes/local-dev/harness/upstream/'))) {
    await verifyFile(runtimeSource(root, file.sourcePath), file);
  }
}
console.log('REPOSITORY_LAYOUT_SMOKE_OK: workspace links, lockfile, script entrypoints, Cargo members, gateway dependencies');
