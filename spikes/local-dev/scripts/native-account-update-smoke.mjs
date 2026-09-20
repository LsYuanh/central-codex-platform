// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Isolated native-host fixture, never a packaged runtime or a real OAuth account.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {ModelCredentialBroker} from '../services/test-gateway/dist/model-credential-broker.js';

const root=mkdtempSync(join(tmpdir(),'native-account-update-'));
const dist=join(root,'app/gateway/dist');mkdirSync(dist,{recursive:true});
writeFileSync(join(root,'package.json'),'{"type":"module"}');
writeFileSync(join(root,'manifest.json'),JSON.stringify({kind:'central-gateway-candidate',nativeWorker:{protocol:process.platform==='darwin'?'macos-seatbelt/v1':'windows-worker-host/v1',appServer:{sha256:'0'.repeat(64)},seatbeltProfile:{sha256:'0'.repeat(64)},host:{sha256:'0'.repeat(64)},privateFileHelper:{sha256:'0'.repeat(64)}}}));
for(const name of ['native-service-host.js','central-management-contract.js','service-metrics.js'])copyFileSync(resolve('services/test-gateway/dist',name),join(dist,name));
const {NativeServiceHost}=await import(pathToFileURL(join(dist,'native-service-host.js')));
const jwt=(expiry,marker)=>'e30.'+Buffer.from(JSON.stringify({exp:expiry,marker})).toString('base64url')+'.synthetic';
const old=jwt(Math.floor(Date.now()/1000)+600,'old'),updated=jwt(Math.floor(Date.now()/1000)+3600,'renewed');
const instance='1'.repeat(32),frames=[];
const host=new NativeServiceHost(instance,{config:{schemaVersion:1,revision:1,dataDirectory:join(root,'data'),listen:{host:'127.0.0.1',port:14593},clientUrl:'wss://model-broker.invalid:14593/ws',tls:{certificateId:'fixture'},runtimePackageId:'fixture',limits:{maxWorkers:2,perUserTurns:1,totalTurns:2},shutdown:{graceMs:1000,forceMs:1000}},tls:{cert:'synthetic',key:'synthetic'},account:{tokens:{access_token:old,account_id:'same-fixture-account'}}});
const source=host.modelSource({serviceUsers:()=>[{id:'fixture-user',disabled:false}]});
const seen=[];
const upstream=http.createServer((req,res)=>{seen.push(req.headers.authorization);req.resume();res.writeHead(200,{'content-type':'application/json'});res.end('{"id":"fixture-response","output":[]}');});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
let broker;
const originalWrite=process.stdout.write;
try {
  broker=await ModelCredentialBroker.start({configFile:join(root,'bindings.memory'),allowLoopbackTestProviders:true,memorySource:{readCredential:source.readCredential,readConfig:()=>{const c=source.readConfig();c.providers['native-default'].baseUrl=`http://127.0.0.1:${upstream.address().port}/backend-api/codex`;return c;}}});
  const lease=broker.createLease('fixture-user');
  const request=()=>new Promise((resolve,reject)=>{const req=http.request(broker.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+lease.token,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{"model":"fixture","input":[]}');});
  assert.equal(await request(),200);
  process.stdout.write=function(chunk,...args){frames.push(JSON.parse(String(chunk)));const done=args.find(a=>typeof a==='function');done?.();return true;};
  const update={method:'central/service',protocol:'central-service-host/v1',instanceId:instance,command:'account/update',updateId:'2'.repeat(32),revision:1,account:{tokens:{access_token:updated,account_id:'same-fixture-account'}}};
  host.accept(update);
  assert.equal(frames.at(-1).event,'accountUpdated');
  assert.equal(await request(),200); // Same lease survives: no restart/reconnection.
  assert.deepEqual(seen,['Bearer '+old,'Bearer '+updated]);
  host.accept({...update,updateId:'3'.repeat(32)}); // Lost acknowledgement is safely reconciled.
  for(const patch of [
    {instanceId:'0'.repeat(32)}, {revision:0}, {revision:1,account:{tokens:{access_token:old,account_id:'same-fixture-account'}}},
    {revision:2,account:{tokens:{access_token:updated,account_id:'another-account'}}},
    {revision:2,account:{tokens:{access_token:jwt(1,'expired'),account_id:'same-fixture-account'}}},
    {revision:2,account:{tokens:{access_token:updated,account_id:'same-fixture-account',refresh_token:'MUST_NEVER_REACH_GATEWAY'}}},
  ])assert.throws(()=>host.accept({...update,...patch}),/SERVICE_/);
  assert.equal(await request(),200);assert.equal(seen.at(-1),'Bearer '+updated);
  assert(!JSON.stringify(frames).includes(updated));assert(!JSON.stringify(frames).includes('refresh_token'));
  lease.release();
} finally {process.stdout.write=originalWrite;await broker?.close();await new Promise(resolve=>upstream.close(resolve));}
console.log(JSON.stringify({passed:true,checks:['same-lease-uses-new-token','duplicate-ack-safe','stale-instance-and-revision-rejected','account-switch-expired-token-and-refresh-token-rejected','no-credential-in-ack'],realCredentialsUsed:false}));
