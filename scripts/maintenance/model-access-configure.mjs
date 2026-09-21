// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Central operator only. stdin contains a binding, never a password, model key or token.
import {readFileSync,writeFileSync,renameSync,lstatSync,realpathSync,existsSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(process.platform,'darwin','Configure model access on the central Mac');
const file=resolve(process.env.PLATFORM_MODEL_BINDINGS??''),authFile=resolve(process.env.PLATFORM_AUTH_FILE??'');
const workerRoot=resolve(process.env.PLATFORM_WORKER_ROOT??resolve(dirname(process.env.TEST_GATEWAY_STATE_FILE??'data/test-gateway-state.json'),'workers'));
function outsideWorkers(path){const rel=relative(workerRoot,resolve(path));assert(rel.startsWith('..')||isAbsolute(rel),'Model configuration and credentials must be outside all Worker directories');}
assert(process.env.PLATFORM_MODEL_BINDINGS&&process.env.PLATFORM_AUTH_FILE,'Set PLATFORM_MODEL_BINDINGS and PLATFORM_AUTH_FILE');
function safe(path,directory=false){const s=lstatSync(path);assert.equal(realpathSync(path),path);assert(directory?s.isDirectory():s.isFile());assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o077,0);if(!directory)assert.equal(s.nlink,1);}
safe(dirname(file),true);safe(authFile);
outsideWorkers(file);
let raw='';for await(const chunk of process.stdin){raw+=chunk;assert(raw.length<=8192,'Binding too large');}
const input=JSON.parse(raw);assert(Object.keys(input).every(k=>['userId','enabled','provider'].includes(k)),'Only userId, enabled and provider are accepted');
assert(typeof input.userId==='string'&&input.userId.length<=128);assert(typeof input.enabled==='boolean');
const users=JSON.parse(readFileSync(authFile,'utf8')).users;assert(users.some(u=>u.id===input.userId),'Unknown platform user');
let config={version:1,users:{},providers:{}};
if(existsSync(file)){safe(file);config=JSON.parse(readFileSync(file,'utf8'));assert.equal(config.version,1);}
if(input.provider){
 const p=input.provider;assert(Object.keys(p).every(k=>['id','kind','credentialFile','baseUrl'].includes(k)));
 assert(/^[a-zA-Z0-9_-]{1,80}$/.test(p.id));assert(['chatgpt','api-key'].includes(p.kind));assert(isAbsolute(p.credentialFile));safe(p.credentialFile);
 const expected=p.kind==='chatgpt'?'https://chatgpt.com/backend-api/codex':'https://api.openai.com/v1';
 assert(!p.baseUrl||p.baseUrl===expected,'Only reviewed official provider URLs are supported');
 outsideWorkers(p.credentialFile);
 const normalized={id:p.id,kind:p.kind,credentialFile:p.credentialFile,baseUrl:expected};
 if(config.providers[p.id])assert.deepEqual(config.providers[p.id],normalized,'Provider change may affect other users; use a new provider id');
 config.providers[p.id]=normalized;config.users[input.userId]={providerId:p.id,enabled:input.enabled};
}else{assert(config.users[input.userId],'A new binding requires a provider');config.users[input.userId].enabled=input.enabled;}
for(const provider of Object.values(config.providers)){outsideWorkers(provider.credentialFile);safe(provider.credentialFile);}
const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file);
for(const path of [file,dirname(file)]){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
console.log(JSON.stringify({ok:true,userId:input.userId,enabled:input.enabled,action:'model-access-binding-saved',credentialsPrinted:false}));
