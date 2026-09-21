// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Protocol-only process fixtures. This does not qualify AppContainer/Job safety.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WindowsWorkerTransport, encodeWindowsWorkerBootstrap } from '../../services/central-gateway/src/windows-worker-transport.ts';

if (process.platform !== 'win32') throw Error('Windows protocol fixture required');
const root = await mkdtemp(path.join(os.tmpdir(), 'windows-host-transport-'));
const filename = path.join(root, 'fixture.cjs');
const executable = realpathSync(process.execPath);
const binaryHash = createHash('sha256').update(readFileSync(executable)).digest('hex');
const fixture = String.raw`
const assert=require('node:assert/strict');
const scenario=process.argv[2],args=process.argv.slice(3);
const get=name=>args[args.indexOf(name)+1];
const instance=get('--instance'),userKey=get('--user-key');
assert.equal(get('--parent-pid'),String(process.ppid));
assert.equal(Object.keys(process.env).some(key=>/CODEX|NODE_OPTIONS|YUAN|TOKEN|OPENAI/i.test(key)),false);
let buffer=Buffer.alloc(0),boot=false;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const data=bytes=>emit({method:'host/data',params:{protocol:'windows-worker-host/v1',instanceId:instance,base64:Buffer.from(bytes).toString('base64')}});
const worker=value=>{const bytes=Buffer.from(JSON.stringify(value)+'\n');data(bytes.subarray(0,3));data(bytes.subarray(3));};
const closed=()=>({method:'host/closed',params:{protocol:'windows-worker-host/v1',instanceId:scenario==='wrong-instance'?'f'.repeat(32):instance,jobCloseVerified:true}});
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]);
 if(!boot){
  if(buffer.length<16)return;
  assert.equal(buffer.subarray(0,8).toString(),'YZWH0001');
  const tokenLength=buffer.readUInt32LE(12);
  if(buffer.length<20+tokenLength)return;
  const caLength=buffer.readUInt32LE(16+tokenLength);
  if(buffer.length<20+tokenLength+caLength)return;
  assert.equal(buffer.readUInt32LE(8),12345);assert.equal(tokenLength,48);
  assert.match(buffer.subarray(20+tokenLength,20+tokenLength+caLength).toString(),/BEGIN CERTIFICATE/);
  buffer=buffer.subarray(20+tokenLength+caLength);boot=true;
  if(scenario==='startup-timeout')return;
  if(scenario==='early-rpc'){emit({id:1,result:{}});return;}
  if(scenario==='bad-utf8'){process.stdout.write(Buffer.from([255,10]));return;}
  if(scenario==='oversize'){process.stdout.write('x'.repeat(4096));return;}
  emit({method:'host/ready',params:{protocol:'windows-worker-host/v1',instanceId:instance,userKey,pid:process.pid}});
  if(scenario==='diagnostic')process.stderr.write('HOST_INTERNAL_ERROR\nHOST_RUNTIME_EXIT_C0000142\nHOST_RUNTIME_EXIT_C0000142_EXTRA\nSYNTHETIC_SECRET_MUST_NOT_ESCAPE\n');
  if(scenario==='spontaneous')setTimeout(()=>{emit(closed());process.stdout.write('',()=>process.exit(0));},100);
  if(scenario==='worker-closed-spoof'){worker(closed());return;}
  if(scenario==='invalid-base64'){emit({method:'host/data',params:{protocol:'windows-worker-host/v1',instanceId:instance,base64:'!!!!'}});return;}
 }
 let newline;
 while((newline=buffer.indexOf(10))>=0){
  const request=JSON.parse(buffer.subarray(0,newline));buffer=buffer.subarray(newline+1);
  if(request.method==='hang')continue;
  worker({id:request.id,result:{method:request.method,worker:process.pid}});
  worker({method:'fixture/notification',params:{safe:true}});
 }
});
process.stdin.on('end',()=>{
 if(scenario==='no-evidence'||scenario==='worker-closed-spoof'){process.exit(0);return;}
 emit(closed());
 if(scenario==='extra-after-closed')emit({unexpected:true});
 process.stdout.write('',()=>process.exit(scenario==='nonzero'?7:0));
});
`;
await writeFile(filename, fixture);
function lease() {
  let done;
  let releases = 0;
  const closed = new Promise(resolve => { done = resolve; });
  return { value: { token: 't'.repeat(48), forwardPort: 12345, serverName: 'model-broker.invalid', certificatePem: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n', expiresAt: Date.now()+60000, closed,
    release() { releases++; done(); } }, get releases() { return releases; }, revoke() { done(); } };
}
let live;
const results = [];
function make(scenario, options = {}) {
  const credential = lease();
  const transport = new WindowsWorkerTransport({ hostPath: executable, hostSha256: binaryHash, runtimePath: executable, runtimeSha256: binaryHash,
    root: path.join(root, 'workers'), userKey: 'a'.repeat(64), instanceId: 'b'.repeat(32), model: 'fixture', lease: credential.value,
    startTimeoutMs: 5000, stopTimeoutMs: 5000, requestTimeoutMs: 1000, ...options,
  }, (command,args,settings) => { const child=spawn(command,[filename,scenario,...args],settings);live=child;return child; });
  return { transport, credential };
}
try {
  const bootstrap = encodeWindowsWorkerBootstrap(lease().value);
  assert.equal(bootstrap.subarray(0,8).toString(),'YZWH0001');
  assert.equal(bootstrap.readUInt32LE(12),48);
  assert.throws(()=>encodeWindowsWorkerBootstrap({...lease().value,forwardPort:0}),/LEASE_INVALID/);
  assert.throws(()=>encodeWindowsWorkerBootstrap({...lease().value,token:'secret\ninvalid'}),/LEASE_INVALID/);
  results.push('bootstrap-layout-and-invalid-input');
  {
    const {transport,credential}=make('normal');
    const notifications=[];transport.subscribe(message=>notifications.push(message));
    let sawNotification;
    const notificationReceived=new Promise(resolve=>{sawNotification=resolve;});
    transport.subscribe(message=>{if(message.method==='fixture/notification')sawNotification();});
    assert.equal(transport.alive,true);
    assert.throws(()=>transport.write({method:'too-early'}),/NOT_READY/);
    await transport.ready;
    assert.equal(transport.alive,true);
    const response=await transport.request('initialize',{});
    assert.equal(response.method,'initialize');
    let notificationTimer;
    try { await Promise.race([notificationReceived,new Promise((_,reject)=>{notificationTimer=setTimeout(()=>reject(Error('FIXTURE_NOTIFICATION_TIMEOUT')),3000);})]); }
    finally { clearTimeout(notificationTimer); }
    transport.close();transport.close();
    await transport.closed;
    assert.equal(credential.releases,1);
    assert.equal(transport.alive,false);
    assert.equal(notifications.some(message=>message.method==='fixture/notification'),true);
    results.push('ready-rpc-notification-eof-verified-close-idempotent-release');
  }
  {
    const {transport,credential}=make('normal');await transport.ready;credential.revoke();await transport.closed;
    assert.equal(credential.releases,1);results.push('lease-revocation-stops-host');
  }
  {
    const diagnostics=[];
    const {transport}=make('diagnostic',{onDiagnostic:code=>diagnostics.push(code)});
    await transport.ready;transport.close();await transport.closed;
    assert.deepEqual(diagnostics,['HOST_INTERNAL_ERROR','HOST_RUNTIME_EXIT_C0000142']);results.push('only-whitelisted-native-diagnostic-codes-reported');
  }
  {
    const unavailable=[];
    const {transport}=make('spontaneous');
    transport.subscribe(message=>{if(message.method==='gateway/runtimeUnavailable')unavailable.push(message);});
    await transport.ready;await transport.closed;
    assert.equal(unavailable.length,1);assert.equal(unavailable[0].params.error,'WINDOWS_HOST_EXITED');
    assert.equal(transport.alive,false);results.push('spontaneous-verified-exit-notifies-runtime-unavailable-once');
  }
  {
    const {transport,credential}=make('startup-timeout',{startTimeoutMs:500});
    await assert.rejects(transport.ready,/START_TIMEOUT/);await transport.closed;
    assert.equal(credential.releases,1);results.push('startup-timeout-retains-until-verified-close');
  }
  {
    const {transport}=make('normal');transport.close();await assert.rejects(transport.ready,/STOPPING/);await transport.closed;
    results.push('close-before-ready-still-awaits-evidence');
  }
  for(const scenario of ['no-evidence','wrong-instance','extra-after-closed','nonzero']){
    const {transport,credential}=make(scenario);await transport.ready;transport.close();
    await assert.rejects(transport.closed,/CLEANUP_UNKNOWN/);
    assert.equal(credential.releases,1);results.push(`cleanup-rejected:${scenario}`);
  }
  for(const scenario of ['early-rpc','bad-utf8','oversize']){
    const {transport}=make(scenario,{maxFrameBytes:1024});
    await assert.rejects(transport.ready,/PROTOCOL_INVALID|FRAME_LIMIT/);
    await assert.rejects(transport.closed,/CLEANUP_UNKNOWN/);results.push(`protocol-rejected:${scenario}`);
  }
  for(const scenario of ['worker-closed-spoof','invalid-base64']){
    const {transport}=make(scenario);await transport.ready;
    await assert.rejects(transport.closed,/CLEANUP_UNKNOWN/);results.push(`envelope-rejected:${scenario}`);
  }
  {
    const {transport}=make('normal',{requestTimeoutMs:100,maxPendingRequests:1});await transport.ready;
    const pending=transport.request('hang',{});
    await assert.rejects(transport.request('hang',{}),/REQUEST_LIMIT/);
    await assert.rejects(pending,/RPC_TIMEOUT/);transport.close();await transport.closed;
    results.push('pending-quota-and-request-timeout');
  }
  assert.throws(()=>new WindowsWorkerTransport({hostPath:executable,hostSha256:'0'.repeat(64),runtimePath:executable,runtimeSha256:binaryHash,root,userKey:'a'.repeat(64),instanceId:'b'.repeat(32),model:'fixture',lease:lease().value}),/HASH_MISMATCH/);
  results.push('host-hash-rejected-before-spawn');
  console.log(JSON.stringify({passed:true,scope:'windows-host-transport-protocol-fixtures',osIsolationVerified:false,productionGateEnabled:false,checks:results},null,2));
} finally {
  if(live?.exitCode===null&&!live?.signalCode)live.kill();
  if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('windows-host-transport-'))throw Error('UNSAFE_CLEANUP');
  await rm(root,{recursive:true,force:true});
}
