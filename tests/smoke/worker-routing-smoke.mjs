// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real TLS gateway and Ed25519 device authentication; App Server/Agent are labelled protocol fixtures.
// No central host, native credential vault, model calls, or client commands are used.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rename,access,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash,generateKeyPairSync,sign} from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import {WebSocket} from 'ws';
import {PlatformAuth} from '../../services/central-gateway/dist/platform-auth.js';

const testTransport=process.argv.includes('--transport');
const testClientUpdates=process.argv.includes('--client-updates')||testTransport;
const testDeviceReview=process.argv.includes('--device-approval')||testClientUpdates;
let adminToken;
const root=await mkdtemp(join(tmpdir(),'worker-routing-'));
const sockets=[],processes=[],workerPids=new Set(),checks=[],agentRequests=[];
const authFile=join(root,'auth.json'),stateFile=join(root,'state.json'),auditDir=join(root,'audit');
const cert=join(root,'cert.pem'),key=join(root,'key.pem'),password='qa-'+randomBytes(24).toString('hex');
const config=join(root,'openssl.cnf');
await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const generated=spawnSync(process.env.OPENSSL_BIN??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl'),['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',cert,'-config',config],{windowsHide:true});
assert.equal(generated.status,0,String(generated.stderr));
const ca=await readFile(cert);
const auth=new PlatformAuth(authFile);
const users=[await auth.createUser('alice',password,'admin'),await auth.createUser('bob',password)];auth.close();
const fixtureCode=String.raw`
const fs=require('node:fs'),rl=require('node:readline');let responses=[],next=0,reads=0,lastTools=[],deletes=[];
fs.writeFileSync('pid',String(process.pid));
const out=messages=>process.stdout.write(messages.map(m=>JSON.stringify(m)+'\n').join(''));
rl.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(!q.method){responses.push(q);fs.writeFileSync('responses.json',JSON.stringify(responses));return;}
 if(q.method==='model/list'&&q.params.fixture==='crash')process.exit(27);
 let result={};
 if(q.method==='initialize')result={userAgent:'routing-protocol-fixture yuan-zhou-remote-workspace/1'+(q.params.clientInfo?.name==='legacy-runtime'?'':' yuan-zhou-conversation-read/1')+(process.env.TEST_DEVICE_REVIEW==='1'?' yuan-zhou-device-approval/1':'')};
 if(q.method==='model/list')result={pid:process.pid,responses,reads,lastTools,deletes};
 if(q.method==='thread/delete'){
   deletes.push(q.params.threadId);
   if(fs.existsSync('deny-delete')){out([{id:q.id,error:{code:-32602,message:'REMOTE_WORKSPACE_UNSUPPORTED: thread/delete'}}]);return;}
 }
 if(q.method==='thread/start'){lastTools=(q.params.dynamicTools??[]).map(t=>t.name);result={thread:{id:'routing-'+process.pid+'-'+ ++next}};}
 if(q.method==='turn/start')result={turn:{id:'update-race',status:'inProgress'}};
 if(q.method==='thread/read'||q.method==='thread/resume'){reads++;result={thread:{id:q.params.threadId,turns:[{id:'history-turn',status:'completed',items:[{id:'history-user',type:'userMessage',content:[{type:'text',text:'SAME_USER_HISTORY'}]}]}]}};}
 out([{id:q.id,result}]);
});
setInterval(()=>{if(!fs.existsSync('inbox.json'))return;const batch=JSON.parse(fs.readFileSync('inbox.json','utf8'));fs.unlinkSync('inbox.json');out(batch);},20);
`;
const runtimeDirs=[];
for(const user of users){const dir=join(root,'workers',createHash('sha256').update(user.id).digest('hex'),'runtime');runtimeDirs.push(dir);await mkdir(dir,{recursive:true});await writeFile(join(dir,'app-server'),fixtureCode);}
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const base=`https://localhost:${port}`,gateway=`wss://localhost:${port}/ws`;
let log='';
const env={...process.env,TEST_DEVICE_REVIEW:testDeviceReview?'1':'0',CODEX_BIN:process.execPath,PLATFORM_DEVICE_AUTH_MODE:'legacy-mtls-v1',PLATFORM_WORKER_ISOLATION:'protocol-fixture',TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:stateFile,PLATFORM_AUTH_FILE:authFile,PLATFORM_TLS_CERT:cert,PLATFORM_TLS_KEY:key,PLATFORM_WORKER_ROOT:join(root,'workers'),PLATFORM_AUDIT_DIR:auditDir,PLATFORM_WORKER_RESTART_MS:'100',PLATFORM_WORKER_IDLE_MS:'60000'};
function start(extra={}){const child=spawn(process.execPath,[resolve(process.env.WORKER_ROUTING_GATEWAY_ENTRY??'services/central-gateway/dist/index.js')],{env:{...env,...(testClientUpdates?{PLATFORM_DEVICE_AUTH_MODE:'device-token-v1'}:{}),...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});processes.push(child);child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);return child;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error(`Timeout: ${label}; ${log.slice(-1200)}`);}
const pass=name=>{checks.push(name);console.log('PASS '+name);};
function http(path,body,token){return new Promise((resolve,reject)=>{const request=https.request(base+path,{method:body===undefined?'GET':'POST',ca,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})}},response=>{let raw='';response.on('data',d=>raw+=d);response.on('end',()=>{try{const value=JSON.parse(raw);if(!value.ok)throw Error(value.error??JSON.stringify(value));resolve(value);}catch(error){reject(error);}});});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});}
async function post(path,body={},token){return(await http(path,body,token)).data;}
async function connect(path,token,onMessage){const socket=new WebSocket(path,{ca,headers:{Authorization:'Bearer '+token}});sockets.push(socket);if(onMessage)socket.on('message',raw=>onMessage(JSON.parse(String(raw))));await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});return socket;}
async function client(login,device){const events=[],pending=new Map();const socket=await connect(testClientUpdates?gateway:`${gateway}?deviceId=${device.deviceId}`,testClientUpdates?device.deviceToken:login.accessToken,m=>{events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);});return{socket,events,request:(operation,payload={})=>new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Request timeout: '+operation));},5000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?resolve(m.data):reject(Error(m.error));});socket.send(JSON.stringify({type:'request',requestId,operation,payload}));})};}
function envelope(type,payload,requestId){return{protocol:'agentrpc',version:1,type,timestamp:new Date().toISOString(),nonce:randomUUID(),...(requestId?{requestId}:{}),payload};}
async function device(login){if(testClientUpdates)return tokenDevice(login);const keys=generateKeyPairSync('ed25519'),raw=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32);const code=await post('/auth/pair-code',{},login.accessToken);const paired=await post('/auth/pair',{code:code.code,publicKey:raw.toString('base64'),name:'routing protocol Agent fixture'},login.accessToken);const challenge=await post('/auth/device/challenge',{sessionId:login.sessionId,deviceId:paired.deviceId});const proof=await post('/auth/device/prove',{nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),keys.privateKey).toString('base64')});
 let ready=false;const socket=await connect(`${gateway}/agent?deviceId=${paired.deviceId}`,proof.ticket,m=>{if(m.type==='agent.hello_ack')ready=true;if(m.type!=='agent.request')return;agentRequests.push(m);socket.send(JSON.stringify(envelope('agent.response',{ok:true,result:m.payload.method==='workspace/context'?{workspaceRoot:'C:/routing-fixture',os:'windows',rules:[]}:m.payload.method==='workspace/apply_patch'&&m.payload.params.dryRun?{patchHash:'fixture-hash',expectedVersions:{'a.txt':'missing'},expectedPaths:{'a.txt':'C:/routing-fixture/a.txt'}}:m.payload.method==='workspace/apply_patch'?{outcome:'completed'}:{content:'protocol fixture response'}},m.requestId)));});
 socket.send(JSON.stringify(envelope('agent.hello',{deviceId:paired.deviceId,agent:{version:'routing-fixture',os:'windows',arch:'x64',deviceKey:paired.deviceKey,workspaceRoot:'C:/routing-fixture',capabilities:['client-paths/v1','remote-workspace/v1','workspace/context','workspace/read_text','workspace/apply_patch']}})));await until(()=>ready,'Agent fixture hello');return paired;}
