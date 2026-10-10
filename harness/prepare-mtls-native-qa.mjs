// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaGateway, qaOrigin} from '../scripts/maintenance/operator-config.mjs';
// Local QA only. Passwords enter the native helper over stdin, never the renderer.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

export const namespace='com.centralcodex.harnessqa20260909';
export const gateway=qaGateway();
export const origin=qaOrigin();
export const ca=resolve('target/harness-deploy/p5-mtls-server-ca.pem');
export const binary=resolve('target/harness-agent/debug/examples/platform-acceptance.exe');
export const desktop=resolve('target/harness-agent/debug/desktop-spike.exe');
export const agent=resolve('target/harness-agent/debug/local-agent.exe');
export const directory=join(process.env.APPDATA??'',namespace);
export const recordPath=resolve('target/harness-mtls-native.json');
export const names=['desktop-runtime-v1.json','platform-ca-v1.json'];
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function regular(path){assert(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink(),`Expected regular QA file: ${path}`);}
export function native(input,{allowFailure=false}={}){
  const result=spawnSync(binary,[],{input:JSON.stringify({gateway,ca,...input}),encoding:'utf8',windowsHide:true,timeout:120_000,maxBuffer:1024*1024});
  if(result.status!==0){if(allowFailure)return {ok:false};throw Error(`Native QA ${input.action} failed (exit ${result.status}); no credential output retained`);}
  let value;try{value=JSON.parse(result.stdout);}catch{throw Error('Invalid native QA response');}
  assert.equal(value.ok,true,'Native QA request failed');return {ok:true,data:value.data};
}
function powershell(code){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:30_000});
  assert.equal(result.status,0,'Cannot establish isolated QA process/vault state; nothing may be overwritten');
  return JSON.parse(result.stdout.trim());
}
export function assertStopped(){
  const value=powershell(`$ErrorActionPreference='Stop'; $paths=@('${desktop.replaceAll("'","''")}','${agent.replaceAll("'","''")}'); $found=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('desktop-spike.exe','local-agent.exe') } | Where-Object { -not $_.ExecutablePath -or $paths -contains $_.ExecutablePath }); @{stopped=($found.Count -eq 0)} | ConvertTo-Json -Compress`);
  assert.equal(value.stopped,true,'Close the isolated QA desktop/Agent before preparation or cleanup');
}
export function vaultCount(){
  // Enumerate target names only. CredentialBlob is never inspected or emitted.
  const code=`$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MtlsQaVaultProbe {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr credentials);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
 public static int Count(string ns) {
  uint count; IntPtr entries;
  if(!CredEnumerateW(null,0,out count,out entries)) { int error=Marshal.GetLastWin32Error(); if(error==1168)return 0; throw new InvalidOperationException("Credential metadata unavailable"); }
  int found=0;
  try { for(int i=0;i<count;i++) { IntPtr item=Marshal.ReadIntPtr(entries,i*IntPtr.Size); string target=Marshal.PtrToStringUni(Marshal.ReadIntPtr(item,8)); if(target!=null && (target.EndsWith("."+ns+".platform-v1",StringComparison.Ordinal) || target.EndsWith("."+ns+".device-tls-v1.key",StringComparison.Ordinal) || target.EndsWith("."+ns+".device-tls-v1.certificate",StringComparison.Ordinal)))found++; } } finally { CredFree(entries); }
  return found;
 }
}
'@
@{count=[MtlsQaVaultProbe]::Count('${namespace}')} | ConvertTo-Json -Compress`;
  return powershell(code).count;
}
export function writeRecord(record){writeFileSync(recordPath,JSON.stringify(record,null,2)+'\n');}
function main(){
  assert.equal(process.platform,'win32','Windows QA only');assert(process.env.APPDATA,'APPDATA required');
  assertStopped();const count=vaultCount();
  assert.equal(count,0,'QA namespace already contains credentials; preserve them and ask root to build a new QA identifier');
  if(process.argv.includes('--check-only')){console.log(JSON.stringify({ok:true,namespace,existingCredentials:count,processesStopped:true}));return;}
  assert(!existsSync(recordPath),'Existing mTLS QA preparation record must be reviewed; refusing to overwrite');
  for(const file of [binary,desktop,agent,ca])regular(file);
  if(existsSync(directory))assert(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'QA config directory must not be a link');
  mkdirSync(resolve('target'),{recursive:true});
  const backup=mkdtempSync(resolve('target/harness-mtls-native-backup-'));
  const files=names.map(name=>{
    const path=join(directory,name),existed=existsSync(path);
    if(!existed)return {name,existed:false};
    regular(path);const bytes=readFileSync(path);writeFileSync(join(backup,name),bytes,{flag:'wx'});
    return {name,existed:true,originalHash:hash(bytes)};
  });
  const workspace=resolve('target/harness-mtls-qa-workspace');
  const record={version:1,namespace,gateway,ca,workspace,backup,files,initialVaultCount:0,preparedAt:new Date().toISOString(),stage:'backed-up',binaryHashes:{helper:hash(readFileSync(binary)),desktop:hash(readFileSync(desktop)),agent:hash(readFileSync(agent))}};
  writeFileSync(recordPath,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  let password=native({namespace:'com.centralcodex.harnessqa.p5.bootstrap',action:'fixture-get'}).data.password;
  assert.equal(typeof password,'string');assert(password.length>0);
  record.stage='setup-started';writeRecord(record);
  let identity;try{identity=native({namespace,action:'setup',username:'mtlsalice',password,name:'P5 mTLS 原生 QA 设备'}).data;}finally{password=undefined;}
  assert(identity.deviceId&&identity.userId&&identity.sessionId,'Missing native pairing identity');
  record.identity=identity;record.stage='paired';writeRecord(record);
  mkdirSync(workspace,{recursive:true});mkdirSync(directory,{recursive:true});
  const configs=[{gatewayUrl:gateway,userId:identity.userId,deviceId:identity.deviceId,workspaceRoot:workspace},{[origin]:ca}];
  for(let i=0;i<names.length;i++){
    const file=files[i],path=join(directory,file.name),bytes=Buffer.from(JSON.stringify(configs[i],null,2)+'\n');
    if(file.existed)assert.equal(hash(readFileSync(path)),file.originalHash,'Original QA config changed during setup; preserve it');
    else assert(!existsSync(path),'New QA config appeared during setup; preserve it');
    file.qaHash=hash(bytes);writeRecord(record);writeFileSync(path,bytes);
  }
  record.stage='configured';writeRecord(record);
  console.log(JSON.stringify({ok:true,namespace,deviceId:identity.deviceId,configPrepared:true,backup,recordPath}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
