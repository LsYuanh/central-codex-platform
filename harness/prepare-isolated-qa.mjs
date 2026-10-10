// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaRoot, qaAuthFile} from '../scripts/maintenance/operator-config.mjs';
// Fixed central QA only: model login is read in place by the broker, never copied into a Worker.
import {mkdirSync,existsSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const qa=qaRoot(),dir=qa+'/p5-isolated-security';
assert.equal(process.platform,'darwin');assert(!existsSync(dir+'/auth.json'),'Preserve existing QA identities');
mkdirSync(dir,{recursive:true,mode:0o700});
let raw='';for await(const chunk of process.stdin){raw+=chunk;assert(raw.length<=8192);}
const {PlatformAuth}=await import(qa+'/gateway/services/central-gateway/dist/platform-auth.js');
const auth=new PlatformAuth(dir+'/auth.json'),input=JSON.parse(raw),users=[];
const credential=qaAuthFile(),stat=lstatSync(credential);
assert.equal(realpathSync(credential),credential);assert(stat.isFile()&&stat.nlink===1&&(stat.mode&0o077)===0);
try{
 for(const username of ['isoalice','isobob']){
  const user=await auth.createUser(username,input.password,username==='isoalice'?'admin':'user');users.push(user);
  const base=qa+'/live-data/isolated-workers/'+createHash('sha256').update(user.id).digest('hex');
  mkdirSync(base+'/home',{recursive:true,mode:0o700});mkdirSync(base+'/runtime',{recursive:true,mode:0o700});
 }
 const models={version:1,users:Object.fromEntries(users.map(u=>[u.id,{providerId:'central-readonly-qa',enabled:true}])),providers:{'central-readonly-qa':{id:'central-readonly-qa',kind:'chatgpt',credentialFile:credential,baseUrl:'https://chatgpt.com/backend-api/codex'}}};
 writeFileSync(dir+'/models.json',JSON.stringify(models,null,2),{flag:'wx',mode:0o600});
 writeFileSync(dir+'/public-users.json',JSON.stringify(users,null,2),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({ok:true,accounts:users.length,credentialHandling:'central broker reads existing login in place; no copy, refresh, revoke or Worker auth link',port:4529}));
}finally{auth.close();}
