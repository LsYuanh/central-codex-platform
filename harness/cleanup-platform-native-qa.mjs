// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaOrigin, qaGateway} from '../scripts/maintenance/operator-config.mjs';
// Restore only the configuration prepared by prepare-platform-native-qa.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const record = JSON.parse(readFileSync(resolve('target/harness-p5-native.json'), 'utf8'));
assert.equal(record.namespace, 'com.centralcodex.harnessqa20260909');
assert.equal(record.gateway, qaGateway());
const directory = join(process.env.APPDATA, record.namespace);
const backup = resolve('target/harness-p5-native-backup');
assert.equal(record.backup, backup);
const config = JSON.parse(readFileSync(join(directory, 'desktop-runtime-v1.json'), 'utf8'));
assert.equal(config.deviceId, record.deviceId, 'QA config changed since preparation; preserve it');
assert.equal(config.gatewayUrl, record.gateway);
assert(existsSync(join(backup, 'desktop-runtime-v1.json')), 'Original QA config backup required');
const native = input => {
  const result = spawnSync(resolve('target/harness-agent/debug/examples/platform-acceptance.exe'), [], {
    input: JSON.stringify({ gateway: record.gateway, ca: record.ca, ...input }), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).data;
};
const logout = native({ namespace: record.namespace, action: 'logout' });
const bootstrap = native({ namespace: 'com.centralcodex.harnessqa.p5.bootstrap', action: 'cleanup' });
for (const name of ['desktop-runtime-v1.json', 'platform-ca-v1.json']) {
  const original = join(backup, name), current = join(directory, name);
  if (existsSync(original)) copyFileSync(original, current);
  else {
    assert.equal(name, 'platform-ca-v1.json');
    const map = JSON.parse(readFileSync(current, 'utf8'));
    assert.deepEqual(map, { [qaOrigin()]: record.ca }, 'QA CA settings changed; preserve them');
    unlinkSync(current);
  }
}
const evidence = { at: new Date().toISOString(), logout, bootstrap, qaConfigRestored: true, originalCaConfigAbsent: !existsSync(join(backup, 'platform-ca-v1.json')) };
writeFileSync(resolve('target/harness-p5-cleanup.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
