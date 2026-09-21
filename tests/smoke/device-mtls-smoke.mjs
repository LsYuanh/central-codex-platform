// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real HTTPS client authentication + durable platform state; no model calls.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign,randomBytes,constants} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import https from 'node:https';
import {WebSocket,WebSocketServer} from 'ws';
import {PlatformAuth} from '../../services/central-gateway/dist/platform-auth.js';
import {DeviceCertificates,createDeviceCertificateAuthority} from '../../services/central-gateway/dist/device-certificates.js';

const root=await mkdtemp(join(tmpdir(),'device-mtls-')),checks=[],sockets=[];
const record=name=>{checks.push(name);console.log('PASS '+name);};
const ca=await createDeviceCertificateAuthority({directory:join(root,'device-ca'),protocolFixture:true,certificateLifetimeSeconds:60,renewBeforeSeconds:50});
const issuer=await DeviceCertificates.load({configFile:ca.configFile,protocolFixture:true});
const cert=join(root,'server.pem'),key=join(root,'server-key.pem'),config=join(root,'openssl.cnf');
await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const generated=spawnSync(process.env.OPENSSL_BIN??'C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',cert,'-config',config],{windowsHide:true});assert.equal(generated.status,0,String(generated.stderr));
let auth=new PlatformAuth(join(root,'auth.json'),undefined,undefined,'legacy-mtls-v1');auth.setCertificates(issuer);
const server=https.createServer({cert:await readFile(cert),key:await readFile(key),ca:issuer.caPem,requestCert:true,rejectUnauthorized:false,secureOptions:constants.SSL_OP_NO_TICKET},(req,res)=>void auth.http(req,res));
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{try{const principal=auth.upgrade(req,'agent');wss.handleUpgrade(req,socket,head,ws=>{auth.track(ws,principal);ws.on('error',()=>{});});}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`https://localhost:${server.address().port}`,serverCa=await readFile(cert);
function post(route,body,token,identity){return new Promise((resolve,reject)=>{const req=https.request(origin+route,{method:'POST',ca:serverCa,agent:false,...(identity?{cert:identity.certificate.pem,key:identity.tls.privateKey}:{}),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const value=JSON.parse(raw);value.ok?resolve(value.data):reject(Error(value.error));}catch(e){reject(e);}});});req.on('error',reject);req.end(JSON.stringify(body));});}
async function pair(username,password){const login=await post('/auth/login',{username,password}),ed=generateKeyPairSync('ed25519'),tls=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'der'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});const {code}=await post('/auth/pair-code',{},login.accessToken);const paired=await post('/auth/pair',{code,publicKey:ed.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'),tlsPublicKey:tls.publicKey.toString('base64'),name:username},login.accessToken);return {...login,...paired,ed,tls};}
async function ticket(d){const c=await post('/auth/device/challenge',{sessionId:d.sessionId,deviceId:d.deviceId});return (await post('/auth/device/prove',{nonce:c.nonce,signature:sign(null,Buffer.from(c.message),d.ed.privateKey).toString('base64')})).ticket;}
async function connect(d,identity=d){const bearer=await ticket(d);return new Promise((resolve,reject)=>{const ws=new WebSocket(origin.replace('https:','wss:')+'/ws/agent?deviceId='+d.deviceId,{ca:serverCa,...(identity?{cert:identity.certificate.pem,key:identity.tls.privateKey}:{}),headers:{Authorization:'Bearer '+bearer}});sockets.push(ws);ws.once('open',()=>resolve(ws));ws.once('error',reject);});}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await wait(50);}throw Error(label);}
try{
 const password='qa-'+randomBytes(20).toString('hex');await auth.createUser('alice',password,'admin');await auth.createUser('bob',password);
 const a=await pair('alice',password),b=await pair('bob',password),c=await pair('alice',password);
 record('TLS bootstrap pairs client-generated keys; returns public certificates only');
 await assert.rejects(connect(a,null));await assert.rejects(connect(a,b));record('missing certificate and foreign device certificate denied despite valid ticket');
 const foreign=await createDeviceCertificateAuthority({directory:join(root,'foreign-ca'),protocolFixture:true});const foreignIssuer=await DeviceCertificates.load({configFile:foreign.configFile,protocolFixture:true});
 const forged={...a,certificate:await foreignIssuer.issue({deviceId:a.deviceId,userId:a.user.id,tlsPublicKey:a.tls.publicKey.toString('base64')})};await assert.rejects(connect(a,forged));record('untrusted CA cannot forge an authenticated device');
 const wa=await connect(a),wb=await connect(b),wc=await connect(c);record('three genuine mTLS device channels admitted');
 await assert.rejects(post('/auth/device/renew',{deviceId:a.deviceId,sessionId:a.sessionId}));
 await assert.rejects(post('/auth/device/renew',{deviceId:a.deviceId,sessionId:b.sessionId},undefined,a));
 await assert.rejects(post('/auth/device/renew',{deviceId:a.deviceId,sessionId:a.sessionId},undefined,b));record('renewal requires mTLS plus matching device and platform session');
 const first=await post('/auth/device/renew',{deviceId:a.deviceId,sessionId:a.sessionId},undefined,a);assert.equal(first.certificate.fingerprint,a.certificate.fingerprint);record('early renewal is idempotent');
 await wait(Math.max(0,a.certificate.renewAfter-Date.now()+100));
 const renewed=await post('/auth/device/renew',{deviceId:a.deviceId,sessionId:a.sessionId},undefined,a);assert.notEqual(renewed.certificate.fingerprint,a.certificate.fingerprint);assert.equal(wa.readyState,WebSocket.OPEN);assert.equal(wb.readyState,WebSocket.OPEN);record('renewal reauthorizes only its channel without disconnecting active peers');
 const renewedA={...a,certificate:renewed.certificate};const replacement=await connect(renewedA);assert.equal(replacement.readyState,WebSocket.OPEN);record('renewed certificate reconnects successfully');
 await post('/auth/device/revoke',{deviceId:a.deviceId},a.accessToken);await until(()=>wa.readyState===WebSocket.CLOSED&&replacement.readyState===WebSocket.CLOSED,'revocation closes renewed channels');assert.equal(wb.readyState,WebSocket.OPEN);await assert.rejects(connect(renewedA));await assert.rejects(post('/auth/device/renew',{deviceId:a.deviceId,sessionId:a.sessionId},undefined,renewedA));record('revoking one device closes all its channels and blocks renewal; other devices remain online');
 // Restart the auth store, preserving certificates and revoked identities.
 auth.close();auth=new PlatformAuth(join(root,'auth.json'),undefined,undefined,'legacy-mtls-v1');auth.setCertificates(issuer);
 const reopened=await connect(c),survivor=await connect(b);await wait(Math.max(0,b.certificate.renewAfter-Date.now()+100));const bRenewed=await post('/auth/device/renew',{deviceId:b.deviceId,sessionId:b.sessionId},undefined,b);assert(bRenewed.certificate.expiresAt>b.certificate.expiresAt);await assert.rejects(connect(renewedA));record('restart restores device certificate bindings and revocations');
 await wait(Math.max(0,c.certificate.expiresAt-Date.now()+600));await until(()=>reopened.readyState===WebSocket.CLOSED,'expired socket closes');assert.equal(survivor.readyState,WebSocket.OPEN);record('reauthorized channel survives its original handshake certificate expiry');await assert.rejects(connect(c));await assert.rejects(post('/auth/device/renew',{deviceId:c.deviceId,sessionId:c.sessionId},undefined,c));record('unrenewed certificate expiry closes channel and denies reconnect and renewal');
 const repaired=await pair('alice',password);await connect(repaired);record('expired device can explicitly re-pair using fresh client keys');
 const disk=await readFile(join(root,'auth.json'),'utf8');for(const secret of [password,a.tls.privateKey,a.accessToken])assert(!disk.includes(secret));record('durable auth records contain neither TLS private keys nor login secrets');
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks,source:'real TLS and platform auth; no model fixture',root},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,result:join(root,'result.json')}));
}finally{for(const socket of sockets)socket.terminate();auth.close();wss.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
