// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Two real native processes. Endpoint addresses are exchanged in memory, never logged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
const executable = resolve(root, 'target/debug/examples', process.platform === 'win32' ? 'peer-probe.exe' : 'peer-probe');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('PEER_PROBE_')) delete env[key];
const observeSeconds = Number(process.argv[2] ?? 2);
assert(Number.isSafeInteger(observeSeconds) && observeSeconds >= 1);
env.PEER_PROBE_OBSERVE_SECS = String(observeSeconds);
const children = [];
const traceDirectory = resolve(root, 'target/peer-transport/private-traces');
await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
const traceRun = `${Date.now()}-${process.pid}`;
let timer;
try {
  const peers = ['listen', 'dial'].map(role => {
    const traceFile = resolve(traceDirectory, `${traceRun}-${role}.log`);
    const child = spawn(executable, [role], { cwd: root,
      env: { ...env, PEER_PROBE_TRACE_FILE: traceFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let resolveAddress, rejectAddress;
    const address = new Promise((yes, no) => { resolveAddress = yes; rejectAddress = no; });
    let result;
    let lines = 0;
    child.stderr.resume(); // Detailed diagnostics may contain addresses. Keep the report redacted.
    const done = new Promise((yes, no) => {
      child.once('error', error => { rejectAddress(error); no(error); });
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const value = JSON.parse(line);
          if (++lines === 1) {
            assert.equal(typeof value.id, 'string');
            assert(Array.isArray(value.addrs));
            resolveAddress(value);
          } else {
            assert.equal(lines, 2, 'unexpected probe output');
            result = value;
          }
        } catch {
          const error = new Error('Invalid native probe output');
          rejectAddress(error); no(error); child.kill();
        }
      });
      child.once('exit', code => {
        if (code !== 0 || !result) {
          const error = new Error(`${role} probe failed (exit ${code})`);
          rejectAddress(error); no(error);
        } else yes(result);
      });
    });
    // Attach rejection handlers immediately, even while awaiting the addressing phase.
    address.catch(() => {});
    done.catch(() => {});
    return { child, address, done, traceFile };
  });
  const deadline = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error('Native probe test deadline exceeded')), observeSeconds * 1000 + 90_000);
  });
  const run = async () => {
    const [listener, dialer] = await Promise.all(peers.map(peer => peer.address));
    peers[0].child.stdin.end(JSON.stringify(dialer) + '\n');
    peers[1].child.stdin.end(JSON.stringify(listener) + '\n');
    const [served, received] = await Promise.all(peers.map(peer => peer.done));
    assert.equal(received.bytes, 8 * 1024 * 1024 + 17);
    assert.equal(served.bytesEchoed, received.bytes);
    assert.equal(received.routeBefore, 'Direct');
    assert.equal(received.routeAfter, 'Direct');
    assert.match(received.sha256, /^[a-f0-9]{64}$/);
    for (const result of [served, received]) {
      assert.equal(result.protocolVersion, 2);
      assert.equal(result.transferComplete, true);
      assert.equal(result.observationComplete, true);
      assert(result.heartbeats >= 1);
      assert(result.diagnostics.some(event => event.event === 'path_snapshot'));
      assert(result.diagnostics.some(event => event.event === 'net_report'));
    }
    assert.equal(served.heartbeats, received.heartbeats);
    assert(received.observationElapsedMs >= observeSeconds * 1000);
    for (const peer of peers) assert((await stat(peer.traceFile)).size > 0, 'private trace must contain transport events');
    const report = { schema: 'peer-transport-probe/v2', scope: 'same-host-two-processes', passed: true, results: [served, received] };
    await mkdir(resolve(root, 'target/peer-transport'), { recursive: true });
    await writeFile(resolve(root, 'target/peer-transport/two-process.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('PEER_TRANSPORT_PROBE_OK: two native processes, direct route, SHA-256 round trip; WAN not tested');
  };
  await Promise.race([run(), deadline]);
} finally {
  clearTimeout(timer);
  for (const child of children) if (child.exitCode === null) child.kill();
}
