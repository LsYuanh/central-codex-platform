// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real TLS + PlatformAuth HTTP/WebSocket fixture; no Worker, model or Local Agent.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { PlatformAuth } from '../../services/central-gateway/dist/platform-auth.js';
import { createModelPipeTls } from '../../services/central-gateway/dist/model-pipe-tls.js';
import { protectSyntheticFixture } from './windows-private-fixture.mjs';

const localDev=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const parent=path.join(localDev,'target','central-p0');mkdirSync(parent,{recursive:true});
const fixture=realpathSync(mkdtempSync(path.join(parent,'central-people-')));
protectSyntheticFixture(fixture);
const stateFile=path.join(fixture,'platform-auth.json');
const checks=[],audits=[],clients=new Set(),presence=new Map();
const password=`People_QA_${randomBytes(24).toString('base64url')}`;
const tls=await createModelPipeTls(Date.now()+600000);
let auth,server,wss,port,adminToken;
const check=(value,code)=>assert(value,`QA_${code}`);
const bounded=async(promise,ms=8000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('QA_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(route,input={},token=adminToken){
  return bounded(new Promise((resolve,reject)=>{
    const payload=Buffer.from(JSON.stringify(input));
    const req=https.request({host:'127.0.0.1',port,servername:'model-broker.invalid',ca:tls.certificatePem,agent:false,path:route,method:'POST',headers:{'content-type':'application/json','content-length':payload.length,...(token?{authorization:`Bearer ${token}`}:{})}},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;if(text.length>256*1024){res.destroy();reject(Error('QA_RESPONSE_LIMIT'));}});
      res.once('end',()=>{try{resolve(JSON.parse(text));}catch{reject(Error('QA_RESPONSE_INVALID'));}});res.once('error',()=>reject(Error('QA_HTTP_FAILED')));
    });req.once('error',()=>reject(Error('QA_HTTP_FAILED')));req.setTimeout(6000,()=>req.destroy());req.end(payload);
  }));
}
async function ok(route,input,token){const result=await request(route,input,token);check(result.ok===true,`HTTP_${route.replace(/[^A-Za-z]/g,'_').toUpperCase()}`);return result.data;}
async function denied(route,input,code,token){const result=await request(route,input,token);check(result.ok===false&&result.error===code,'EXPECTED_REJECTION');}
async function start(){
  auth=new PlatformAuth(stateFile);
  auth.setAudit((action,status,userId,errorCode)=>audits.push({action,status,userId,errorCode}));
  auth.setDevicePresence(id=>presence.get(id)??{online:false,lastSeenAt:null});
  server=https.createServer(tls.options,(req,res)=>{void auth.http(req,res);});
  wss=new WebSocketServer({noServer:true,maxPayload:4096});
  server.on('upgrade',(req,socket,head)=>{
    try{const principal=auth.upgrade(req,'agent');wss.handleUpgrade(req,socket,head,ws=>{
      auth.track(ws,principal);
      ws.on('message',bytes=>{if(bytes.toString()!==JSON.stringify({method:'protocolAgent/ready'})){ws.close(1008);return;}presence.set(principal.deviceId,{online:true,lastSeenAt:Date.now()});ws.send(JSON.stringify({method:'protocolAgent/accepted'}));});
      ws.once('close',()=>presence.set(principal.deviceId,{online:false,lastSeenAt:Date.now()}));
    });}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;check(port!==4510,'FORMAL_PORT_FORBIDDEN');
}
async function stop(){
  for(const ws of clients)ws.terminate();clients.clear();
  auth?.close();await new Promise(resolve=>wss?.close(resolve));await new Promise(resolve=>server?.close(resolve));presence.clear();
}
async function connectDevice(deviceToken){
  const ws=new WebSocket(`wss://127.0.0.1:${port}/ws/agent`,{servername:'model-broker.invalid',ca:tls.certificatePem,headers:{authorization:`Bearer ${deviceToken}`}});clients.add(ws);ws.on('error',()=>{});
  await bounded(once(ws,'open'));const accepted=once(ws,'message');ws.send(JSON.stringify({method:'protocolAgent/ready'}));await bounded(accepted);return ws;
}
async function pair(userId,requestId){const code=await ok('/auth/admin/pair-code',{userId,requestId});return ok('/auth/device/pair',{code:code.code,name:'Synthetic protocolAgent'},null);}
try{
  await start();await auth.createUser('qa_admin',password,'admin');
  const firstLogin=await ok('/auth/login',{username:'qa_admin',password},null);adminToken=firstLogin.accessToken;
  const concurrent=await Promise.all([ok('/auth/admin/user/create-pairing',{requestId:'create-1',username:'person_one'}),ok('/auth/admin/user/create-pairing',{requestId:'create-1',username:'person_one'})]);
  const user=concurrent[0];check(user.id===concurrent[1].id&&user.loginMode==='pairing-only'&&user.role==='user','PAIRING_USER_IDEMPOTENT');
  await denied('/auth/admin/user/create-pairing',{requestId:'create-1',username:'person_other'},'REQUEST_ID_CONFLICT');
  await denied('/auth/admin/user/create-pairing',{requestId:'create-2',username:'person_one'},'INVALID_OR_EXISTING_ACCOUNT');
  await denied('/auth/admin/user/create-pairing',{requestId:'create-3',username:'person_other',password},'INVALID_INPUT');
  await denied('/auth/admin/user/create-pairing',{username:'missing_id'},'INVALID_INPUT');
  const stored=JSON.parse(readFileSync(stateFile,'utf8')).users.find(u=>u.id===user.id);
  check(stored.authType==='pairing-only'&&!Object.hasOwn(stored,'salt')&&!Object.hasOwn(stored,'passwordHash'),'NO_PLACEHOLDER_PASSWORD');
  check(!readFileSync(stateFile,'utf8').includes(password),'NO_PLAINTEXT_PASSWORD');checks.push('pairing-only-user-no-placeholder-password-concurrent-idempotency-and-strict-fields');
  await stop();await start();
  adminToken=(await ok('/auth/login',{username:'qa_admin',password},null)).accessToken;
  const users=await ok('/auth/admin/users');check(users.users.some(u=>u.id===user.id&&u.loginMode==='pairing-only'&&u.online===false&&u.lastSeenAt===null),'PERSISTED_USER');
  await denied('/auth/login',{username:'person_one',password},'INVALID_LOGIN',null);checks.push('restart-persistence-and-pairing-only-password-login-denied');
  const first=await ok('/auth/admin/pair-code',{userId:user.id,requestId:'pair-1'}),retry=await ok('/auth/admin/pair-code',{userId:user.id,requestId:'pair-1'});
  check(first.code===retry.code&&first.expiresIn===300&&first.expiresAt>Date.now(),'PAIR_CODE_IDEMPOTENT_TTL');
  const second=await ok('/auth/admin/pair-code',{userId:user.id,requestId:'pair-2'});
  await denied('/auth/device/pair',{code:first.code,name:'old'},'INVALID_PAIR_CODE',null);
  await denied('/auth/admin/pair-code',{userId:user.id,requestId:'pair-1'},'REQUEST_EXPIRED');
  const device=await ok('/auth/device/pair',{code:second.code,name:'Synthetic protocolAgent'},null);
  await denied('/auth/device/pair',{code:second.code,name:'reuse'},'INVALID_PAIR_CODE',null);
  await denied('/auth/admin/pair-code',{userId:user.id,requestId:'pair-2'},'REQUEST_EXPIRED');
  checks.push('pair-code-single-use-reissue-revocation-and-stale-request-rejection');
  for(const [route,payload]of [['/auth/admin/users',{}],['/auth/admin/devices',{}],['/auth/admin/user/create-pairing',{requestId:'forbidden',username:'forbidden_user'}],['/auth/admin/user/create',{username:'forbidden_user',password}],['/auth/admin/user/disable',{userId:user.id}],['/auth/admin/pair-code',{userId:user.id}]])await denied(route,payload,'NOT_FOUND',device.deviceToken);
  const peer=await pair(user.id,'pair-peer');await denied('/auth/device/revoke',{deviceId:peer.deviceId},'NOT_FOUND',device.deviceToken);
  checks.push('device-token-denied-all-admin-routes-and-other-device-revocation');
  let ws=await connectDevice(device.deviceToken);
  let listed=await ok('/auth/admin/devices',{userId:user.id});let row=listed.devices.find(d=>d.id===device.deviceId);
  check(row.online===true&&Number.isFinite(row.lastSeenAt)&&row.userId===user.id&&row.authMode==='device-token-v1','ONLINE_FROM_PROTOCOL_AGENT');
  const closed=once(ws,'close');await ok('/auth/device/revoke',{deviceId:device.deviceId,requestId:'revoke-1'});await bounded(closed);
  await denied('/auth/device/status',{},'DEVICE_REVOKED',device.deviceToken);
  check((await ok('/auth/admin/devices')).devices.find(d=>d.id===device.deviceId).online===false,'REVOKED_OFFLINE');
  await ok('/auth/device/revoke',{deviceId:device.deviceId,requestId:'revoke-1'});checks.push('presence-reader-and-revoke-immediate-token-invalidation-and-protocolAgent-close');
  ws=await connectDevice(peer.deviceToken);const closedDisabled=once(ws,'close');const pending=await ok('/auth/admin/pair-code',{userId:user.id,requestId:'pending-disable'});
  await ok('/auth/admin/user/disable',{userId:user.id,requestId:'disable-1'});await bounded(closedDisabled);
  await denied('/auth/device/status',{},'AUTH_REQUIRED',peer.deviceToken);
  await denied('/auth/device/pair',{code:pending.code,name:'disabled'},'INVALID_PAIR_CODE',null);
  const disabled=(await ok('/auth/admin/users')).users.find(u=>u.id===user.id);check(disabled.disabled&&disabled.online===false,'DISABLED_OFFLINE');
  await ok('/auth/admin/user/disable',{userId:user.id,requestId:'disable-1'});checks.push('disable-immediate-token-invalidation-protocolAgent-close-and-pair-code-revocation');
  const logoutUser=await ok('/auth/admin/user/create-pairing',{requestId:'create-logout',username:'person_logout'});
  const logoutPair=await ok('/auth/admin/pair-code',{requestId:'pair-logout',userId:logoutUser.id});
  await ok('/auth/logout');await denied('/auth/device/pair',{code:logoutPair.code,name:'after logout'},'INVALID_PAIR_CODE',null);
  adminToken=(await ok('/auth/login',{username:'qa_admin',password},null)).accessToken;
  const principal=auth.bearer(`Bearer ${adminToken}`),expiring=auth.adminPairCode(principal,logoutUser.id),realNow=Date.now;
  try{Date.now=()=>expiring.expiresAt+1;let rejected=false;try{auth.pairDeviceToken(expiring.code,'expired');}catch(error){rejected=error.message==='INVALID_PAIR_CODE';}check(rejected,'PAIR_EXPIRY');}finally{Date.now=realNow;}
  checks.push('issuer-logout-and-five-minute-expiry-invalidate-pair-codes');
  const managed=await ok('/auth/admin/login',{username:'qa_admin',password},null);
  await denied('/auth/admin/login',{username:'qa_admin',password,scope:'central-admin'},'INVALID_INPUT',null);
  await denied('/auth/admin/login',{username:'qa_admin',password:'wrong-password'},'INVALID_LOGIN',null);
  await ok('/auth/me',{},managed.accessToken);
  const refreshed=await ok('/auth/refresh',{refreshToken:managed.refreshToken},null);
  const replacement=await ok('/auth/admin/login',{username:'qa_admin',password},null);
  await denied('/auth/me',{},'AUTH_REQUIRED',refreshed.accessToken);
  await ok('/auth/me',{},adminToken);await ok('/auth/me',{},replacement.accessToken);
  const scopedPath=path.join(fixture,'scope-auth.json'),scoped=new PlatformAuth(scopedPath,86400_000),clock=Date.now,base=clock();
  try{
    await scoped.createUser('scope_admin',password,'admin');
    const ordinary=await scoped.login('scope_admin',password,'synthetic');
    let prior;
    for(let i=0;i<12;i++){
      Date.now=()=>base+(i+1)*61000; // Age the documented login rate window, not password checks.
      const next=await scoped.login('scope_admin',password,'synthetic',true);
      if(prior){let rejected=false;try{scoped.bearer(`Bearer ${prior.accessToken}`);}catch{rejected=true;}check(rejected,'OLD_MANAGEMENT_SESSION_RETIRED');}
      prior=next;
    }
    check(scoped.valid(scoped.bearer(`Bearer ${ordinary.accessToken}`)),'ORDINARY_SESSION_PRESERVED');
    const sessions=JSON.parse(readFileSync(scopedPath,'utf8')).sessions;
    check(sessions.filter(s=>s.scope==='central-admin').length===1&&sessions.filter(s=>s.scope===undefined).length===1,'SCOPED_SESSION_CAPACITY');
  }finally{Date.now=clock;scoped.close();}
  checks.push('admin-login-password-before-session-retirement-refresh-scope-and-twelve-management-restarts');
  check(audits.some(a=>a.action==='auth.admin.user.create-pairing'&&a.status==='succeeded')&&audits.some(a=>a.action==='auth.admin.user.disable'&&a.status==='succeeded')&&audits.some(a=>a.action==='auth.admin.users'&&a.status==='failed'),'AUDITED_MANAGEMENT');
  const result={passed:true,scope:'PlatformAuth real TLS HTTP and protocolAgent WebSocket fixture',checks,protocolAgent:true,realLocalAgent:false,realGatewayProcess:false,realCredentialsUsed:false,modelCalls:0,formal4510Modified:false};
  writeFileSync(path.join(fixture,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,resultFile:path.join(fixture,'result.json')},null,2));
}catch(error){
  const code=/^QA_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'QA_PEOPLE_SMOKE_FAILED';
  const result={passed:false,code,checks};writeFileSync(path.join(fixture,'failure.json'),JSON.stringify(result,null,2));console.error(JSON.stringify({...result,resultFile:path.join(fixture,'failure.json')}));process.exitCode=1;
}finally{await stop();if(Buffer.isBuffer(tls.options.key))tls.options.key.fill(0);}
