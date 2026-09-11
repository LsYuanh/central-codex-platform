// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Windows credential vault + TLS + Agent; local App Server is an explicitly labelled protocol fixture.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import {WebSocket} from 'ws';
import {PlatformAuth} from '../services/test-gateway/dist/platform-auth.js';
import {createDeviceCertificateAuthority,DeviceCertificates} from '../services/test-gateway/dist/device-certificates.js';
const fixture=await mkdtemp(join(tmpdir(),'platform-live-'));const sockets=[],agents=[],namespaces=[];let server;let gatewayLog='';const checks=[],cleanupTokens=[];
const central=process.env.PLATFORM_QA_CENTRAL==='1';
const workerQa=process.env.PLATFORM_WORKER_QA==='1';
const isolatedQa=process.env.PLATFORM_ISOLATION_QA==='1';
const mtlsQa=process.env.PLATFORM_MTLS_QA==='1';
const userA=mtlsQa?'mtlsalice':isolatedQa?'isoalice':process.env.PLATFORM_QA_FINAL==='1'?'finalalice':'alice',userB=mtlsQa?'mtlsbob':isolatedQa?'isobob':process.env.PLATFORM_QA_FINAL==='1'?'finalbob':'bob';
let password='qa-'+randomBytes(20).toString('hex');
let cert=join(fixture,'cert.pem');const key=join(fixture,'key.pem'),config=join(fixture,'openssl.cnf'),serverCert=join(fixture,'server.pem');
if(!central){
await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const openssl=(args)=>{const r=spawnSync(process.env.OPENSSL_BIN??'C:/Program Files/Git/usr/bin/openssl.exe',args,{windowsHide:true});assert.equal(r.status,0,String(r.stderr));};
const rootKey=join(fixture,'ca-key.pem'),csr=join(fixture,'server.csr'),extensions=join(fixture,'server-extensions.cnf');
openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',rootKey,'-out',cert,'-config',config]);
await writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN=localhost']);
openssl(['x509','-req','-in',csr,'-CA',cert,'-CAkey',rootKey,'-set_serial','1','-days','2','-out',serverCert,'-extfile',extensions]);
}
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const localPort=probe.address().port;await new Promise(r=>probe.close(r));const port=central?4529:localPort,host=central?'192.0.2.10':'localhost';const gateway=`wss://${host}:${port}/ws`;
if(central){cert=resolve(mtlsQa?'target/harness-deploy/p5-mtls-server-ca.pem':'target/harness-deploy/p5-central-ca.pem');const read=spawnSync(resolve('target/harness-agent/debug/examples/platform-acceptance.exe'),[],{input:JSON.stringify({namespace:'com.centralcodex.harnessqa.p5.bootstrap',gateway,action:'fixture-get'}),encoding:'utf8',windowsHide:true});assert.equal(read.status,0,read.stderr);password=JSON.parse(read.stdout).data.password;}
const ca=await readFile(cert);
const localUsers=[];
const deviceCa=!central?await createDeviceCertificateAuthority({directory:join(fixture,'device-ca'),protocolFixture:true,...(mtlsQa?{certificateLifetimeSeconds:60,renewBeforeSeconds:40}:{})}):undefined;
const authFile=join(fixture,'auth.json');if(!central){const auth=new PlatformAuth(authFile);localUsers.push(await auth.createUser(userA,password,'admin'),await auth.createUser(userB,password));auth.close();}
await mkdir(join(fixture,'remote-worker'));
await writeFile(join(fixture,'remote-worker','app-server'),`const rl=require('readline').createInterface({input:process.stdin});let n=0;rl.on('line',line=>{const q=JSON.parse(line);if(!q.method)return;let result={};if(q.method==='initialize')result={userAgent:'protocol-fixture yuan-zhou-remote-workspace/1'};if(q.method==='thread/start')result={thread:{id:'p5-thread-'+ ++n}};if(q.method==='thread/read'||q.method==='thread/resume')result={thread:{id:q.params.threadId,turns:[]}};process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');});`);
for(const user of localUsers){const dir=join(fixture,'workers',createHash('sha256').update(user.id).digest('hex'),'runtime');await mkdir(dir,{recursive:true});const code=await readFile(join(fixture,'remote-worker','app-server'),'utf8');await writeFile(join(dir,'app-server'),code.replace("'p5-thread-'+ ++n","'p5-thread-'+process.pid+'-'+ ++n"));}
function start(){server=spawn(process.execPath,[resolve('services/test-gateway/dist/index.js')],{env:{...process.env,CODEX_BIN:process.execPath,PLATFORM_DEVICE_AUTH_MODE:'legacy-mtls-v1',PLATFORM_WORKER_ISOLATION:'protocol-fixture',TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:join(fixture,'state.json'),PLATFORM_AUTH_FILE:authFile,PLATFORM_TLS_CERT:serverCert,PLATFORM_TLS_KEY:key,PLATFORM_DEVICE_CA_CONFIG:deviceCa.configFile},windowsHide:true,stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>gatewayLog+=d);server.stderr.on('data',d=>gatewayLog+=d);}
const until=async(fn,label,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw Error(`Timed out: ${label}; ${gatewayLog.slice(-1000)}`);};
function post(path,body={},token){return new Promise((resolve,reject)=>{const req=https.request(`https://${host}:${port}${path}`,{method:'POST',ca,agent:false,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const v=JSON.parse(raw);if(v.ok){if(path==='/auth/login')cleanupTokens.push(v.data.accessToken);resolve(v.data);}else reject(Error(v.error));}catch(e){reject(e);}});});req.on('error',reject);req.end(JSON.stringify(body));});}
const acceptanceBinary=resolve('target/harness-agent/debug/examples/platform-acceptance.exe');
function native(namespace,action,extra={}){return new Promise((resolve,reject)=>{const child=spawn(acceptanceBinary,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(Error(`native ${action} failed: ${err}`));try{resolve(JSON.parse(out).data);}catch(e){reject(e);}});child.stdin.end(JSON.stringify({namespace,gateway,ca:cert,action,username:namespace.endsWith('.a')?userA:userB,password,name:namespace,...extra}));});}
function connect(token,deviceId,suffix=''){return new Promise((resolve,reject)=>{const socket=new WebSocket(`${gateway}?deviceId=${deviceId}${suffix}`,{ca,headers:{Authorization:'Bearer '+token}});sockets.push(socket);const events=[],pending=new Map();socket.on('message',raw=>{const m=JSON.parse(String(raw));events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);});socket.on('error',reject);socket.on('close',()=>{for(const done of pending.values())done({ok:false,error:'connection closed'});pending.clear();});socket.once('open',()=>resolve({socket,events,request:(operation,payload={})=>new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error(operation+' timeout'));},Math.max(20000,(payload.timeoutMs??0)+10000));pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?resolve(m.data):reject(Error(m.error));});socket.send(JSON.stringify({type:'request',requestId,operation,payload}));})}));});}
const record=name=>{checks.push(name);console.log('PASS '+name);};
function getAdmin(path,token){return new Promise((resolve,reject)=>{const req=https.get(`https://${host}:${port}${path}`,{ca,agent:false,headers:{Authorization:'Bearer '+token}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const v=JSON.parse(raw);if(!v.ok)throw Error(v.error);resolve(v);}catch(e){reject(e);}});});req.on('error',reject);});}
function control(action,userId=''){
 assert(central&&workerQa);assert(['crash-user','stop','start-workers','start-isolated','start-mtls','model-disable','model-enable'].includes(action));if(userId)assert(/^[a-f0-9-]{36}$/.test(userId));
 const result=spawnSync('ssh.exe',['-i','C:/Users/developer/.ssh/id_ed25519','-o','BatchMode=yes','operator@192.0.2.10',`/Users/operator/central-codex-platform/artifacts/macos-tools/node/bin/node /Users/operator/central-harness-qa-20260909/qa-control.mjs ${action} ${userId}`],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
try{
 if(!central){start();await until(()=>gatewayLog.includes('listening'),'TLS gateway ready');}
 await assert.rejects(new Promise((resolve,reject)=>{const request=https.get(`https://${host}:${port}/healthz`,resolve);request.on('error',reject);}),/certificate|self.signed/i);record('untrusted TLS rejected');
 const prefix='com.centralcodex.harnessqa.p5.'+randomUUID();namespaces.push(prefix+'.a',prefix+'.b');
 await writeFile(join(fixture,'public-cleanup-manifest.json'),JSON.stringify({gateway,namespaces,ca:cert},null,2));
 await assert.rejects(native(namespaces[0],'setup',{ca:''}),/TLS/);record('native TLS rejects untrusted central certificate before login');
 const a=await native(namespaces[0],'setup'),b=await native(namespaces[1],'setup');record('native vault login and device pairing for two users');
 let la=await post('/auth/login',{username:userA,password}),lb=await post('/auth/login',{username:userB,password});
 if(mtlsQa){
   // Disposable adversarial probe keys, unrelated to either native device. No private
   // probe key is sent to the server or written to disk; product keys stay in the vault.
   const ed=generateKeyPairSync('ed25519'),tls=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{format:'der',type:'spki'},privateKeyEncoding:{format:'pem',type:'pkcs8'}});
   const code=(await post('/auth/pair-code',{},la.accessToken)).code;
   const probeDevice=await post('/auth/pair',{code,name:'Disposable mTLS admission probe',publicKey:ed.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),tlsPublicKey:tls.publicKey.toString('base64')},la.accessToken);
   try{
     const attempt=async certificate=>{
       const challenge=await post('/auth/device/challenge',{sessionId:la.sessionId,deviceId:probeDevice.deviceId});
       const ticket=(await post('/auth/device/prove',{nonce:challenge.nonce,signature:sign(null,Buffer.from(challenge.message),ed.privateKey).toString('base64')})).ticket;
       return new Promise((resolve,reject)=>{const socket=new WebSocket(gateway.replace('/ws','/ws/agent')+'?deviceId='+probeDevice.deviceId,{ca,handshakeTimeout:10000,...(certificate?{cert:certificate,key:tls.privateKey}:{}),headers:{Authorization:'Bearer '+ticket}});sockets.push(socket);socket.once('open',()=>{socket.close();resolve();});socket.once('error',reject);});
     };
     await assert.rejects(attempt(undefined));
     const foreign=await createDeviceCertificateAuthority({directory:join(fixture,'foreign-device-ca'),protocolFixture:true});
     const foreignIssuer=await DeviceCertificates.load({configFile:foreign.configFile,protocolFixture:true});
     const forged=await foreignIssuer.issue({deviceId:probeDevice.deviceId,userId:a.userId,tlsPublicKey:tls.publicKey.toString('base64')});
     await assert.rejects(attempt(forged.pem));
     record('target gateway denies missing and forged mTLS certificate even with valid signed device tickets');
   }finally{await post('/auth/device/revoke',{deviceId:probeDevice.deviceId},la.accessToken);}
 }
 await assert.rejects(connect(la.accessToken,a.deviceId,'&userId='+b.userId));await assert.rejects(connect(lb.accessToken,a.deviceId));record('WSS rejects forged identity and foreign device');
 assert.equal((await post('/auth/me',{},la.accessToken)).user.id,a.userId);assert((await post('/auth/devices',{},la.accessToken)).devices.some(d=>d.id===a.deviceId));
 let ua=await connect(la.accessToken,a.deviceId),ub=await connect(lb.accessToken,b.deviceId);
 for(const u of [ua,ub])await u.request('session.initialize',{clientInfo:{name:'p5-fixture',version:'1'}});
 for(const [i,d] of [a,b].entries()){
   const root=join(fixture,i?'client-b':'client-a');await mkdir(root);await writeFile(join(root,'marker.txt'),i?'CLIENT_B':'CLIENT_A');
   const child=spawn(resolve('target/harness-agent/debug/local-agent.exe'),['--workspace-root',root,'--gateway-url',`${gateway.replace('/ws','/ws/agent')}?deviceId=${d.deviceId}`,'--attachment-stdio','--allow-insecure-lan'],{env:{...process.env,YUAN_PLATFORM_NAMESPACE:namespaces[i],YUAN_PLATFORM_CA:cert},windowsHide:true,stdio:['pipe','pipe','pipe']});agents.push(child);child.stdout.resume();child.stderr.on('data',d=>gatewayLog+=d);
 }
 for(const u of [ua,ub])await until(async()=>{try{return(await u.request('device.workspace.context')).ok;}catch{return false;}},'paired Agent ready');
 assert.equal((await ua.request('device.workspace.read_text',{path:'marker.txt'})).result.content,'CLIENT_A');assert.equal((await ub.request('device.workspace.read_text',{path:'marker.txt'})).result.content,'CLIENT_B');record('real Agent files remain on their own devices');
 if(mtlsQa){
   const before=await native(namespaces[0],'certificate-status');assert.equal(before.state,'valid');
   const duration=Math.max(15000,before.expiresAt-Date.now()+2000),startEvents=ua.events.length;
   const commandSource="require('fs').writeFileSync('renewal.pid',String(process.pid));setTimeout(()=>{require('fs').writeFileSync('renewal.done','DONE');console.log('RENEWAL_DONE')},"+duration+")";
   const running=ua.request('device.exec',{program:process.execPath,args:['-e',commandSource],timeoutMs:duration+15000}).catch(error=>({error:String(error)}));
   await until(async()=>{try{await access(join(fixture,'client-a','renewal.pid'));return true;}catch{return false;}},'actual Windows command before automatic renewal');
   await until(async()=>{const next=await native(namespaces[0],'certificate-status');return next.expiresAt>before.expiresAt;},'native Agent renews through mTLS and saves public cert in system vault',150000);
   record('native Agent automatically renews certificate during a Windows command');
   await running;assert.equal(await readFile(join(fixture,'client-a','renewal.done'),'utf8'),'DONE');assert(Date.now()>before.expiresAt);
   assert(!ua.events.slice(startEvents).some(e=>e.type==='device.status'&&e.agent==='offline'));
   assert.equal((await ub.request('device.workspace.read_text',{path:'marker.txt'})).result.content,'CLIENT_B');
   record('Windows command completes across original certificate expiry without Agent disconnect; other device remains online');
 }
 const thread=(await ua.request('conversation.create')).thread.id;
 for(const op of ['conversation.read','conversation.resume','conversation.archive','conversation.delete','conversation.rename','conversation.turn.cancel','conversation.message.status'])await assert.rejects(ub.request(op,{threadId:thread,name:'intrusion',clientMessageId:'x'}));
 const listed=await ub.request('conversation.list');assert(!JSON.stringify(listed).includes(thread));record('cross-user Thread access and mutations denied');
 if(central){
   const patch='*** Begin Patch\n*** Add File: approval.txt\n+ONLY_ALICE_APPROVED\n*** End Patch';
   const turn=(await ua.request('conversation.turn.create',{threadId:thread,clientMessageId:randomUUID(),input:[{type:'text',text:`Authorized isolated authentication acceptance: use device_workspace_apply_patch exactly once with this exact patch, then finish. Do not use other tools or retry.\n${patch}`}]})).turn.id;
   await until(()=>{const terminal=ua.events.find(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turn);if(terminal?.data?.turn?.status==='failed')throw Error('Model terminal failed before approval: '+JSON.stringify(terminal.data.turn.error));return ua.events.some(e=>e.type==='approval.request');},'real model patch approval',120000);
   const approval=ua.events.find(e=>e.type==='approval.request');assert.equal(approval.data.deviceId,a.deviceId);assert(!ub.events.some(e=>e.type==='approval.request'));
   ub.socket.send(JSON.stringify({type:'approval.response',requestId:approval.requestId,result:{decision:'accept'}}));
   await new Promise(r=>setTimeout(r,300));await assert.rejects(access(join(fixture,'client-a','approval.txt')));
   ua.socket.send(JSON.stringify({type:'approval.response',requestId:approval.requestId,result:{decision:'accept'}}));
   await until(()=>ua.events.some(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turn),'real model completion',120000);
   assert.equal(await readFile(join(fixture,'client-a','approval.txt'),'utf8'),'ONLY_ALICE_APPROVED\n');
   assert(!ub.events.some(e=>JSON.stringify(e).includes(thread)));record('real model approval and events stay with owner; forged approval cannot write');
 }
 if(workerQa&&central){
   const initial=(await getAdmin('/workers',la.accessToken)).workers;const aw=initial.find(w=>w.userId===a.userId),bw=initial.find(w=>w.userId===b.userId);
   assert(aw?.ready&&bw?.ready);assert.notEqual(aw.pid,bw.pid);await assert.rejects(getAdmin('/workers',lb.accessToken),/NOT_FOUND/);await assert.rejects(getAdmin('/audit',lb.accessToken),/NOT_FOUND/);record('distinct real central worker PIDs; worker and audit views admin-only');
   const tb=(await ub.request('conversation.create')).thread.id,ta2=(await ua.request('conversation.create')).thread.id;
   const command=(label,ms)=>({program:process.execPath,args:['-e',`require('fs').writeFileSync('${label}.pid',String(process.pid));setTimeout(()=>{require('fs').writeFileSync('${label}.done','DONE');console.log('${label}_DONE')},${ms})`],timeoutMs:60000});
   const prompt=(label,ms)=>`Authorized worker-isolation QA: call device_exec exactly once with this exact JSON, wait for its result and then reply with the completion marker. Do not use other tools or repeat the command. ${JSON.stringify(command(label,ms))}`;
   const [turnA,turnB]=await Promise.all([ua.request('conversation.turn.create',{threadId:thread,clientMessageId:randomUUID(),input:[{type:'text',text:prompt('worker-a',45000)}]}),ub.request('conversation.turn.create',{threadId:tb,clientMessageId:randomUUID(),input:[{type:'text',text:prompt('worker-b',30000)}]})]);
   await until(async()=>{try{await access(join(fixture,'client-a','worker-a.pid'));await access(join(fixture,'client-b','worker-b.pid'));return true;}catch{return false;}},'both real worker commands running',90000);
   const quotaId=randomUUID();await assert.rejects(ua.request('conversation.turn.create',{threadId:ta2,clientMessageId:quotaId,input:[{type:'text',text:'must not start while quota full'}]}),/TURN_LIMIT/);
   assert.equal((await ua.request('conversation.message.status',{threadId:ta2,clientMessageId:quotaId})).status,'failed');record('two users run concurrently; over-quota submission fails without unknown-state lock');
   const beforeB=ub.events.length,killed=control('crash-user',a.userId);assert.equal(killed.pid,aw.pid);
   await until(()=>ua.events.some(e=>e.eventType==='gateway.runtime_unavailable'),'owner receives worker failure');
   const commandPid=Number(await readFile(join(fixture,'client-a','worker-a.pid'),'utf8'));await until(()=>{try{process.kill(commandPid,0);return false;}catch{return true;}},'failed worker cancels only its actual client command');
   await until(()=>ub.events.some(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turnB.turn.id),'other real worker completes',90000);
   assert.equal(await readFile(join(fixture,'client-b','worker-b.done'),'utf8'),'DONE');await assert.rejects(access(join(fixture,'client-a','worker-a.done')));
   assert(!ub.events.slice(beforeB).some(e=>e.eventType==='gateway.runtime_unavailable'));assert.equal((await getAdmin('/workers',la.accessToken)).workers.find(w=>w.userId===b.userId).pid,bw.pid);record('one worker crash cancels its Windows command; other worker completes with same PID');
   await until(async()=>{try{await ua.request('session.initialize',{clientInfo:{name:'worker-recovery',version:'1'}});return true;}catch{return false;}},'owner worker recreated');
   assert.notEqual((await getAdmin('/workers',la.accessToken)).workers.find(w=>w.userId===a.userId).pid,aw.pid);
   const recovered=await ua.request('conversation.resume',{threadId:thread});assert.equal(recovered.thread.id,thread);assert(JSON.stringify(recovered).includes('ONLY_ALICE_APPROVED'));await assert.rejects(ub.request('conversation.read',{threadId:thread}));
   assert.equal(await readFile(join(fixture,'client-a','worker-a.pid'),'utf8'),String(commandPid));await assert.rejects(access(join(fixture,'client-a','worker-a.done')));record('worker recreation restores own history and preserves no-replay boundary');
   const auditBefore=(await getAdmin('/audit',la.accessToken)).events;assert(auditBefore.some(e=>e.action==='worker.quota'&&e.userId===a.userId));assert(auditBefore.some(e=>e.action==='worker.exit'&&e.userId===a.userId));
   const survivor=auditBefore.find(e=>e.action==='auth.login'&&e.status==='succeeded').id;
   ua.socket.terminate();ub.socket.terminate();control('stop');control(mtlsQa?'start-mtls':isolatedQa?'start-isolated':'start-workers');
   la=await post('/auth/login',{username:userA,password});lb=await post('/auth/login',{username:userB,password});
   const auditAfter=(await getAdmin('/audit',la.accessToken)).events;assert(auditAfter.some(e=>e.id===survivor));assert(!JSON.stringify(auditAfter).includes(password));assert(!JSON.stringify(auditAfter).includes(la.accessToken));
   ua=await connect(la.accessToken,a.deviceId);ub=await connect(lb.accessToken,b.deviceId);for(const u of [ua,ub])await u.request('session.initialize',{clientInfo:{name:'worker-restarted-gateway',version:'1'}});
   for(const u of [ua,ub])await until(async()=>{try{return(await u.request('device.workspace.context')).ok;}catch{return false;}},'Agents reconnect after gateway restart');
   assert.equal((await ua.request('conversation.resume',{threadId:thread})).thread.id,thread);record('gateway restart retains audit IDs and per-user history without replay');
 }
 if(isolatedQa&&central){
   const tBob=(await ub.request('conversation.create')).thread.id;
   const beforeB=(await getAdmin('/workers',la.accessToken)).workers.find(w=>w.userId===b.userId).pid;
   const command={program:process.execPath,args:['-e',"require('fs').writeFileSync('isolation-b.pid',String(process.pid));setTimeout(()=>{require('fs').writeFileSync('isolation-b.done','DONE');console.log('ISOLATION_B_DONE')},15000)"],timeoutMs:40000};
   const runB=await ub.request('conversation.turn.create',{threadId:tBob,clientMessageId:randomUUID(),input:[{type:'text',text:`Authorized QA: execute device_exec once with exact JSON ${JSON.stringify(command)} then wait and report completion; no repeat or other tools.`}]});
   await until(async()=>{try{await access(join(fixture,'client-b','isolation-b.pid'));return true;}catch{return false;}},'Bob command before model access revocation',90000);
   const beforeA=ua.events.length;control('model-disable',a.userId);
   await until(async()=>(await getAdmin('/model-access',la.accessToken)).modelAccess.status==='disabled','Alice model access disabled');
   await until(()=>ua.events.slice(beforeA).some(e=>e.eventType==='gateway.runtime_unavailable'),'revoked lease stops owner worker');
   await assert.rejects(ua.request('session.initialize',{clientInfo:{name:'disabled-model-probe',version:'1'}}),/MODEL_CREDENTIAL_DISABLED|WORKER_STOPPING|WORKER_RESTART_BACKOFF/);
   assert.equal((await getAdmin('/model-access?userId='+b.userId,la.accessToken)).modelAccess.status,'disabled');
   record('model access disabled for owner; query cannot inspect another user; initialization fails explicitly');
   await until(()=>ub.events.some(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===runB.turn.id),'Bob completes while Alice disabled',90000);
   assert.equal(await readFile(join(fixture,'client-b','isolation-b.done'),'utf8'),'DONE');
   assert.equal((await getAdmin('/workers',la.accessToken)).workers.find(w=>w.userId===b.userId).pid,beforeB);
   record('revoking one model lease leaves other real model and Windows command running');
   control('model-enable',a.userId);
   await until(async()=>{try{await ua.request('session.initialize',{clientInfo:{name:'model-access-restored',version:'1'}});return true;}catch{return false;}},'fresh Worker after restored model access');
   assert.equal((await ua.request('conversation.resume',{threadId:thread})).thread.id,thread);
   const recovered=await ua.request('conversation.turn.create',{threadId:thread,clientMessageId:randomUUID(),input:[{type:'text',text:'Use device_workspace_read_text to read marker.txt exactly once and report its contents. Do not modify files or rerun any previous command.'}]});
   await until(()=>ua.events.some(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===recovered.turn.id),'restored owner model completes',90000);
   assert.equal(ua.events.find(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===recovered.turn.id).data.turn.status,'completed');
   await assert.rejects(access(join(fixture,'client-a','worker-a.done')));
   record('restored model binding creates a new lease, resumes own history and completes without replay');
   const audit=(await getAdmin('/audit',la.accessToken)).events;
   assert(audit.some(e=>e.action==='model.request'&&e.userId===a.userId));assert(!JSON.stringify(audit).includes(password));
   record('model proxy use is durably audited with user identity and no platform credentials');
 }
 const execution=ua.request('device.exec',{program:process.execPath,args:['-e',"require('fs').writeFileSync('run.pid',String(process.pid));setTimeout(()=>require('fs').writeFileSync('finished','bad'),30000)"],timeoutMs:60000}).catch(error=>({error:String(error)}));
 await until(async()=>{try{await access(join(fixture,'client-a','run.pid'));return true;}catch{return false;}},'client command running');
 await post('/auth/device/revoke',{deviceId:a.deviceId},la.accessToken);
 await until(()=>ua.socket.readyState===WebSocket.CLOSED,'revoked UI disconnected');
 const response=await execution.catch(e=>({error:String(e)}));assert(response.ok!==true);
 const pid=Number(await readFile(join(fixture,'client-a','run.pid'),'utf8'));
 await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}},'revocation cancels client process');
 assert.equal((await ub.request('device.workspace.read_text',{path:'marker.txt'})).result.content,'CLIENT_B');record('revocation stops actual process without affecting other user');
 await native(namespaces[1],'logout');await until(()=>ub.events.some(e=>e.type==='device.status'&&e.agent==='offline'),'native logout');
 await assert.rejects(post('/auth/device/challenge',{sessionId:b.sessionId,deviceId:b.deviceId}),/AUTH_REQUIRED/);record('native logout revokes device session');
 if(!central){const disk=await readFile(authFile,'utf8');assert(!disk.includes(password));assert(!disk.includes(la.accessToken));record('no plaintext credentials in server state');}
 await writeFile(join(fixture,'result.json'),JSON.stringify({ok:true,source:central?'real-central-Rust-TLS-native-vault-Windows-Agent':'real-TLS-native-vault-Windows-Agent-with-labelled-App-Server-fixture',checks,fixture},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,fixture}));
}catch(error){console.error(JSON.stringify({ok:false,fixture,checks,error:String(error),gatewayLog:gatewayLog.slice(-2500)}));throw error;}finally{
 for(const socket of sockets)socket.terminate();for(const agent of agents)agent.kill();
 for(const ns of namespaces){await native(ns,'logout').catch(()=>undefined);await native(ns,'cleanup').catch(()=>undefined);}
 for(const token of cleanupTokens)await post('/auth/logout',{},token).catch(()=>undefined);
 server?.kill();
}
