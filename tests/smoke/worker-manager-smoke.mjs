// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,readdir,stat} from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {WorkerManager} from '../../services/central-gateway/dist/worker-manager.js';
import {AuditJournal} from '../../services/central-gateway/dist/audit-journal.js';
const root=await mkdtemp(join(tmpdir(),'workers-')),script=join(root,'fixture.cjs'),checks=[],events=[],bridges=[];
await writeFile(script,`const fs=require('fs'),p=require('path');const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line),t=q.params?.threadId;const out=m=>process.stdout.write(JSON.stringify(m)+'\\n');if(q.method==='hang')return;if(q.method==='crash')process.exit(27);if(q.method==='error'){out({id:q.id,error:'App Server request failed: rejected'});return;}if(q.method==='turn/start')fs.writeFileSync(p.join(process.env.CODEX_HOME,t),t);if(q.method==='turn/interrupt')out({method:'turn/completed',params:{threadId:t,turn:{id:'turn-'+t,status:'interrupted'}}});out({id:q.id,result:q.method==='initialize'?{userAgent:'fixture yuan-zhou-remote-workspace/1'}:q.method==='turn/start'?{turn:{id:'turn-'+t}}:q.method==='thread/read'?{thread:{id:t,marker:fs.readFileSync(p.join(process.env.CODEX_HOME,t),'utf8')}}:{pid:process.pid,cwd:process.cwd(),home:process.env.CODEX_HOME}});});`);
let manager;
class Bridge{
  alive=true;enforcedRuntimeReady=false;next=0;pending=new Map();
  constructor(user,paths){this.child=spawn(process.execPath,[script],{cwd:paths.directory,env:{...process.env,CODEX_HOME:paths.home},windowsHide:true,stdio:['pipe','pipe','pipe']});this.pid=this.child.pid;this.child.stderr.resume();createInterface({input:this.child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}}else manager.notification(user,this,m);});this.child.on('exit',()=>{this.alive=false;this.enforcedRuntimeReady=false;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('worker exited; result unknown'));}this.pending.clear();manager.notification(user,this,{method:'gateway/runtimeUnavailable'});manager.exited(user,this);});bridges.push(this);}
  async request(method,params){const id=++this.next;const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('request timeout; result unknown'));},500);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});if(method==='initialize')this.enforcedRuntimeReady=true;return result;}
  respond(){} close(){this.alive=false;this.child.kill();}
}
const options={root:join(root,'users'),perUser:true,maxWorkers:2,perUserTurns:1,totalTurns:2,maxRequests:2,idleMs:10000,cooldownMs:100,create:(user,paths)=>new Bridge(user,paths),event:(...e)=>events.push(e)};
const until=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,25));}throw Error('condition timeout');};
const pass=s=>{checks.push(s);console.log('PASS '+s);};
try{
 if(!process.env.AUDIT_ONLY){
 manager=new WorkerManager(options);const a=manager.forUser('alice'),b=manager.forUser('bob');
 const [ia,ib]=await Promise.all([a.request('info',{}),b.request('info',{})]);assert.notEqual(ia.pid,ib.pid);assert.notEqual(ia.cwd,ib.cwd);assert.notEqual(ia.home,ib.home);pass('real child processes and canonical homes separated');
 await assert.rejects(manager.forUser('charlie').request('info',{}),/WORKER_CAPACITY/);pass('worker capacity enforced');
 await a.request('turn/start',{threadId:'a'});await assert.rejects(a.request('turn/start',{threadId:'a'}),/THREAD_BUSY/);await assert.rejects(a.request('turn/start',{threadId:'a2'}),/TURN_LIMIT/);await b.request('turn/start',{threadId:'b'});pass('per-user turn quota does not consume another user allowance');
 await a.request('turn/interrupt',{threadId:'a'});await a.request('turn/start',{threadId:'a2'});pass('terminal event releases quota');
 await assert.rejects(a.request('crash',{}),/exited/);assert.equal((await b.request('info',{})).pid,ib.pid);await until(()=>manager.snapshot().length===1);await assert.rejects(a.request('info',{}),/RESTART_BACKOFF/);await new Promise(r=>setTimeout(r,120));const restarted=await a.request('thread/read',{threadId:'a'});assert.equal(restarted.thread.marker,'a');assert.notEqual(manager.snapshot().find(w=>w.userId==='alice').pid,ia.pid);assert.equal(manager.snapshot().find(w=>w.userId==='bob').activeTurns,1);pass('crashed user restarts with saved history; other worker and active turn unaffected');
 const pending=[a.request('hang',{}).catch(e=>e),a.request('hang',{}).catch(e=>e)];await assert.rejects(a.request('info',{}),/WORKER_REQUEST_LIMIT/);await Promise.all(pending);assert(await a.request('info',{}));pass('bounded pending RPCs recover after timeout');
 manager.close();await until(()=>bridges.every(b=>b.child.exitCode!==null||b.child.signalCode!==null));
 manager=new WorkerManager({...options,totalTurns:1,idleMs:100});await manager.forUser('a').request('turn/start',{threadId:'active'});await assert.rejects(manager.forUser('b').request('turn/start',{threadId:'other'}),/TURN_LIMIT/);await until(()=>manager.snapshot().length===1);assert.equal(manager.snapshot()[0].userId,'a');pass('global quota and idle reclaim preserve active worker');
 manager.close();await until(()=>bridges.every(b=>b.child.exitCode!==null||b.child.signalCode!==null));
 // Controlled response ordering exercises the manager boundary without timing-sensitive sleeps.
 const startReplies=[];const raceBridge={alive:true,enforcedRuntimeReady:true,pid:undefined,respond(){},close(){this.alive=false;},request(method){assert.equal(method,'turn/start');return new Promise(resolve=>startReplies.push(resolve));}};
 manager=new WorkerManager({...options,idleMs:10000,create:()=>raceBridge});const racer=manager.forUser('race');
 const complete=id=>manager.notification('race',raceBridge,{method:'turn/completed',params:{threadId:'same-thread',turn:{id,status:'completed'}}});
 const oldStart=racer.request('turn/start',{threadId:'same-thread'});startReplies.shift()({turn:{id:'old-turn'}});await oldStart;complete('old-turn');assert.equal(manager.snapshot()[0].activeTurns,0);
 const newStart=racer.request('turn/start',{threadId:'same-thread'});complete('old-turn');assert.equal(manager.snapshot()[0].activeTurns,1);
 await assert.rejects(racer.request('turn/start',{threadId:'same-thread'}),/THREAD_BUSY/);await assert.rejects(racer.request('turn/start',{threadId:'another-thread'}),/TURN_LIMIT/);
 startReplies.shift()({turn:{id:'new-turn'}});await newStart;assert.equal(manager.snapshot()[0].activeTurns,1);complete('old-turn');assert.equal(manager.snapshot()[0].activeTurns,1);complete('new-turn');assert.equal(manager.snapshot()[0].activeTurns,0);
 pass('late old Turn completion cannot release the pending or identified new Turn reservation');
 const earlyStart=racer.request('turn/start',{threadId:'same-thread'});complete('early-turn');assert.equal(manager.snapshot()[0].activeTurns,1);
 await assert.rejects(racer.request('turn/start',{threadId:'another-thread'}),/TURN_LIMIT/);startReplies.shift()({turn:{id:'early-turn'}});await earlyStart;assert.equal(manager.snapshot()[0].activeTurns,0);
 pass('completion preceding start response retains quota until the matching Turn ID is confirmed');
 manager.close();
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 const mockBridge=()=>({alive:true,enforcedRuntimeReady:true,pid:undefined,sent:[],closeCalls:0,
   respond(){},close(){this.closeCalls++;this.alive=false;},
   async request(method,params){this.sent.push({method,params});return method==='turn/start'?{turn:{id:'async-'+params.threadId}}:{method,params};}});
 const within=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('async fixture did not settle')),2000);})]);}finally{clearTimeout(timer);}};
 // Creation is deliberately unresolved: request slots and worker capacity must
 // be reserved before the factory can create a bridge or execute an RPC.
 let factories=[];let createCount=0;
 const asyncCreate=()=>{createCount++;const creation=deferred();factories.push(creation);return creation.promise;};
 manager=new WorkerManager({...options,maxWorkers:1,maxRequests:2,create:asyncCreate});
 const queuedA=manager.forUser('async-a').request('info',{nonce:1});
 const queuedB=manager.forUser('async-a').request('info',{nonce:2});
 assert.equal(createCount,1);assert.equal(manager.snapshot()[0].starting,true);assert.equal(manager.snapshot()[0].pendingRequests,2);
 assert.equal(manager.enforcedRuntimeReady,false);
 await assert.rejects(manager.forUser('async-a').request('info',{nonce:3}),/WORKER_REQUEST_LIMIT/);
 await assert.rejects(manager.forUser('async-b').request('info',{}),/WORKER_CAPACITY/);
 const shared=mockBridge();factories[0].resolve(shared);
 await within(Promise.all([queuedA,queuedB]));assert.deepEqual(shared.sent.map(call=>call.params.nonce),[1,2]);
 assert.equal(manager.snapshot()[0].pendingRequests,0);assert.equal(manager.snapshot()[0].starting,false);assert.equal(createCount,1);
 pass('delayed async factory is single-flight; startup waiters and other users obey request and worker capacity with no replay');
 manager.close();

 factories=[];createCount=0;
 manager=new WorkerManager({...options,maxWorkers:1,create:asyncCreate});
 const rejectedA=manager.forUser('failure').request('info',{}).catch(error=>error);
 const rejectedB=manager.forUser('failure').request('info',{}).catch(error=>error);
 factories[0].reject(Error('INJECTED_FACTORY_FAILURE'));
 for(const error of await within(Promise.all([rejectedA,rejectedB])))assert.match(error.message,/INJECTED_FACTORY_FAILURE/);
 assert.equal(manager.snapshot().length,0);assert.equal(createCount,1);
 const retry=manager.forUser('failure').request('info',{nonce:'explicit-new-request'});
 assert.equal(createCount,2);const repaired=mockBridge();factories[1].resolve(repaired);await within(retry);
 assert.deepEqual(repaired.sent.map(call=>call.params.nonce),['explicit-new-request']);
 pass('async creation failure releases its slot and all waiters; explicit next request creates once without replaying failed requests');
 manager.close();

 factories=[];createCount=0;
 manager=new WorkerManager({...options,maxWorkers:1,create:asyncCreate});
 const cancelled=manager.forUser('cancelled').request('info',{}).catch(error=>error);
 manager.stopUser('cancelled');manager.stopUser('cancelled');
 assert.match((await within(cancelled)).message,/WORKER_STOPPING/);
 assert.equal(manager.snapshot()[0].stopping,true);assert.equal(manager.snapshot()[0].pendingRequests,0);
 await assert.rejects(manager.forUser('cancelled').request('info',{}),/WORKER_STOPPING/);
 await assert.rejects(manager.forUser('other').request('info',{}),/WORKER_CAPACITY/);
 const late=mockBridge();factories[0].resolve(late);await until(()=>late.closeCalls===1);
 assert.equal(late.sent.length,0);assert.equal(manager.snapshot().length,1);
 manager.exited('cancelled',mockBridge());assert.equal(manager.snapshot().length,1);
 manager.exited('cancelled',late);assert.equal(manager.snapshot().length,0);
 await new Promise(resolve=>setTimeout(resolve,120));
 const replacement=manager.forUser('cancelled').request('info',{nonce:'replacement'});
 const fresh=mockBridge();factories[1].resolve(fresh);await within(replacement);
 manager.exited('cancelled',late);assert.equal(manager.snapshot().length,1);assert.equal(fresh.alive,true);
 pass('stopUser rejects startup waiters, closes a late bridge once, and retains stopping capacity until the matching exit; stale exit cannot remove replacement');
 manager.close();

 factories=[];createCount=0;
 manager=new WorkerManager({...options,maxWorkers:2,create:asyncCreate});
 const closingA=manager.forUser('closing-a').request('info',{}).catch(error=>error);
 const closingB=manager.forUser('closing-b').request('info',{}).catch(error=>error);
 manager.close();manager.close();
 for(const error of await within(Promise.all([closingA,closingB])))assert.match(error.message,/WORKER_STOPPING/);
 await assert.rejects(manager.forUser('closing-c').request('info',{}),/WORKER_MANAGER_UNAVAILABLE/);
 const afterClose=mockBridge();factories[0].resolve(afterClose);factories[1].reject(Error('FACTORY_ENDED_AFTER_MANAGER_CLOSE'));
 await until(()=>afterClose.closeCalls===1&&manager.snapshot().length===1);
 assert.equal(afterClose.sent.length,0);assert.equal(createCount,2);
 manager.exited('closing-a',afterClose);assert.equal(manager.snapshot().length,0);
 pass('manager close cancels all pending startups, closes late success, releases late failure and never admits a new request');

 factories=[];createCount=0;
 manager=new WorkerManager({...options,maxWorkers:2,totalTurns:1,create:asyncCreate});
 const queuedTurn=manager.forUser('turn-a').request('turn/start',{threadId:'pending'});
 assert.equal(manager.snapshot()[0].activeTurns,1);
 await assert.rejects(manager.forUser('turn-b').request('turn/start',{threadId:'denied'}),/TURN_LIMIT/);
 const turnA=mockBridge(),turnB=mockBridge();factories[0].resolve(turnA);factories[1].resolve(turnB);await within(queuedTurn);
 assert.equal(turnA.sent.length,1);assert.equal(turnB.sent.length,0);
 manager.notification('turn-a',turnA,{method:'turn/completed',params:{threadId:'pending',turn:{id:'async-pending',status:'completed'}}});
 await manager.forUser('turn-b').request('turn/start',{threadId:'explicit-after-completion'});
 assert.equal(turnB.sent.length,1);assert.equal(turnB.sent[0].params.threadId,'explicit-after-completion');
 pass('Turn quota is reserved while creation waits and released only by matching completion; denied startup Turn is never replayed');
 manager.close();
 }
 const record=(extra={})=>({id:randomUUID(),at:new Date().toISOString(),action:'worker.start',status:'started',userId:'a',...extra});
 const dir=join(root,'audit');let journal=new AuditJournal(dir,1024);
 for(let i=0;i<20;i++)journal.append(record({password:'must-not-be-written'}));
 journal=new AuditJournal(dir,1024);assert.equal(journal.recent.length,20);
 const segments=(await readdir(dir)).sort();assert(segments.length>1);
 for(const name of segments){assert((await stat(join(dir,name))).size<=1024);assert(!(await readFile(join(dir,name),'utf8')).includes('must-not-be-written'));}
 journal.append(record());assert.equal(new AuditJournal(dir,1024).recent.length,21);pass('bounded rotated durable audit survives reopen and append; unknown fields never reach disk');
 const sanitized=journal.append(record({errorCode:'Bearer must-not-be-written\nprivate body',requestId:'first\r\nsecond',action:'worker.start password=must-not-be-written',password:'must-not-be-written'}));
 assert.equal(sanitized.errorCode,'AUDIT_ERROR_REDACTED');assert.equal(sanitized.action,'audit.unknown');assert.equal(sanitized.requestId,'first  second');assert(!JSON.stringify(new AuditJournal(dir,1024).recent).includes('must-not-be-written'));pass('returned and persisted audit remove error text, unknown fields and control characters');
 await writeFile(join(dir,'audit-00000001.jsonl'),'broken');assert.throws(()=>new AuditJournal(dir,1024),/AUDIT_TRUNCATED/);assert.equal(await readFile(join(dir,'audit-00000001.jsonl'),'utf8'),'broken');pass('truncated audit refuses startup without resetting history');
 for(const [name,raw] of [['json','{broken}\n'],['optional',JSON.stringify(record({deviceId:{secret:'bad'}}))+'\n'],['required',JSON.stringify({id:'x'})+'\n'],['unknown',JSON.stringify(record({password:'bad'}))+'\n'],['blank','\n'],['utf8',Buffer.from([0xff,0x0a])]]){
   const corrupt=join(root,'audit-corrupt-'+name);await mkdir(corrupt);await writeFile(join(corrupt,'audit-00000001.jsonl'),raw);assert.throws(()=>new AuditJournal(corrupt),/AUDIT_RECORD_INVALID/);
 }pass('invalid JSON, optional field types, missing fields, unknown fields, blank records and invalid UTF-8 fail closed');
 const missing=join(root,'audit-missing');await mkdir(missing);await writeFile(join(missing,'audit-00000002.jsonl'),JSON.stringify(record())+'\n');assert.throws(()=>new AuditJournal(missing),/AUDIT_SEGMENT_MISSING/);pass('missing audit segment refuses startup');
 const empty=join(root,'audit-empty');await mkdir(empty);await writeFile(join(empty,'audit-00000001.jsonl'),'');journal=new AuditJournal(empty);journal.append(record());assert.equal(new AuditJournal(empty).recent.length,1);pass('empty final segment from interrupted creation accepts the first complete record');
 const oversized=join(root,'audit-oversized');journal=new AuditJournal(oversized,256);assert.throws(()=>journal.append(record({requestId:'x'.repeat(256)})),/AUDIT_RECORD_TOO_LARGE/);assert.deepEqual(await readdir(oversized),[]);pass('oversized first record creates no skipped or invalid segment');
 const blocked=join(root,'audit-blocked');journal=new AuditJournal(blocked);await mkdir(join(blocked,'audit-00000001.jsonl'));assert.throws(()=>journal.append(record()));assert.throws(()=>journal.append(record()),/AUDIT_STORAGE_UNAVAILABLE/);assert.equal(journal.recent.length,0);pass('audit open failure is surfaced and sticky without acknowledgement');
 const stale=join(root,'audit-stale');const first=new AuditJournal(stale);first.append(record());const second=new AuditJournal(stale);first.append(record());assert.throws(()=>second.append(record()),/AUDIT_SEGMENT_CHANGED/);assert.equal(new AuditJournal(stale).recent.length,2);pass('stale reopened writer refuses changed segment instead of appending to an outdated view');
 const originalWrite=fs.writeSync,originalSync=fs.fsyncSync;
 try{
   let shortCalls=0;const short=join(root,'audit-short-write');journal=new AuditJournal(short);
   fs.writeSync=(fd,buffer,offset)=>{shortCalls++;return originalWrite(fd,buffer,offset,Math.min(8,buffer.length-offset));};syncBuiltinESMExports();
   journal.append(record());fs.writeSync=originalWrite;syncBuiltinESMExports();assert(shortCalls>1);assert.equal(new AuditJournal(short).recent.length,1);pass('short successful writes are completed before acknowledgement');
   let calls=0;const partial=join(root,'audit-partial');journal=new AuditJournal(partial);
   fs.writeSync=(fd,buffer,offset)=>{if(calls++===0)return originalWrite(fd,buffer,offset,8);throw Error('INJECTED_WRITE_FAILURE');};syncBuiltinESMExports();
   assert.throws(()=>journal.append(record()),/INJECTED_WRITE_FAILURE/);assert.throws(()=>journal.append(record()),/AUDIT_STORAGE_UNAVAILABLE/);assert.equal(journal.recent.length,0);assert.equal(calls,2);
   fs.writeSync=originalWrite;syncBuiltinESMExports();assert.throws(()=>new AuditJournal(partial),/AUDIT_TRUNCATED/);pass('partial write poisons the instance and restart detects the unacknowledged tail');
   const flush=join(root,'audit-flush');journal=new AuditJournal(flush);fs.fsyncSync=()=>{throw Error('INJECTED_FSYNC_FAILURE');};syncBuiltinESMExports();
   assert.throws(()=>journal.append(record()),/INJECTED_FSYNC_FAILURE/);assert.throws(()=>journal.append(record()),/AUDIT_STORAGE_UNAVAILABLE/);assert.equal(journal.recent.length,0);
   fs.fsyncSync=originalSync;syncBuiltinESMExports();assert.equal(new AuditJournal(flush).recent.length,1);pass('fsync failure is not acknowledged or replayed; a complete uncertain record remains readable');
 }finally{fs.writeSync=originalWrite;fs.fsyncSync=originalSync;syncBuiltinESMExports();}
 const killed=join(root,'audit-killed');const auditModule=new URL('../../services/central-gateway/dist/audit-journal.js',import.meta.url).href;
 const writer=spawn(process.execPath,['--input-type=module','-e',`import {AuditJournal} from ${JSON.stringify(auditModule)};new AuditJournal(${JSON.stringify(killed)}).append(${JSON.stringify(record({id:'acknowledged-before-kill'}))});process.stdout.write('ACK\\n');setInterval(()=>{},1000);`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 try{
   await new Promise((resolve,reject)=>{let acknowledged=false,output='';const timer=setTimeout(()=>{writer.kill();reject(Error('audit writer timeout'));},5000);writer.stderr.on('data',chunk=>{output+=chunk;});writer.on('error',error=>{clearTimeout(timer);reject(error);});writer.stdout.once('data',chunk=>{acknowledged=chunk.toString().includes('ACK');writer.kill('SIGKILL');});writer.on('exit',()=>{clearTimeout(timer);acknowledged?resolve():reject(Error('audit writer exited before acknowledgement: '+output));});});
 }finally{if(writer.exitCode===null&&writer.signalCode===null)writer.kill();}
 assert.equal(new AuditJournal(killed).recent[0].id,'acknowledged-before-kill');pass('acknowledged audit survives a real writer process killed without shutdown');
 const bounded=join(root,'audit-cache');journal=new AuditJournal(bounded);for(let i=0;i<1002;i++)journal.append(record({id:String(i)}));journal=new AuditJournal(bounded);assert.equal(journal.recent.length,1000);assert.equal(journal.recent[0].id,'2');assert.equal((await readFile(join(bounded,'audit-00000001.jsonl'),'utf8')).trimEnd().split('\n').length,1002);pass('recent cache is bounded while durable history remains intact');
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks,root},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,root}));
}finally{manager?.close();for(const b of bridges)if(b.child.exitCode===null)b.child.kill();}
