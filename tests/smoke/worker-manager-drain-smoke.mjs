// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {WorkerManager} from '../../services/central-gateway/dist/worker-manager.js';

const root=await mkdtemp(join(tmpdir(),'worker-drain-'));
const checks=[];
const pass=value=>{checks.push(value);console.log('PASS '+value);};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const bridge=()=>{const exit=deferred();return {alive:true,enforcedRuntimeReady:true,pid:undefined,closed:exit.promise,exit,
  request:async()=>({ok:true}),respond(){},close(){this.alive=false;}};};
const options={root,perUser:true,maxWorkers:1,perUserTurns:1,totalTurns:1,maxRequests:2,idleMs:10_000,cooldownMs:0,event(){}};
const managers=[];
const manager=create=>{const m=new WorkerManager({...options,create});managers.push(m);return m;};
try{
  const first=bridge(),m=manager(()=>first);
  await m.forUser('alice').request('initialize',{});
  let drained=false;
  const draining=m.drain(1000).then(()=>{drained=true;});
  await wait(20);assert.equal(drained,false);assert.equal(m.snapshot().length,1);
  first.exit.resolve();await draining;assert.equal(m.snapshot().length,0);
  pass('close and alive=false retain the slot until matching cleanup evidence arrives');

  const stuck=bridge(),timeout=manager(()=>stuck);
  await timeout.forUser('stuck').request('initialize',{});
  await assert.rejects(timeout.drain(30),/WORKER_SHUTDOWN_TIMEOUT/);
  assert.equal(timeout.snapshot()[0].stopping,true);
  stuck.exit.resolve();await timeout.drain(1000);
  pass('drain timeout retains occupancy and later verified exit completes draining');

  const early=bridge();early.alive=false;early.exit.resolve();
  const replay=manager(async()=>early);
  await replay.forUser('early').request('initialize',{}).catch(()=>{});
  await replay.drain(1000);
  pass('an exit settled before async factory registration is replayed');

  const generation1=bridge(),generation2=bridge();let count=0;
  const generations=manager(()=>++count===1?generation1:generation2);
  await generations.forUser('same').request('initialize',{});
  generation1.exit.resolve();await wait(0);
  await generations.forUser('same').request('initialize',{});
  generations.exited('same',generation1);
  assert.equal(generations.snapshot().length,1);
  const generationDrain=generations.drain(1000);
  generation2.exit.resolve();await generationDrain;
  pass('stale exit evidence cannot remove the replacement generation');

  const factory=deferred(),late=bridge(),pendingManager=manager(()=>factory.promise);
  const pending=pendingManager.forUser('late').request('initialize',{}).catch(error=>error);
  const lateDrain=pendingManager.drain(1000);
  assert.match((await pending).message,/WORKER_STOPPING/);
  factory.resolve(late);await wait(0);
  assert.equal(late.alive,false);assert.equal(pendingManager.snapshot().length,1);
  late.exit.resolve();await lateDrain;
  pass('shutdown cancels a starting request and waits for the late worker cleanup');

  const unknown=bridge(),unverified=manager(()=>unknown);
  await unverified.forUser('unknown').request('initialize',{});
  unknown.exit.reject(Error('HOST_EXIT_WITHOUT_PROOF'));await wait(0);
  await assert.rejects(unverified.drain(30),/WORKER_SHUTDOWN_TIMEOUT/);
  assert.equal(unverified.snapshot().length,1);
  pass('unverified native cleanup is a bounded failure and never frees a slot');

  const child=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const actual=bridge();actual.pid=child.pid;actual.close=()=>{actual.alive=false;child.stdin.end();};
  child.stdout.resume();child.stderr.resume();child.on('error',error=>actual.exit.reject(error));
  child.on('exit',()=>actual.exit.resolve());
  const real=new WorkerManager({...options,perUser:false,create:()=>actual});managers.push(real);
  await real.drain(5000);assert.equal(child.exitCode,0);
  pass('legacy single-process shutdown waits for a real child exit');
}finally{for(const m of managers)m.close();}
console.log(JSON.stringify({scope:'worker-manager-drain',passed:true,checks}));
