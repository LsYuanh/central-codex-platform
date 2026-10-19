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

const root=await mkdtemp(join(tmpdir(),'task-control-gateway-'));
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
const fs=require('node:fs'),rl=require('node:readline');let responses=[],next=0,reads=0,lastTools=[],deletes=[],calls=[],goals={},turns={};const loaded=new Set();
const out=messages=>process.stdout.write(messages.map(m=>JSON.stringify(m)+'\n').join(''));
const emit=(method,params)=>out([{method,params}]);
rl.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(!q.method){responses.push(q);return;}calls.push(q.method);let result={};
 if(q.method==='initialize')result={userAgent:'control-fixture yuan-zhou-remote-workspace/1 yuan-zhou-plan-goal/1'};
 if(q.method==='model/list')result={pid:process.pid,responses,reads,lastTools,deletes,calls};
 if(q.method==='model/list'&&q.params.fixture==='unload')loaded.clear();
 if(q.method==='thread/start'){result={thread:{id:'control-'+process.pid+'-'+ ++next}};loaded.add(result.thread.id);}
 if(q.method==='thread/loaded/list')result={data:[...loaded],nextCursor:null};
 if(q.method==='thread/resume')loaded.add(q.params.threadId);
 if(q.method==='thread/read'||q.method==='thread/resume')result={thread:{id:q.params.threadId,turns:turns[q.params.threadId]?[turns[q.params.threadId]]:[]}};
 if(q.method==='thread/goal/get')result={goal:goals[q.params.threadId]??null};
 if(q.method==='thread/goal/set'){
  const tid=q.params.threadId;goals[tid]={threadId:tid,objective:'fixture',tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,...goals[tid],...q.params};result={goal:goals[tid]};
  if(q.params.objective==='delay-activation'){emit('thread/goal/updated',{threadId:tid,goal:result.goal});setTimeout(()=>out([{id:q.id,result}]),100);return;}
 }
 if(q.method==='thread/goal/clear')delete goals[q.params.threadId];
 if(q.method==='turn/interrupt'){
  const turn=turns[q.params.threadId];
  if(!q.params.turnId||turn?.id!==q.params.turnId){out([{id:q.id,error:{code:-32602,message:'missing or wrong turnId'}}]);return;}
  emit('turn/completed',{threadId:q.params.threadId,turn:{...turn,status:'interrupted'}});delete turns[q.params.threadId];
 }
 if(q.method==='turn/start')result={turn:{id:'turn-'+ ++next}};
 out([{id:q.id,result}]);
 if(q.method==='thread/goal/set')emit('thread/goal/updated',{threadId:q.params.threadId,goal:result.goal});
 if(q.method==='thread/goal/set'&&result.goal.status==='active'){
  const turn={id:'goal-turn-'+ ++next,status:'inProgress'};turns[q.params.threadId]=turn;emit('turn/started',{threadId:q.params.threadId,turn});
 }
 if(q.method==='thread/goal/clear')emit('thread/goal/cleared',{threadId:q.params.threadId});
 if(q.method==='turn/start'){emit('turn/started',{threadId:q.params.threadId,turn:result.turn});emit('turn/completed',{threadId:q.params.threadId,turn:{...result.turn,status:'completed'}});}
});
setInterval(()=>{if(!fs.existsSync('inbox.json'))return;const batch=JSON.parse(fs.readFileSync('inbox.json','utf8'));fs.unlinkSync('inbox.json');out(batch);},20);
`;
const runtimeDirs=[];
for(const user of users){const dir=join(root,'workers',createHash('sha256').update(user.id).digest('hex'),'runtime');runtimeDirs.push(dir);await mkdir(dir,{recursive:true});await writeFile(join(dir,'app-server'),fixtureCode);}
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const base=`https://localhost:${port}`,gateway=`wss://localhost:${port}/ws`;
let log='';
const env={...process.env,CODEX_BIN:process.execPath,PLATFORM_DEVICE_AUTH_MODE:'legacy-mtls-v1',PLATFORM_WORKER_ISOLATION:'protocol-fixture',TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:stateFile,PLATFORM_AUTH_FILE:authFile,PLATFORM_TLS_CERT:cert,PLATFORM_TLS_KEY:key,PLATFORM_WORKER_ROOT:join(root,'workers'),PLATFORM_AUDIT_DIR:auditDir,PLATFORM_WORKER_RESTART_MS:'100',PLATFORM_WORKER_IDLE_MS:'60000',PLATFORM_USER_TURNS:'1'};
function start(extra={}){const child=spawn(process.execPath,[resolve('services/central-gateway/dist/index.js')],{env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});processes.push(child);child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);return child;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error(`Timeout: ${label}; ${log.slice(-1200)}`);}
const pass=name=>{checks.push(name);console.log('PASS '+name);};
function http(path,body,token){return new Promise((resolve,reject)=>{const request=https.request(base+path,{method:body===undefined?'GET':'POST',ca,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})}},response=>{let raw='';response.on('data',d=>raw+=d);response.on('end',()=>{try{const value=JSON.parse(raw);if(!value.ok)throw Error(value.error??JSON.stringify(value));resolve(value);}catch(error){reject(error);}});});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});}
async function post(path,body={},token){return(await http(path,body,token)).data;}
async function connect(path,token,onMessage){const socket=new WebSocket(path,{ca,headers:{Authorization:'Bearer '+token}});sockets.push(socket);if(onMessage)socket.on('message',raw=>onMessage(JSON.parse(String(raw))));await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});return socket;}
async function client(login,device){const events=[],pending=new Map();const socket=await connect(`${gateway}?deviceId=${device.deviceId}`,login.accessToken,m=>{events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);});return{socket,events,request:(operation,payload={})=>new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Request timeout: '+operation));},5000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?resolve(m.data):reject(Error(m.error));});socket.send(JSON.stringify({type:'request',requestId,operation,payload}));})};}
function envelope(type,payload,requestId){return{protocol:'agentrpc',version:1,type,timestamp:new Date().toISOString(),nonce:randomUUID(),...(requestId?{requestId}:{}),payload};}
async function device(login){const keys=generateKeyPairSync('ed25519'),raw=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32);const code=await post('/auth/pair-code',{},login.accessToken);const paired=await post('/auth/pair',{code:code.code,publicKey:raw.toString('base64'),name:'routing protocol Agent fixture'},login.accessToken);const challenge=await post('/auth/device/challenge',{sessionId:login.sessionId,deviceId:paired.deviceId});const proof=await post('/auth/device/prove',{nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),keys.privateKey).toString('base64')});
 let ready=false;const socket=await connect(`${gateway}/agent?deviceId=${paired.deviceId}`,proof.ticket,m=>{if(m.type==='agent.hello_ack')ready=true;if(m.type!=='agent.request')return;agentRequests.push(m);socket.send(JSON.stringify(envelope('agent.response',{ok:true,result:m.payload.method==='workspace/context'?{workspaceRoot:'C:/routing-fixture',os:'windows',rules:[]}:{content:'protocol fixture response'}},m.requestId)));});
 socket.send(JSON.stringify(envelope('agent.hello',{deviceId:paired.deviceId,agent:{version:'routing-fixture',os:'windows',arch:'x64',deviceKey:paired.deviceKey,workspaceRoot:'C:/routing-fixture',capabilities:['client-paths/v1','remote-workspace/v1','workspace/context','workspace/read_text']}})));await until(()=>ready,'Agent fixture hello');return paired;}
