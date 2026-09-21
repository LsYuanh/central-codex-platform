// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Validate a completed isolated Windows QA run. No binary is launched here.
import assert from 'node:assert/strict';
import {readFileSync, existsSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

assert.equal(process.platform, 'win32', 'This is Windows-only QA');
assert(process.argv[2], 'Pass the completed QA directory');
const root = resolve(process.argv[2]);
const fixture = process.argv[3] === '--ipc-fixture';
const homeHelperFixture = process.argv[3] === '--home-helper-fixture';
const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
const result = {
  scope: fixture ? 'synthetic-inherited-stdio-pipes' : homeHelperFixture ? 'isolated-production-helper-synthetic-fixture' : 'isolated-app-server-initialize-and-rpc-boundary',
  passed: false, realModelVerified: false, realDeviceVerified: false,
  fullNetworkIsolationVerified: false, deployable: false,
  profileCleaned: summary.profileCleaned === true,
  jobCloseVerified: summary.jobCloseVerified === true,
};
if (existsSync(join(root, 'probe.exe')))
  result.binarySha256 = createHash('sha256').update(readFileSync(join(root, 'probe.exe'))).digest('hex');
try {
  assert.equal(summary.scope, 'runtime-transport-only-verify-jsonl-separately');
  assert.equal(summary.receivedResponses, true, 'Runtime responses were not collected; inspect alice/runtime-stderr.log');
  assert.equal(summary.profileCleaned, true);
  assert.equal(summary.jobCloseVerified, true);
  const messages = readFileSync(join(root, 'alice', 'runtime-stdout.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const response = id => {
    const matches = messages.filter(message => message.id === id);
    assert.equal(matches.length, 1, `Expected exactly one response for ${id}`);
    return matches[0];
  };
  const initialized = response('p0-initialize');
  assert.equal(initialized.error, undefined);
  assert.match(initialized.result?.userAgent ?? '', /yuan-zhou-remote-workspace\/1/);
  assert.equal(initialized.result.userAgent.includes('SYNTHETIC_IPC_FIXTURE'), fixture,
    'Synthetic IPC fixture cannot qualify as a real App Server');
  assert.equal(initialized.result.userAgent.includes('SYNTHETIC_HOME_HELPER_FIXTURE'), homeHelperFixture,
    'Synthetic home-helper fixture cannot qualify as a real App Server');
  if (homeHelperFixture) {
    const diagnostics = initialized.result.homeHelperDiagnostics;
    for (const key of ['ownHomeCanonicalized', 'helperIdentityCheckCompleted', 'missingRejected',
      'ordinaryFileRejected', 'suppliedDevicePathRejected', 'relativePathRejected', 'volumeRootRejected', 'uncRejected', 'relativeReadWrite', 'cwdRestored'])
      assert.equal(diagnostics?.[key], true, `home helper: ${key}`);
    for (const key of ['centralDirectoryError', 'otherUserDirectoryError', 'nonRemoteError'])
      assert.equal(diagnostics?.[key], 5, `home helper: ${key}`);
    result.homeHelperDiagnostics = diagnostics;
    if (diagnostics.junctionsTested) {
      assert.equal(diagnostics.centralJunctionError, 5);
      assert.equal(diagnostics.otherUserJunctionError, 5);
    }
  }
  if (fixture) {
    assert.equal(initialized.result.inheritedCanaryError, 6, 'Omitted inheritable canary handle must be invalid');
    result.omittedInheritedCanaryDenied = true;
    result.inheritedCanaryException = initialized.result.inheritedCanaryException ?? null;
    result.canonicalizationDiagnostics = initialized.result.canonicalizationDiagnostics ?? null;
  }
  for (const [id, method] of [['p0-command', 'command/exec'], ['p0-filesystem', 'fs/readFile']]) {
    const denied = response(id);
    assert.equal(denied.result, undefined, `${method} must not return a result`);
    assert.equal(denied.error?.code, -32602, `${method} must return the pinned boundary error code`);
    assert.equal(denied.error?.message, `REMOTE_WORKSPACE_UNSUPPORTED: ${method}`);
  }
  assert.equal(existsSync(join(root, 'alice', 'FORBIDDEN-EXECUTED')), false);
  result.initializeMarkerVerified = true;
  result.commandRpcDenied = true;
  result.filesystemRpcDenied = true;
  result.jobCloseVerified = true;
  result.profileCleaned = true;
  result.passed = true;
} catch (error) {
  result.error = String(error.message ?? error);
  process.exitCode = 1;
}
writeFileSync(join(root, 'runtime-verified.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
