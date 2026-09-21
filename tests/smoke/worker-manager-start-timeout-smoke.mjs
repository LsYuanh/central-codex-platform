// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Bounded startup timeout QA; does not launch Codex or read credentials.
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerManager} from '../../services/central-gateway/dist/worker-manager.js';

const events = [], factories = [];
const bridges = [];
const makeBridge = () => ({alive: true, enforcedRuntimeReady: true, pid: undefined, closeCalls: 0,
  request: async () => ({ok: true}), respond() {}, close() { this.closeCalls++; this.alive = false; }});
const manager = new WorkerManager({root: await mkdtemp(join(tmpdir(),'worker-start-timeout-')), perUser: true, maxWorkers: 1, perUserTurns: 1, totalTurns: 1,
  maxRequests: 2, idleMs: 10_000, cooldownMs: 10, startTimeoutMs: 120,
  create: () => new Promise((resolve, reject) => factories.push({resolve, reject})), event: (...event) => events.push(event)});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const keepAlive = setInterval(() => {}, 1000);
const until = async predicate => { const end = Date.now() + 1500; while (Date.now() < end) { if (predicate()) return; await wait(10); } throw Error('QA_START_TIMEOUT_WAIT'); };
const result = {scope: 'worker-manager-start-timeout', passed: false, checks: []};
const pass = value => { result.checks.push(value); console.log('PASS ' + value); };
try {
  const pending = manager.forUser('slow').request('info', {}).catch(error => error);
  await until(() => manager.snapshot()[0]?.starting === true);
  assert.equal(manager.snapshot()[0].stopping, false);
  const error = await pending;
  assert.match(error.message, /WORKER_STOPPING/);
  assert.equal(manager.snapshot()[0].stopping, true);
  assert(events.some(event => event[0] === 'worker.start' && event[2] === 'failed' && event[3] === 'WORKER_START_TIMEOUT'));
  pass('Unresolved startup reaches a bounded failure and rejects its waiting request without sending an RPC');
  const late = makeBridge(); bridges.push(late); factories[0].resolve(late);
  await until(() => late.closeCalls === 1);
  assert.equal(manager.snapshot().length, 1);
  manager.exited('slow', late);
  assert.equal(manager.snapshot().length, 0);
  pass('A late bridge is closed exactly once and its slot remains reserved until matching exit');
  await wait(20);
  const retryPromise = manager.forUser('slow').request('info', {nonce: 'explicit-retry'}).catch(error => error);
  assert.equal(factories.length, 2);
  const retry = makeBridge(); bridges.push(retry); factories[1].resolve(retry);
  assert.deepEqual(await retryPromise, {ok: true});
  pass('After matching exit, a new explicit request starts one replacement without replaying the timed out request');
  result.passed = true;
} finally {
  clearInterval(keepAlive);
  manager.close();
  for (const bridge of bridges) bridge.close();
}
console.log(JSON.stringify(result));