async function emit(index,messages){const path=join(runtimeDirs[index],'inbox.json'),temp=path+'.tmp';await writeFile(temp,JSON.stringify(messages));await rename(temp,path);await until(async()=>{try{await access(path);return false;}catch{return true;}},'fixture reads message batch');}
const approval=threadId=>({id:'reused-upstream-approval',method:'item/tool/requestUserInput',params:{threadId,questions:[{id:'secret',question:'ALICE_PRIVATE_PROMPT'}]}});
async function init(ui,name='worker-routing-protocol-fixture'){await ui.request('session.initialize',{clientInfo:{name,version:'1'}});const info=await ui.request('model.list');workerPids.add(info.pid);return info.pid;}

try {
 const server=start();await until(()=>log.includes('listening'),'gateway ready');
 const la=await post('/auth/login',{username:'alice',password}),lb=await post('/auth/login',{username:'bob',password});
 const da=await device(la),db=await device(lb),otherDevice=await device(la);
 let a=await client(la,da);const b=await client(lb,db),other=await client(la,otherDevice);
 await init(a);await init(b);await init(other);
 const tid=(await a.request('conversation.create')).thread.id;
 const mode={mode:'plan',settings:{model:'fixture',reasoning_effort:null,developer_instructions:null}};
 const payload={threadId:tid,clientMessageId:randomUUID(),input:[{type:'text',text:'Plan'}],collaborationMode:mode};
 await assert.rejects(a.request('conversation.turn.create',{...payload,clientMessageId:undefined}),/COLLABORATION_SUBMISSION_REQUIRED/);
 await a.request('conversation.turn.create',payload);
 await until(()=>a.events.some(e=>e.eventType==='turn.completed'),'plan completed');
 assert.equal((await a.request('conversation.read',{threadId:tid})).collaborationMode,'plan');
 await assert.rejects(a.request('conversation.turn.create',{...payload,collaborationMode:{...mode,mode:'default'}}),/COLLABORATION_SUBMISSION_CONFLICT/);
 await assert.rejects(a.request('conversation.goal.set',{threadId:tid,objective:'blocked in plan'}),/GOAL_PLAN_ONLY/);
 const agentCount=agentRequests.length;
 await emit(0,[{id:'forbidden-write',method:'item/tool/call',params:{threadId:tid,turnId:'plan-tool',tool:'device_write_file',arguments:{content:'forbidden'}}}]);
 await until(async()=> (await a.request('model.list')).responses.some(r=>r.id==='forbidden-write'),'plan denial');
 const denied=(await a.request('model.list')).responses.find(r=>r.id==='forbidden-write');assert.equal(denied.result.success,false);assert.equal(agentRequests.length,agentCount);
 pass('mode persists, idempotency conflicts reject, plan write never reaches Agent');
 await a.request('conversation.turn.create',{...payload,clientMessageId:randomUUID(),collaborationMode:{...mode,mode:'default'}});
 await a.request('conversation.goal.set',{threadId:tid,objective:'continue safely',status:'active',tokenBudget:500});
 assert.equal((await a.request('conversation.goal.get',{threadId:tid})).goal.status,'active');
 assert.equal((await a.request('conversation.goal.get',{threadId:tid})).goal.origin,'user');
 await assert.rejects(b.request('conversation.goal.get',{threadId:tid}),/does not belong/);
 await assert.rejects(other.request('conversation.goal.set',{threadId:tid,status:'paused'}),/GOAL_DEVICE_MISMATCH/);
 const second=(await a.request('conversation.create')).thread.id;
 let queueSettled=false;
 const cancelledGoal=a.request('conversation.goal.set',{threadId:second,objective:'cancel queued goal',status:'active'}).then(v=>{queueSettled=true;return v;},e=>{queueSettled=true;return e;});
 await sleep(60);assert.equal(queueSettled,false);
 await a.request('conversation.turn.cancel',{threadId:second});
 assert.match(String(await cancelledGoal),/GOAL_CANCELLED/);
 assert.equal((await a.request('conversation.goal.get',{threadId:second})).goal,null,'cancelled admission never reaches App Server');
 // A distinct queued activation must proceed once the first goal releases its slot.
 queueSettled=false;
 const admittedGoal=a.request('conversation.goal.set',{threadId:second,objective:'wait for capacity',status:'active'}).then(v=>{queueSettled=true;return v;});
 await sleep(60);assert.equal(queueSettled,false);
 await a.request('conversation.turn.cancel',{threadId:tid});
 assert.equal((await admittedGoal).goal.status,'active');
 await a.request('conversation.turn.cancel',{threadId:second});
 assert.equal((await a.request('conversation.goal.get',{threadId:tid})).goal.status,'paused');
 assert.equal((await a.request('conversation.goal.get',{threadId:tid})).goal.origin,'user','Stop is an explicit user action');
 const nativeCalls=(await a.request('model.list')).calls;assert(nativeCalls.lastIndexOf('thread/goal/set')<nativeCalls.lastIndexOf('turn/interrupt'));
 pass('ownership, device binding, queued goal cancellation and admission, stop pauses before interrupt');
 await a.request('conversation.goal.set',{threadId:tid,status:'active'});
 a.socket.close();await until(async()=> (await other.request('conversation.goal.get',{threadId:tid})).goal.status==='paused','disconnect pauses native goal');
 assert.equal((await other.request('conversation.goal.get',{threadId:tid})).goal.origin,'automatic','Disconnect is not a user pause instruction');
 a=await client(la,da);await init(a);await a.request('conversation.resume',{threadId:tid});
 assert.equal((await a.request('conversation.goal.get',{threadId:tid})).goal.status,'paused');
 await a.request('conversation.goal.clear',{threadId:tid});assert.equal((await a.request('conversation.goal.get',{threadId:tid})).goal,null);
 pass('disconnect pauses and reconnect requires explicit resume; clear reconciles');
 await a.request('model.list',{fixture:'unload'});
 const beforeResumes=(await a.request('model.list')).calls.filter(c=>c==='thread/resume').length;
 await a.request('conversation.goal.set',{threadId:tid,objective:'cold resume',status:'active'});
 assert.equal((await a.request('model.list')).calls.filter(c=>c==='thread/resume').length,beforeResumes+1);
 await a.request('conversation.turn.cancel',{threadId:tid});
 pass('goal activation reloads evicted Worker thread before reserving continuation');
 const activation=a.request('conversation.goal.set',{threadId:tid,objective:'delay-activation',status:'active'}).then(()=>null,e=>e);
 await sleep(30);await a.request('conversation.turn.cancel',{threadId:tid});
 assert.match(String(await activation),/GOAL_CANCELLED/);
 await until(async()=> (await a.request('conversation.goal.get',{threadId:tid})).goal.status==='paused','activation-stop race');
 pass('stop racing activation cannot restart unattended work');
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks,source:'authenticated gateway, protocol App Server and Agent fixtures'},null,2));
 console.log(JSON.stringify({ok:true,checks:checks.length,root}));
}catch(error){console.error(JSON.stringify({root,error:String(error),gatewayLog:log.slice(-2000)}));throw error;}
finally{for(const socket of sockets)socket.terminate();for(const child of processes)if(child.exitCode===null&&child.signalCode===null)child.kill();for(const pid of workerPids)try{process.kill(pid);}catch{}}
