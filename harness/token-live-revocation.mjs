// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Windows developer QA only. Executes only when explicitly invoked.
// The native relay owns the token. This script reads no token/bootstrap contents.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.platform,'win32','Windows live revocation QA only');
assert(process.argv.length===4&&process.argv[2]==='--helper','Usage: node harness/token-live-revocation.mjs --helper target/debug/examples/token-socket-qa.exe');
const helper=resolve(root,process.argv[3]);assert.equal(helper,join(root,'target/debug/examples/token-socket-qa.exe'),'Use the fixed local QA relay helper');
const namespace='com.centralcodex.harnessqa.rc20260909',gateway='wss://192.0.2.10:4529/ws';
assert(process.env.APPDATA&&isAbsolute(process.env.APPDATA),'Absolute APPDATA required');
const qaRoot=join(root,'target/token-native-win32'),recordPath=join(qaRoot,'record.json'),workspace=join(qaRoot,'workspace');
const directory=join(process.env.APPDATA,namespace),ca=join(root,'target/harness-deploy/p5-token-server-ca.pem');
const regular=path=>{const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink(),'Expected a regular public QA file');};
for(const file of [helper,ca,recordPath])regular(file);
const record=JSON.parse(readFileSync(recordPath,'utf8'));
for(const [key,value] of Object.entries({version:1,namespace,gateway,directory,platform:'win32',workspace,stage:'configured'}))assert.equal(record[key],value,'QA record scope mismatch');
assert.equal(record.identity?.authMode,'device-token-v1');assert(record.identity.paired&&record.identity.user?.id&&record.identity.deviceId&&record.identity.deviceKey,'Configured public QA identity required');
const id=randomUUID(),readyMarker='READY_'+id,readyFile=`token-revoke-ready-${id}.json`,completionFile=`token-revoke-completed-${id}.txt`,completionMarker='COMPLETED_'+id;
const resultPath=join(qaRoot,`revocation-${Date.now()}-${id}.json`),checks=[];
const result={ok:false,namespace,gateway,platform:'win32',deviceId:record.identity.deviceId,userId:record.identity.user.id,workspace,readyFile,readyMarker,completionFile,completionMarker,startedAt:new Date().toISOString(),checks,osProcessExitValidated:false,completionAbsenceValidated:false};
const safe=error=>String(error?.message??error).match(/\b(?:TOKEN_SOCKET_QA_[A-Z_]+|DEVICE_REVOKED|AUTH_REQUIRED|AUTH_MODE_UNSUPPORTED|AGENT_OFFLINE|REVOCATION_[A-Z_]+)\b/)?.[0]??'REVOCATION_CHECK_FAILED';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,label)=>{assert(value,label);checks.push(label);console.log('PASS '+label);};
const normalize=path=>path.replaceAll('\\','/').replace(/^\/\/\?\//,'').replace(/\/$/,'').toLowerCase();
let relay;
async function connect(){
  const child=spawn(helper,[],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let ready=false,closed=false,closing=false,fatal,buffer='',stderr='';const pending=new Map();
  let readyResolve,readyReject;const connected=new Promise((r,j)=>{readyResolve=r;readyReject=j;});
  const closedPromise=new Promise(r=>child.once('close',r));
  const fail=code=>{fatal??=code;readyReject(Error(fatal));for(const finish of [...pending.values()])finish({ok:false,error:fatal});};
  child.on('error',()=>fail('TOKEN_SOCKET_QA_PROCESS_FAILED'));child.stdin.on('error',()=>fail('TOKEN_SOCKET_QA_STDIN_CLOSED'));
  child.stderr.on('data',bytes=>{if(stderr.length<4096)stderr+=bytes.toString('utf8').slice(0,4096-stderr.length);});
  child.on('close',(code,signal)=>{closed=true;result.relayExit={code,signal,at:new Date().toISOString(),initiatedByScript:closing};if(!closing)fail(safe(stderr));});
  child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{
    buffer+=part;if(Buffer.byteLength(buffer)>2*1024*1024){fail('TOKEN_SOCKET_QA_FRAME_LIMIT');child.kill();return;}
    for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let value;
      try{value=JSON.parse(line);}catch{fail('TOKEN_SOCKET_QA_FRAME_INVALID');child.kill();return;}
      if(value.type==='qa.relay.ready'){
        if(ready||value.authMode!=='device-token-v1'||value.deviceId!==record.identity.deviceId||value.deviceKey!==record.identity.deviceKey||value.userId!==record.identity.user.id){fail('TOKEN_SOCKET_QA_IDENTITY_MISMATCH');child.kill();return;}
        ready=true;readyResolve();continue;
      }
      if(!ready){fail('TOKEN_SOCKET_QA_NOT_READY');child.kill();return;}
      if(value.type==='response')pending.get(value.requestId)?.(value);
      if(value.type==='approval.request'){child.stdin.write(JSON.stringify({type:'approval.response',requestId:value.requestId,result:{decision:'decline'}})+'\n');fail('TOKEN_SOCKET_QA_UNEXPECTED_APPROVAL');}
    }
  });
  const api={get closed(){return closed;},assertLive(){if(fatal||closed)throw Error(fatal??'TOKEN_SOCKET_QA_CLOSED');},
    request(operation,payload={},timeoutMs=10000){return new Promise((r,j)=>{
      if(fatal||!ready||closed){j(Error(fatal??'TOKEN_SOCKET_QA_NOT_READY'));return;}
      const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);j(Error('TOKEN_SOCKET_QA_RPC_TIMEOUT'));},timeoutMs);
      pending.set(requestId,value=>{clearTimeout(timer);pending.delete(requestId);value.ok===true?r(value.data):j(Error(safe(value.error)));});
      child.stdin.write(JSON.stringify({type:'request',requestId,operation,payload})+'\n',error=>{if(error)pending.get(requestId)?.({ok:false,error:'TOKEN_SOCKET_QA_SEND_FAILED'});});
    });},
    async close(){if(closed)return;closing=true;child.stdin.end();const timer=setTimeout(()=>child.kill(),4000);await closedPromise;clearTimeout(timer);for(const finish of [...pending.values()])finish({ok:false,error:'TOKEN_SOCKET_QA_CLOSED'});},
  };
  relay=api;child.stdin.write(JSON.stringify({namespace,gateway,ca,'token-root':directory})+'\n');
  const timer=setTimeout(()=>{fail('TOKEN_SOCKET_QA_SETUP_TIMEOUT');child.kill();},20000);try{await connected;}finally{clearTimeout(timer);}return api;
}
function revoke(){return new Promise((resolve,reject)=>{
  // This fixed action retrieves its existing synthetic bootstrap via helper stdin;
  // it only revokes the Windows QA record's device. No SSH action is selectable here.
  const child=spawn(process.execPath,[join(root,'harness/run-token-qa.mjs'),'windows-revoke'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('REVOCATION_ADMIN_TIMEOUT'));},125000);
  child.on('error',()=>{clearTimeout(timer);reject(Error('REVOCATION_ADMIN_SPAWN_FAILED'));});
  child.stdout.on('data',bytes=>{if(stdout.length<65536)stdout+=bytes.toString('utf8').slice(0,65536-stdout.length);});child.stderr.on('data',bytes=>{if(stderr.length<4096)stderr+=bytes.toString('utf8').slice(0,4096-stderr.length);});
  child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(Error('REVOCATION_ADMIN_FAILED'));return;}try{const value=JSON.parse(stdout);assert(value.ok===true&&value.deviceId===record.identity.deviceId&&value.status?.status==='revoked');resolve({ok:true,deviceId:value.deviceId,status:'revoked',at:new Date().toISOString()});}catch{reject(Error('REVOCATION_ADMIN_RESULT_INVALID'));}});
});}
try{
  const ui=await connect();check(true,'native relay confirms the configured QA device identity');
  await ui.request('session.initialize',{clientInfo:{name:'token-live-revocation',version:'1'}});
  const context=await ui.request('device.workspace.context');check(context?.ok===true&&context.result?.source==='client'&&context.result.os==='windows'&&normalize(context.result.workspaceRoot)===normalize(workspace),'real Agent reports the expected Windows QA workspace');
  // Direct device.exec does not forward Agent output events. A CreateNew READY
  // file from the same command proves it reached execution before revocation.
  const command=`$ErrorActionPreference='Stop'; $ready=@{marker='${readyMarker}';pid=$PID;startedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress; $bytes=[System.Text.Encoding]::UTF8.GetBytes($ready); $file=[System.IO.File]::Open('${readyFile}',[System.IO.FileMode]::CreateNew); try {$file.Write($bytes,0,$bytes.Length)} finally {$file.Dispose()}; Write-Output '${readyMarker}'; [Console]::Out.Flush(); Start-Sleep -Seconds 30; $bytes=[System.Text.Encoding]::UTF8.GetBytes('${completionMarker}'); $file=[System.IO.File]::Open('${completionFile}',[System.IO.FileMode]::CreateNew); try {$file.Write($bytes,0,$bytes.Length)} finally {$file.Dispose()}`;
  result.executionRequestedAt=new Date().toISOString();const before=Date.now();
  // Attach failure handling immediately; revocation intentionally closes this request.
  const pending=ui.request('device.exec',{program:'powershell.exe',args:['-NoProfile','-NonInteractive','-Command',command],cwd:'.',timeoutMs:45000},60000).then(data=>({resolved:true,data}),error=>({resolved:false,error:safe(error)}));
  let started;
  while(Date.now()-before<10000){ui.assertLive();const read=await ui.request('device.workspace.read_text',{path:readyFile});if(read?.ok===true&&read.result?.source==='client'){try{started=JSON.parse(read.result.content);}catch{throw Error('REVOCATION_READY_INVALID');}break;}await delay(100);}
  check(started?.marker===readyMarker&&Number.isSafeInteger(started.pid)&&started.pid>0&&Number.isFinite(Date.parse(started.startedAt)),'the actual PowerShell job wrote its unique READY marker and PID before revocation');
  result.job={pid:started.pid,startedAt:started.startedAt,readyConfirmedAt:new Date().toISOString(),delaySeconds:30};
  result.revocationRequestedAt=new Date().toISOString();result.revocation=await revoke();check(true,'the existing administrator QA action confirms this device is revoked');
  const outcome=await pending;result.pendingOutcome={resolved:outcome.resolved,error:outcome.error,agentOk:outcome.data?.ok,errorCode:outcome.data?.errorCode};
  check(!outcome.resolved||outcome.data?.ok===false,'the pending device command fails when its device authorization is revoked');
  const closeDeadline=Date.now()+5000;while(!ui.closed&&Date.now()<closeDeadline)await delay(50);
  check(ui.closed&&result.relayExit?.initiatedByScript===false,'the native WSS relay closed before script cleanup');
  result.ok=true;result.requiresExternalVerification=['Confirm the recorded PowerShell PID and Local Agent exited.','After the job start time plus 30 seconds, verify the unique completion file is absent.'];
}catch(error){result.errorCode=safe(error);process.exitCode=1;}
finally{
  if(relay)await relay.close();result.completedAt=new Date().toISOString();await writeFile(resultPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ok:result.ok,resultPath,jobPid:result.job?.pid,readyFile,completionFile,checks:checks.length,requiresExternalProcessAndMarkerVerification:true,...(result.errorCode?{errorCode:result.errorCode}:{})}));
}
