// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Run on the developer Windows worktree. Credentials enter stdin and stay in memory.
// Never starts/stops a desktop or Agent and never logs out its native session.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import https from 'node:https';
import {WebSocket} from 'ws';

const origin='https://192.0.2.10:4529',gateway='wss://192.0.2.10:4529/ws';
const ca=await readFile(resolve('target/harness-deploy/p5-rc-server-ca.pem'));
const checks=[],sockets=[];let token,resultPath,result,input;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeError=error=>String(error?.message??error).match(/\b(?:REMOTE_WORKSPACE_CHANGED|AUTH_REQUIRED|DEVICE_REVOKED|DEVICE_CERTIFICATE_[A-Z_]+|AGENT_OFFLINE|MODEL_[A-Z_]+|WORKER_[A-Z_]+|COMMAND_[A-Z_]+)\b/)?.[0]??'QA_CHECK_FAILED';
function check(condition,message){if(!condition)throw Error(message);checks.push(message);console.log('PASS '+message);}
function post(path,body={},access=token){
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const req=https.request(origin+path,{method:'POST',ca,agent:false,headers:{'Content-Type':'application/json',...(access?{Authorization:'Bearer '+access}:{})}},res=>{
      let raw='',size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy();finish(Error('HTTP response limit'));return;}raw+=chunk;});
      res.on('error',()=>finish(Error('HTTP response failed')));res.on('end',()=>{let value;try{value=JSON.parse(raw);}catch{finish(Error('HTTP JSON invalid'));return;}value.ok===true?finish(undefined,value.data):finish(Error(safeError(value.error)));});
    });
    const timer=setTimeout(()=>{req.destroy();finish(Error('HTTP timeout'));},20_000);req.on('error',()=>finish(Error('HTTP request failed')));req.end(JSON.stringify(body));
  });
}
async function connect(){
  const socket=new WebSocket(`${gateway}?deviceId=${encodeURIComponent(input.deviceId)}`,{ca,headers:{Authorization:'Bearer '+token},handshakeTimeout:15_000,maxPayload:8*1024*1024});sockets.push(socket);
  const events=[],pending=new Map();let fatal;
  socket.on('message',raw=>{
    let m;try{m=JSON.parse(String(raw));}catch{fatal='WS JSON invalid';socket.terminate();return;}
    if(events.length>=20000){fatal='WS event limit';socket.terminate();return;}events.push(m);
    if(m.type==='response')pending.get(m.requestId)?.(m);
    if(m.type==='approval.request'){fatal='Unexpected model approval: read-only QA must not request mutations';socket.send(JSON.stringify({type:'approval.response',requestId:m.requestId,result:{decision:'decline'}}));}
  });
  socket.on('error',()=>{fatal??='WS transport failed';});
  socket.on('close',()=>{fatal??='WS connection closed';for(const finish of pending.values())finish({ok:false,error:fatal});pending.clear();});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',()=>reject(Error('WS connection failed')));socket.once('close',()=>reject(Error('WS closed before opening')));});
  function request(operation,payload={}){
    return new Promise((resolve,reject)=>{
      if(fatal||socket.readyState!==WebSocket.OPEN){reject(Error(fatal??'WS unavailable'));return;}
      const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error(`RPC timeout: ${operation}`));},Math.max(60_000,(payload.timeoutMs??0)+15_000));
      pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok===true?resolve(m.data):reject(Error(safeError(m.error)));});
      socket.send(JSON.stringify({type:'request',requestId,operation,payload}),error=>{if(error)pending.get(requestId)?.({ok:false,error:'WS send failed'});});
    });
  }
  return {socket,events,request,assertLive(){if(fatal)throw Error(fatal);}};
}
async function until(fn,label,timeoutMs,intervalMs=250){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await fn())return;await delay(intervalMs);}throw Error(`Timed out: ${label}`);}
function normalizePath(path){let value=path.replaceAll('\\','/').replace(/\/$/,'');if(input.platform==='win32')value=value.replace(/^\/\/\?\//,'').toLowerCase();return value;}
function shell(win,mac,timeoutMs=20_000){return {program:input.platform==='win32'?'powershell.exe':'/bin/sh',args:input.platform==='win32'?['-NoProfile','-NonInteractive','-Command',win]:['-c',mac],cwd:'.',timeoutMs};}
function commandResult(response){assert(response?.ok===true,'Agent command rejected');assert.equal(response.result?.exitCode,0,'Client command did not exit successfully');assert(response.result?.truncated===false,'Client command output truncated');return response.result;}
async function device(ui){const list=await post('/auth/devices');const found=list.devices?.find(d=>d.id===input.deviceId);assert(found&&!found.revoked,'Expected own unrevoked device');ui.assertLive();return found;}
async function markerRead(ui,path,expected){const read=await ui.request('device.workspace.read_text',{path});assert(read.ok===true&&read.result?.source==='client','Marker must be read by the real client Agent');assert.equal(read.result.content,expected,'Client marker contents mismatch');return read.result;}
async function runModel(ui,threadId,markerFile,marker){
  const begin=ui.events.length;
  const created=await ui.request('conversation.turn.create',{threadId,clientMessageId:randomUUID(),input:[{type:'text',text:`This is an authorized release-candidate acceptance. Call device_workspace_read_text exactly once to read the workspace-relative file ${markerFile}, then reply with the exact full contents. Do not modify files, run commands, request approval, repeat earlier tasks, or use other tools.`}]});
  const turnId=created.turn?.id;assert(turnId,'Model turn ID missing');
  await until(()=>{ui.assertLive();return ui.events.slice(begin).some(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turnId);},'real model read-only turn',180_000);
  const terminal=ui.events.slice(begin).find(e=>e.eventType==='turn.completed'&&e.data?.turn?.id===turnId);assert.equal(terminal.data.turn.status,'completed','Real model turn failed');
  const calls=ui.events.slice(begin).filter(e=>e.eventType==='device.tool.completed'&&e.data?.threadId===threadId&&e.data?.turnId===turnId);
  assert(calls.some(e=>e.data.tool==='device_workspace_read_text'&&e.data.status==='succeeded'),'Real model did not successfully call the client read tool');
  assert(calls.every(e=>['device_workspace_read_text','device_workspace_context'].includes(e.data.tool)),'Read-only model QA invoked another tool');
  const history=await ui.request('conversation.read',{threadId,includeTurns:true});
  const turn=history.thread?.turns?.find(t=>t.id===turnId);assert(turn,'Model turn missing from persisted history');
  const reply=turn.items?.filter(item=>item.type==='agentMessage').map(item=>item.text??'').join('\n')??'';
  assert(reply.includes(marker),'Model reply lacks unpredictable marker read from the client');
  check(true,'real central model read the client marker and retained history');return turnId;
}

try{
  let raw=Buffer.alloc(0);const inputTimer=setTimeout(()=>{process.stdin.destroy(Error('stdin timeout'));},15_000);
  try{for await(const chunk of process.stdin){assert(raw.length+chunk.length<=16_384,'Input limit');raw=Buffer.concat([raw,chunk]);}try{input=JSON.parse(raw.toString('utf8'));}catch{throw Error('Invalid stdin JSON; content suppressed');}}finally{clearTimeout(inputTimer);raw.fill(0);}
  assert(input&&typeof input.password==='string'&&input.password.length>0,'Password required on stdin');
  assert(['win32','darwin'].includes(input.platform)&&['create','resume','repaired'].includes(input.phase),'Invalid platform or phase');
  assert.equal(input.username,input.platform==='win32'?'rcwindows':'rcmac','Only this batch RC accounts are allowed');
  assert(typeof input.deviceId==='string'&&/^[a-f\d-]{36}$/i.test(input.deviceId),'Invalid device ID');assert(typeof input.workspace==='string'&&input.workspace.length>0,'Expected workspace required');
  resultPath=resolve(`target/rc-${input.platform}-${input.phase}-result.json`);await mkdir(resolve('target'),{recursive:true});
  result={ok:false,platform:input.platform,phase:input.phase,username:input.username,deviceId:input.deviceId,workspace:input.workspace,startedAt:new Date().toISOString(),checks};
  let previous;if(input.phase!=='create'){previous=JSON.parse(await readFile(resolve(`target/rc-${input.platform}-create-result.json`),'utf8'));assert(previous.ok&&previous.threadId&&previous.markerFile&&previous.marker,'Successful create result required');if(input.threadId)assert.equal(input.threadId,previous.threadId,'Requested history does not match create evidence');}
  const login=await post('/auth/login',{username:input.username,password:input.password},undefined);token=login.accessToken;input.password=undefined;assert(typeof token==='string'&&token.length>0,'Login token missing');
  result.temporaryUiSessionId=login.sessionId;
  const ui=await connect();await ui.request('session.initialize',{clientInfo:{name:'rc-native-device-acceptance',version:'1'}});
  const context=await ui.request('device.workspace.context');assert(context.ok===true&&context.result?.source==='client','Expected actual client context');
  check(context.result.os===(input.platform==='win32'?'windows':'macos')&&normalizePath(context.result.workspaceRoot)===normalizePath(input.workspace),'Agent reports the expected client OS and workspace');
  result.context={source:context.result.source,os:context.result.os,arch:context.result.arch,workspaceRoot:context.result.workspaceRoot};
  if(input.phase==='resume'){
    const resumed=await ui.request('conversation.resume',{threadId:previous.threadId});assert.equal(resumed.thread?.id,previous.threadId);assert(JSON.stringify(resumed).includes(previous.marker),'Resumed history lost marker');
    await markerRead(ui,previous.markerFile,previous.marker);check(true,'same device restores existing history and reads unchanged client marker');
    result.threadId=previous.threadId;result.markerFile=previous.markerFile;result.marker=previous.marker;
  }else{
    if(input.phase==='repaired'){
      assert.notEqual(input.deviceId,previous.deviceId,'Repaired acceptance requires a newly paired device');
      await assert.rejects(ui.request('conversation.resume',{threadId:previous.threadId}),/REMOTE_WORKSPACE_CHANGED/);ui.assertLive();
      check(true,'new device cannot resume the old device history; connection remains usable');result.previousThreadId=previous.threadId;
    }
    const markerFile=`rc-acceptance-${randomUUID()}.txt`,marker=`RC_${input.platform.toUpperCase()}_${randomUUID()}`;
    result.markerFile=markerFile;result.marker=marker;
    const created=commandResult(await ui.request('device.exec',shell(`$ErrorActionPreference='Stop'; $bytes=[System.Text.Encoding]::UTF8.GetBytes('${marker}'); $file=[System.IO.File]::Open('${markerFile}',[System.IO.FileMode]::CreateNew); try {$file.Write($bytes,0,$bytes.Length)} finally {$file.Dispose()}; (Get-Location).Path`,`set -eu; (set -C; printf '%s' '${marker}' > '${markerFile}'); /bin/pwd`)));
    check(normalizePath(created.stdout.trim())===normalizePath(input.workspace),'actual client shell writes a unique marker and reports its working directory');await markerRead(ui,markerFile,marker);check(true,'real Agent reads back the exact UTF-8 marker');
    if(input.phase==='create'){
      const before=await device(ui);assert.equal(before.certificateStatus,'valid');const expiresAt=before.certificateExpiresAt;
      assert(Number.isFinite(expiresAt)&&expiresAt>Date.now()&&expiresAt-Date.now()<180_000,'Expected short-lived isolated QA certificate');
      const seconds=Math.ceil((expiresAt-Date.now()+2_000)/1000),duration=seconds*1000,doneFile=`rc-renewal-${randomUUID()}.txt`,done=`RENEWAL_${randomUUID()}`,start=ui.events.length;
      result.renewal={oldExpiresAt:expiresAt,seconds,doneFile};
      // Attach rejection immediately while certificate samples run concurrently.
      const execution=ui.request('device.exec',shell(`$ErrorActionPreference='Stop'; Start-Sleep -Seconds ${seconds}; [System.IO.File]::WriteAllText('${doneFile}','${done}',(New-Object System.Text.UTF8Encoding($false))); Write-Output '${done}'`,`set -eu; /bin/sleep ${seconds}; (set -C; printf '%s' '${done}' > '${doneFile}'); printf '%s\\n' '${done}'`,duration+20_000)).then(value=>({value}),error=>({error}));
      let renewed;await until(async()=>{const next=await device(ui);if(next.certificateExpiresAt>expiresAt){renewed=next;return true;}return false;},'native Agent certificate renewal',duration+20_000,1000);
      check(true,'native Agent renews its certificate while a client command is running');
      const completed=await execution;if(completed.error)throw completed.error;const command=commandResult(completed.value);
      assert.equal(command.stdout.trim(),done);assert(Date.now()>expiresAt,'Long command finished before original expiry');await markerRead(ui,doneFile,done);
      check(!ui.events.slice(start).some(e=>e.type==='device.status'&&e.deviceId===input.deviceId&&e.agent==='offline'),'client command crosses old certificate expiry without device disconnect');
      result.renewal={...result.renewal,newExpiresAt:renewed.certificateExpiresAt,completedAt:new Date().toISOString(),exitCode:command.exitCode,markerVerified:true};
    }
    const thread=(await ui.request('conversation.create')).thread;assert(thread?.id,'New thread missing');result.threadId=thread.id;
    result.turnId=await runModel(ui,thread.id,markerFile,marker);await markerRead(ui,markerFile,marker);
  }
  result.ok=true;
}catch(error){
  if(!result)result={ok:false,checks};result.ok=false;result.errorCode=safeError(error);
  // Local assertion diagnostics are safe except raw transport/server responses, which are suppressed above.
  result.error=error?.code==='ERR_ASSERTION'?String(error.message).split('\n')[0]:String(error.message??'QA failure');
  console.error(JSON.stringify({ok:false,errorCode:result.errorCode,error:result.error}));process.exitCode=1;
}finally{
  if(input)input.password=undefined;for(const socket of sockets)socket.terminate();
  if(token){try{await post('/auth/logout',{},token);result.temporaryUiSessionLoggedOut=true;}catch{result.temporaryUiSessionLoggedOut=false;result.ok=false;result.cleanupError='Temporary UI session logout not confirmed';process.exitCode=1;}token=undefined;}
  result??={ok:false,checks};result.completedAt=new Date().toISOString();
  if(resultPath){await writeFile(resultPath,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,resultPath,threadId:result.threadId,checks:checks.length,temporaryUiSessionLoggedOut:result.temporaryUiSessionLoggedOut}));}
}
