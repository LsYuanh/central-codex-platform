// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Run from any directory after npm ci; only the three desktop icon formats are retained.
import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
for (const app of ['desktop', 'central']) {
  const source = join(root, 'apps', app, 'src/assets/logo.svg');
  const temporary = join(root, 'target/brand-icons', app);
  const destination = join(root, 'apps', app, 'src-tauri/icons');
  const result = spawnSync(process.execPath, [cli, 'icon', source, '--output', temporary], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed for ${app} (${result.status})`);
  mkdirSync(destination, { recursive: true });
  for (const name of ['icon.png', 'icon.ico', 'icon.icns']) {
    copyFileSync(join(temporary, name), join(destination, name));
  }
  console.log(`Updated ${app} desktop icons from src/assets/logo.svg`);
}
