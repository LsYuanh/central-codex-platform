// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Read-only post-run integrity check for databases created by the actual QA runtime.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';

assert.equal(process.platform, 'win32');
assert(process.argv[2], 'Pass the verified actual-runtime QA directory');
const root = resolve(process.argv[2]);
const verification = JSON.parse(readFileSync(join(root, 'runtime-verified.json'), 'utf8'));
assert.equal(verification.scope, 'isolated-app-server-initialize-and-rpc-boundary');
assert.equal(verification.passed, true);
assert.equal(verification.jobCloseVerified, true);
const home = join(root, 'alice', 'codex-home');
const result = {
  scope: 'read-only-sqlite-integrity-after-isolated-runtime-job-close',
  passed: false, readOnly: true, databases: [],
  stderrBytes: statSync(join(root, 'alice', 'runtime-stderr.log')).size,
  actualRuntimeBinarySha256: verification.binarySha256,
  realModelVerified: false, deployable: false,
};
try {
  const databases = readdirSync(home, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.sqlite')).map(entry => entry.name).sort();
  assert(databases.length > 0, 'Actual runtime did not create any SQLite database');
  for (const name of databases) {
    const database = new DatabaseSync(join(home, name), {readOnly: true});
    try {
      const rows = database.prepare('PRAGMA quick_check').all();
      assert.equal(rows.length, 1, `${name}: unexpected integrity output`);
      assert.equal(rows[0].quick_check, 'ok', `${name}: integrity check failed`);
      result.databases.push({name, quickCheck: 'ok'});
    } finally { database.close(); }
  }
  assert.equal(result.stderrBytes, 0, 'App Server emitted stderr; inspect it before acceptance');
  result.passed = true;
} catch (error) {
  result.error = String(error.message ?? error);
  process.exitCode = 1;
}
writeFileSync(join(root, 'sqlite-quick-check.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
