// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelCredentialBroker} from '../../services/central-gateway/dist/model-credential-broker.js';
import {WorkerManager} from '../../services/central-gateway/dist/worker-manager.js';
import {catalogVersion} from '../../services/central-gateway/dist/model-catalog.js';
import {stableVersion,compareVersions} from '../../harness/check-upstream.mjs';
import {verifyRuntimeSignature} from '../../scripts/release/runtime-signature.mjs';
import {changedContracts} from '../../harness/check-runtime-schema.mjs';
const baselineSchema={json_schema:{'request.json':JSON.stringify({type:'object',required:['threadId']})}};
assert.deepEqual(changedContracts(baselineSchema,structuredClone(baselineSchema)),[]);
assert.deepEqual(changedContracts(baselineSchema,{json_schema:{'request.json':JSON.stringify({type:'object',required:['threadId','newRequired']})}}),['request.json']);
assert.deepEqual(changedContracts(baselineSchema,{json_schema:{}}),['request.json']);
const signedFixture=new URL('../fixtures/runtime-update-signature/',import.meta.url);
const signedPayload=readFileSync(new URL('descriptor.json',signedFixture)),signedProof=readFileSync(new URL('descriptor.json.sig',signedFixture),'utf8'),signedKey=readFileSync(new URL('public.key',signedFixture),'utf8');
verifyRuntimeSignature(signedPayload,signedProof,signedKey);
assert.throws(()=>verifyRuntimeSignature(Buffer.concat([signedPayload,Buffer.from(' ')]),signedProof,signedKey),/RUNTIME_SIGNATURE_INVALID/);
assert.throws(()=>verifyRuntimeSignature(signedPayload,signedProof,JSON.parse(readFileSync(new URL('../../harness/runtime-update-channel.json',import.meta.url))).publicKey),/RUNTIME_SIGNATURE_INVALID/);
console.log('PASS signing job verifies payload and trusted key before publishing');
const root=mkdtempSync(join(tmpdir(),'runtime-updates-'));
const credentials={tokens:{access_token:'e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fake',account_id:'catalog-fixture-account'}};
const received=[];let mode='normal';
const model={slug:'fixture-new-model',display_name:'Fixture model',visibility:'list',supported_reasoning_levels:[{effort:'high',description:'Fixture'}],default_service_tier:null,service_tiers:[{id:'priority',name:'Fast'}],base_instructions:'catalog metadata sentinel'};
const upstream=http.createServer((req,res)=>{
  received.push({path:req.url,auth:req.headers.authorization,account:req.headers['chatgpt-account-id']});
  if(mode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/secret'});res.end(credentials.tokens.access_token);return;}
  if(mode==='hold')return;
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(mode==='invalid'?{error:{message:credentials.tokens.access_token}}:{models:[model],private_top_level:'must not forward'}));
});
await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
const config={version:1,users:{alice:{providerId:'account',enabled:true}},providers:{account:{id:'account',kind:'chatgpt',credentialFile:join(root,'memory'),baseUrl:`http://127.0.0.1:${upstream.address().port}/backend-api/codex`}}};
const broker=await ModelCredentialBroker.start({configFile:join(root,'bindings'),memorySource:{readConfig:()=>config,readCredential:()=>credentials},allowLoopbackTestProviders:true,timeoutMs:200,maxConcurrent:2,maxConcurrentPerUser:1});
try{
  const lease=broker.createLease('alice');
  const get=(path='/v1/models?client_version=0.156.1',token=lease.token)=>fetch(broker.url+path,{headers:{authorization:'Bearer '+token}});
  const value=await (await get()).json();assert.deepEqual(value,{models:[model]});
  assert.equal(received[0].path,'/backend-api/codex/models?client_version=0.156.1');assert.equal(received[0].auth,'Bearer '+credentials.tokens.access_token);assert.equal(received[0].account,credentials.tokens.account_id);
  assert.deepEqual(await broker.verifyCatalog('alice','0.156.1'),[model.slug]);
  assert.equal((await get(undefined,'x'.repeat(43))).status,401);
  for(const path of ['/v1/models','/v1/models?client_version=latest','/v1/models?client_version=0.156.1&url=https://example.com','/v1/models?client_version=0.156.1%0d%0a','/admin'])assert.equal((await get(path)).status,404);
  for(mode of ['redirect','invalid','hold']){const res=await get();assert.equal(res.status,503);assert.ok(!(await res.text()).includes(credentials.tokens.access_token));}
  mode='normal';config.users.alice.enabled=false;broker.reload();assert.equal((await get()).status,401);lease.release();
  assert.equal(catalogVersion('POST','/v1/models?client_version=0.156.1'),undefined);
  console.log('PASS authenticated catalog, real version forwarding, metadata preservation, revoked leases, forbidden routes, redirects, invalid body, timeout and diagnostic filtering');
}finally{await broker.close();upstream.closeAllConnections();await new Promise(done=>upstream.close(done));}
let release;
const bridge={alive:true,enforcedRuntimeReady:true,pid:42,request:async(method)=>method==='hold'?new Promise(done=>{release=done;}):method==='turn/start'?{turn:{id:'turn'}}:{},respond(){},close(){this.alive=false;}};
const manager=new WorkerManager({root:join(root,'workers'),perUser:true,maxWorkers:1,perUserTurns:1,totalTurns:1,maxRequests:2,idleMs:100000,cooldownMs:0,create:()=>bridge,event:()=>{}});
try{
  const client=manager.forUser('alice');const pending=client.request('hold',{});assert.equal(manager.quiesceIfIdle(),false);release({});await pending;
  await client.request('turn/start',{threadId:'thread'});assert.equal(manager.quiesceIfIdle(),false);
  manager.notification('alice',bridge,{method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
  assert.equal(manager.quiesceIfIdle(),true);await assert.rejects(client.request('turn/start',{threadId:'thread'}),/CENTRAL_UPDATING/);
  console.log('PASS in-flight RPC and running turn block switching; idle check closes admission atomically');
}finally{manager.close();}
for(const tag of ['rust-v1.2.3-alpha','v1.2.3','main','rust-v1.2'])assert.equal(stableVersion(tag),undefined);
assert.equal(stableVersion('rust-v0.156.1'),'0.156.1');assert.equal(compareVersions('0.156.1','0.99.9'),1);
console.log('PASS stable release channel rejects prerelease tags and compares numeric versions');
