// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual DTO and polling implementation; deterministic clock, no native service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
async function load(relative, replacements = []) {
  let source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  for (const [from, to] of replacements) { assert(source.includes(from)); source = source.replace(from, to); }
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'strip' })).toString('base64')}`);
}
const dto = await load('../apps/central/src/service-client.ts', [
  ["import { nativeCall } from './native';", "const nativeCall = async () => { throw Error('NATIVE_FORBIDDEN'); };"],
  ["import { invoke } from '@tauri-apps/api/core';", 'const invoke = (...args) => globalThis.metricsSmokeInvoke(...args);'],
]);
const model = await load('../apps/central/src/overview-metrics.ts');
const time = 100000;
const metrics = { sequence: 1, observedAt: time, onlineDevices: 0, activeTurns: 0, workers: 0, readyWorkers: 0, startingWorkers: 1, stoppingWorkers: 2 };
const running = { generation: 1, sequence: 2, instanceId: 'instance-a', state: 'running', cleanupVerified: false, forcedStop: false, metrics };
const state = { snapshot: running, checkedAt: time, waitingSince: time, loading: false, pending: false, error: '', now: time };
let count = 0;
async function check(name, run) { await run(); count++; console.log(`PASS ${name}`); }
await check('real zero and independent starting/stopping counts survive parsing', () => {
  const parsed = dto.readServiceSnapshot(running);
  assert.equal(parsed.metrics.startingWorkers, 1); assert.deepEqual(model.metricsView({ ...state, snapshot: parsed }).numbers, [0, 0, 0]);
});
await check('public metrics parsing detaches and strips unknown fields', () => {
  const input = structuredClone(running); input.secret = 'SYNTHETIC'; input.metrics.secret = 'SYNTHETIC';
  const parsed = dto.readServiceSnapshot(input); input.metrics.onlineDevices = 5;
  assert.equal(parsed.metrics.onlineDevices, 0); assert(!JSON.stringify(parsed).includes('SYNTHETIC'));
});
await check('invalid bounds, fractional counts, missing fields and ready without worker fail', () => {
  for (const patch of [{ sequence: 0 }, { observedAt: -1 }, { workers: 129 }, { activeTurns: 0.5 }, { onlineDevices: 100001 }, { readyWorkers: 1 }, { stoppingWorkers: undefined }])
    assert.throws(() => dto.readServiceSnapshot({ ...running, metrics: { ...metrics, ...patch } }));
  assert.throws(() => dto.readServiceSnapshot({ ...running, state: 'stopping' }));
});
await check('older compatible snapshots normalize absent metrics to null', () => assert.equal(dto.readServiceSnapshot({ ...running, metrics: undefined }).metrics, null));
await check('stale and future metrics hide all numbers', () => {
  for (const observedAt of [time - 10001, time + 1]) assert.equal(model.metricsView({ ...state, snapshot: { ...running, metrics: { ...metrics, observedAt } } }).numbers, null);
  assert.deepEqual(model.metricsView({ ...state, now: time + 10000 }).numbers, [0, 0, 0]);
});
await check('failed reads and stale stopped snapshots cannot display reassuring zeros', () => {
  assert.equal(model.metricsView({ ...state, error: 'read failed' }).numbers, null);
  const stopped = { ...running, state: 'stopped', metrics: null, cleanupVerified: true };
  assert.deepEqual(model.metricsView({ ...state, snapshot: stopped }).numbers, [0, 0, 0]);
  assert.equal(model.metricsView({ ...state, snapshot: stopped, now: time + 10001 }).numbers, null);
  for (const patch of [{ state: 'failed' }, { cleanupVerified: false }]) assert.equal(model.metricsView({ ...state, snapshot: { ...stopped, ...patch } }).numbers, null);
});
await check('running without a metrics-capable runtime has a bounded wait', () => {
  const empty = { ...state, snapshot: { ...running, metrics: null } };
  assert.equal(model.metricsView(empty).retry, false);
  const result = model.metricsView({ ...empty, now: time + 10000, checkedAt: time + 10000 });
  assert.equal(result.retry, true); assert.match(result.message, /未收到/); assert.equal(result.numbers, null);
});
await check('instance changes clear previous values, old generations and metric regressions fail', () => {
  const next = { ...running, generation: 2, sequence: 1, instanceId: 'instance-b', metrics: null };
  assert.equal(model.acceptMetricsSnapshot(running, next).metrics, null);
  for (const incoming of [{ ...running, generation: 0 }, { ...running, sequence: 1 }, { ...running, instanceId: 'foreign' }, { ...running, metrics: { ...metrics, onlineDevices: 1 } }])
    assert.throws(() => model.acceptMetricsSnapshot(running, incoming));
  assert.throws(() => model.acceptMetricsSnapshot({ ...running, metrics: { ...metrics, sequence: 2 } }, running));
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let now = time, visible = true, id = 0, calls = 0;
  const timers = new Map(), requests = [], updates = [];
  const poller = model.startMetricsPolling({
    read: () => { calls++; const request = deferred(); requests.push(request); return request.promise; },
    update: value => updates.push(value), visible: () => visible, now: () => now,
    setTimer: (callback, delay) => { const key = ++id; timers.set(key, { at: now + delay, callback }); return key; },
    clearTimer: key => timers.delete(key),
  });
  return {
    poller, requests, updates, get calls() { return calls; }, get last() { return updates.at(-1); },
    visible(value) { visible = value; poller.visibilityChanged(); },
    async advance(ms) {
      await flush(); const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}
await check('polling timeout hides values without creating overlapping IPC reads', async () => {
  const qa = fixture(); await qa.advance(8000);
  assert.equal(qa.calls, 1); assert.equal(qa.last.loading, false); assert.equal(qa.last.pending, true); assert.match(qa.last.error, /超时/);
  qa.poller.refresh(); await qa.advance(6000); assert.equal(qa.calls, 1);
  qa.requests[0].resolve(running); await flush(); assert.equal(qa.calls, 2); assert.equal(qa.last.snapshot, null);
  qa.poller.dispose(); qa.requests[1].resolve(running); await flush();
});
await check('hidden pages pause reads and suppress old responses; foreground refreshes', async () => {
  const qa = fixture(); await flush(); qa.visible(false); const before = qa.updates.length;
  qa.requests[0].resolve(running); await qa.advance(10000);
  assert.equal(qa.updates.length, before); assert.equal(qa.calls, 1);
  qa.visible(true); await flush(); assert.equal(qa.calls, 2); assert.equal(qa.last.snapshot, null);
  qa.requests[1].resolve({ ...running, metrics: { ...metrics, observedAt: time + 10000 } }); await flush();
  assert.equal(qa.last.loading, false); qa.poller.dispose();
});
await check('returning to a pending timed-out read never restarts infinite loading', async () => {
  const qa = fixture(); await flush(); qa.visible(false); await qa.advance(9000); qa.visible(true);
  assert.equal(qa.last.loading, false); assert.match(qa.last.error, /超时/); assert.equal(qa.calls, 1);
  qa.poller.dispose(); qa.requests[0].resolve(running); await flush();
});
await check('unmounted owners ignore late results and remove all scheduled polling', async () => {
  const qa = fixture(); await flush(); qa.poller.dispose(); const before = qa.updates.length;
  qa.requests[0].resolve(running); await qa.advance(30000);
  assert.equal(qa.updates.length, before); assert.equal(qa.calls, 1);
});
await check('failed read has explicit retry and subsequent success recovers', async () => {
  const qa = fixture(); await flush(); qa.requests[0].reject(Error('synthetic')); await flush();
  assert.equal(model.metricsView(qa.last).retry, true);
  qa.poller.refresh(); await flush(); qa.requests[1].resolve(running); await flush();
  assert.deepEqual(model.metricsView(qa.last).numbers, [0, 0, 0]); qa.poller.dispose();
});
await check('module-level IPC ownership is shared across overview remounts', async () => {
  let calls = 0; const request = deferred(); globalThis.metricsSmokeInvoke = () => { calls++; return request.promise; };
  const first = dto.getMetricsSnapshot(), second = dto.getMetricsSnapshot(); assert.equal(first, second); assert.equal(calls, 1);
  request.resolve(running); await first; await flush();
  globalThis.metricsSmokeInvoke = async () => { calls++; return running; }; await dto.getMetricsSnapshot(); assert.equal(calls, 2);
  delete globalThis.metricsSmokeInvoke;
});
console.log(`Central overview metrics smoke: ${count} passed.`);