async function emit(index,messages){const path=join(runtimeDirs[index],'inbox.json'),temp=path+'.tmp';await writeFile(temp,JSON.stringify(messages));await rename(temp,path);await until(async()=>{try{await access(path);return false;}catch{return true;}},'fixture reads message batch');}
const approval=threadId=>({id:'reused-upstream-approval',method:'item/tool/requestUserInput',params:{threadId,questions:[{id:'secret',question:'ALICE_PRIVATE_PROMPT'}]}});
async function init(ui,name='worker-routing-protocol-fixture'){await ui.request('session.initialize',{clientInfo:{name,version:'1'}});const info=await ui.request('model.list');workerPids.add(info.pid);return info.pid;}

async function tokenDevice(login){
 const user=(await post('/auth/me',{},login.accessToken)).user;
 const code=await post('/auth/admin/pair-code',{userId:user.id},adminToken);
 const paired=await post('/auth/device/pair',{code:code.code,name:'update session protocol fixture'});
 paired.mode='plain';paired.cancels=0;paired.sessionId=randomUUID();
 paired.connect=async()=>{
  let ready=false;
  const socket=await connect(`${gateway}/agent`,paired.deviceToken,async m=>{
   if(m.type==='agent.hello_ack')ready=true;
   if(m.type==='job.cancel')paired.cancels++;
   if(m.type!=='agent.request')return;
   agentRequests.push(m);const {method,params}=m.payload;
   let payload={ok:true,result:method==='workspace/context'?{workspaceRoot:'C:/routing-fixture',os:'windows',rules:[]}:method==='workspace/apply_patch'&&params.dryRun?{patchHash:'fixture-hash',expectedVersions:{'a.txt':'missing'},expectedPaths:{'a.txt':'C:/routing-fixture/a.txt'}}:method==='workspace/apply_patch'?{outcome:'completed'}:{content:'protocol fixture response'}};
   if(method==='exec'&&paired.mode!=='plain'){
    if(params.sessionId){
     assert.equal(params.sessionId,paired.sessionId);
     assert.equal(params.program,'');assert.deepEqual(params.args,[]);
     assert.equal(params.yieldMs,0);assert.equal(params.cancel,undefined);assert.equal(params.stdin,undefined);
     assert.equal(params.__sessionOwner,paired.owner,'preflight must preserve the session owner');
     if(paired.onPoll)await paired.onPoll();
     if(paired.mode==='timeout')return;
    }else paired.owner=params.__sessionOwner;
    payload=paired.mode==='missing'?{ok:false,error:'COMMAND_SESSION_NOT_FOUND'}:{ok:true,result:{sessionId:paired.mode==='malformed'?'wrong-session':paired.sessionId,running:paired.mode!=='ended',completion:paired.mode==='ended'?{ok:true,result:{exitCode:0}}:null}};
   }
   socket.send(JSON.stringify(envelope('agent.response',payload,m.requestId)));
  });
  paired.socket=socket;
  socket.send(JSON.stringify(envelope('agent.hello',{deviceId:paired.deviceId,agent:{version:'update-fixture',os:'windows',arch:'x64',deviceKey:paired.deviceKey,workspaceRoot:'C:/routing-fixture',capabilities:['client-paths/v1','remote-workspace/v1','exec-sessions/v1','workspace/context','workspace/read_text','workspace/apply_patch']}})));
  await until(()=>ready,'token Agent ready');
 };await paired.connect();return paired;
}
function updateRequest(device,path='prepare',lease,prefix=testTransport?'transport':'client-updates'){return new Promise((resolve,reject)=>{
 const request=https.request(base+'/'+prefix+'/'+path,{method:'POST',ca,headers:{Authorization:'Bearer '+device.deviceToken,'x-update-version':'0.3.2',...(lease?{'x-update-lease':lease}:{})}},response=>{
  let raw='';response.on('data',d=>raw+=d);response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(raw)});}catch(e){reject(e);}});
 });request.on('error',reject);request.end();
});}

