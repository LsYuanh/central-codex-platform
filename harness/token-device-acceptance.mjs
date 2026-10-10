// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaGateway} from '../scripts/maintenance/operator-config.mjs';
// Developer QA only. This process never reads/decrypts a device token and never
// starts/stops an application/Agent or changes its pairing. The native relay owns WSS.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const namespace='com.centralcodex.harnessqa.rc20260909',gateway=qaGateway();
const platform=process.platform,checks=[];
const options={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];assert(['--helper','--phase'].includes(key)&&!(key in options)&&process.argv[i+1],'Usage: node harness/token-device-acceptance.mjs --helper /absolute/token-socket-qa --phase create|resume|repaired');options[key]=process.argv[i+1];}
const helper=options['--helper'],phase=options['--phase'];
assert(['win32','darwin'].includes(platform)&&['create','resume','repaired'].includes(phase),'Unsupported QA platform or phase');
assert(helper&&isAbsolute(helper),'Absolute native token-socket-qa helper path required');
const regular=path=>{const stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink(),'Expected regular public QA file');};
regular(helper);
const qaRoot=join(root,'target',`token-native-${platform}`),recordPath=join(qaRoot,'record.json');
const ca=join(root,'target/harness-deploy/p5-token-server-ca.pem');regular(ca);regular(recordPath);
const record=JSON.parse(readFileSync(recordPath,'utf8'));
const directory=platform==='win32'?join(process.env.APPDATA,namespace):join(process.env.HOME,'Library/Application Support',namespace);
const workspace=join(qaRoot,'workspace');
assert.equal(record.version,1);assert.equal(record.namespace,namespace);assert.equal(record.gateway,gateway);assert.equal(record.directory,directory);
assert.equal(record.platform,platform);assert.equal(record.workspace,workspace);assert.equal(record.stage,'configured');
assert.equal(record.identity?.authMode,'device-token-v1');assert(record.identity.paired&&record.identity.deviceId&&record.identity.deviceKey&&record.identity.user?.id,'Configured public token identity required');
const resultPath=join(qaRoot,`acceptance-${phase}-${Date.now()}.json`),createPath=join(qaRoot,'acceptance-create.json');
let previous;
if(phase==='create')assert(!existsSync(createPath),'Preserve completed create evidence; choose resume/repaired');
else{
  regular(createPath);previous=JSON.parse(readFileSync(createPath,'utf8'));
  assert(previous.ok&&previous.threadId&&previous.marker&&previous.markerFile,'Completed create evidence required');
  assert.equal(previous.namespace,namespace);assert.equal(previous.workspace,workspace);assert.equal(previous.userId,record.identity.user.id);
  if(phase==='resume')assert.equal(record.identity.deviceId,previous.deviceId,'Resume must keep the same paired device');
  else assert.notEqual(record.identity.deviceId,previous.deviceId,'Repaired phase requires a new paired device');
}
const result={ok:false,namespace,platform,phase,workspace,deviceId:record.identity.deviceId,userId:record.identity.user.id,startedAt:new Date().toISOString(),checks};
const safeError=error=>String(error?.message??error).match(/\b(?:REMOTE_WORKSPACE_CHANGED|AUTH_REQUIRED|DEVICE_REVOKED|AUTH_MODE_UNSUPPORTED|AGENT_OFFLINE|MODEL_[A-Z_]+|WORKER_[A-Z_]+|COMMAND_[A-Z_]+|TOKEN_SOCKET_QA_[A-Z_]+)\b/)?.[0]??'TOKEN_QA_CHECK_FAILED';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(condition,label){assert(condition,label);checks.push(label);console.log('PASS '+label);}
function normalizePath(path){let value=path.replaceAll('\\','/').replace(/\/$/,'');if(platform==='win32')value=value.replace(/^\/\/\?\//,'').toLowerCase();return value;}
function shell(win,mac){return {program:platform==='win32'?'powershell.exe':'/bin/sh',args:platform==='win32'?['-NoProfile','-NonInteractive','-Command',win]:['-c',mac],cwd:'.',timeoutMs:20000};}
function commandResult(value){assert(value?.ok===true,'Real Agent command rejected');assert.equal(value.result?.exitCode,0,'Client command failed');assert.equal(value.result?.truncated,false,'Client command was truncated');return value.result;}
let relay;
async function connect(){
  const child=spawn(helper,[],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let fatal,buffer='',stderr='',ready=false,closing=false;const events=[],pending=new Map();
  let readyResolve,readyReject;const connected=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const closed=new Promise(resolve=>child.once('close',resolve));
  function fail(code){fatal??=code;readyReject(Error(fatal));for(const finish of pending.values())finish({ok:false,error:fatal});pending.clear();}
  child.on('error',()=>fail('TOKEN_SOCKET_QA_PROCESS_FAILED'));child.stdin.on('error',()=>fail('TOKEN_SOCKET_QA_STDIN_CLOSED'));
  child.stderr.on('data',bytes=>{if(stderr.length<4096)stderr+=bytes.toString('utf8').slice(0,4096-stderr.length);});
  child.on('close',()=>{if(!closing)fail(safeError(stderr)||'TOKEN_SOCKET_QA_CLOSED');});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',part=>{
    buffer+=part;
    if(Buffer.byteLength(buffer)>2*1024*1024){fail('TOKEN_SOCKET_QA_FRAME_LIMIT');child.kill();return;}
    for(;;){
      const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      let message;try{message=JSON.parse(line);}catch{fail('TOKEN_SOCKET_QA_FRAME_INVALID');child.kill();return;}
      if(message.type==='qa.relay.ready'){
        if(ready||message.authMode!=='device-token-v1'||message.deviceId!==record.identity.deviceId||message.deviceKey!==record.identity.deviceKey||message.userId!==record.identity.user.id){fail('TOKEN_SOCKET_QA_IDENTITY_MISMATCH');child.kill();return;}
        ready=true;readyResolve();continue;
      }
      if(!ready||events.length>=20000){fail('TOKEN_SOCKET_QA_EVENT_LIMIT');child.kill();return;}events.push(message);
      if(message.type==='response')pending.get(message.requestId)?.(message);
      if(message.type==='approval.request'){
        child.stdin.write(JSON.stringify({type:'approval.response',requestId:message.requestId,result:{decision:'decline'}})+'\n');
        fail('TOKEN_SOCKET_QA_UNEXPECTED_APPROVAL');
      }
    }
  });
  const api={events,assertLive(){if(fatal)throw Error(fatal);},
    request(operation,payload={}){
      return new Promise((resolve,reject)=>{
        if(fatal||!ready){reject(Error(fatal??'TOKEN_SOCKET_QA_NOT_READY'));return;}
        const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('TOKEN_SOCKET_QA_RPC_TIMEOUT'));},60000);
        pending.set(requestId,value=>{clearTimeout(timer);pending.delete(requestId);value.ok===true?resolve(value.data):reject(Error(safeError(value.error)));});
        child.stdin.write(JSON.stringify({type:'request',requestId,operation,payload})+'\n',error=>{if(error)pending.get(requestId)?.({ok:false,error:'TOKEN_SOCKET_QA_SEND_FAILED'});});
      });
    },
    async close(){
      closing=true;child.stdin.end();const timer=setTimeout(()=>child.kill(),4000);await closed;clearTimeout(timer);
      for(const finish of pending.values())finish({ok:false,error:'TOKEN_SOCKET_QA_CLOSED'});pending.clear();
    },
  };
  relay=api;
  child.stdin.write(JSON.stringify({namespace,gateway,ca,'token-root':directory})+'\n');
  const timer=setTimeout(()=>{fail('TOKEN_SOCKET_QA_SETUP_TIMEOUT');child.kill();},30000);
  try{await connected;}finally{clearTimeout(timer);}
  return api;
}
async function until(ui,fn,label,timeoutMs=180000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){ui.assertLive();if(fn())return;await delay(250);}throw Error(label+' timeout');}
async function markerRead(ui,path,expected){const value=await ui.request('device.workspace.read_text',{path});assert(value.ok===true&&value.result?.source==='client','Marker must come from the actual client Agent');assert.equal(value.result.content,expected,'Client marker mismatch');}
async function runModel(ui,threadId,markerFile,marker){
  const start=ui.events.length;
  const created=await ui.request('conversation.turn.create',{threadId,clientMessageId:randomUUID(),input:[{type:'text',text:`This is an authorized isolated device-token acceptance. Call device_workspace_read_text exactly once to read the workspace-relative file ${markerFile}, then reply with its exact full contents. Do not modify files, run commands, request approval, repeat earlier tasks, or use other tools.`}]});
  const turnId=created.turn?.id;assert(turnId,'Central model turn ID missing');
  await until(ui,()=>ui.events.slice(start).some(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turnId),'Central read-only model turn');
  const terminal=ui.events.slice(start).find(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turnId);assert.equal(terminal.data.turn.status,'completed');
  const calls=ui.events.slice(start).filter(e=>e.eventType==='device.tool.completed'&&e.data?.threadId===threadId&&e.data?.turnId===turnId);
  assert(calls.some(e=>e.data.tool==='device_workspace_read_text'&&e.data.status==='succeeded'),'Model did not read through the real client Agent');
  assert(calls.every(e=>['device_workspace_read_text','device_workspace_context'].includes(e.data.tool)),'Model attempted an unexpected tool');
  const history=await ui.request('conversation.read',{threadId,includeTurns:true});const turn=history.thread?.turns?.find(t=>t.id===turnId);assert(turn,'Completed turn was not persisted');
  const reply=turn.items?.filter(i=>i.type==='agentMessage').map(i=>i.text??'').join('\n')??'';assert(reply.includes(marker),'Model reply lacks unpredictable client marker');
  check(true,'real central model reads the client marker and retains the completed history');return turnId;
}
try{
  const ui=await connect();check(true,'native relay authenticates the configured device without exposing its token');
  await ui.request('session.initialize',{clientInfo:{name:'device-token-native-acceptance',version:'1'}});
  let context;const agentDeadline=Date.now()+20000;
  while(!context){try{context=await ui.request('device.workspace.context');}catch(error){if(!/AGENT_OFFLINE/.test(String(error))||Date.now()>=agentDeadline)throw error;await delay(250);}}
  assert(context.ok===true&&context.result?.source==='client','Expected actual client context');
  check(context.result.os===(platform==='win32'?'windows':'macos')&&normalizePath(context.result.workspaceRoot)===normalizePath(workspace),'real Agent reports the expected client OS and workspace');
  result.context={source:context.result.source,os:context.result.os,arch:context.result.arch,workspaceRoot:context.result.workspaceRoot};
  if(phase==='resume'){
    const resumed=await ui.request('conversation.resume',{threadId:previous.threadId});assert.equal(resumed.thread?.id,previous.threadId);assert(JSON.stringify(resumed).includes(previous.marker),'Persisted marker missing from resumed history');
    await markerRead(ui,previous.markerFile,previous.marker);check(true,'same device restores the old history and reads its unchanged client marker');
    result.threadId=previous.threadId;result.markerFile=previous.markerFile;result.marker=previous.marker;
  }else{
    if(phase==='repaired'){
      await assert.rejects(ui.request('conversation.resume',{threadId:previous.threadId}),/REMOTE_WORKSPACE_CHANGED/);ui.assertLive();
      check(true,'repaired device cannot resume the old device binding and retains a usable connection');result.previousThreadId=previous.threadId;
    }
    const markerFile=`token-acceptance-${randomUUID()}.txt`,marker=`TOKEN_${platform.toUpperCase()}_${randomUUID()}`;
    result.markerFile=markerFile;result.marker=marker;
    const wrote=commandResult(await ui.request('device.exec',shell(`$ErrorActionPreference='Stop'; $bytes=[System.Text.Encoding]::UTF8.GetBytes('${marker}'); $file=[System.IO.File]::Open('${markerFile}',[System.IO.FileMode]::CreateNew); try {$file.Write($bytes,0,$bytes.Length)} finally {$file.Dispose()}; (Get-Location).Path`,`set -eu; (set -C; printf '%s' '${marker}' > '${markerFile}'); /bin/pwd`)));
    check(normalizePath(wrote.stdout.trim())===normalizePath(workspace),'actual client shell writes a unique marker in the selected workspace');
    await markerRead(ui,markerFile,marker);check(true,'real Agent reads back the exact UTF-8 marker');
    const thread=(await ui.request('conversation.create')).thread;assert(thread?.id,'New thread missing');result.threadId=thread.id;
    result.turnId=await runModel(ui,thread.id,markerFile,marker);await markerRead(ui,markerFile,marker);
  }
  result.ok=true;
}catch(error){
  result.errorCode=safeError(error);result.error=error?.code==='ERR_ASSERTION'?String(error.message).split('\n')[0]:result.errorCode;
  console.error(JSON.stringify({ok:false,errorCode:result.errorCode,error:result.error}));process.exitCode=1;
}finally{
  if(relay)await relay.close();result.completedAt=new Date().toISOString();
  await writeFile(resultPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  if(result.ok&&phase==='create')await writeFile(createPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ok:result.ok,resultPath,threadId:result.threadId,checks:checks.length,devicePairingPreserved:true}));
}
