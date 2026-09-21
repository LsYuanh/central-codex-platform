// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Exercises the actual projection and request observer, with deterministic IPC.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
async function load(relative, replacements) {
  let source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  for (const [from, to] of replacements) { assert(source.includes(from)); source = source.replace(from, to); }
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source, { mode: 'strip' })).toString('base64')}`);
}
const service = await load('../../apps/central/src/service-client.ts', [
  ["import { nativeCall } from './native';", "const nativeCall = async () => { throw Error('NATIVE_FORBIDDEN'); };"],
  ["import { invoke } from '@tauri-apps/api/core';", "const invoke = async () => { throw Error('NATIVE_FORBIDDEN'); };"],
]);
globalThis.diagnosticsReadMetrics = service.readServiceMetrics;
const model = await load('../../apps/central/src/diagnostics-client.ts', [
  ["import { invoke } from '@tauri-apps/api/core';", "const invoke = async () => { throw Error('NATIVE_FORBIDDEN'); };"],
  ["import { readServiceMetrics, type ServiceMetrics, type ServiceSnapshot } from './service-client';", 'const readServiceMetrics = globalThis.diagnosticsReadMetrics;'],
]);
const time = 100000;
const report = { schemaVersion: 1, generatedAt: time, appVersion: '0.1.0', platform: 'windows',
  configuration: { status: 'available', revision: 1, limits: { maxWorkers: 8, perUserTurns: 2, totalTurns: 4 }, shutdown: { graceMs: 5000, forceMs: 1000 }, runtimeSelected: true, certificateSelected: true, errorCode: null },
  service: { state: 'running', generation: 1, sequence: 2, observedAt: time, cleanupVerified: false, forcedStop: false, failureCode: null, metricsStatus: 'fresh',
    metrics: { sequence: 1, observedAt: time, onlineDevices: 1, activeTurns: 0, workers: 1, readyWorkers: 1, startingWorkers: 0, stoppingWorkers: 2 } } };
let count = 0;
async function check(name, run) { await run(); count++; console.log(`PASS ${name}`); }
await check('public projection detaches every nested record and strips identifiers, credentials and paths', () => {
  const input = structuredClone(report);
  for (const record of [input, input.configuration, input.configuration.limits, input.configuration.shutdown, input.service, input.service.metrics]) record.secret = 'SYNTHETIC_SECRET';
  const output = model.readDiagnosticsReport(input);
  input.service.metrics.workers = 128; input.configuration.limits.maxWorkers = 128;
  assert.equal(output.service.metrics.workers, 1); assert.equal(output.configuration.limits.maxWorkers, 8);
  assert(!JSON.stringify(output).includes('SYNTHETIC_SECRET'));
});
await check('unknown error content becomes a fixed code and message', () => {
  const output = model.readDiagnosticsReport({ ...report, service: { ...report.service, state: 'failed', metricsStatus: 'inactive', metrics: null, failureCode: 'C:\\SYNTHETIC_SECRET' } });
  assert.equal(output.service.failureCode, 'INTERNAL_ERROR'); assert(!JSON.stringify(output).includes('SYNTHETIC_SECRET'));
  assert.equal(model.diagnosticsMessage({ code: 'unknown', message: 'SYNTHETIC_SECRET' }), model.diagnosticsMessage('INTERNAL_ERROR'));
});
await check('native public failure codes and no-overwrite result have actionable fixed mappings', () => {
  const native = readFileSync(new URL('../../apps/central/src-tauri/src/diagnostics.rs', import.meta.url), 'utf8');
  const body = native.slice(native.indexOf('fn public_code('), native.indexOf('pub fn build_report('));
  for (const [, code] of body.matchAll(/"([A-Z_]+)"\s*=>/g)) assert.notEqual(model.diagnosticsMessage(code), model.diagnosticsMessage('INTERNAL_ERROR'), code);
  assert.match(model.diagnosticsMessage('DIAGNOSTICS_TARGET_EXISTS'), /已存在.*新的文件名.*未覆盖/);
});
await check('invalid counts, configuration limits, times and impossible metric states fail closed', () => {
  for (const patch of [{ schemaVersion: 2 }, { generatedAt: 0 }, { platform: 'win32' }, { appVersion: '0.1.0 /SECRET' }]) assert.throws(() => model.readDiagnosticsReport({ ...report, ...patch }));
  for (const patch of [{ workers: 129 }, { onlineDevices: -1 }, { activeTurns: 0.5 }, { readyWorkers: 2 }, { observedAt: time + 1 }, { observedAt: time - 10001 }])
    assert.throws(() => model.readDiagnosticsReport({ ...report, service: { ...report.service, metrics: { ...report.service.metrics, ...patch } } }));
  for (const patch of [{ state: 'stopped' }, { state: 'other' }, { metricsStatus: 'inactive' }, { metricsStatus: 'stale' }, { forcedStop: true }, { cleanupVerified: true }, { observedAt: time + 1 }, { failureCode: 'SERVICE_START_TIMEOUT' }])
    assert.throws(() => model.readDiagnosticsReport({ ...report, service: { ...report.service, ...patch } }));
  for (const limits of [{ maxWorkers: 129, perUserTurns: 1, totalTurns: 1 }, { maxWorkers: 1, perUserTurns: 3, totalTurns: 2 }])
    assert.throws(() => model.readDiagnosticsReport({ ...report, configuration: { ...report.configuration, limits } }));
  assert.throws(() => model.readDiagnosticsReport({ ...report, configuration: { ...report.configuration, shutdown: { graceMs: 60001, forceMs: 1000 } } }));
});
await check('missing configuration and stopped service remain explicit, without fabricated metrics', () => {
  const empty = model.readDiagnosticsReport({ ...report, configuration: { status: 'missing', revision: null, limits: null, shutdown: null, runtimeSelected: false, certificateSelected: false, errorCode: null },
    service: { ...report.service, state: 'stopped', cleanupVerified: true, metricsStatus: 'inactive', metrics: null } });
  assert.equal(empty.configuration.status, 'missing'); assert.equal(empty.service.metrics, null);
  assert.throws(() => model.readDiagnosticsReport({ ...empty, configuration: { ...empty.configuration, revision: 1 } }));
  for (const metricsStatus of ['missing', 'stale']) assert.equal(model.readDiagnosticsReport({ ...report, service: { ...report.service, metricsStatus, metrics: null } }).service.metrics, null);
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let now = time, key = 0;
  const timers = new Map(), reads = [], saves = [], updates = [];
  const read = model.createDiagnosticsFlight(() => { const task = deferred(); reads.push(task); return task.promise; }, () => now);
  const save = model.createDiagnosticsFlight(() => { const task = deferred(); saves.push(task); return task.promise; }, () => now);
  const mount = () => model.createDiagnosticsSession({ read, export: save, update: value => updates.push(value), now: () => now,
    setTimer: (callback, delay) => { const id = ++key; timers.set(id, { at: now + delay, callback }); return id; }, clearTimer: id => timers.delete(id) });
  return { reads, saves, updates, mount, get last() { return updates.at(-1); },
    async advance(ms) {
      await flush(); const end = now + ms;
      for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush(); }
      now = end; await flush();
    } };
}
await check('read timeout retains the real lock and ignores late result; retry succeeds after settlement', async () => {
  const qa = fixture(), view = qa.mount(); view.refresh(); await qa.advance(10000);
  assert.equal(qa.reads.length, 1); assert.equal(qa.last.reading, false); assert.equal(qa.last.readPending, true); assert.match(qa.last.readError, /超过 10 秒/);
  view.refresh(); await flush(); assert.equal(qa.reads.length, 1);
  qa.reads[0].resolve(report); await flush(); assert.equal(qa.last.report, null); assert.equal(qa.last.readPending, false);
  view.refresh(); await flush(); qa.reads[1].resolve(report); await flush(); assert.equal(qa.last.report, report); assert.equal(qa.last.readError, ''); view.dispose();
});
await check('failed refresh preserves previous collection time and never exposes raw error', async () => {
  const qa = fixture(), view = qa.mount(); view.refresh(); await flush(); qa.reads[0].resolve(report); await flush();
  view.refresh(); await flush(); qa.reads[1].reject({ code: 'UNKNOWN', message: 'SYNTHETIC_SECRET' }); await flush();
  assert.equal(qa.last.report.generatedAt, time); assert(!qa.last.readError.includes('SYNTHETIC_SECRET')); assert.equal(qa.last.readPending, false); view.dispose();
});
await check('unmounted read cannot publish a late completion and remount cannot overlap actual IPC', async () => {
  const qa = fixture(), first = qa.mount(); first.refresh(); await flush(); first.dispose(); const oldUpdates = qa.updates.length;
  qa.reads[0].resolve(report); await flush(); assert.equal(qa.updates.length, oldUpdates);
  const second = qa.mount(); second.refresh(); await flush(); second.dispose(); const third = qa.mount(); third.refresh(); await flush();
  assert.equal(qa.reads.length, 2); qa.reads[1].resolve(report); await flush(); assert.equal(qa.last.report, report); third.dispose();
});
await check('export timeout, navigation and repeated clicks keep one native save dialog', async () => {
  const qa = fixture(), first = qa.mount(); first.export(); await qa.advance(120000);
  assert.equal(qa.saves.length, 1); assert.equal(qa.last.exportStatus, 'timeout'); assert.equal(qa.last.exportPending, true);
  first.export(); first.dispose(); const second = qa.mount(); second.export(); await qa.advance(1);
  assert.equal(qa.saves.length, 1); assert.equal(qa.last.exportStatus, 'timeout');
  qa.saves[0].resolve(true); await flush(); assert.equal(qa.last.exportStatus, 'saved'); assert.equal(qa.last.exportPending, false); second.dispose();
});
await check('export cancellation, known conflict and success have distinct recoverable outcomes', async () => {
  const qa = fixture(), view = qa.mount(); view.export(); await flush(); qa.saves[0].resolve(false); await flush(); assert.equal(qa.last.exportStatus, 'cancelled');
  view.export(); await flush(); qa.saves[1].reject({ code: 'DIAGNOSTICS_TARGET_EXISTS', detail: 'SYNTHETIC_SECRET' }); await flush();
  assert.equal(qa.last.exportStatus, 'failed'); assert.match(qa.last.exportMessage, /已存在/); assert(!qa.last.exportMessage.includes('SYNTHETIC_SECRET'));
  view.export(); await flush(); qa.saves[2].resolve(true); await flush(); assert.equal(qa.last.exportStatus, 'saved'); view.dispose();
});
await check('idle mounted diagnostics never poll or export automatically', async () => {
  const qa = fixture(), view = qa.mount(); await qa.advance(300000); assert.equal(qa.reads.length, 0); assert.equal(qa.saves.length, 0);
  view.refresh(); await flush(); qa.reads[0].resolve(report); await qa.advance(300000); assert.equal(qa.reads.length, 1); assert.equal(qa.saves.length, 0); view.dispose();
});
console.log(`central diagnostics smoke: ${count} passed`);
