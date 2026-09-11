// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Fetch the public source once, verify its fixed archive, and apply the reviewable patch.
// This prepares source; it never starts Codex or replaces a running installation.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { preparePatch } from './prepare-patch.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(here, 'upstream.json')));
const patchBytes = readFileSync(join(here, pin.patch.path));
if (createHash('sha256').update(patchBytes).digest('hex') !== pin.patch.sha256) throw new Error('Fork patch hash mismatch');
const destination = resolve(process.argv[2] ?? join(here, '.cache'));
const source = join(destination, `codex-${pin.commit}`);
if (existsSync(source)) throw new Error(`Source already exists; do not overwrite it: ${source}`);
mkdirSync(destination, { recursive: true });
const response = await fetch(pin.archive.url);
if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== pin.archive.sha256) throw new Error('Source archive hash mismatch');
const archivePath = join(destination, 'upstream.tar.gz');
writeFileSync(archivePath, archive);
// The pinned archive has one symlink: bubblewrap/LICENSE -> COPYING. Windows
// extraction may require privileges for symlinks. Materialize only that license;
// do not skip arbitrary files or change executable sources/dependency versions.
const license = `codex-${pin.commit}/codex-rs/vendor/bubblewrap/LICENSE`;
const tar = spawnSync('tar', ['-xzf', archivePath, '-C', destination,
  ...(process.platform === 'win32' ? ['--exclude', license] : [])], { stdio: 'inherit' });
if (tar.status !== 0) throw new Error('Extraction failed; incomplete source must not be built');
if (process.platform === 'win32') copyFileSync(join(source, 'codex-rs/vendor/bubblewrap/COPYING'), join(destination, license));
console.log(JSON.stringify(preparePatch(source)));
console.log(source);
