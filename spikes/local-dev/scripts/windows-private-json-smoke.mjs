// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real native ACL/file reads of fresh synthetic data only; no account credentials.
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, linkSync, symlinkSync, copyFileSync, lstatSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {protectSyntheticFixture} from './windows-private-fixture.mjs';
import {readWindowsPrivateJson, WindowsPrivateJsonError} from '../services/test-gateway/dist/windows-private-json.js';
import {ModelCredentialBroker} from '../services/test-gateway/dist/model-credential-broker.js';

assert.equal(process.platform, 'win32', 'WINDOWS_QA_REQUIRED');
const binary = process.env.PLATFORM_NATIVE_HELPER_BINARY;
assert(binary && process.env.PLATFORM_NATIVE_HELPER_SHA256, 'PINNED_NATIVE_HELPER_REQUIRED');
const options = {binary, sha256: process.env.PLATFORM_NATIVE_HELPER_SHA256};
assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), options.sha256);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'windows-private-json-'))), checks = [];
const payload = {apiKey: 'SYNTHETIC_ONLY_' + randomBytes(16).toString('hex')};
const privateDir = join(root, 'private'); mkdirSync(privateDir);
const credential = join(privateDir, 'synthetic.json'); writeFileSync(credential, JSON.stringify(payload));
protectSyntheticFixture(root, [privateDir, credential]);
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const denied = (action, expected) => assert.throws(action, error => error instanceof WindowsPrivateJsonError
  && (!expected || error.code === expected) && !error.message.includes(payload.apiKey) && !error.message.includes(root));

assert.deepEqual(readWindowsPrivateJson(credential, 1024, options), payload);
pass('Protected current-user directory and JSON file pass actual native admission');
const coldDirectory = join(root, 'cold-artifacts'); mkdirSync(coldDirectory);
let observedColdCtimeChanges = 0;
for (let index = 0; index < 3; index++) {
  const coldBinary = join(coldDirectory, `helper-${index}.exe`); copyFileSync(binary, coldBinary);
  const before = lstatSync(coldBinary, {bigint: true});
  assert.deepEqual(readWindowsPrivateJson(credential, 1024, {...options, binary: coldBinary}), payload);
  const after = lstatSync(coldBinary, {bigint: true});
  for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'nlink']) assert.equal(after[field], before[field]);
  if (before.ctimeNs !== after.ctimeNs) observedColdCtimeChanges++;
}
pass('Three newly copied helper executables pass cold-start revalidation with stable identity, mtime and pinned content');
const tamperedBinary = join(coldDirectory, 'tampered.exe'); copyFileSync(binary, tamperedBinary);
const tamperedBytes = readFileSync(tamperedBinary); tamperedBytes[0] ^= 1; writeFileSync(tamperedBinary, tamperedBytes);
denied(() => readWindowsPrivateJson(credential, 1024, {...options, binary: tamperedBinary}), 'WINDOWS_PRIVATE_JSON_HELPER_UNTRUSTED');
const linkedBinary = join(coldDirectory, 'linked.exe'); copyFileSync(binary, linkedBinary);
linkSync(linkedBinary, join(coldDirectory, 'linked-alias.exe'));
denied(() => readWindowsPrivateJson(credential, 1024, {...options, binary: linkedBinary}));
pass('Modified executable bytes and multiply linked executable identity are rejected before launch');
const broadDir = join(root, 'ordinary'); mkdirSync(broadDir);
const broadFile = join(broadDir, 'synthetic.json'); writeFileSync(broadFile, JSON.stringify(payload));
denied(() => readWindowsPrivateJson(broadFile, 1024, options));
protectSyntheticFixture(root, [broadFile]);
denied(() => readWindowsPrivateJson(broadFile, 1024, options));
pass('Ordinary Windows file and broad parent remain rejected even if the file ACL alone is protected');

denied(() => readWindowsPrivateJson(credential, 1024, {...options, sha256: '0'.repeat(64)}), 'WINDOWS_PRIVATE_JSON_HELPER_UNTRUSTED');
denied(() => readWindowsPrivateJson(credential, 1024, {binary: '', sha256: ''}), 'WINDOWS_PRIVATE_JSON_HELPER_UNTRUSTED');
denied(() => readWindowsPrivateJson(credential, 0, options));
denied(() => readWindowsPrivateJson(credential, 1024 * 1024 + 1, options));
denied(() => readWindowsPrivateJson(credential, 2, options));
pass('Absent or incorrect helper pin and oversized/undersized read bounds fail closed');

const malformed = join(privateDir, 'malformed.json'); writeFileSync(malformed, '{"synthetic":');
protectSyntheticFixture(root, [malformed]);
denied(() => readWindowsPrivateJson(malformed, 1024, options));
const nativeFailure = spawnSync(binary, ['read-private-json-v1'], {
  input: JSON.stringify({version: 1, path: malformed, maxBytes: 1024}), windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4096,
});
assert.equal(nativeFailure.status, 1); assert.equal(nativeFailure.stdout, '');
assert.equal(nativeFailure.stderr.trim(), 'CENTRAL_PRIVATE_JSON_INVALID');
const invalidProtocol = spawnSync(binary, ['read-private-json-v1'], {
  input: JSON.stringify({version: 1, path: credential, maxBytes: 1024, command: 'arbitrary'}), windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 4096,
});
assert.equal(invalidProtocol.status, 1); assert.equal(invalidProtocol.stdout, '');
assert.equal(invalidProtocol.stderr.trim(), 'CENTRAL_PRIVATE_PROTOCOL_INVALID');
pass('Malformed JSON and unsupported protocol fields produce no stdout payload and only fixed stderr codes');

const configFile = join(privateDir, 'bindings.json');
writeFileSync(configFile, JSON.stringify({version: 1, users: {alice: {providerId: 'a', enabled: true}},
  providers: {a: {id: 'a', kind: 'api-key', credentialFile: credential}}}));
protectSyntheticFixture(root, [configFile]);
const broker = await ModelCredentialBroker.start({configFile});
try {
  assert.equal(broker.status('alice').status, 'ready');
  const capability = broker.createLease('alice'); capability.release();
  linkSync(credential, join(privateDir, 'hardlink.json'));
  denied(() => readWindowsPrivateJson(credential, 1024, options));
  assert.deepEqual(broker.status('alice'), {status: 'unavailable', code: 'MODEL_CREDENTIAL_FILE_UNSAFE'});
  pass('Broker reads config and synthetic credential through native admission; later hardlink makes status unavailable');
} finally { await broker.close(); }

const junction = join(root, 'alias'); symlinkSync(privateDir, junction, 'junction');
denied(() => readWindowsPrivateJson(join(junction, 'bindings.json'), 1024, options));
denied(() => readWindowsPrivateJson(join(privateDir, 'absent.json'), 1024, options), 'WINDOWS_PRIVATE_JSON_NOT_FOUND');
pass('Junction aliases and absent files fail without disclosing private paths');

const result = {ok: true, fixtureOnly: true, nativeAclVerified: true, hostileSameUserSwapProtected: false, observedColdCtimeChanges, checks};
writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ok: true, checks: checks.length, result: resolve(root, 'result.json')}));
