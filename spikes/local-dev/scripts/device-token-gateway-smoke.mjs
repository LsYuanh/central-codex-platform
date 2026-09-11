// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual gateway entry point + real local HTTPS/WSS. App Server and Agent are protocol fixtures.
// No central host, native credentials, model inference, or OS command execution.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import {WebSocket} from 'ws';
import {PlatformAuth} from '../services/test-gateway/dist/platform-auth.js';

await mkdir(resolve('target'),{recursive:true});const root=await mkdtemp(resolve('target/device-token-gateway-'));
const authFile=join(root,'auth.json'),stateFile=join(root,'state.json'),workerRoot=join(root,'workers'),auditDir=join(root,'audit');
const cert=join(root,'cert.pem'),key=join(root,'key.pem'),config=join(root,'openssl.cnf'),password=randomBytes(32).toString('base64url');
await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const tls=spawnSync(process.env.OPENSSL_BIN??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl'),['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',cert,'-config',config],{windowsHide:true});assert.equal(tls.status,0,'Synthetic TLS generation failed');
const ca=await readFile(cert),seed=new PlatformAuth(authFile),users=[];
try{users.push(await seed.createUser('gatewayadmin',password,'admin'),await seed.createUser('gatewayalice',password),await seed.createUser('gatewaybob',password));}finally{seed.close();}
const fixture=String.raw`
const rl=require('node:readline');let next=0;
rl.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(!q.method)return;let result={};
 if(q.method==='initialize')result={userAgent:'token-gateway-protocol-fixture yuan-zhou-remote-workspace/1'};
 if(q.method==='model/list')result={pid:process.pid};
 if(q.method==='thread/start')result={thread:{id:'token-thread-'+process.pid+'-'+ ++next}};
 if(q.method==='thread/read'||q.method==='thread/resume')result={thread:{id:q.params.threadId,turns:[]}};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\n');});
`;
for(const user of users){const directory=join(workerRoot,createHash('sha256').update(user.id).digest('hex'),'runtime');await mkdir(directory,{recursive:true});await writeFile(join(directory,'app-server'),fixture);}
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`https://localhost:${port}`,gateway=`wss://localhost:${port}/ws`,checks=[],sockets=[],children=[],workerPids=new Set(),secrets=[password];
const env={...process.env,CODEX_BIN:process.execPath,PLATFORM_WORKER_ISOLATION:'protocol-fixture',TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:stateFile,PLATFORM_AUTH_FILE:authFile,PLATFORM_TLS_CERT:cert,PLATFORM_TLS_KEY:key,PLATFORM_WORKER_ROOT:workerRoot,PLATFORM_AUDIT_DIR:auditDir,PLATFORM_WORKER_IDLE_MS:'60000',TEST_GATEWAY_ENABLE_CONTROLS:'1'};
delete env.PLATFORM_DEVICE_AUTH_MODE;delete env.PLATFORM_DEVICE_CA_CONFIG;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(25);}throw Error('Timeout: '+label);}
function start(extra={}){const child=spawn(process.execPath,[resolve('services/test-gateway/dist/index.js')],{env:{...env,...extra},stdio:['ignore','pipe','pipe'],windowsHide:true});const run={child,log:''};children.push(run);child.stdout.on('data',d=>run.log+=d);child.stderr.on('data',d=>run.log+=d);return run;}
async function stop(run){if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill();await until(()=>run.child.exitCode!==null||run.child.signalCode!==null,'gateway stopped');}
function http(route,body,token){return new Promise((resolve,reject)=>{const req=https.request(origin+route,{method:body===undefined?'GET':'POST',ca,agent:false,timeout:5000,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const value=JSON.parse(raw);value.ok?resolve(value):reject(Error(value.error??'HTTP_FAILED'));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTP timeout')));req.end(body===undefined?undefined:JSON.stringify(body));});}
async function post(route,body={},token){return(await http(route,body,token)).data;}
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function connect(url,token,onMessage){
  const ws=new WebSocket(url,{ca,headers:{Authorization:'Bearer '+token},handshakeTimeout:5000});sockets.push(ws);ws.on('error',()=>{});if(onMessage)ws.on('message',raw=>onMessage(JSON.parse(String(raw))));
  await new Promise((r,j)=>{ws.once('open',r);ws.once('error',()=>j(Error('WSS_REJECTED')));ws.once('unexpected-response',(_,res)=>{res.resume();j(Error(res.headers['x-yuan-auth-error']??'WSS_REJECTED'));ws.terminate();});});return ws;
}
async function ui(device){const pending=new Map(),events=[];const socket=await connect(gateway,device.deviceToken,message=>{events.push(message);if(message.type==='response')pending.get(message.requestId)?.(message);});
 socket.on('close',()=>{for(const finish of [...pending.values()])finish({ok:false,error:'UI_DISCONNECTED'});});
 return {socket,events,request:(operation,payload={})=>new Promise((resolve,reject)=>{
  if(socket.readyState!==WebSocket.OPEN){reject(Error('UI_DISCONNECTED'));return;}const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('RPC_TIMEOUT'));},5000);
  pending.set(requestId,message=>{clearTimeout(timer);pending.delete(requestId);message.ok?resolve(message.data):reject(Error(message.error));});socket.send(JSON.stringify({type:'request',requestId,operation,payload}));
 })};}
const envelope=(type,payload,requestId)=>({protocol:'agentrpc',version:1,type,timestamp:new Date().toISOString(),nonce:randomUUID(),...(requestId?{requestId}:{}),payload});
async function agent(device,{wrongKey=false}={}){
 const messages=[];let ready=false;const socket=await connect(gateway+'/agent',device.deviceToken,message=>{
  messages.push(message);if(message.type==='agent.hello_ack')ready=true;if(message.type!=='agent.request')return;
  if(message.payload.method==='exec')return; // Deliberately hold a protocol request until authorization is revoked.
  const result=message.payload.method==='workspace/context'?{source:'client',workspaceRoot:'C:/synthetic-token-workspace',os:'windows',rules:[]}:{source:'client',content:device.deviceId};
  socket.send(JSON.stringify(envelope('agent.response',{ok:true,result},message.requestId)));
 });
 socket.send(JSON.stringify(envelope('agent.hello',{deviceId:device.deviceId,agent:{version:'token-protocol-fixture',os:'windows',arch:'x64',deviceKey:wrongKey?'0'.repeat(64):device.deviceKey,workspaceRoot:'C:/synthetic-token-workspace',capabilities:['remote-workspace/v1','workspace/context','workspace/read_text','exec']}})));
 await until(()=>ready||socket.readyState===WebSocket.CLOSED,'Agent hello');return{socket,messages,ready};
}
let current,result;
try{
 current=start();await until(()=>current.log.includes('listening'),'default gateway ready');assert.equal((await http('/healthz')).devices,0);pass('actual gateway defaults to token HTTPS without a device CA or client certificate');
 let admin=await post('/auth/login',{username:'gatewayadmin',password});secrets.push(admin.accessToken);
 const issue=async userId=>{const value=await post('/auth/admin/pair-code',{userId},admin.accessToken);secrets.push(value.code);return value.code;};
 const pair=async userId=>{const value=await post('/auth/device/pair',{code:await issue(userId),name:'Gateway protocol fixture'});secrets.push(value.deviceToken);return value;};
 const a=await pair(users[1].id),a2=await pair(users[1].id),b=await pair(users[2].id);
 const bad=await agent(a,{wrongKey:true});assert(!bad.ready);assert.equal(bad.socket.readyState,WebSocket.CLOSED);pass('actual Agent hello rejects a deviceKey that differs from its bearer binding');
 const aa=await agent(a),aa2=await agent(a2),ab=await agent(b);assert(aa.ready&&aa2.ready&&ab.ready);const ua=await ui(a),ua2=await ui(a2),ub=await ui(b);
 for(const client of [ua,ua2,ub]){await client.request('session.initialize',{clientInfo:{name:'token-gateway-protocol-fixture',version:'1'}});workerPids.add((await client.request('model.list')).pid);}
 const health=await http('/healthz');assert.equal(health.devices,3);assert.equal(health.clients,3);assert.equal(workerPids.size,2);pass('token UI and Agent channels use existing gateway routing and separate per-user Workers');
 assert.equal((await ua.request('device.workspace.read_text',{path:'fixture.txt'})).result.content,a.deviceId);assert.equal((await ub.request('device.workspace.read_text',{path:'fixture.txt'})).result.content,b.deviceId);pass('device read requests route to the exact bearer-bound Agent fixture');
 const threadId=(await ua.request('conversation.create')).thread.id;assert(threadId);await ua.request('conversation.resume',{threadId});await assert.rejects(ua2.request('conversation.resume',{threadId}),/REMOTE_WORKSPACE_CHANGED/);await assert.rejects(ub.request('conversation.read',{threadId}));pass('existing Thread ownership and original-device workspace binding remain enforced');
 await assert.rejects(ua.request('test.approval.inject'));await assert.rejects(connect(gateway+'?deviceId='+b.deviceId,a.deviceToken));await assert.rejects(connect(gateway,admin.accessToken),/AUTH_MODE_UNSUPPORTED/);pass('authentication keeps fixture controls disabled and denies URL/session identity substitution');
 const pending=ua.request('device.exec',{program:'never-executed-protocol-fixture',args:[],cwd:'.',timeoutMs:30000}).then(()=>({unexpected:true}),error=>({error:String(error)}));
 await until(()=>aa.messages.some(m=>m.type==='agent.request'&&m.payload.method==='exec'),'pending device request dispatched');
 await post('/auth/device/revoke',{deviceId:a.deviceId},admin.accessToken);await until(()=>ua.socket.readyState===WebSocket.CLOSED&&aa.socket.readyState===WebSocket.CLOSED,'revoked channels close');assert((await pending).error);assert.equal(aa2.socket.readyState,WebSocket.OPEN);assert.equal((await ua2.request('device.workspace.read_text',{path:'fixture.txt'})).result.content,a2.deviceId);await assert.rejects(connect(gateway+'/agent',a.deviceToken),/DEVICE_REVOKED/);pass('revocation closes both channels, fails the outstanding request without replay, and preserves a sibling Agent');
 await post('/auth/admin/user/disable',{userId:users[2].id},admin.accessToken);await until(()=>ub.socket.readyState===WebSocket.CLOSED&&ab.socket.readyState===WebSocket.CLOSED,'disabled user channels close');pass('user disablement removes its active UI and Agent through the real gateway');
 await post('/auth/device/disconnect',{},a2.deviceToken);await until(()=>ua2.socket.readyState===WebSocket.CLOSED&&aa2.socket.readyState===WebSocket.CLOSED,'self-disconnect channels close');await until(async()=>{const h=await http('/healthz');return h.devices===0&&h.clients===0;},'all device channels removed');pass('self disconnect uses the existing gateway lifecycle and leaves no device connection');
 const before=await readFile(stateFile,'utf8'),source=JSON.parse(before);assert.equal(source.users[users[1].id][0].summary.deviceId,a.deviceId);
 await stop(current);current=start({PLATFORM_DEVICE_CA_CONFIG:join(root,'does-not-exist-device-ca.json')});await until(()=>current.log.includes('listening'),'restart ignores irrelevant device CA');
 await assert.rejects(connect(gateway,a.deviceToken),/DEVICE_REVOKED/);await assert.rejects(connect(gateway,b.deviceToken),/AUTH_REQUIRED/);assert.equal(await readFile(stateFile,'utf8'),before);pass('restart preserves revocation and Thread bindings; token mode never reads an inherited device CA path');
 admin=await post('/auth/login',{username:'gatewayadmin',password});secrets.push(admin.accessToken);const replacement=await pair(users[1].id),replacementAgent=await agent(replacement),replacementUi=await ui(replacement);
 await replacementUi.request('session.initialize',{clientInfo:{name:'replacement-protocol-fixture',version:'1'}});workerPids.add((await replacementUi.request('model.list')).pid);await assert.rejects(replacementUi.request('conversation.resume',{threadId}),/REMOTE_WORKSPACE_CHANGED/);assert(replacementAgent.ready);pass('re-pair after restart creates a new device without rewriting old history ownership');
 await post('/auth/device/disconnect',{},replacement.deviceToken);await until(()=>replacementAgent.socket.readyState===WebSocket.CLOSED,'replacement cleanup');await stop(current);
 const sharedFile=join(root,'legacy-shared-state.json'),sharedBytes=JSON.stringify({version:1,users:{[users[1].id]:[{id:threadId,summary:{deviceId:a.deviceId}}]}});await writeFile(sharedFile,sharedBytes);
 const guards=[
  ['shared historical layout still requires explicit migration',{TEST_GATEWAY_STATE_FILE:sharedFile},/WORKER_LAYOUT_MIGRATION_REQUIRED/],
  ['invalid authentication mode fails before listening',{PLATFORM_DEVICE_AUTH_MODE:'typo'},/AUTH_MODE_UNSUPPORTED/],
  ['explicit legacy mode loads and validates its required configured CA',{PLATFORM_DEVICE_AUTH_MODE:'legacy-mtls-v1',PLATFORM_DEVICE_CA_CONFIG:join(root,'missing-legacy-ca.json')},/DEVICE_CA|ENOENT/],
  ['token authentication does not weaken real Worker model prerequisites',{PLATFORM_WORKER_ISOLATION:'',PLATFORM_MODEL_BINDINGS:''},/MODEL_BINDINGS_REQUIRED/],
  ['protocol fixture still refuses a non-loopback listener',{TEST_GATEWAY_HOST:'0.0.0.0'},/WORKER_FIXTURE_REQUIRES_LOOPBACK_NODE/],
  ...(process.platform==='win32'?[['real Windows central Worker remains unsupported',{PLATFORM_WORKER_ISOLATION:'',PLATFORM_MODEL_BINDINGS:join(root,'unused-models.json')},/WORKER_ISOLATION_UNSUPPORTED/]]:[]),
 ];
 for(const [name,extra,expected] of guards){const run=start(extra);await until(()=>run.child.exitCode!==null||run.child.signalCode!==null,name);assert.notEqual(run.child.exitCode,0);assert.match(run.log,expected);assert(!run.log.includes('listening'));pass(name);}
 assert.equal(await readFile(sharedFile,'utf8'),sharedBytes);
 const auditFiles=await readdir(auditDir);const auditText=(await Promise.all(auditFiles.filter(f=>f.endsWith('.jsonl')).map(f=>readFile(join(auditDir,f),'utf8')))).join('');const disk=await readFile(authFile,'utf8'),logs=children.map(r=>r.log).join('');for(const secret of secrets){assert(!auditText.includes(secret));assert(!disk.includes(secret));assert(!logs.includes(secret));}pass('actual gateway audit, persisted identity state and process logs contain no raw code/token/password');
 result={ok:true,root,checks,source:'actual gateway entry + real local TLS; labelled Node App Server and Agent protocol fixtures',centralValidated:false,nativeExecutionValidated:false};
}catch(error){result={ok:false,root,checks,error:String(error.message)};process.exitCode=1;}
finally{
 for(const ws of sockets)ws.terminate();for(const run of children)await stop(run);
 result??={ok:false,root,checks};
 try{await until(()=>[...workerPids].every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'tracked protocol Workers exit without extra process signals');result.cleanupConfirmed=true;}
 catch{result.ok=false;result.cleanupConfirmed=false;result.cleanupError='PROTOCOL_WORKER_EXIT_NOT_CONFIRMED';process.exitCode=1;}
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,checks:checks.length,result:join(root,'result.json'),...(result.error?{error:result.error}:{})}));
}
