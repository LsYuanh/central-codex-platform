// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual isolated filesystem tests. No gateway, private state, network or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { readGatewayState, writeGatewayState } from '../services/test-gateway/dist/gateway-state.js';

const evidenceRoot = resolve('target');
fs.mkdirSync(evidenceRoot, { recursive: true });
const root = fs.mkdtempSync(join(evidenceRoot, 'harness-state-smoke-'));
const statePath = join(root, 'state.json');
const checks = [];
const legacy = {
  version: 1,
  futureTopLevel: { preserve: ['unknown', { nested: true }] },
  users: {
    'harness-state-user': [{
      id: 'legacy-thread', futureEntry: 'preserve-entry',
      summary: {
        id: 'legacy-thread', futureSummary: { schema: 7 },
        attachmentSubmissions: [{ clientMessageId: 'legacy-message', status: 'sent', attachments: [{ path: 'C:\\fixture\\old.txt', future: true }] }],
        outputs: [{ id: 'legacy-output', status: 'saved', sha256: 'legacy-digest', future: ['kept'] }],
      },
    }],
  },
};

function noTemporaryFiles() {
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), [], 'failed write leaked a sibling temporary file');
}
function originalUnchanged(before) {
  assert.deepEqual(fs.readFileSync(statePath), before, 'last committed state was changed by a failed operation');
  noTemporaryFiles();
}

