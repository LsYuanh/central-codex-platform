// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Run matching cases on two machines using a private JSON configuration. Only
// public peer identities are exchanged; reports omit network addresses and keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [configFile, role] = process.argv.slice(2);
assert(configFile && ['listen', 'dial'].includes(role), 'usage: wan-probe config.json listen|dial');
const config = JSON.parse(await readFile(configFile, 'utf8'));
assert.match(config.identity, /^[a-f0-9]{64}$/);
assert.match(config.peerIdentity, /^[a-f0-9]{64}$/);
assert.equal(new URL(config.relayUrl).protocol, 'https:');
assert(Array.isArray(config.cases) && config.cases.length > 0);
const results = [];

async function runCase(test) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('PEER_PROBE_')) delete env[name];
  Object.assign(env, {
    PEER_PROBE_RELAY_URL: config.relayUrl,
    PEER_PROBE_CA_FILE: config.caFile,
    PEER_PROBE_SECRET_FILE: config.secretFile,
    PEER_PROBE_ACCEPT_SECS: String(config.acceptSeconds ?? 1200),
    PEER_PROBE_BYTES: String(config.sampleBytes ?? 1048593),
  });
  if (test.relayOnly) env.PEER_PROBE_RELAY_ONLY = '1';
  const child = spawn(config.executable, [role], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let nativeResult, lines = 0, outputError = false;
  // Native diagnostics can contain network addresses; don't copy them to a report.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const completion = new Promise(resolve => {
    child.once('error', () => resolve({ error: 'PROBE_PROCESS_START_FAILED' }));
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const value = JSON.parse(line);
        if (++lines === 1) {
          assert.equal(value.id, config.identity, 'probe identity must match relay enrollment');
          // Start with only the relay address: iroh must discover any direct path.
          child.stdin.end(JSON.stringify({ id: config.peerIdentity, addrs: [{ Relay: config.relayUrl }] }) + '\n');
          console.log(JSON.stringify({ event: 'ready', role, case: test.name }));
        } else {
          assert.equal(lines, 2);
          nativeResult = value;
        }
      } catch {
        outputError = true;
        child.kill();
      }
    });
    child.once('exit', code => {
      if (code !== 0 || !nativeResult || outputError) {
        resolve({ error: 'PROBE_PROCESS_FAILED', exitCode: code });
        return;
      }
      const bytes = config.sampleBytes ?? 1048593;
      const complete = role === 'dial'
        ? nativeResult.bytes === bytes && /^[a-f0-9]{64}$/.test(nativeResult.sha256)
        : nativeResult.bytesEchoed === bytes;
      // The listener accepts before the dialer's direct grace period finishes;
      // route assertions therefore use the dialer's transfer snapshots.
      const routeMatches = role === 'listen' || !test.expectedRoute ||
        (nativeResult.routeBefore === test.expectedRoute && nativeResult.routeAfter === test.expectedRoute);
      resolve({ ...nativeResult, complete, routeMatches, passed: complete && routeMatches });
    });
  });
  const timer = setTimeout(() => child.kill(), (config.acceptSeconds ?? 1200) * 1000 + 120_000);
  try { return { name: test.name, relayOnly: !!test.relayOnly, ...await completion }; }
  finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}

for (const test of config.cases) {
  assert.equal(typeof test.name, 'string');
  // A harness pause gives the operator time to collect relay counters between
  // cases. It does not pace or limit data within an established connection.
  if (results.length) await delay(role === 'dial' ? (config.interCaseDelayMs ?? 5000) : 1000);
  const result = await runCase(test);
  results.push(result);
  await writeFile(config.reportFile, JSON.stringify({ schema: 'peer-transport-wan-probe/v1', role, scope: config.scope, passed: results.every(x => x.passed), results }, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'result', role, result }));
  // A failed connection can desynchronize the two sequential runners; do not
  // silently replay an uncertain case or call it a later case's successful run.
  if (!result.complete) break;
}
if (results.length !== config.cases.length || results.some(x => !x.passed)) process.exitCode = 1;