try{
 const server=start();await until(()=>log.includes('listening'),'TLS gateway ready');
 const la=await post('/auth/login',{username:'alice',password}),lb=await post('/auth/login',{username:'bob',password});
 adminToken=la.accessToken;
 const da=await device(la),db=await device(lb);let a=await client(la,da);const b=await client(lb,db);
 const pidA=await init(a),pidB=await init(b,'legacy-runtime');assert.notEqual(pidA,pidB);
 const threadId=(await a.request('conversation.create')).thread.id;
 const otherDevice=await device(la),other=await client(la,otherDevice);await init(other);
 const targetId=(await other.request('conversation.create')).thread.id;
 await other.request('conversation.archive',{threadId:targetId});
 other.socket.close();
 const foreignId=(await b.request('conversation.create')).thread.id;
 assert((await a.request('model.list')).lastTools.includes('conversation_read'));
 assert(!(await b.request('model.list')).lastTools.includes('conversation_read'));
 await emit(1,[{id:'legacy-history-read',method:'item/tool/call',params:{threadId:foreignId,tool:'conversation_read',arguments:{threadId:foreignId}}}]);
 let legacyRead;await until(async()=>{legacyRead=(await b.request('model.list')).responses.find(r=>r.id==='legacy-history-read');return !!legacyRead;},'legacy history capability rejection');
 assert.equal(legacyRead.result.success,false);assert.match(legacyRead.result.contentItems[0].text,/NEW_THREAD_REQUIRED/);
 assert.equal((await b.request('model.list')).reads,0);
 const beforeHistoryAgentCalls=agentRequests.length;
 async function readTool(id,target,ownerThread=threadId){
   await emit(0,[{id,method:'item/tool/call',params:{threadId:ownerThread,turnId:'read-turn',tool:'conversation_read',arguments:{threadId:target}}}]);
   let response;await until(async()=>{response=(await a.request('model.list')).responses.find(r=>r.id===id);return !!response;},'history tool response');return response.result;
 }
 const ownedRead=await readTool('owned-history',targetId);assert.equal(ownedRead.success,true);
 const ownedData=JSON.parse(ownedRead.contentItems[0].text);assert.equal(ownedData.archived,true);assert.match(JSON.stringify(ownedData.fragments),/SAME_USER_HISTORY/);
 const beforeDeniedReads=(await a.request('model.list')).reads;
 for(const [id,target]of [['foreign-history',foreignId],['missing-history','absent']]){const result=await readTool(id,target);assert.equal(result.success,false);assert.match(result.contentItems[0].text,/CONVERSATION_UNAVAILABLE/);}
 assert.equal((await a.request('model.list')).reads,beforeDeniedReads);
 await assert.rejects(b.request('conversation.delete',{threadId:targetId}),/does not belong/);
 assert.deepEqual((await a.request('model.list')).deletes,[]);
 assert.deepEqual((await b.request('model.list')).deletes,[]);
 const denyDelete=join(runtimeDirs[0],'deny-delete');await writeFile(denyDelete,'legacy Harness denies deletion');
 await assert.rejects(a.request('conversation.delete',{threadId:targetId}),/REMOTE_WORKSPACE_UNSUPPORTED: thread\/delete/);
 assert.equal((await a.request('conversation.read',{threadId:targetId})).thread.id,targetId,'Rejected delete must retain ownership and history');
 const retained=JSON.parse(await readFile(stateFile,'utf8'));assert(retained.users[users[0].id].some(row=>row.id===targetId));
 await unlink(denyDelete);
 await a.request('conversation.delete',{threadId:targetId});
 assert.deepEqual((await a.request('model.list')).deletes,[targetId,targetId]);
 const saved=JSON.parse(await readFile(stateFile,'utf8'));assert(!saved.users[users[0].id].some(row=>row.id===targetId));
 pass('delete enforces user ownership, retains metadata on runtime rejection, and only removes metadata after success');
 const deletedRead=await readTool('deleted-history',targetId);assert.equal(deletedRead.success,false);
 assert.equal(agentRequests.length,beforeHistoryAgentCalls,'central history performs no device RPC');
 assert(!b.events.some(e=>JSON.stringify(e).includes('SAME_USER_HISTORY')));
 assert.equal((await b.request('conversation.read',{threadId:foreignId})).thread.id,foreignId);
 pass('conversation_read reads same-user archived cross-device history, rejects foreign/missing/deleted IDs before Worker read, and never dispatches to Agent');
 await b.request('model.list'); // Make Bob the last active UI, while Alice owns this Thread.
 a.socket.close();await until(()=>a.socket.readyState===WebSocket.CLOSED,'Alice UI disconnected');
 const bobBoundary=b.events.length;await emit(0,[approval(threadId)]);
 // Wait for the fixture to receive the rejection while Alice still has no connected UI.
 let offlineResponse;
 await until(async()=>{try{offlineResponse=JSON.parse(await readFile(join(runtimeDirs[0],'responses.json'),'utf8')).find(r=>r.id==='reused-upstream-approval');return!!offlineResponse;}catch{return false;}},'offline owner approval rejected');
 assert.equal(offlineResponse.result.decision,'reject');
 assert(!b.events.slice(bobBoundary).some(e=>e.type==='approval.request'||JSON.stringify(e).includes('ALICE_PRIVATE_PROMPT')));
 pass('offline owner approval is rejected on its Worker and never leaks to last-active foreign user');

 a=await client(la,da);
 await emit(0,[approval(threadId)]);await until(()=>a.events.some(e=>e.type==='approval.request'),'first generation approval');
 const old=a.events.find(e=>e.type==='approval.request');
 await assert.rejects(a.request('model.list',{fixture:'crash'}),/exited|unavailable/i);
 await until(()=>a.events.some(e=>e.eventType==='gateway.runtime_unavailable'),'owner sees Worker failure');
 await until(async()=>{try{return(await init(a))!==pidA;}catch{return false;}},'replacement Worker initializes');
 assert.equal((await b.request('model.list')).pid,pidB);
 const boundary=a.events.length;await emit(0,[approval(threadId)]);
 await until(()=>a.events.slice(boundary).some(e=>e.type==='approval.request'),'replacement approval with reused upstream id');
 const current=a.events.slice(boundary).find(e=>e.type==='approval.request');assert.notEqual(current.requestId,old.requestId);
 a.socket.send(JSON.stringify({type:'approval.response',requestId:old.requestId,result:{answers:{secret:'STALE_RESPONSE'}}}));
 assert.deepEqual((await a.request('model.list')).responses,[]);
 a.socket.send(JSON.stringify({type:'approval.response',requestId:current.requestId,result:{answers:{secret:'CURRENT_RESPONSE'}}}));
 const accepted=(await a.request('model.list')).responses;assert.equal(accepted.length,1);assert.equal(accepted[0].id,'reused-upstream-approval');assert.equal(accepted[0].result.answers.secret,'CURRENT_RESPONSE');
 pass('restarted Worker reusing upstream approval ID rejects stale UI response; current response reaches correct bridge');

 const beforeUnknown=a.events.length;
 await emit(0,[{id:'unknown-permission',method:'future/privilegedApproval',params:{threadId}}]);
 const unknown=(await a.request('model.list')).responses.find(r=>r.id==='unknown-permission');
 assert.equal(unknown?.result?.decision,'reject');assert(!a.events.slice(beforeUnknown).some(e=>e.type==='approval.request'));
 pass('unknown central approval cannot be approved through the UI');

 const tool=()=>({id:'buffered-tool',method:'item/tool/call',params:{threadId,turnId:'stopped-turn',tool:'device_read_file',arguments:{path:'must-not-read.txt'}}});
 const beforeLiveTool=agentRequests.length;await emit(0,[tool()]);
 await until(async()=>{const info=await a.request('model.list');return info.responses.some(r=>r.id==='buffered-tool'&&r.result.success===true);},'live fixture tool reaches Agent');
 assert(agentRequests.length>beforeLiveTool);assert(agentRequests.some(r=>r.payload.method==='read_file'));
 if(testDeviceReview){
   const currentMode=()=>a.request('conversation.read',{threadId}).then(r=>r.permissionMode);
   assert.equal(await currentMode(),'auto');
   await assert.rejects(b.request('conversation.permissions.set',{threadId,permissionMode:'full'}),/does not belong/);
   await assert.rejects(a.request('conversation.permissions.set',{threadId,permissionMode:'bogus'}),/PERMISSION_MODE_INVALID/);
   let actionNumber=0;
   async function prepareAction(mode,args={program:'powershell',args:['-Command','Write-Output reviewed']},tool='device_exec'){
     await a.request('conversation.permissions.set',{threadId,permissionMode:mode});
     assert.equal(await currentMode(),mode);
     const id='prepare-'+ ++actionNumber;
     await emit(0,[{id,method:'item/tool/call',params:{threadId,turnId:'review-turn',namespace:'yuan_zhou_device_approval',tool:'prepare',arguments:{tool,arguments:args}}}]);
     let response;await until(async()=>{response=(await a.request('model.list')).responses.find(r=>r.id===id);return !!response;},'prepared action');
     assert.equal(response.result.success,true,JSON.stringify(response));
     return JSON.parse(response.result.contentItems[0].text);
   }
   async function completeAction(prepared,outcome,expectPrompt=false){
     const id='complete-'+actionNumber,boundary=a.events.length;
     await emit(0,[{id,method:'item/tool/call',params:{threadId,turnId:'review-turn',namespace:'yuan_zhou_device_approval',tool:'complete',arguments:{token:prepared.token,outcome,reason:'fixture review decision'}}}]);
     if(expectPrompt){
       await until(()=>a.events.slice(boundary).some(e=>e.type==='approval.request'),'manual fallback');
       const prompt=a.events.slice(boundary).find(e=>e.type==='approval.request');
       assert.equal(prompt.method,'device/operation/requestApproval');
       a.socket.send(JSON.stringify({type:'approval.response',requestId:prompt.requestId,result:{decision:'accept'}}));
     }
     let response;await until(async()=>{response=(await a.request('model.list')).responses.find(r=>r.id===id);return !!response;},'completed reviewed action');
     if(!expectPrompt)assert(!a.events.slice(boundary).some(e=>e.type==='approval.request'));
     return response.result;
   }
   for(const [mode,outcome,manual] of [['auto','approved',false],['full','approved',false],['ask','manual',true],['auto','unavailable',true]]){
     const before=agentRequests.length,prepared=await prepareAction(mode);
     assert.equal(agentRequests.length,before,'prepare must not execute');
     assert.equal(prepared.mode,mode);assert.equal(prepared.action.source,'client');
     assert.equal((await completeAction(prepared,outcome,manual)).success,true);
     assert.equal(agentRequests.filter(r=>r.payload.method==='exec').length>0,true);
     await emit(0,[{id:'replay-'+actionNumber,method:'item/tool/call',params:{threadId,turnId:'review-turn',namespace:'yuan_zhou_device_approval',tool:'complete',arguments:{token:prepared.token,outcome:'approved'}}}]);
     await until(async()=>{const r=(await a.request('model.list')).responses.find(r=>r.id==='replay-'+actionNumber);return r?.result.success===false;},'one-use token rejects replay');
   }
   const patchBefore=agentRequests.length,patch=await prepareAction('auto',{patch:'*** Begin Patch\n*** Add File: a.txt\n+reviewed\n*** End Patch'},'device_workspace_apply_patch');
   assert.equal(agentRequests.length,patchBefore+1,'patch preparation only previews');
   assert.equal(agentRequests.at(-1).payload.params.dryRun,true);
   assert.equal(patch.action.arguments.dryRun,false);assert.deepEqual(patch.action.arguments.expectedPaths,{'a.txt':'C:/routing-fixture/a.txt'});
   await assert.rejects(a.request('conversation.permissions.set',{threadId,permissionMode:'full'}),/PERMISSION_MODE_BUSY/);
   const patchResult=await completeAction(patch,'approved');assert.equal(patchResult.success,true,JSON.stringify(patchResult));
   const {__remoteWorkspace:reviewBinding,...executedPatch}=agentRequests.at(-1).payload.params;
   assert.equal(reviewBinding.deviceKey,patch.action.deviceKey);
   assert.deepEqual(executedPatch,patch.action.arguments,'dispatch must use the exact reviewed snapshot');
   const beforeDenied=agentRequests.length,denied=await prepareAction('auto');
   assert.equal((await completeAction(denied,'denied')).success,false);
   assert.equal(agentRequests.length,beforeDenied,'native denial must never execute');
   const beforeBypass=agentRequests.length;
   await emit(0,[{id:'review-bypass',method:'item/tool/call',params:{threadId,turnId:'review-turn',tool:'device_exec',arguments:{program:'powershell',args:['-Command','Remove-Item file']}}}]);
   await until(async()=>{const r=(await a.request('model.list')).responses.find(r=>r.id==='review-bypass');return r?.result.success===false;},'unwrapped mutation denied');
   assert.equal(agentRequests.length,beforeBypass);
   pass('device permissions persist per thread; native auto/full execution, manual/unavailable confirmation, deny, replay and raw-exec bypass prevention');
   if(testClientUpdates){
     const begin=async()=>{da.mode='running';da.sessionId=randomUUID();assert.equal((await completeAction(await prepareAction('full',{program:'powershell',args:['-Command','fixture'],yieldMs:0}),'approved')).success,true);};
     const allowed=async(device=da)=>{const r=await updateRequest(device);assert.equal(r.status,200,JSON.stringify(r));assert(r.body.token);await updateRequest(device,'release',r.body.token);};
     const blocked=async reason=>{const r=await updateRequest(da);assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.body.reason,reason);};
     await begin();da.mode='ended';await allowed();
     const polls=agentRequests.length;await allowed();assert.equal(agentRequests.length,polls,'confirmed terminal record is removed');
     pass('ended command with no model follow-up poll no longer blocks installation');
     await begin();await blocked('command-running');await allowed(db);
     da.mode='malformed';await blocked('command-state-unknown');
     da.mode='timeout';const cancels=da.cancels;await blocked('command-state-unknown');assert.equal(da.cancels,cancels,'status timeout must not cancel a live command');
     da.mode='ended';await allowed();
     pass('running, malformed and timed-out probes remain blocked without cancelling commands; other devices are independent');
     await begin();da.mode='missing';await blocked('command-state-unknown');
     da.socket.close();await until(()=>da.socket.readyState===WebSocket.CLOSED,'Agent disconnect');
     await blocked('agent-unavailable');await da.connect();await allowed();
     pass('missing session is only terminal after a confirmed replacement Agent connection');
     await begin();da.mode='ended';
     da.onPoll=async()=>{
       await a.request('conversation.turn.create',{threadId,input:[{type:'text',text:'protocol-only update race'}]});
     };
     await blocked('active-turn');da.onPoll=undefined;
     await emit(0,[{method:'turn/completed',params:{threadId,turn:{id:'update-race',status:'completed'}}}]);
     await until(async()=>{try{await a.request('conversation.permissions.set',{threadId,permissionMode:'full'});return true;}catch{return false;}},'completed turn releases its Worker slot');
     const raced=await Promise.all([updateRequest(da),updateRequest(da,'prepare',undefined,'client-updates')]);
     assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]);
     await updateRequest(da,'release',raced.find(r=>r.status===200).body.token);
     await allowed();da.mode='plain';
     pass('turn starting during reconciliation blocks install; concurrent preparations grant only one lease');
   }
 }
 // Trigger synchronous fail-closed shutdown on the first line of one stdout batch.
 // A second buffered tool line must not execute after runtimeUnavailable cleanup.
 const segment=join(auditDir,'audit-00000001.jsonl');await rename(segment,segment+'.preserved');await mkdir(segment);
 const before=agentRequests.length,eventsBefore=a.events.length;
 await emit(0,[{id:'audit-failure',method:'item/commandExecution/requestApproval',params:{threadId}},tool()]);
 await until(()=>log.includes('AUDIT_STORAGE_UNAVAILABLE'),'durable audit write failure');
 await until(()=>[...workerPids].every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'all Workers stopped by audit failure');
 await until(()=>a.socket.readyState===WebSocket.CLOSED&&b.socket.readyState===WebSocket.CLOSED,'audit failure closes authenticated clients');
 await sleep(150);assert.equal(agentRequests.length,before);
 assert(!a.events.slice(eventsBefore).some(e=>e.eventType==='device.tool.started'));
 await assert.rejects(post('/auth/login',{username:'alice',password}),/AUTH_STORAGE_UNAVAILABLE|AUDIT_STORAGE_UNAVAILABLE/);
 pass('audit failure stops Workers, rejects new authentication, and discards the next buffered tool message without Agent dispatch');

 server.kill();await until(()=>server.exitCode!==null||server.signalCode!==null,'gateway shutdown');
 const oldState=join(root,'old-shared-state.json'),oldLog=log.length;
 await writeFile(oldState,JSON.stringify({version:1,users:{[users[0].id]:[{id:threadId,summary:{id:threadId}}]}}));
 const oldServer=start({TEST_GATEWAY_STATE_FILE:oldState,PLATFORM_AUDIT_DIR:join(root,'old-audit')});
 await until(()=>oldServer.exitCode!==null||oldServer.signalCode!==null,'old layout startup rejected');
 assert.notEqual(oldServer.exitCode,0);assert.match(log.slice(oldLog),/WORKER_LAYOUT_MIGRATION_REQUIRED/);
 assert(!log.slice(oldLog).includes('listening'));
 pass('legacy shared history refuses secure per-user startup before accepting connections');
 const guards=[
  ['missing central model configuration fails before listening',{PLATFORM_WORKER_ISOLATION:'',PLATFORM_MODEL_BINDINGS:''},/MODEL_BINDINGS_REQUIRED/],
  ['protocol fixture refuses a LAN listening address',{TEST_GATEWAY_HOST:'0.0.0.0'},/WORKER_FIXTURE_REQUIRES_LOOPBACK_NODE/],
  ...(process.platform==='win32'?[['authenticated model worker refuses an unsupported OS',{PLATFORM_WORKER_ISOLATION:'',PLATFORM_MODEL_BINDINGS:join(root,'unused-models.json')},/WORKER_ISOLATION_UNSUPPORTED/]]:[]),
 ];
 for(const [label,extra,expected] of guards){
  const from=log.length,guard=start({TEST_GATEWAY_STATE_FILE:join(root,'fresh-guard-state.json'),PLATFORM_AUDIT_DIR:join(root,'guard-audit'),...extra});
  await until(()=>guard.exitCode!==null||guard.signalCode!==null,label);assert.notEqual(guard.exitCode,0);assert.match(log.slice(from),expected);assert(!log.slice(from).includes('listening'));pass(label);
 }
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,source:'real local TLS gateway with authenticated protocol-only App Server and Agent fixtures',checks,root},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,root}));
}catch(error){console.error(JSON.stringify({ok:false,root,checks,error:String(error),gatewayLog:log.slice(-2000)}));throw error;}
finally{for(const socket of sockets)socket.terminate();for(const child of processes)if(child.exitCode===null&&child.signalCode===null)child.kill();for(const pid of workerPids)try{process.kill(pid);}catch{};}
