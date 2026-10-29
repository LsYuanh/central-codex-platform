// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Owned stdin controller + synthetic account/TLS only. No model or Worker calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir, readFile, lstat } from 'node:fs/promises';
import https from 'node:https';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelPipeTls } from '../../services/central-gateway/dist/model-pipe-tls.js';
import { protectSyntheticFixture } from './windows-private-fixture.mjs';
import { verifyCandidate } from '../../scripts/build/stage-central-gateway.mjs';
import {collectServiceMetrics,ServiceMetricsEmitter,validateServiceMetrics} from '../../services/central-gateway/dist/service-metrics.js';

const protocol='central-service-host/v1';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bounded=async(promise,ms,code)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),ms);})]);}finally{clearTimeout(timer);}};
function safeCode(error){const code=String(error?.message??'');return /^QA_[A-Z0-9_]+$/.test(code)?code:'QA_NATIVE_SERVICE_FAILED';}
export async function smokeMetrics(){
  const worker=(extra={})=>({alive:false,ready:false,starting:false,stopping:false,activeTurns:0,...extra});
  const zero={onlineDevices:0,activeTurns:0,workers:0,readyWorkers:0,startingWorkers:0,stoppingWorkers:0};
  const checks=[];
  assert.deepEqual(collectServiceMetrics([],[]),zero);
  const metrics=collectServiceMetrics([{ready:true,socket:{readyState:1}},{ready:true,socket:{readyState:3}},{ready:false,socket:{readyState:1}}],[
    worker({alive:true,pid:31,ready:true,activeTurns:2}),worker({alive:true,pid:32,stopping:true,ready:true,activeTurns:1}),
    worker({alive:true,ready:true}),worker({starting:true,stopping:true,activeTurns:3}),worker({stopping:true}),
  ]);
  assert.deepEqual(metrics,{onlineDevices:1,activeTurns:6,workers:1,readyWorkers:1,startingWorkers:1,stoppingWorkers:3});
  checks.push('counts-use-open-ready-agents-confirmed-pids-and-overlapping-worker-states');
  for(const extra of [{activeTurns:-1},{activeTurns:NaN},{activeTurns:1.2},{alive:1},{starting:undefined},{pid:0},{pid:-2},{pid:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>collectServiceMetrics([],[worker(extra)]),/SERVICE_METRICS_INVALID/);
  assert.throws(()=>collectServiceMetrics([],[worker({activeTurns:Number.MAX_SAFE_INTEGER}),worker({activeTurns:1})]),/SERVICE_METRICS_INVALID/);
  assert.throws(()=>collectServiceMetrics([{ready:true,socket:{readyState:9}}],[]),/SERVICE_METRICS_INVALID/);
  assert.throws(()=>validateServiceMetrics({...zero,untrusted:0}),/SERVICE_METRICS_INVALID/);
  checks.push('invalid-missing-overflow-counts-and-invalid-pids-fail-without-zero-substitution');
  const tasks=new Map();let next=0;const timing={schedule:(callback,delayMs)=>{assert.equal(delayMs,2000);tasks.set(++next,callback);return next;},cancel:id=>tasks.delete(id)};
  const settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
  const frames=[],failures=[];let release,sampled=0;
  const emitter=new ServiceMetricsEmitter(()=>({...zero,onlineDevices:++sampled}),(sequence,value)=>{frames.push({sequence,value});return new Promise(resolve=>{release=resolve;});},async code=>{failures.push(code);},timing);
  emitter.start();emitter.start();assert.equal(frames.length,1);assert.equal(frames[0].sequence,1);assert.equal(tasks.size,0);
  await settle();assert.equal(frames.length,1);assert.equal(sampled,1);
  release();await settle();assert.equal(tasks.size,1);const tick=tasks.values().next().value;tasks.clear();tick();await settle();
  assert.equal(frames.length,2);assert.equal(frames[1].sequence,2);assert.equal(frames[1].value.onlineDevices,2);assert.equal(tasks.size,0);
  emitter.stop();release();await settle();assert.equal(tasks.size,0);emitter.start();tick();await settle();assert.equal(frames.length,2);assert.deepEqual(failures,[]);
  checks.push('immediate-first-sample-single-flight-flush-then-two-second-delay-and-stop-during-flush');
  const scheduled=new ServiceMetricsEmitter(()=>zero,async()=>{},async()=>{},timing);scheduled.start();await settle();assert.equal(tasks.size,1);scheduled.stop();assert.equal(tasks.size,0);
  const stopped=new ServiceMetricsEmitter(()=>{throw Error('must not read');},async()=>{},async()=>{throw Error('must not fail');},timing);stopped.stop();stopped.start();await settle();assert.equal(tasks.size,0);
  checks.push('stop-clears-scheduled-sample-and-pre-ready-stop-prevents-start');
  const broken=new ServiceMetricsEmitter(()=>{throw Error('private diagnostic must not escape');},async()=>{throw Error('must not write');},async code=>failures.push(code),timing);
  broken.start();await settle();assert.deepEqual(failures,['SERVICE_METRICS_INVALID']);assert.equal(tasks.size,0);
  const disconnected=new ServiceMetricsEmitter(()=>zero,async()=>{throw Error('private pipe detail');},async code=>failures.push(code),timing);
  disconnected.start();await settle();assert.deepEqual(failures,['SERVICE_METRICS_INVALID','SERVICE_CONTROLLER_CLOSED']);assert.equal(tasks.size,0);
  checks.push('aggregation-and-pipe-failure-stop-with-fixed-code-once');
  return {passed:true,scope:'owned-service-metrics-aggregation-and-bounded-scheduler',checks};
}
export async function smokeNativeService(candidate) {
  assert.equal(process.platform,'win32','QA_WINDOWS_REQUIRED');
  assert(path.isAbsolute(candidate),'QA_EXPLICIT_CANDIDATE_REQUIRED');
  const manifest=await verifyCandidate(candidate);
  assert(manifest.nativeWorker?.protocol==='windows-worker-host/v1','QA_FULL_CANDIDATE_REQUIRED');
  const localDev=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const parent=path.join(localDev,'target','central-p0');mkdirSync(parent,{recursive:true});
  const fixture=realpathSync(mkdtempSync(path.join(parent,'central-service-host-')));
  const data=path.join(fixture,'data');mkdirSync(data);protectSyntheticFixture(fixture,[fixture,data]);
  const tls=await createModelPipeTls(Date.now()+600000);
  const cert=String(tls.options.cert),key=Buffer.isBuffer(tls.options.key)?tls.options.key.toString('utf8'):String(tls.options.key);
  const admin={username:'qa_admin',password:`Native_QA_${randomBytes(24).toString('base64url')}`};
  const accountId=`synthetic-${randomBytes(16).toString('hex')}`;
  const jwt=[Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+600,sub:accountId})).toString('base64url'),'synthetic-signature'].join('.');
  const account={tokens:{access_token:jwt,account_id:accountId}};
  const checks=[],runs=[];
  let child,currentExit;
  async function request(port,route,body,token) {
    return bounded(new Promise((resolve,reject)=>{
      const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
      const call=https.request({hostname:'127.0.0.1',port,servername:'model-broker.invalid',ca:tls.certificatePem,rejectUnauthorized:true,agent:false,path:route,method:payload?'POST':'GET',
        headers:{...(payload?{'content-type':'application/json','content-length':String(payload.length)}:{}),...(token?{authorization:`Bearer ${token}`}:{})}},response=>{
        const chunks=[];let bytes=0;
        response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){response.destroy();reject(Error('QA_HTTP_SIZE_LIMIT'));}else chunks.push(chunk);});
        response.once('error',()=>reject(Error('QA_HTTP_FAILED')));
        response.once('end',()=>{try{resolve({status:response.statusCode,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Error('QA_HTTP_INVALID_RESPONSE'));}});
      });
      call.once('error',()=>reject(Error('QA_HTTP_FAILED')));call.setTimeout(5000,()=>call.destroy());call.end(payload);
    }),6000,'QA_HTTP_TIMEOUT');
  }
  async function privateDiskCheck() {
    const forbidden=[jwt,accountId,admin.password,key,cert,'-----BEGIN PRIVATE KEY-----'];
    async function visit(folder){
      for(const entry of await readdir(folder,{withFileTypes:true})){
        const filename=path.join(folder,entry.name);assert(!entry.isSymbolicLink(),'QA_DATA_LINK_UNEXPECTED');
        if(entry.isDirectory())await visit(filename);
        else{assert(entry.isFile(),'QA_DATA_FILE_UNEXPECTED');assert((await lstat(filename)).size<8*1024*1024,'QA_DATA_FILE_TOO_LARGE');const text=await readFile(filename,'utf8');assert(!forbidden.some(secret=>text.includes(secret)),'QA_PLAINTEXT_SECRET_FOUND');}
      }
    }
    await visit(data);
  }
  async function runCase(mode,provisionAdmin) {
    const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4510,'QA_FORMAL_PORT_FORBIDDEN');
    const instanceId=randomBytes(16).toString('hex'),frames=[],diagnostics=[];let invalidMetrics=false;
    const config={schemaVersion:1,revision:1,dataDirectory:data,listen:{host:'127.0.0.1',port},clientUrl:`wss://model-broker.invalid:${port}/ws`,tls:{certificateId:'synthetic-tls'},runtimePackageId:path.basename(candidate),limits:{maxWorkers:2,perUserTurns:1,totalTurns:2},shutdown:{graceMs:10000,forceMs:5000}};
    const bootstrap={method:'central/service',protocol,instanceId,command:'bootstrap',config:{config,tls:{cert,key},account,...(provisionAdmin?{admin}: {})}};
    const env={CENTRAL_SERVICE_HOST:'1'};for(const [name,value]of Object.entries(process.env))if(/^(SystemRoot|WINDIR)$/i.test(name))env[name]=value;
    child=spawn(path.join(candidate,'bin','node.exe'),[path.join(candidate,manifest.entrypoint)],{cwd:fixture,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    currentExit=new Promise(resolve=>{child.once('error',()=>resolve({code:null,signal:null,spawnFailed:true}));child.once('close',(code,signal)=>resolve({code,signal}));});
    let output=Buffer.alloc(0),stdoutBytes=0,stderrBuffer='',stderrBytes=0;
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      stdoutBytes+=chunk.length;if(stdoutBytes>1024*1024){child.kill();return;}
      output=Buffer.concat([output,chunk]);let end;
      while((end=output.indexOf(10))>=0){const line=output.subarray(0,end).toString('utf8');output=output.subarray(end+1);
        try{const frame=JSON.parse(line);if(frame.method==='central/service'&&frame.protocol===protocol&&frame.instanceId===instanceId){
          if(frame.event==='metrics'){
            try{validateServiceMetrics(frame.metrics);assert(Number.isSafeInteger(frame.sequence)&&frame.sequence>0);frames.push({event:'metrics',sequence:frame.sequence,metrics:frame.metrics});}catch{invalidMetrics=true;}
          }else if(['connectionUpdatesReady','accountUpdated'].includes(frame.event))frames.push({event:frame.event,updateId:frame.updateId});
          else if(['ready','stopped','failed'].includes(frame.event))frames.push({event:frame.event,listening:frame.listening===true,...(typeof frame.code==='string'&&/^SERVICE_[A-Z0-9_]+$/.test(frame.code)?{code:frame.code}:{})});
        }}catch{/* Ordinary gateway diagnostics are never retained or displayed. */}
      }
    });
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)return;stderrBuffer+=chunk.toString('ascii');let end;while((end=stderrBuffer.indexOf('\n'))>=0){const line=stderrBuffer.slice(0,end);stderrBuffer=stderrBuffer.slice(end+1);const match=line.match(/\b((?:SERVICE|GATEWAY)_[A-Z0-9_]+)\b/);if(match)diagnostics.push(match[1]);}});
    const payload=Buffer.from(JSON.stringify(bootstrap)+'\n');child.stdin.write(payload,()=>payload.fill(0));
    const run={mode,frames,diagnostics};runs.push(run);
    const readyDeadline=Date.now()+20000;
    while(!frames.some(frame=>frame.event==='ready')&&Date.now()<readyDeadline){if(child.exitCode!==null||child.signalCode)throw Error('QA_SERVICE_EXITED_BEFORE_READY');await pause(50);}
    assert(frames.some(frame=>frame.event==='ready'&&frame.listening),'QA_SERVICE_READY_TIMEOUT');
    const metricsDeadline=Date.now()+6000;
    while(frames.filter(frame=>frame.event==='metrics').length<2&&Date.now()<metricsDeadline)await pause(25);
    const snapshots=frames.filter(frame=>frame.event==='metrics');
    assert(!invalidMetrics&&snapshots.length>=2,'QA_METRICS_MISSING_OR_INVALID');
    assert(frames.findIndex(frame=>frame.event==='metrics')>frames.findIndex(frame=>frame.event==='ready'),'QA_METRICS_BEFORE_READY');
    for(const [index,snapshot]of snapshots.entries()){
      assert.equal(snapshot.sequence,index+1,'QA_METRICS_SEQUENCE_INVALID');
      assert.deepEqual(snapshot.metrics,{onlineDevices:0,activeTurns:0,workers:0,readyWorkers:0,startingWorkers:0,stoppingWorkers:0},'QA_IDLE_METRICS_INVALID');
    }
    const health=await request(port,'/healthz');assert.equal(health.status,200,'QA_HEALTH_FAILED');assert.equal(health.value.ok,true,'QA_HEALTH_FAILED');assert.equal(health.value.enforcedRuntimeReady,false,'QA_UNEXPECTED_WORKER');
    const login=await request(port,'/auth/login',admin);assert.equal(login.status,200,'QA_ADMIN_LOGIN_FAILED');assert(login.value.ok===true&&typeof login.value.data?.accessToken==='string','QA_ADMIN_LOGIN_FAILED');
    const access=await request(port,'/model-access',undefined,login.value.data.accessToken);assert.equal(access.status,200,'QA_MODEL_ACCESS_FAILED');assert.equal(access.value.modelAccess?.status,'ready','QA_MODEL_ACCESS_NOT_READY');
    const workers=await request(port,'/workers',undefined,login.value.data.accessToken);assert(Array.isArray(workers.value.workers)&&workers.value.workers.length===0,'QA_UNEXPECTED_WORKER');
    assert(frames.some(f=>f.event==='connectionUpdatesReady'),'QA_CONNECTION_CAPABILITY_MISSING');
    const sessionToken=login.value.data.accessToken;
    const me=await request(port,'/auth/me',{},sessionToken);
    const code=await request(port,'/auth/admin/pair-code',{userId:me.value.data.user.id},sessionToken);
    const paired=await request(port,'/auth/device/pair',{code:code.value.data.code,name:'transport config fixture'});
    assert.equal(paired.status,200);const device=paired.value.data;
    assert.equal((await request(port,'/transport/config',{})).status,401);
    assert.equal((await request(port,'/transport/config',{},sessionToken)).status,401);
    assert.equal((await request(port,'/transport/config',{},device.deviceToken)).status,503);
    const relay={centralId:'a'.repeat(64),access:{url:'https://relay.example/',token:'synthetic-route-token-0123456789abcdef',caPem:''}};
    for(const target of [relay,null]){
      const updateId=randomBytes(16).toString('hex');
      child.stdin.write(JSON.stringify({method:'central/service',protocol,instanceId,command:'connection/update',updateId,relay:target})+'\n');
      const deadline=Date.now()+5000;while(!frames.some(f=>f.event==='accountUpdated'&&f.updateId===updateId)&&Date.now()<deadline)await pause(20);
      assert(frames.some(f=>f.event==='accountUpdated'&&f.updateId===updateId));
      const current=await request(port,'/transport/config',{},device.deviceToken);assert.equal(current.status,200);
      assert.deepEqual(current.value.data,{protocol:'yuan-connection/v1',deviceId:device.deviceId,deviceKey:device.deviceKey,userId:device.user.id,relay:target});
    }
    await privateDiskCheck();
    if(mode==='wrong-instance')child.stdin.write(JSON.stringify({method:'central/service',protocol,instanceId:'0'.repeat(32),command:'stop'})+'\n');
    else if(mode==='eof')child.stdin.end();
    else child.stdin.write(JSON.stringify({method:'central/service',protocol,instanceId,command:'stop'})+'\n');
    const exit=await bounded(currentExit,20000,'QA_SERVICE_STOP_TIMEOUT');run.exit=exit;
    assert.equal(exit.code,0,'QA_SERVICE_EXIT_FAILED');assert.equal(exit.signal,null,'QA_SERVICE_SIGNAL_EXIT');
    assert(frames.some(frame=>frame.event==='stopped'),'QA_STOP_RECEIPT_MISSING');
    assert.equal(frames.at(-1)?.event,'stopped','QA_FRAME_AFTER_STOPPED');
    if(mode==='wrong-instance')assert(frames.some(frame=>frame.event==='failed'&&frame.code==='SERVICE_CONTROL_INVALID'),'QA_WRONG_INSTANCE_NOT_REJECTED');
    else assert(!frames.some(frame=>frame.event==='failed'),'QA_SERVICE_REPORTED_FAILURE');
    await assert.rejects(request(port,'/healthz'),error=>error.message==='QA_HTTP_FAILED');
    await privateDiskCheck();child=undefined;
  }
  try {
    await runCase('stop',true);checks.push('synthetic-memory-bootstrap-https-health-admin-login-model-status-and-owned-stop');
    await runCase('wrong-instance',false);checks.push('restart-with-persisted-admin-and-wrong-instance-control-rejection');
    await runCase('eof',false);checks.push('controller-eof-stops-service-with-receipt-exit-and-port-close');
    checks.push('device-only-connection-config-unavailable-until-owned-native-control-delivery','relay-enabled-and-disabled-configuration-preserve-paired-device-identity','no-account-token-tls-or-admin-password-plaintext-in-run-directory','zero-workers-and-no-model-requests','owned-metrics-after-ready-monotonic-per-instance-and-no-frame-after-stopped');
    const result={passed:true,scope:'native-service-host-synthetic-bootstrap-and-lifecycle',packageId:path.basename(candidate),realCredentialsUsed:false,realModelVerified:false,productionQualified:false,formal4510Modified:false,checks,runs};
    writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));
    return {...result,resultFile:path.join(fixture,'result.json')};
  }catch(error){
    const result={passed:false,code:safeCode(error),checks,runs};writeFileSync(path.join(fixture,'failure.json'),JSON.stringify(result,null,2));
    console.error(JSON.stringify({...result,resultFile:path.join(fixture,'failure.json')},null,2));throw Error(safeCode(error));
  }finally{
    if(child&&child.exitCode===null&&!child.signalCode){child.stdin.end();try{await bounded(currentExit,20000,'QA_CLEANUP_TIMEOUT');}catch{child.kill();await bounded(currentExit,5000,'QA_CLEANUP_TIMEOUT');}}
    if(Buffer.isBuffer(tls.options.key))tls.options.key.fill(0);
  }
}
if(process.argv.length===3&&process.argv[2]==='--metrics-only'){
  try{console.log(JSON.stringify(await smokeMetrics(),null,2));}catch(error){console.error(safeCode(error));process.exitCode=1;}
}else if(process.argv.length===4&&process.argv[2]==='--candidate'){
  try{console.log(JSON.stringify(await smokeNativeService(path.resolve(process.argv[3])),null,2));}catch(error){console.error(safeCode(error));process.exitCode=1;}
}else{console.error('Usage: node tests/smoke/central-service-host-smoke.mjs --candidate <absolute complete candidate> | --metrics-only');process.exitCode=1;}
