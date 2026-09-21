// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real native host + App Server; synthetic broker credentials and metadata RPCs
// only. Requires the root-built host, runtime and native private-file helper pins.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelCredentialBroker } from '../../services/central-gateway/dist/model-credential-broker.js';
import { WindowsWorkerBridge } from '../../services/central-gateway/dist/windows-worker-bridge.js';
import { WorkerManager } from '../../services/central-gateway/dist/worker-manager.js';
import { protectSyntheticFixture } from './windows-private-fixture.mjs';

assert.equal(process.platform,'win32','WINDOWS_QA_REQUIRED');
function artifact(pathVariable,hashVariable) {
  const filename=process.env[pathVariable],hash=process.env[hashVariable];
  assert(filename&&path.isAbsolute(filename)&&/^[a-f0-9]{64}$/.test(hash??''),`${pathVariable}_PIN_REQUIRED`);
  assert.equal(createHash('sha256').update(readFileSync(filename)).digest('hex'),hash,`${pathVariable}_HASH_MISMATCH`);
  return {path:realpathSync(filename),hash};
}
const host=artifact('PLATFORM_WORKER_HOST_BINARY','PLATFORM_WORKER_HOST_SHA256');
const runtime=artifact('PLATFORM_WORKER_BINARY','PLATFORM_WORKER_BINARY_SHA256');
const helper=artifact('PLATFORM_NATIVE_HELPER_BINARY','PLATFORM_NATIVE_HELPER_SHA256');
const localDev=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const parent=path.join(localDev,'target','central-p0');mkdirSync(parent,{recursive:true});
const root=realpathSync(mkdtempSync(path.join(parent,'native-worker-smoke-')));
protectSyntheticFixture(root);
const workersRoot=path.join(root,'workers');
assert.equal(existsSync(workersRoot),false,'HOST_MUST_CREATE_WORKER_ROOT');
const fixtureFile=path.join(root,'synthetic-api-key.json'),configFile=path.join(root,'bindings.json');
writeFileSync(fixtureFile,JSON.stringify({apiKey:`SYNTHETIC_ONLY_${randomBytes(24).toString('hex')}`}));
let upstreamRequests=0;
const upstream=http.createServer((_request,response)=>{upstreamRequests++;response.writeHead(503);response.end('synthetic fixture: model calls are not part of this test');});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
writeFileSync(configFile,JSON.stringify({version:1,users:{alice:{providerId:'synthetic',enabled:true},bob:{providerId:'synthetic',enabled:true}},providers:{synthetic:{id:'synthetic',kind:'api-key',credentialFile:fixtureFile,baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`}}}));
protectSyntheticFixture(root,[fixtureFile,configFile]);
const checks=[],events=[],diagnostics=[],instances=[];
const userKey=user=>createHash('sha256').update(user).digest('hex');
let broker,manager,completed=false,failureCode;
const deadline=async(promise,ms=40000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NATIVE_QA_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}};
function assertGone(pid){assert(Number.isInteger(pid)&&pid>0);assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','WORKER_PROCESS_STILL_EXISTS');}
function bridgeOptions(user,lease,overrides={}) {
  return {hostPath:host.path,hostSha256:host.hash,runtimePath:runtime.path,runtimeSha256:runtime.hash,
    root:workersRoot,userKey:userKey(user),instanceId:randomBytes(16).toString('hex'),model:'gpt-6-astra',lease,
    onDiagnostic:code=>diagnostics.push({user,code}),...overrides};
}
try {
  broker=await ModelCredentialBroker.start({configFile,forbiddenRoots:[workersRoot],allowLoopbackTestProviders:true,timeoutMs:15000});
  assert.equal(broker.status('alice').status,'ready');
  assert.equal(broker.status('bob').status,'ready');
  manager=new WorkerManager({root:workersRoot,perUser:true,nativeManagedPaths:true,maxWorkers:2,perUserTurns:1,totalTurns:2,maxRequests:8,idleMs:60000,cooldownMs:0,
    create:async(user)=>{
      const instanceId=randomBytes(16).toString('hex');
      const lease=await broker.createPipeLease(user,instanceId);
      let bridge;
      try { bridge=new WindowsWorkerBridge(bridgeOptions(user,lease,{instanceId}),()=>{assert.equal(broker.status(user).status,'ready');}); }
      catch(error){lease.release();throw error;}
      instances.push({user,instanceId,bridge});
      bridge.subscribe(message=>manager.notification(user,bridge,message));
      return bridge;
    },event:(action,user,status,code)=>events.push({action,user,status,code})});
  const init={clientInfo:{name:'native-host-metadata-qa',version:'1'},capabilities:{experimentalApi:true}};
  const [initialized,aliceList]=await deadline(Promise.all([
    manager.forUser('alice').request('initialize',init),
    manager.forUser('alice').request('thread/list',{limit:10}),
  ]));
  assert.match(initialized.userAgent,/yuan-zhou-remote-workspace\/1/);
  assert(Array.isArray(aliceList.data));
  assert.equal(instances.filter(value=>value.user==='alice').length,1);
  const first=instances.find(value=>value.user==='alice');
  const firstPid=first.bridge.pid;
  assert.equal(first.bridge.enforcedRuntimeReady,true);
  assert.equal(existsSync(path.join(workersRoot,userKey('alice'),'home')),true);
  const homeIdentity=lstatSync(path.join(workersRoot,userKey('alice'),'home')).ino;
  checks.push('real-host-initialize-marker-and-concurrent-single-flight-thread-list');
  const bobList=await deadline(manager.forUser('bob').request('thread/list',{limit:10}));
  assert(Array.isArray(bobList.data));
  const bob=instances.find(value=>value.user==='bob');
  assert.notEqual(bob.bridge.pid,firstPid);
  assert.notEqual(path.join(workersRoot,userKey('alice')),path.join(workersRoot,userKey('bob')));
  assert.equal(manager.snapshot().length,2);
  checks.push('distinct-users-have-distinct-native-processes-and-home-directories');
  manager.stopUser('alice');await deadline(first.bridge.closed,30000);assertGone(firstPid);
  const aliceAgain=await deadline(manager.forUser('alice').request('thread/list',{limit:10}));
  assert(Array.isArray(aliceAgain.data));
  assert.deepEqual(aliceAgain.data.map(value=>value.id),aliceList.data.map(value=>value.id));
  assert.equal(instances.filter(value=>value.user==='alice').length,2);
  assert.equal(lstatSync(path.join(workersRoot,userKey('alice'),'home')).ino,homeIdentity);
  checks.push('same-user-restart-retains-home-directory-and-thread-list');
  const activePids=instances.slice(1).map(value=>value.bridge.pid);
  await deadline(manager.drain(30000),35000);
  for(const pid of activePids)assertGone(pid);
  assert.equal(manager.snapshot().length,0);
  checks.push('manager-drain-requires-native-close-evidence-and-process-disappearance');
  const wrongLease=await broker.createPipeLease('alice',randomBytes(16).toString('hex'));
  try { assert.throws(()=>new WindowsWorkerBridge(bridgeOptions('alice',wrongLease,{hostSha256:'0'.repeat(64)}),()=>{}),/HASH_MISMATCH/); }
  finally {wrongLease.release();await deadline(wrongLease.closed,5000);}
  checks.push('wrong-host-hash-rejected-before-spawn');
  assert.equal(upstreamRequests,0);
  await deadline(broker.close(),10000);
  checks.push('synthetic-broker-closed-with-zero-model-requests');
  completed=true;
  const result={passed:true,scope:'real-windows-native-host-metadata-and-lifecycle',realCredentialsUsed:false,realModelVerified:false,threadWithMessagesPersistenceVerified:false,
    productionGateEnabled:false,formal4510Modified:false,hostSha256:host.hash,runtimeSha256:runtime.hash,helperSha256:helper.hash,
    checks,diagnostics,instanceCount:instances.length,upstreamRequests};
  writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,resultFile:path.join(root,'result.json')},null,2));
} catch(error) {
  failureCode=String(error.message).slice(0,200);
  writeFileSync(path.join(root,'failure.json'),JSON.stringify({passed:false,code:String(error.message).slice(0,200),checks,diagnostics,events},null,2));
  console.error(JSON.stringify({passed:false,error:error.message,diagnostics,resultFile:path.join(root,'failure.json')},null,2));
  process.exitCode=1;
} finally {
  let cleanupVerified=completed,cleanupFailure;
  if(!completed&&manager)try{await deadline(manager.drain(25000),30000);cleanupVerified=true;}catch(error){process.exitCode=1;cleanupFailure=String(error.message).slice(0,200);}
  if(broker)await deadline(broker.close(),10000);
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
  if(failureCode){
    // stdout and stderr use distinct OS pipes: preserve final diagnostics only
    // after drain/child close, as the initial RPC rejection may arrive first.
    const final={passed:false,code:failureCode,checks,diagnostics,events,cleanupVerified,cleanupFailure,workers:manager?.snapshot()??[]};
    writeFileSync(path.join(root,'failure-final.json'),JSON.stringify(final,null,2));
    console.error(JSON.stringify({passed:false,diagnostics,cleanupVerified,cleanupFailure,resultFile:path.join(root,'failure-final.json')},null,2));
  }
}
