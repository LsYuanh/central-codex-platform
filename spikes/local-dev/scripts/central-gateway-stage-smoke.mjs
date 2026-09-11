// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyClosure, digestFile, inside, verifyCandidate } from './stage-central-gateway.mjs';

export async function smokeGateway(candidate) {
  if (!path.isAbsolute(candidate)) throw Error('ABSOLUTE_CANDIDATE_REQUIRED');
  const manifest = await verifyCandidate(candidate);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'central-gateway-distribution-'));
  const runtime = path.join(temporary, 'runtime');
  let child;
  let exited;
  let output = '';
  try {
    // Outside the source workspace: ancestor node_modules cannot satisfy a
    // missing dependency. The package carries its own Node executable.
    await cp(candidate, runtime, { recursive: true, errorOnExist: true, force: false });
    await verifyCandidate(runtime);
    const undeclared = path.join(runtime, 'undeclared.js');
    await writeFile(undeclared, '// must not enter a verified runtime');
    await assert.rejects(verifyCandidate(runtime), /UNDECLARED_FILE/);
    await rm(undeclared);
    const sample = path.join(temporary, 'integrity-sample');
    await writeFile(sample, 'verified');
    const before = await digestFile(sample);
    await writeFile(sample, 'modified');
    assert.notEqual((await digestFile(sample)).sha256, before.sha256);
    for (const bad of ['../escape', '/absolute', 'a\\b', 'a/../b', 'C:/drive']) assert.throws(() => inside(runtime, bad));
    const nested = dependencyClosure({ packages: {
      'node_modules/a': { version: '1', integrity: 'sha512-a', dependencies: { b: '1' } },
      'node_modules/a/node_modules/b': { version: '1', integrity: 'sha512-b' },
      'node_modules/dev-only': { version: '1', integrity: 'sha512-d' },
    } }, { dependencies: { a: '1' } });
    assert.deepEqual([...nested.selected.keys()], ['node_modules/a', 'node_modules/a/node_modules/b']);
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    assert.notEqual(port, 4510);
    const home = path.join(temporary, 'home');
    await mkdir(home);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR)$/i.test(key)));
    Object.assign(env, { TEMP: temporary, TMP: temporary, USERPROFILE: home, HOME: home,
      TEST_GATEWAY_HOST: '127.0.0.1', TEST_GATEWAY_PORT: String(port),
      TEST_GATEWAY_STATE_FILE: path.join(temporary, 'state.json'),
      CODEX_BIN: path.join(temporary, 'intentionally-unavailable-worker.exe'),
      NODE_PATH: '', NODE_OPTIONS: '',
    });
    child = spawn(path.join(runtime, 'bin', 'node.exe'), [inside(runtime, manifest.entrypoint)], {
      cwd: temporary, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = `${output}${data}`.slice(-32768); });
    const deadline = Date.now() + 15000;
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error(`GATEWAY_EXITED:${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(health?.ok, true, `No healthy standalone gateway: ${output}`);
    assert.equal(health.service, 'central-test-gateway');
    assert.equal(health.requiredHarness, 'yuan-zhou-remote-workspace/1');
    assert.equal(health.enforcedRuntimeReady, false);
    assert.equal(health.controlsEnabled, false);
    assert.equal(health.clients, 0);
    assert.equal(health.devices, 0);
    child.kill();
    const cleanup = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('GATEWAY_CLEANUP_TIMEOUT')), 5000); timer.unref(); })]);
    child = undefined;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));
    return {
      passed: true, scope: 'standalone-gateway-distribution-health-only',
      node: manifest.node.version, dependencyCount: manifest.packages.length, fileCount: manifest.files.length,
      workspaceDependenciesUsed: false, realCredentialsUsed: false, workerStarted: false,
      formal4510Modified: false, ready: false, qualified: false,
      checks: ['copied-candidate-integrity', 'undeclared-file-rejection', 'path-traversal-rejection', 'same-size-tamper-detected', 'nested-production-dependency-closure', 'isolated-node-start', 'healthz', 'child-exit', 'listener-closed'],
      health, cleanup,
    };
  } finally {
    if (child) {
      child.kill();
      await Promise.race([exited, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('GATEWAY_CLEANUP_TIMEOUT')), 5000);
        timer.unref();
      })]);
    }
    if (path.dirname(temporary) !== os.tmpdir() || !path.basename(temporary).startsWith('central-gateway-distribution-')) throw Error('UNSAFE_CLEANUP');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--candidate') {
    console.error('Usage: node scripts/central-gateway-stage-smoke.mjs --candidate <absolute staged gateway directory>');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await smokeGateway(process.argv[3]), null, 2)); }
    catch (error) { console.error(error.stack); process.exitCode = 1; }
  }
}
