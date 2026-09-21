// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Generates synthetic input itself. Deliberately accepts no source/restore path argument.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inspectMigrationBundle, readBundleFile } from './migration-preflight.mjs';

assert.equal(process.argv.length, 2, 'This rehearsal accepts no production source or destination.');
const target = resolve('target'); fs.mkdirSync(target, { recursive: true });
const root = fs.mkdtempSync(join(target, 'migration-rehearsal-'));
const source = join(root, 'synthetic-source'); fs.mkdirSync(source);
const sha = value => createHash('sha256').update(value).digest('hex');
const now = Date.now(), key = sha('synthetic-ed25519-public-key');
const binding = { policy: 'remote-workspace/v1', userId: 'old-alice', deviceId: 'old-device', deviceKey: key, workspaceRoot: 'C:\\Synthetic QA\\workspace' };
const gateway = { version: 1, futureTopLevel: { keep: true }, users: { 'old-alice': [{ id: 'thread-a', futureEntry: 'keep', summary: { deviceId: 'old-device', deviceKey: key, remoteWorkspace: binding, attachmentSubmissions: [{ clientMessageId: 'fixture-message', status: 'sent', future: 'keep' }], outputs: [{ id: 'fixture-output', status: 'saved', sha256: sha('synthetic-output'), future: true }], futureSummary: ['keep'] } }] } };
const identities = { version: 1, users: [{ id: 'new-alice', disabled: false }], devices: [{ id: 'new-device', userId: 'new-alice', deviceKey: sha('new-synthetic-key'), workspaceRoot: binding.workspaceRoot, revoked: false, certificates: [{ fingerprint: sha('synthetic-cert-metadata-not-x509'), expiresAt: now + 86_400_000 }] }] };
const historyBytes = Buffer.from('{"synthetic":true,"threadId":"thread-a","message":"history kept byte for byte"}\n');
const plan = { version: 1, sourceQuiesced: true, accounts: [{ sourceUserId: 'old-alice', targetUserId: 'new-alice' }], devices: [{ sourceUserId: 'old-alice', sourceDeviceId: 'old-device', targetDeviceId: 'new-device' }], history: [{ threadId: 'thread-a', files: [{ path: 'history/thread-a.jsonl', sha256: sha(historyBytes) }] }] };
const json = (directory, name, value) => fs.writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function reset() {
  json(source, 'gateway.json', gateway); json(source, 'target-identities.json', identities); json(source, 'plan.json', plan);
}
fs.mkdirSync(join(source, 'history')); fs.writeFileSync(join(source, 'history/thread-a.jsonl'), historyBytes, { mode: 0o600 }); reset();
const checks = [];
function check(name, action) { action(); checks.push(name); }
function has(result, code) { assert(result.issues.some(issue => issue.code === code), code); }
function inspect() { return inspectMigrationBundle(source, now); }
function changed(name, mutate, code, file = 'plan.json') {
  check(name, () => { const value = JSON.parse(fs.readFileSync(join(source, file), 'utf8')); mutate(value); json(source, file, value); has(inspect(), code); reset(); });
}
check('shared-layout-remains-blocked-with-complete-mapping', () => {
  const before = fs.readFileSync(join(source, 'gateway.json')); const result = inspect();
  has(result, 'WORKER_LAYOUT_MIGRATION_REQUIRED'); assert.equal(result.readyForCutover, false);
  assert.equal(result.threads[0].execution, 'unavailable-binding-changed');
  assert.equal(result.threads[0].preservation, 'listed-bytes-verified');
  assert.deepEqual(fs.readFileSync(join(source, 'gateway.json')), before);
});
changed('missing-account-fails', p => p.accounts = [], 'ACCOUNT_MAPPING_MISSING');
changed('missing-device-mapping-fails', p => p.devices = [], 'DEVICE_MAPPING_MISSING');
changed('missing-certificate-fails', p => p.devices[0].certificates = [], 'DEVICE_CERTIFICATE_MISSING_OR_EXPIRED', 'target-identities.json');
changed('expired-certificate-fails', p => p.devices[0].certificates[0].expiresAt = now - 1, 'DEVICE_CERTIFICATE_MISSING_OR_EXPIRED', 'target-identities.json');
changed('revoked-device-fails', p => p.devices[0].revoked = true, 'TARGET_DEVICE_UNAVAILABLE_OR_FOREIGN', 'target-identities.json');
changed('foreign-device-owner-fails', p => { p.users.push({ id: 'bob', disabled: false }); p.devices[0].userId = 'bob'; }, 'TARGET_DEVICE_UNAVAILABLE_OR_FOREIGN', 'target-identities.json');
changed('disabled-account-fails', p => p.users[0].disabled = true, 'TARGET_ACCOUNT_UNAVAILABLE', 'target-identities.json');
changed('missing-native-history-fails', p => p.history = [], 'NATIVE_HISTORY_INVENTORY_MISSING');
changed('native-history-digest-mismatch-fails', p => p.history[0].files[0].sha256 = '0'.repeat(64), 'NATIVE_HISTORY_HASH_MISMATCH');
changed('unknown-submission-never-replayed', p => p.users['old-alice'][0].summary.attachmentSubmissions[0].status = 'unknown', 'SUBMISSION_RECONCILIATION_REQUIRED', 'gateway.json');
changed('in-progress-output-needs-reconciliation', p => p.users['old-alice'][0].summary.outputs[0].status = 'saving', 'OUTPUT_RECONCILIATION_REQUIRED', 'gateway.json');
changed('source-binding-user-mismatch-fails', p => p.users['old-alice'][0].summary.remoteWorkspace.userId = 'bob', 'SOURCE_BINDING_INCONSISTENT', 'gateway.json');
changed('source-writers-not-attested-fails', p => p.sourceQuiesced = false, 'SOURCE_QUIESCENCE_NOT_ATTESTED');
check('duplicate-thread-ownership-fails-without-rewrite', () => {
  const value = structuredClone(gateway); value.users.bob = structuredClone(value.users['old-alice']); json(source, 'gateway.json', value);
  assert.throws(inspect, /GATEWAY_STATE_CORRUPT/); reset();
});
check('raw-auth-state-rejected', () => {
  const value = { ...identities, sessions: [] }; json(source, 'target-identities.json', value);
  assert.throws(inspect, /PUBLIC_INVENTORY_ONLY/); reset();
});
check('duplicate-account-mapping-refused', () => {
  const value = structuredClone(plan); value.accounts.push(structuredClone(value.accounts[0])); json(source, 'plan.json', value);
  assert.throws(inspect, /ACCOUNT_MAPPING_AMBIGUOUS/); reset();
});
check('implicit-account-merge-refused', () => {
  const state = structuredClone(gateway); state.users['old-bob'] = []; json(source, 'gateway.json', state);
  const value = structuredClone(plan); value.accounts.push({ sourceUserId: 'old-bob', targetUserId: 'new-alice' }); json(source, 'plan.json', value);
  assert.throws(inspect, /ACCOUNT_MERGE_REQUIRES_SEPARATE_REVIEW/); reset();
});
check('duplicate-device-mapping-refused', () => {
  const value = structuredClone(plan); value.devices.push(structuredClone(value.devices[0])); json(source, 'plan.json', value);
  assert.throws(inspect, /DEVICE_MAPPING_AMBIGUOUS/); reset();
});
check('history-traversal-rejected', () => {
  const value = structuredClone(plan); value.history[0].files[0].path = '../outside'; json(source, 'plan.json', value);
  assert.throws(inspect, /BUNDLE_PATH_UNSAFE/); reset();
});
check('history-hardlink-rejected', () => {
  fs.linkSync(join(source, 'history/thread-a.jsonl'), join(root, 'history-hardlink'));
  assert.throws(inspect, /BUNDLE_FILE_UNSAFE/);
  fs.unlinkSync(join(root, 'history-hardlink'));
});
check('complete-per-user-metadata-is-not-release-approval', () => {
  const value = structuredClone(gateway); value.workerLayout = 'per-user/v1'; json(source, 'gateway.json', value);
  const result = inspect(); assert.equal(result.status, 'offline-checks-passed-runtime-validation-required'); assert.equal(result.readyForCutover, false); assert.equal(result.importImplemented, false); reset();
});

