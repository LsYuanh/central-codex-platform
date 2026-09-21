// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {PlatformAuth} from '../../services/central-gateway/dist/platform-auth.js';
const root=await mkdtemp(join(tmpdir(),'platform-auth-')),path=join(root,'auth.json');
let store=new PlatformAuth(path,1000,60_000,'legacy-mtls-v1');let checks=0;
const check=(name)=>{checks++;console.log(`PASS ${name}`);};
const request=(token,deviceId,userId)=>({url:'/ws?deviceId='+deviceId+(userId?'&userId='+userId:''),headers:{authorization:'Bearer '+token}});
const password='fixture-'+randomBytes(24).toString('hex');
try{
 const a=await store.createUser('alice',password,'admin'),b=await store.createUser('bob',password);
 await assert.rejects(store.login('alice','wrong-password','qa'),/INVALID_LOGIN/);check('password verification');
 const loginA=await store.login('alice',password,'a'),loginB=await store.login('bob',password,'b');
 let pa=store.bearer('Bearer '+loginA.accessToken),pb=store.bearer('Bearer '+loginB.accessToken);
 const keys=generateKeyPairSync('ed25519'),raw=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
 const code=store.pairCode(pa).code;assert.throws(()=>store.pair(pb,code,raw,'stolen'),/INVALID_PAIR_CODE/);
 const next=store.pairCode(pa).code,d=store.pair(pa,next,raw,'Alice device');assert.throws(()=>store.pair(pa,next,raw,'again'),/INVALID_PAIR_CODE/);check('pair code owner and single-use');
 assert.throws(()=>store.upgrade(request(loginA.accessToken,d.deviceId,b.id),'ui'),/OVERRIDE/);
 assert.throws(()=>store.upgrade(request(loginB.accessToken,d.deviceId),'ui'),/NOT_FOUND/);check('forged user and cross-user device denied');
 const c=store.challenge(loginA.sessionId,d.deviceId);assert.throws(()=>store.prove(c.nonce,randomBytes(64).toString('base64')),/AUTH_REQUIRED/);
 assert.throws(()=>store.prove(c.nonce,sign(null,Buffer.from(c.message),keys.privateKey).toString('base64')),/AUTH_REQUIRED/);check('bad proof consumes challenge');
 const c2=store.challenge(loginA.sessionId,d.deviceId);const ticket=store.prove(c2.nonce,sign(null,Buffer.from(c2.message),keys.privateKey).toString('base64')).ticket;
 assert.equal(store.upgrade(request(ticket,d.deviceId),'agent').userId,a.id);assert.throws(()=>store.upgrade(request(ticket,d.deviceId),'agent'),/AUTH_REQUIRED/);check('signed device proof and ticket replay rejection');
 const rotated=store.refresh(loginA.refreshToken);assert.throws(()=>store.refresh(loginA.refreshToken),/REFRESH_REUSED/);assert.throws(()=>store.bearer('Bearer '+rotated.accessToken),/AUTH_REQUIRED/);check('refresh rotation detects reuse and revokes session');
 const renewed=await store.login('alice',password,'a2');pa=store.bearer('Bearer '+renewed.accessToken);
 const principal=store.upgrade(request(renewed.accessToken,d.deviceId),'ui');let closed=false;
 store.track({close(){closed=true;},once(){},terminate(){}},principal);store.revokeDevice(pa,d.deviceId);assert(closed);assert.throws(()=>store.challenge(renewed.sessionId,d.deviceId),/DEVICE_REVOKED/);check('revocation closes existing socket and denies reconnect');
 store.disableUser(pa,b.id);assert.throws(()=>store.bearer('Bearer '+loginB.accessToken),/AUTH_REQUIRED/);check('disabled user loses all sessions');
 const disk=await readFile(path,'utf8');for(const secret of [password,loginA.accessToken,loginA.refreshToken,rotated.refreshToken])assert(!disk.includes(secret));check('no plaintext passwords or tokens in durable state');
 store.close();store=new PlatformAuth(path,1000,60_000,'legacy-mtls-v1');const restored=store.refresh(renewed.refreshToken);assert.equal(restored.user.id,a.id);check('restart restores refresh state and ownership');
 await new Promise(r=>setTimeout(r,1050));assert.throws(()=>store.bearer('Bearer '+restored.accessToken),/AUTH_REQUIRED/);check('access expiry');
 const final=store.refresh(restored.refreshToken);store.logout(store.bearer('Bearer '+final.accessToken));assert.throws(()=>store.refresh(final.refreshToken),/AUTH_REQUIRED/);check('logout revokes refresh');
 const corrupt=join(root,'corrupt.json');await writeFile(corrupt,'{broken');assert.throws(()=>new PlatformAuth(corrupt),/CORRUPT/);assert.equal(await readFile(corrupt,'utf8'),'{broken');check('corrupt identity state never resets');
 console.log(JSON.stringify({ok:true,checks,source:'real-crypto-and-durable-state',root}));
}finally{store.close();}
