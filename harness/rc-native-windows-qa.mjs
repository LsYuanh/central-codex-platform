// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaGateway, qaOrigin} from '../scripts/maintenance/operator-config.mjs';
// Developer QA only: native secrets stay in helper stdin and the Windows vault.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const namespace='com.centralcodex.harnessqa.rc20260909';
const gateway=qaGateway(),origin=qaOrigin();
const username='rcwindows',productName='远舟 RC 20260909';
const helper=join(root,'target/harness-agent/debug/examples/platform-acceptance.exe');
const ca=join(root,'target/harness-deploy/p5-rc-server-ca.pem');
const installDirectory=join(process.env.LOCALAPPDATA??'',productName);
const desktop=join(installDirectory,'yuan-zhou-rc.exe'),agent=join(installDirectory,'local-agent.exe');
// Windows redirects files created by the packaged Codex host into this physical
// LocalCache directory. This exact alias was observed in the RC1 process list.
const packagedInstallDirectory=join(process.env.LOCALAPPDATA??'','Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local',productName);
const agentPaths=[agent,join(packagedInstallDirectory,'local-agent.exe')];
const directory=join(process.env.APPDATA??'',namespace);
const qaRoot=join(root,'target/rc-native-windows'),workspace=join(qaRoot,'workspace');
const backup=join(qaRoot,'backup'),recordPath=join(qaRoot,'record.json');
const names=['desktop-runtime-v1.json','platform-ca-v1.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const psQuote=value=>"'"+value.replaceAll("'","''")+"'";
function regular(path){const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink(),`Expected regular QA file: ${path}`);}
function plainDirectory(path){const st=lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink(),`Expected plain QA directory: ${path}`);}
function powershell(code){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${code}`],{encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:1024*1024});
  assert.equal(result.status,0,'Cannot establish RC process/vault metadata; preserve existing state');
  return JSON.parse(result.stdout.trim());
}
export function processState(){
  return powershell(`$ErrorActionPreference='Stop'; $paths=@(${agentPaths.map(psQuote).join(',')}); $all=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('yuan-zhou-rc.exe','local-agent.exe') }); $rc=@($all | Where-Object { $_.Name -eq 'yuan-zhou-rc.exe' }); $rcPids=@($rc | ForEach-Object { $_.ProcessId }); foreach($p in $rc) { if($p.ExecutablePath) { $paths+=Join-Path (Split-Path -Parent $p.ExecutablePath) 'local-agent.exe' } }; $found=@($all | Where-Object { $_.Name -eq 'yuan-zhou-rc.exe' -or -not $_.ExecutablePath -or $paths -contains $_.ExecutablePath -or $rcPids -contains $_.ParentProcessId } | ForEach-Object { @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;path=$_.ExecutablePath} }); @{stopped=($found.Count -eq 0);processes=$found;agentPaths=$paths} | ConvertTo-Json -Depth 4 -Compress`);
}
function assertStopped(){assert.equal(processState().stopped,true,'Close the installed RC application and its Agent before this action');}
function vaultCount(){
  // Only target metadata is inspected; CredentialBlob is never read.
  return powershell(`$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RcQaVaultProbe {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr credentials);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
 public static int Count(string ns) {
  uint count; IntPtr entries;
  if(!CredEnumerateW(null,0,out count,out entries)) { if(Marshal.GetLastWin32Error()==1168)return 0; throw new InvalidOperationException("Credential metadata unavailable"); }
  int found=0;
  try { for(int i=0;i<count;i++) { IntPtr item=Marshal.ReadIntPtr(entries,i*IntPtr.Size); string target=Marshal.PtrToStringUni(Marshal.ReadIntPtr(item,8)); if(target!=null && (target.EndsWith("."+ns+".platform-v1",StringComparison.Ordinal) || target.EndsWith("."+ns+".device-tls-v1.key",StringComparison.Ordinal) || target.EndsWith("."+ns+".device-tls-v1.certificate",StringComparison.Ordinal)))found++; } } finally { CredFree(entries); }
  return found;
 }
}
'@
@{count=[RcQaVaultProbe]::Count('${namespace}')} | ConvertTo-Json -Compress`).count;
}
function native(action,extra={},allowFailure=false){
  regular(helper);regular(ca);
  const result=spawnSync(helper,[],{input:JSON.stringify({namespace,gateway,ca,action,...extra}),encoding:'utf8',windowsHide:true,timeout:120_000,maxBuffer:1024*1024});
  if(result.status!==0){if(allowFailure)return null;throw Error(`Native RC ${action} failed (exit ${result.status}); credential output omitted`);}
  let value;try{value=JSON.parse(result.stdout);}catch{throw Error('Invalid native RC response; output omitted');}
  assert.equal(value.ok,true,'Native RC request failed');return value.data;
}
function publicCertificate(value){
  return Object.fromEntries(['state','expiresAt','renewAfter','fingerprint','error'].filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
}
function setup(){
  let password=native('fixture-get',{namespace:'com.centralcodex.harnessqa.p5.bootstrap'}).password;
  assert(typeof password==='string'&&password.length>0,'QA bootstrap password missing');
  let result;try{result=native('setup',{username,password,name:'Windows RC 原生验收设备'});}finally{password=undefined;}
  for(const key of ['userId','deviceId','deviceKey','sessionId'])assert(typeof result[key]==='string'&&result[key].length>0,`Missing public RC ${key}`);
  return {userId:result.userId,deviceId:result.deviceId,deviceKey:result.deviceKey,sessionId:result.sessionId,certificate:publicCertificate(result.certificate)};
}
function writeRecord(record){
  const temp=join(qaRoot,`record-${randomUUID()}.tmp`);
  writeFileSync(temp,JSON.stringify(record,null,2)+'\n',{flag:'wx'});renameSync(temp,recordPath);
}
function readRecord(){
  plainDirectory(qaRoot);plainDirectory(backup);regular(recordPath);
  const r=JSON.parse(readFileSync(recordPath,'utf8'));
  assert.equal(r.version,1);assert.equal(r.namespace,namespace);assert.equal(r.gateway,gateway);assert.equal(r.username,username);
  assert.equal(r.ca,ca);assert.equal(r.directory,directory);assert.equal(r.workspace,workspace);assert.equal(r.backup,backup);assert.equal(r.initialVaultCount,0);
  assert.deepEqual(r.files.map(file=>file.name),names);
  return r;
}
function verifyFiles(record){
  if(existsSync(directory))plainDirectory(directory);
  for(const f of record.files){
    const file=join(directory,f.name),original=join(backup,f.name);
    if(f.existed){regular(original);assert.equal(hash(readFileSync(original)),f.originalHash,'Original RC backup changed');}
    else assert(!existsSync(original),'Unexpected RC backup file');
    if(existsSync(file)){
      regular(file);const digest=hash(readFileSync(file));
      assert((f.qaHashes??[]).includes(digest)||(f.existed&&digest===f.originalHash),'RC config changed outside this QA record; preserve it');
    }else assert(!f.existed,'Original RC config disappeared; preserve remaining state');
  }
}
function writeConfiguration(record){
  verifyFiles(record);mkdirSync(workspace,{recursive:true});plainDirectory(workspace);
  mkdirSync(directory,{recursive:true});plainDirectory(directory);
  const configs=[{gatewayUrl:gateway,userId:record.identity.userId,deviceId:record.identity.deviceId,workspaceRoot:workspace},{[origin]:ca}];
  for(let i=0;i<names.length;i++){
    const bytes=Buffer.from(JSON.stringify(configs[i],null,2)+'\n'),f=record.files[i],digest=hash(bytes);
    f.qaHashes??=[];if(!f.qaHashes.includes(digest))f.qaHashes.push(digest);
    writeRecord(record);writeFileSync(join(directory,f.name),bytes);
  }
  record.stage='configured';writeRecord(record);
}
function prepare(){
  assertStopped();assert.equal(vaultCount(),0,'RC namespace already has credentials; preserve them');
  assert(!existsSync(qaRoot),'Existing RC QA directory must be reviewed; refusing to overwrite');
  for(const f of [helper,ca,desktop,agent])regular(f);plainDirectory(installDirectory);
  const version=powershell(`$ErrorActionPreference='Stop'; $v=(Get-Item -LiteralPath ${psQuote(desktop)}).VersionInfo; @{productName=$v.ProductName;productVersion=$v.ProductVersion} | ConvertTo-Json -Compress`);
  assert.equal(version.productName,productName,'Installed binary is not the isolated RC product');
  if(existsSync(directory))plainDirectory(directory);
  mkdirSync(backup,{recursive:true});
  const files=names.map(name=>{
    const file=join(directory,name);if(!existsSync(file))return {name,existed:false,qaHashes:[]};
    regular(file);const bytes=readFileSync(file);writeFileSync(join(backup,name),bytes,{flag:'wx'});
    return {name,existed:true,originalHash:hash(bytes),qaHashes:[]};
  });
  const record={version:1,namespace,gateway,username,ca,directory,workspace,backup,files,initialVaultCount:0,preparedAt:new Date().toISOString(),stage:'backed-up',installedVersion:version.productVersion,
    binaryHashes:{helper:hash(readFileSync(helper)),desktop:hash(readFileSync(desktop)),agent:hash(readFileSync(agent))},identities:[]};
  writeRecord(record);record.stage='setup-started';writeRecord(record);
  record.identity=setup();record.identities.push(record.identity);record.stage='paired';writeRecord(record);
  writeConfiguration(record);
  return {ok:true,namespace,recordPath,workspace,identity:record.identity,configPrepared:true};
}
function rePair(){
  assertStopped();const record=readRecord();assert.equal(record.stage,'configured','RC must be configured before re-pairing');verifyFiles(record);
  assert(vaultCount()>0,'RC credentials are missing');
  const oldIdentity=record.identity;
  record.stage='re-pair-started';writeRecord(record);
  const newIdentity=setup();
  assert.equal(newIdentity.userId,oldIdentity.userId,'Re-pair must preserve the RC platform user');
  assert.notEqual(newIdentity.deviceId,oldIdentity.deviceId,'Re-pair must create a new device');
  assert.notEqual(newIdentity.sessionId,oldIdentity.sessionId,'Re-pair must create a new platform session');
  record.identity=newIdentity;record.identities.push(newIdentity);
  record.rePairs??=[];record.rePairs.push({at:new Date().toISOString(),oldIdentity,newIdentity});record.stage='paired';writeRecord(record);
  writeConfiguration(record);
  return {ok:true,oldIdentity,newIdentity,configPrepared:true,oldCentralDeviceRequiresQaCleanup:true};
}
function status(){
  const processes=processState(),count=vaultCount();
  const record=existsSync(recordPath)?readRecord():null;
  const certificate=count>0?native('certificate-status',{},true):null;
  return {ok:true,namespace,recordPath,stage:record?.stage??'not-prepared',identity:record?.identity??null,vaultEntries:count,
    certificate:certificate?publicCertificate(certificate):null,...processes};
}
function cleanup(){
  assertStopped();const record=readRecord();verifyFiles(record);
  if(record.stage==='cleaned'){
    assert.equal(vaultCount(),0,'New RC credentials appeared after cleanup');
    for(const f of record.files){const file=join(directory,f.name);if(f.existed)assert.equal(hash(readFileSync(file)),f.originalHash);else assert(!existsSync(file),'RC config reappeared after cleanup');}
    return {ok:true,alreadyCleaned:true,...record.cleanup};
  }
  let remoteLogoutConfirmed=false;
  if(vaultCount()>0){
    assert(['setup-started','paired','configured','re-pair-started'].includes(record.stage),'Unexpected RC credentials before pairing; preserve them');
    remoteLogoutConfirmed=native('logout',{},true)!==null;
    if(!remoteLogoutConfirmed)native('cleanup');
  }
  assert.equal(vaultCount(),0,'RC credential entries remain; cleanup is incomplete');
  for(const f of record.files){
    const file=join(directory,f.name);
    if(f.existed)writeFileSync(file,readFileSync(join(backup,f.name)));
    else if(existsSync(file))unlinkSync(file);
  }
  for(const f of record.files){const file=join(directory,f.name);if(f.existed)assert.equal(hash(readFileSync(file)),f.originalHash);else assert(!existsSync(file));}
  record.stage='cleaned';record.cleanup={at:new Date().toISOString(),remoteLogoutConfirmed,localCredentialsRemoved:true,configurationRestored:true,
    centralIdentitiesToRevoke:record.identities.map(({userId,deviceId,sessionId})=>({userId,deviceId,sessionId}))};writeRecord(record);
  return {ok:true,...record.cleanup,workspacePreserved:true,backupPreserved:true,bootstrapPreserved:true};
}
export function main(){
  assert.equal(process.platform,'win32','Windows RC QA only');
  assert(process.env.APPDATA&&isAbsolute(process.env.APPDATA),'Absolute APPDATA required');
  assert(process.env.LOCALAPPDATA&&isAbsolute(process.env.LOCALAPPDATA),'Absolute LOCALAPPDATA required');
  const [action,...extra]=process.argv.slice(2);assert(extra.length===0&&['prepare','status','cleanup','re-pair'].includes(action),'Usage: node harness/rc-native-windows-qa.mjs prepare|status|cleanup|re-pair');
  const result=({prepare,status,cleanup,'re-pair':rePair})[action]();console.log(JSON.stringify(result));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