// Fixed synthetic file inventory only; no recursive copying or deletion of arbitrary directories.
const names = ['gateway.json', 'target-identities.json', 'plan.json', 'history/thread-a.jsonl'];
const backup = join(root, 'verified-backup'); fs.mkdirSync(backup); fs.mkdirSync(join(backup, 'history'));
const manifest = { version: 1, syntheticOnly: true, files: names.map(path => { const bytes = readBundleFile(source, path); fs.writeFileSync(join(backup, path), bytes, { flag: 'wx', mode: 0o600 }); return { path, bytes: bytes.length, sha256: sha(bytes) }; }) };
json(backup, 'backup-manifest.json', manifest);
function verifiedRestore(destination) {
  assert.equal(fs.existsSync(destination), false, 'restore destination must not exist');
  const verified = manifest.files.map(file => {
    const bytes = readBundleFile(backup, file.path);
    assert.equal(bytes.length, file.bytes, 'BACKUP_INTEGRITY_FAILED'); assert.equal(sha(bytes), file.sha256, 'BACKUP_INTEGRITY_FAILED'); return { ...file, bytes };
  });
  // Verify every file before making even the fresh destination directory.
  fs.mkdirSync(destination); fs.mkdirSync(join(destination, 'history'));
  for (const file of verified) fs.writeFileSync(join(destination, file.path), file.bytes, { flag: 'wx', mode: 0o600 });
  for (const file of manifest.files) assert.equal(sha(readBundleFile(destination, file.path)), file.sha256);
}
check('tampered-backup-refused-before-restore', () => {
  fs.appendFileSync(join(backup, 'history/thread-a.jsonl'), 'tampered');
  const destination = join(root, 'must-not-exist'); assert.throws(() => verifiedRestore(destination), /BACKUP_INTEGRITY_FAILED/); assert.equal(fs.existsSync(destination), false);
  fs.writeFileSync(join(backup, 'history/thread-a.jsonl'), historyBytes);
});
check('source-damage-restores-original-bytes-in-fresh-directory', () => {
  fs.writeFileSync(join(source, 'gateway.json'), '{broken');
  fs.writeFileSync(join(source, 'history/thread-a.jsonl'), 'simulated damaged synthetic state');
  const restored = join(root, 'restored'); verifiedRestore(restored);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(restored, 'gateway.json'), 'utf8')), gateway);
  assert.deepEqual(readBundleFile(restored, 'history/thread-a.jsonl'), historyBytes);
  has(inspectMigrationBundle(restored, now), 'WORKER_LAYOUT_MIGRATION_REQUIRED');
  assert.throws(() => verifiedRestore(restored), /destination must not exist/);
});
const result = { version: 1, status: 'passed-synthetic-rehearsal-only', root, checks, passed: checks.length,
  backupManifestSha256: sha(fs.readFileSync(join(backup, 'backup-manifest.json'))),
  productionDataRead: false, remoteConnections: false, migrationImplemented: false, sourceLayoutGuardPreserved: true };
json(root, 'result.json', result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
