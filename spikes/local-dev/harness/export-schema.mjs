// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Mirrors fixed upstream app-server-protocol/precomputed_exports.rs without starting Codex.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const here = dirname(fileURLToPath(import.meta.url));
const mode = process.argv.includes('--experimental') ? 'experimental' : 'stable';
const outputArg = process.argv.find(arg => arg.startsWith('--out='));
const output = resolve(outputArg?.slice(6) ?? join(here, '.cache/schema', mode));
const input = readFileSync(join(here, `schema/app-server-exports-${mode}.json.zst`));
const pin = JSON.parse(readFileSync(join(here, 'upstream.json')));
if (createHash('sha256').update(input).digest('hex') !== pin.schema[mode].sha256) throw new Error('Schema archive hash mismatch');
const exports = JSON.parse(zstdDecompressSync(input));
const manifest = [];
for (const [kind, files] of [['json', exports.json_schema], ['typescript', exports.typescript]]) {
  for (const [name, value] of Object.entries(files)) {
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error('Unsafe schema entry');
    const path = join(output, kind, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    manifest.push({ path: `${kind}/${name}`, sha256: createHash('sha256').update(value).digest('hex') });
  }
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ commit: pin.commit, mode, files: manifest }, null, 2) + '\n');
console.log(`Exported ${manifest.length} pinned ${mode} protocol files to ${output}`);