try {
  assert.deepEqual(readGatewayState(statePath), { version: 1, users: {} });
  assert.equal(fs.existsSync(statePath), false, 'missing-state read must not create a file');
  checks.push('missing-file-empty-without-write');

  fs.writeFileSync(statePath, JSON.stringify(legacy));
  const loaded = readGatewayState(statePath);
  assert.deepEqual(loaded, legacy, 'read stripped unknown legacy fields');
  writeGatewayState(statePath, loaded);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), legacy, 'write stripped unknown legacy fields');
  noTemporaryFiles();
  checks.push('legacy-v1-unknown-fields-roundtrip');

  const corruptCases = [
    ['bad-json', '{"version":1,"users":'],
    ['wrong-version', JSON.stringify({ version: 2, users: {} })],
    ['users-array', JSON.stringify({ version: 1, users: [] })],
    ['empty-user', JSON.stringify({ version: 1, users: { '': [] } })],
    ['missing-summary', JSON.stringify({ version: 1, users: { a: [{ id: 'x' }] } })],
    ['empty-thread', JSON.stringify({ version: 1, users: { a: [{ id: '', summary: {} }] } })],
    ['duplicate-one-user', JSON.stringify({ version: 1, users: { a: [{ id: 'x', summary: {} }, { id: 'x', summary: {} }] } })],
    ['duplicate-multiple-users', JSON.stringify({ version: 1, users: { a: [{ id: 'x', summary: {} }], b: [{ id: 'x', summary: {} }] } })],
  ];
  for (const [name, raw] of corruptCases) {
    fs.writeFileSync(statePath, raw);
    const before = fs.readFileSync(statePath);
    assert.throws(() => readGatewayState(statePath), /GATEWAY_STATE_CORRUPT.*preserve the state file/);
    originalUnchanged(before);
    checks.push(`reject-${name}-preserve-bytes`);
  }
  assert.throws(() => readGatewayState(root), /GATEWAY_STATE_UNREADABLE/);
  checks.push('unreadable-is-not-missing');

  writeGatewayState(statePath, legacy);
  const committed = fs.readFileSync(statePath);
  const circular = { version: 1, users: {} };
  circular.self = circular;
  assert.throws(() => writeGatewayState(statePath, circular), /circular/i);
  originalUnchanged(committed);
  checks.push('serialization-failure-cleans-temp-preserves-commit');

  const blockedParent = join(root, 'blocked-parent');
  fs.writeFileSync(blockedParent, 'existing regular file');
  assert.throws(() => writeGatewayState(join(blockedParent, 'state.json'), legacy));
  assert.equal(fs.readFileSync(blockedParent, 'utf8'), 'existing regular file');
  originalUnchanged(committed);
  checks.push('actual-invalid-parent-write-failure');

  // Cross-platform deterministic failure at the commit boundary. All preceding
  // open/write/fsync/close calls still operate on a real sibling temporary file.
  const rename = fs.renameSync;
  let renameObserved = false;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === statePath) {
        renameObserved = true;
        assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).futureTopLevel.replacement, true);
        originalUnchangedBeforeRename();
        throw Object.assign(new Error('injected exact-target rename EACCES'), { code: 'EACCES' });
      }
      return rename(source, destination);
    };
    syncBuiltinESMExports();
    assert.throws(() => writeGatewayState(statePath, { ...legacy, futureTopLevel: { replacement: true } }), /injected exact-target rename EACCES/);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert(renameObserved);
  originalUnchanged(committed);
  checks.push('injected-rename-failure-cleans-temp-preserves-commit');
  function originalUnchangedBeforeRename() { assert.deepEqual(fs.readFileSync(statePath), committed); }

  // A separate worker really opens/reads the file while the main thread commits.
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const version = sequence => ({ version: 1, users: {}, future: { sequence, payload: `${sequence}:`.repeat(20000) } });
  writeGatewayState(statePath, version(0));
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const fs=require('node:fs');
    const stop=new Int32Array(workerData.stop);
    let reads=0, min=Infinity, max=-Infinity;
    parentPort.postMessage({ready:true});
    try {
      while(!Atomics.load(stop,0)) {
        const state=JSON.parse(fs.readFileSync(workerData.path,'utf8'));
        const n=state.future.sequence;
        if(state.version!==1 || state.future.payload!==String(n).concat(':').repeat(20000))throw new Error('incoherent snapshot');
        reads++;min=Math.min(min,n);max=Math.max(max,n);
      }
      parentPort.postMessage({reads,min,max});
    } catch(error) {parentPort.postMessage({error:String(error),reads});}
  `, { eval: true, workerData: { path: statePath, stop: stop.buffer } });
  let concurrent;
  try {
    const [ready] = await once(worker, 'message');
    assert.equal(ready.ready, true);
    const finished = once(worker, 'message');
    let committedGeneration = 0;
    let refusedCommits = 0;
    for (let generation = 1; generation <= 80; generation++) {
      try {
        writeGatewayState(statePath, version(generation));
        committedGeneration = generation;
      } catch (error) {
        // Windows can deny replacement while another process briefly holds a
        // reader handle. This must remain an explicit failed commit, never a
        // truncated state or a claimed successful update.
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
        refusedCommits++;
        assert.deepEqual(readGatewayState(statePath), version(committedGeneration));
        noTemporaryFiles();
      }
    }
    Atomics.store(stop, 0, 1);
    [concurrent] = await finished;
    assert.equal(concurrent.error, undefined, `concurrent reader failed: ${JSON.stringify(concurrent)}`);
    assert(concurrent.reads > 0, 'concurrent reader did not observe any snapshots');
    assert(concurrent.max > concurrent.min, 'concurrent reader must observe more than one generation');
    assert.deepEqual(readGatewayState(statePath), version(committedGeneration));
    Object.assign(concurrent, { committedGeneration, refusedCommits });
    noTemporaryFiles();
    checks.push('concurrent-reader-sees-only-complete-json');
  } finally {
    Atomics.store(stop, 0, 1);
    await worker.terminate();
  }
  console.log(JSON.stringify({ result: 'HARNESS_STATE_SMOKE_OK', checks, concurrent }));
} finally {
  // Only remove the exact mkdtemp directory we created, after resolving its boundary.
  const absoluteRoot = fs.realpathSync(root);
  const absoluteParent = fs.realpathSync(evidenceRoot);
  const child = relative(absoluteParent, absoluteRoot);
  assert(child.startsWith('harness-state-smoke-') && child !== '..' && !child.includes(sep) && !isAbsolute(child));
  fs.rmSync(absoluteRoot, { recursive: true, force: true });
}
