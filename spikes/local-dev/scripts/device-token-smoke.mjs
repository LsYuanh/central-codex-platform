// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real HTTPS/WSS and persistent auth state. No model, native vault, or remote host.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import https from 'node:https';
import {WebSocket,WebSocketServer} from 'ws';
import {PlatformAuth} from '../services/test-gateway/dist/platform-auth.js';

await mkdir(resolve('target'),{recursive:true});
const root=await mkdtemp(resolve('target/device-token-smoke-')),checks=[],sockets=[],audit=[];
const path=join(root,'auth.json'),cert=join(root,'server.pem'),key=join(root,'server-key.pem'),config=join(root,'openssl.cnf');
await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const generated=spawnSync(process.env.OPENSSL_BIN??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl'),['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',cert,'-config',config],{windowsHide:true});
assert.equal(generated.status,0,'Synthetic TLS certificate generation failed');
const serverCa=await readFile(cert),password=randomBytes(32).toString('base64url');
let auth=new PlatformAuth(path,undefined,60_000,'device-token-v1');
const attachAudit=()=>auth.setAudit((action,status,userId,errorCode)=>audit.push({action,status,userId,errorCode}));attachAudit();
const server=https.createServer({cert:serverCa,key:await readFile(key),minVersion:'TLSv1.2'},(req,res)=>void auth.http(req,res));
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{
  try{const p=auth.upgrade(req,req.url.startsWith('/ws/agent')?'agent':'ui');wss.handleUpgrade(req,socket,head,ws=>{
    auth.track(ws,p);ws.on('error',()=>{});ws.on('message',()=>{if(!auth.valid(p)){ws.close(4001,auth.failureReason(p));return;}ws.send(JSON.stringify({userId:p.userId,deviceId:p.deviceId,deviceKey:p.deviceKey,role:p.role}));});
  });}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`https://localhost:${server.address().port}`;
const record=name=>{checks.push(name);console.log('PASS '+name);};
function post(route,body={},token,ca=serverCa){return new Promise((resolve,reject)=>{
  const req=https.request(origin+route,{method:'POST',ca,agent:false,timeout:5000,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const value=JSON.parse(raw);value.ok?resolve(value.data):reject(Error(value.error));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTPS timeout')));req.end(JSON.stringify(body));
});}
async function connect(route,token){const ws=new WebSocket(origin.replace('https:','wss:')+route,{ca:serverCa,headers:{Authorization:'Bearer '+token},handshakeTimeout:5000});sockets.push(ws);ws.on('error',()=>{});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return ws;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+3000;while(Date.now()<end){if(fn())return;await sleep(20);}throw Error(label);}
async function close(ws){ws.close();await until(()=>ws.readyState===WebSocket.CLOSED,'WSS close timeout');}
async function principal(ws){const result=new Promise((r,j)=>{const t=setTimeout(()=>j(Error('WSS message timeout')),3000);ws.once('message',raw=>{clearTimeout(t);r(JSON.parse(String(raw)));});});ws.send('probe');return result;}
let admin,alice,bob,login,otherAdmin,otherLogin,code,paired,second,foreign,adminDevice;
try{
  admin=await auth.createUser('tokenadmin',password,'admin');alice=await auth.createUser('tokenalice',password);bob=await auth.createUser('tokenbob',password);otherAdmin=await auth.createUser('issueradmin',password,'admin');
  login=await post('/auth/login',{username:'tokenadmin',password});otherLogin=await post('/auth/login',{username:'issueradmin',password});
  await assert.rejects(post('/auth/login',{username:'tokenadmin',password},undefined,[]));record('HTTPS server identity is validated without disabling TLS checks');
  const issue=async userId=>(await post('/auth/admin/pair-code',{userId},login.accessToken));
  code=await issue(alice.id);assert.equal(code.authMode,'device-token-v1');assert.equal(code.expiresIn,300);assert(/^[A-Za-z0-9_-]{43}$/.test(code.code));
  paired=await post('/auth/device/pair',{code:code.code,name:'Synthetic token device A'});assert.equal(paired.user.id,alice.id);assert.equal(paired.authMode,'device-token-v1');assert.match(paired.deviceToken,/^ydt1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);assert(!('certificate'in paired)&&!('sessionId'in paired));
  await assert.rejects(post('/auth/device/pair',{code:code.code,name:'reuse'}),/INVALID_PAIR_CODE/);record('admin targets an account; high entropy code is consumed once and returns only one device secret');
  const raceCode=await issue(alice.id),raced=await Promise.allSettled([post('/auth/device/pair',{code:raceCode.code,name:'race1'}),post('/auth/device/pair',{code:raceCode.code,name:'race2'})]);assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);record('concurrent redemption cannot mint two devices from one code');
  second=await post('/auth/device/pair',{code:(await issue(alice.id)).code,name:'Synthetic same-account device'});foreign=await post('/auth/device/pair',{code:(await issue(bob.id)).code,name:'Synthetic foreign device'});adminDevice=await post('/auth/device/pair',{code:(await issue(admin.id)).code,name:'Admin-owned ordinary device'});
  for(const route of ['/auth/admin/users','/auth/admin/devices','/auth/admin/pair-code','/auth/admin/user/disable'])await assert.rejects(post(route,route.endsWith('pair-code')||route.endsWith('disable')?{userId:alice.id}:{},adminDevice.deviceToken),/NOT_FOUND/);
  assert.equal((await post('/auth/me',{},adminDevice.deviceToken)).user.role,'user');record('admin-owned device token is role user and cannot acquire administrative capabilities');
  const listing=await post('/auth/admin/devices',{userId:alice.id},login.accessToken);assert(listing.devices.length>=2&&listing.devices.every(d=>d.userId===alice.id));assert(!JSON.stringify(listing).includes('tokenHash'));assert(!JSON.stringify(listing).includes(paired.deviceToken));record('administrator receives filtered public device metadata without token hashes');
  assert.equal((await post('/auth/devices',{},paired.deviceToken)).devices.length,1);
  await assert.rejects(post('/auth/device/revoke',{deviceId:second.deviceId},paired.deviceToken),/NOT_FOUND/);await assert.rejects(post('/auth/device/revoke',{deviceId:foreign.deviceId},paired.deviceToken),/NOT_FOUND/);record('device token cannot list or revoke same-account sibling or foreign devices');
  const ui=await connect('/ws',paired.deviceToken),agent=await connect('/ws/agent?deviceId='+paired.deviceId,paired.deviceToken),survivor=await connect('/ws/agent',second.deviceToken);
  assert.deepEqual(await principal(ui),{userId:alice.id,deviceId:paired.deviceId,deviceKey:paired.deviceKey,role:'user'});assert.equal((await principal(agent)).deviceId,paired.deviceId);record('real UI and Agent WSS use the same device-bound bearer without a client certificate');
  await assert.rejects(connect('/ws?deviceId='+second.deviceId,paired.deviceToken));await assert.rejects(connect('/ws/agent?userId='+bob.id,paired.deviceToken));await assert.rejects(connect('/ws?deviceId='+paired.deviceId+'&deviceId='+paired.deviceId,paired.deviceToken));await assert.rejects(connect('/ws?token='+paired.deviceToken,paired.deviceToken));await assert.rejects(connect('/ws',login.accessToken));record('URL override, duplicate identity, query secrets and administrator session as device are rejected');
  await assert.rejects(post('/auth/device/pair',{code:(await issue(alice.id)).code,name:'override',userId:bob.id}),/INVALID_INPUT/);await assert.rejects(post('/auth/device/status',{deviceId:second.deviceId},paired.deviceToken),/INVALID_INPUT/);record('pair and status bodies cannot replace server-selected identity');
  for(const route of ['/auth/pair-code','/auth/device/challenge','/auth/device/prove','/auth/device/renew'])await assert.rejects(post(route,{sessionId:login.sessionId,deviceId:paired.deviceId,nonce:'unused',signature:'unused'},login.accessToken),/AUTH_MODE_UNSUPPORTED/);record('token mode rejects legacy pairing, challenge and certificate renewal without fallback');
  const expired=await issue(alice.id),originalNow=Date.now;try{Date.now=()=>originalNow()+300_001;assert.throws(()=>auth.pairDeviceToken(expired.code,'expired'),/INVALID_PAIR_CODE/);}finally{Date.now=originalNow;}record('pairing code expires after five minutes');
  const expiredIssuer=await issue(alice.id);try{Date.now=()=>originalNow()+60_001;assert.throws(()=>auth.pairDeviceToken(expiredIssuer.code,'session expired before code'),/INVALID_PAIR_CODE/);assert.equal(auth.bearer('Bearer '+paired.deviceToken).deviceId,paired.deviceId);}finally{Date.now=originalNow;}record('issuer session expiry invalidates an unexpired code; paired device needs no session refresh');
  const revokedIssuerCode=await post('/auth/admin/pair-code',{userId:alice.id},otherLogin.accessToken);await post('/auth/logout',{},otherLogin.accessToken);await assert.rejects(post('/auth/device/pair',{code:revokedIssuerCode.code,name:'issuer logged out'}),/INVALID_PAIR_CODE/);record('issuer session revocation invalidates its outstanding code');
  otherLogin=await post('/auth/login',{username:'issueradmin',password});const disabledIssuerCode=await post('/auth/admin/pair-code',{userId:alice.id},otherLogin.accessToken);await post('/auth/admin/user/disable',{userId:otherAdmin.id},login.accessToken);await assert.rejects(post('/auth/device/pair',{code:disabledIssuerCode.code,name:'issuer disabled'}),/INVALID_PAIR_CODE/);record('issuer disablement invalidates its outstanding code');
  const disabledTargetCode=await issue(bob.id),foreignSocket=await connect('/ws',foreign.deviceToken);await post('/auth/admin/user/disable',{userId:bob.id},login.accessToken);await assert.rejects(post('/auth/device/pair',{code:disabledTargetCode.code,name:'target disabled'}),/INVALID_PAIR_CODE/);await until(()=>foreignSocket.readyState===WebSocket.CLOSED,'disabled target stays connected');await assert.rejects(post('/auth/device/status',{},foreign.deviceToken),/AUTH_REQUIRED/);record('target disablement cancels its active device and invalidates tokens and outstanding codes');
  assert.equal((await post('/auth/device/status',{},paired.deviceToken)).status,'active');
  await post('/auth/device/disconnect',{},paired.deviceToken);await until(()=>ui.readyState===WebSocket.CLOSED&&agent.readyState===WebSocket.CLOSED,'disconnect must close both channels');assert.equal(survivor.readyState,WebSocket.OPEN);await assert.rejects(post('/auth/device/status',{},paired.deviceToken),/DEVICE_REVOKED/);await assert.rejects(connect('/ws/agent',paired.deviceToken));record('self disconnect revokes all of its channels immediately and preserves sibling device');
  const beforeRestartCode=await issue(alice.id);auth.close();await until(()=>survivor.readyState===WebSocket.CLOSED,'auth restart closes old channels');auth=new PlatformAuth(path,undefined,undefined,'device-token-v1');attachAudit();
  const persisted=await connect('/ws/agent',second.deviceToken);assert.equal((await principal(persisted)).deviceId,second.deviceId);await assert.rejects(connect('/ws',paired.deviceToken));await assert.rejects(connect('/ws',foreign.deviceToken));await assert.rejects(post('/auth/device/pair',{code:beforeRestartCode.code,name:'old ephemeral code'}),/INVALID_PAIR_CODE/);record('restart preserves device identity, revoked/disabled state and invalidates outstanding codes');
  login=await post('/auth/login',{username:'tokenadmin',password});await post('/auth/device/revoke',{deviceId:second.deviceId},login.accessToken);await until(()=>persisted.readyState===WebSocket.CLOSED,'admin revoke closes active Agent');record('administrator revoke cancels the selected active Agent');
  const disk=await readFile(path,'utf8'),events=JSON.stringify(audit);for(const secret of [password,code.code,paired.deviceToken,second.deviceToken,foreign.deviceToken,adminDevice.deviceToken,login.accessToken]){assert(!disk.includes(secret),'Secret persisted in auth state');assert(!events.includes(secret),'Secret appeared in audit');}record('persistent auth and audit contain no raw pairing code, device token or login secret');
  const corrupt=JSON.parse(disk);corrupt.devices.find(d=>d.authMode==='device-token-v1').tokenHash='raw-token-not-hash';const corruptPath=join(root,'corrupt-auth.json');await writeFile(corruptPath,JSON.stringify(corrupt));assert.throws(()=>new PlatformAuth(corruptPath),/AUTH_STATE_CORRUPT/);record('malformed persisted device-token metadata fails closed');
  const legacy=new PlatformAuth(path,undefined,undefined,'legacy-mtls-v1');try{assert.throws(()=>legacy.bearer('Bearer '+adminDevice.deviceToken),/AUTH_MODE_UNSUPPORTED/);}finally{legacy.close();}record('explicit legacy mode cannot silently accept a device token');
  await close(await connect('/ws',adminDevice.deviceToken));
  await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks,root,source:'real HTTPS/WSS module protocol; no Agent execution or native vault'},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,result:join(root,'result.json')}));
}finally{for(const ws of sockets)ws.terminate();auth.close();wss.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
