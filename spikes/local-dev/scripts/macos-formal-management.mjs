// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Operator-side test controller. Pair output is secret: pipe directly to the client,
// never show stdout in agent logs. Passwords stay on the central Mac.
import {readFile,writeFile} from 'node:fs/promises';
import {request} from 'node:https';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../artifacts/central-macos/formal-migration-20260911');
const ca=await readFile(path.join(dir,'ca.pem'));
const login=JSON.parse(await readFile(path.join(dir,'admin-login.json'),'utf8'));
async function api(route,body,token){return new Promise((resolve,reject)=>{
  const bytes=Buffer.from(JSON.stringify(body));
  const req=request({hostname:'127.0.0.1',port:4510,path:route,method:'POST',ca,headers:{'content-type':'application/json','content-length':bytes.length,...(token?{authorization:'Bearer '+token}:{})},timeout:15000},res=>{
    let text='';res.on('data',b=>{text+=b;if(text.length>1024*1024)req.destroy(Error('RESPONSE_LIMIT'));});res.on('end',()=>{try{const value=JSON.parse(text);if(!value.ok)throw Error(value.error);resolve(value.data);}catch(e){reject(e);}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('TIMEOUT')));req.end(bytes,()=>bytes.fill(0));
});}
const auth=await api('/auth/admin/login',login);login.password='';
const token=auth.accessToken;
const username='windows-formal-test-20260911';
let user=(await api('/auth/admin/users',{},token)).users.find(u=>u.username===username);
if(process.argv[2]==='pair'||process.argv[2]==='pair-bundle'){
  if(!user){const created=await api('/auth/admin/user/create-pairing',{requestId:randomUUID(),username},token);user=created.user??created;}
  const pair=await api('/auth/admin/pair-code',{requestId:randomUUID(),userId:user.id},token);
  await writeFile(path.join(dir,'client-test-user.json'),JSON.stringify({userId:user.id}),{mode:0o600});
  const code=process.argv[2]==='pair-bundle'?'yzpair1.'+Buffer.from(JSON.stringify({version:1,gateway:'wss://192.0.2.10:4510/ws',caPem:ca.toString(),token:pair.code,expiresAt:pair.expiresAt})).toString('base64url'):pair.code;
  process.stdout.write(JSON.stringify({code}));
}else if(process.argv[2]==='revoke'){
  if(!user)throw Error('TEST_USER_MISSING');
  const devices=(await api('/auth/admin/devices',{userId:user.id},token)).devices;
  const device=devices.find(d=>d.deviceId===process.argv[3]||d.id===process.argv[3]);if(!device)throw Error('TEST_DEVICE_MISSING');
  await api('/auth/device/revoke',{requestId:randomUUID(),deviceId:process.argv[3]},token);
  process.stdout.write(JSON.stringify({revoked:true}));
}else if(process.argv[2]==='status'){
  const users=(await api('/auth/admin/users',{},token)).users;
  const devices=(await api('/auth/admin/devices',{},token)).devices;
  process.stdout.write(JSON.stringify({users:users.length,devices:devices.map(d=>({id:d.deviceId??d.id,online:d.online,revoked:d.revoked}))}));
}else throw Error('UNKNOWN_ACTION');
