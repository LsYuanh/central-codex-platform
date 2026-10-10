// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaGateway, qaOrigin} from '../scripts/maintenance/operator-config.mjs';
// Developer-only RC acceptance. Admin password/code enter stdin; device tokens
// remain inside the native helper and its application-private storage.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import https from 'node:https';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const namespace='com.centralcodex.harnessqa.rc20260909';
const gateway=qaGateway(),origin=qaOrigin();
const platform=process.platform;
assert(['win32','darwin'].includes(platform));
const directory=platform==='win32'?join(process.env.APPDATA,namespace):join(process.env.HOME,'Library/Application Support',namespace);
const qaRoot=join(root,'target',`token-native-${platform}`),workspace=join(qaRoot,'workspace');
const recordPath=join(qaRoot,'record.json'),backup=join(qaRoot,'backup');
const ca=join(root,'target/harness-deploy/p5-token-server-ca.pem');
const helper=join(root,platform==='win32'?'target/debug/examples':'target/desktop-rc-20260909/debug/examples',platform==='win32'?'platform-acceptance.exe':'platform-acceptance');
const names=['desktop-runtime-v1.json','platform-ca-v1.json'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function regular(path){const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink(),'Expected regular QA file');}
function stopped(){
  let r;
  if(platform==='win32'){
    const childEnv={...process.env};delete childEnv.PSModulePath;
    r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'yuan-zhou-rc.exe' -or ($_.Name -eq 'local-agent.exe' -and ($_.ExecutablePath -like '*desktop-rc-20260909*' -or $_.ExecutablePath -like '*远舟 RC 20260909*')) }); if ($p.Count) { exit 2 }"],{env:childEnv,windowsHide:true,timeout:15000,stdio:'pipe'});
    assert.equal(r.status,0,'Close RC desktop and its Agent before changing pairing/configuration');
  }else{
    r=spawnSync('/usr/bin/pgrep',['-f','/远舟 RC 20260909.app/Contents/MacOS/'],{timeout:15000,stdio:'pipe'});
    assert.equal(r.status,1,'Close RC desktop and its Agent before changing pairing/configuration');
  }
}
function native(action,extra={}){
  regular(helper);regular(ca);
  const result=spawnSync(helper,[],{input:JSON.stringify({namespace,gateway,ca,action,'token-root':directory,...extra}),encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:65536});
  if(result.status!==0)throw Error('Native token QA request failed; secret-bearing output suppressed');
  let value;try{value=JSON.parse(result.stdout);}catch{throw Error('Native QA response invalid; output suppressed');}
  assert(value.ok===true);return value.data;
}
function post(path,body,access){
  return new Promise((resolve,reject)=>{
    const req=https.request(origin+path,{method:'POST',ca:readFileSync(ca),agent:false,headers:{'Content-Type':'application/json',...(access?{Authorization:'Bearer '+access}:{})},timeout:15000},res=>{
      let raw='';res.on('data',b=>{raw+=b;if(raw.length>65536)req.destroy();});
      res.on('end',()=>{try{const v=JSON.parse(raw);if(!v.ok)throw Error();resolve(v.data);}catch{reject(Error('Central token QA request rejected'));}});
      res.on('error',()=>reject(Error('Central token QA response failed')));
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('Central token QA connection failed')));req.end(JSON.stringify(body));
  });
}
function save(record){writeFileSync(recordPath,JSON.stringify(record,null,2)+'\n',{mode:0o600});}
function load(){regular(recordPath);const r=JSON.parse(readFileSync(recordPath,'utf8'));assert.equal(r.namespace,namespace);assert.equal(r.directory,directory);assert.equal(r.gateway,gateway);return r;}
function verify(record){
  for(const f of record.files){
    const path=join(directory,f.name);
    if(f.existed){regular(join(backup,f.name));assert.equal(sha(readFileSync(join(backup,f.name))),f.originalHash);}
    if(existsSync(path)){regular(path);assert([f.originalHash,...(f.qaHashes??[])].includes(sha(readFileSync(path))),'RC configuration changed outside this acceptance; preserve it');}
    else assert(!f.existed,'Original RC config missing');
  }
}
const action=process.argv[2];
assert(['prepare','re-pair','revoke','status','cleanup'].includes(action));
try{
  if(action==='status'){
    const r=existsSync(recordPath)?load():null;
    console.log(JSON.stringify({ok:true,stage:r?.stage??'not-prepared',identity:r?.identity??null,status:native('token-status')}));
  }else if(action==='revoke'){
    const record=load();assert.equal(record.stage,'configured');
    let raw='';for await(const b of process.stdin){raw+=b;assert(raw.length<=8192);}
    let input;try{input=JSON.parse(raw);}catch{throw Error('Invalid stdin JSON');}raw='';
    assert(typeof input.password==='string'&&input.password.length>=12);
    let admin;
    try{
      admin=await post('/auth/login',{username:'tokenadmin',password:input.password});input.password=undefined;
      const devices=await post('/auth/admin/devices',{userId:record.identity.user.id},admin.accessToken);
      assert(devices.devices.some(d=>d.id===record.identity.deviceId&&d.name===`${platform} token RC acceptance`));
      await post('/auth/device/revoke',{deviceId:record.identity.deviceId},admin.accessToken);
      const status=native('token-status');assert.equal(status.status,'revoked');
      record.revocations??=[];record.revocations.push({at:new Date().toISOString(),deviceId:record.identity.deviceId});save(record);
      console.log(JSON.stringify({ok:true,deviceId:record.identity.deviceId,status}));
    }finally{input.password=undefined;if(admin)await post('/auth/logout',{},admin.accessToken);}
  }else if(action==='cleanup'){
    stopped();const record=load();verify(record);
    const outcome=native('token-disconnect');
    for(const f of record.files){const path=join(directory,f.name);if(f.existed)writeFileSync(path,readFileSync(join(backup,f.name)));else if(existsSync(path))unlinkSync(path);}
    record.stage='cleaned';record.cleanup={at:new Date().toISOString(),outcome,configurationRestored:true};save(record);
    console.log(JSON.stringify({ok:true,...record.cleanup}));
  }else{
    stopped();const replacing=action==='re-pair';
    let record;
    if(replacing){record=load();assert.equal(record.stage,'configured');verify(record);}
    else assert(!existsSync(qaRoot),'Preserve previous token QA record');
    const prior=native('token-status');
    if(replacing)assert.equal(prior.deviceId,record.identity.deviceId,'Existing native identity changed');
    else assert(!prior.paired&&!prior.deviceId&&!prior.storageError,'Preserve existing RC device identity');
    let raw='';for await(const b of process.stdin){raw+=b;assert(raw.length<=8192);}
    let input;try{input=JSON.parse(raw);}catch{throw Error('Invalid stdin JSON');}raw='';
    assert(typeof input.password==='string'&&input.password.length>=12);
    if(!replacing){
    mkdirSync(backup,{recursive:true,mode:0o700});mkdirSync(workspace,{mode:0o700});mkdirSync(directory,{recursive:true});
    const files=names.map(name=>{const path=join(directory,name);if(!existsSync(path))return {name,existed:false,qaHashes:[]};regular(path);const bytes=readFileSync(path);writeFileSync(join(backup,name),bytes,{flag:'wx',mode:0o600});return {name,existed:true,originalHash:sha(bytes),qaHashes:[]};});
    record={version:1,namespace,directory,gateway,platform,workspace,files,stage:'backed-up',preparedAt:new Date().toISOString(),identities:[]};save(record);
    }
    let admin;
    try{
      admin=await post('/auth/login',{username:'tokenadmin',password:input.password});input.password=undefined;
      const users=await post('/auth/admin/users',{},admin.accessToken);
      const user=users.users.find(u=>u.username==='tokenuser');assert(user);
      const code=await post('/auth/admin/pair-code',{userId:user.id},admin.accessToken);
      record.identity=native('token-pair',{code:code.code,name:`${platform} token RC acceptance`});code.code=undefined;
      assert.equal(record.identity.user.id,user.id);
      if(replacing)assert.notEqual(record.identity.deviceId,prior.deviceId,'Re-pair must produce a new device');
      record.identities.push(record.identity);record.stage='paired';save(record);
    }finally{input.password=undefined;if(admin)await post('/auth/logout',{},admin.accessToken);admin=undefined;}
    const configs=[{gatewayUrl:gateway,userId:record.identity.user.id,deviceId:record.identity.deviceId,workspaceRoot:workspace},{[origin]:ca}];
    for(let n=0;n<names.length;n++){const bytes=Buffer.from(JSON.stringify(configs[n],null,2)+'\n');record.files[n].qaHashes.push(sha(bytes));save(record);writeFileSync(join(directory,names[n]),bytes);}
    record.stage='configured';save(record);
    console.log(JSON.stringify({ok:true,recordPath,workspace,identity:record.identity,status:native('token-status')}));
  }
}catch{console.error('TOKEN_CLIENT_QA_FAILED: preserve QA record and inspect public status; sensitive output suppressed');process.exitCode=1;}
