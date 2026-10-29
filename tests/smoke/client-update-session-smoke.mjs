// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Local Agent/processes, loopback protocol fixture; no model or installer.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {createEnvelope} from '@central-codex-spike/agentrpc-types';
import {localAgentExecutable} from './client-smoke-platform.mjs';
const root=await mkdtemp(resolve('target/update-session-agent-'));
const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
let socket,connections=0,agentLog='';const pending=new Map(),ipcPending=new Map();
const until=async(fn,label,ms=12000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await delay(30);}throw Error('Timed out: '+label+' '+agentLog.slice(-800));};
server.on('connection',current=>current.on('message',raw=>{
 const m=JSON.parse(String(raw));
 if(m.type==='agent.hello'){
  assert(m.payload.agent.capabilities.includes('exec-sessions/v1'));
  current.send(JSON.stringify(createEnvelope('agent.hello_ack',{accepted:true,server:'update-session-fixture',capabilities:['agent.event','job.cancel'],heartbeatIntervalMs:10000})));
  socket=current;connections++;
 }
 if(m.type==='agent.response')pending.get(m.requestId)?.(m.payload);
}));
const agent=spawn(localAgentExecutable(),['--workspace-root',root,'--gateway-url',`ws://127.0.0.1:${server.address().port}`,'--attachment-stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
agent.stderr.on('data',d=>agentLog+=d);
createInterface({input:agent.stdout}).on('line',line=>{const m=JSON.parse(line);ipcPending.get(m.id)?.(m);});
function request(map,send){return new Promise((resolve,reject)=>{
 const id=randomUUID(),timer=setTimeout(()=>{map.delete(id);reject(Error('Agent request timed out'));},10000);
 map.set(id,result=>{clearTimeout(timer);map.delete(id);resolve(result);});send(id);
});}
const exec=params=>request(pending,id=>socket.send(JSON.stringify(createEnvelope('agent.request',{method:'exec',params:{...params,__sessionOwner:'update-smoke-owner'},operationId:id,idempotencyKey:id},{requestId:id}))));
const poll=sessionId=>exec({sessionId,program:'',args:[],yieldMs:0,offset:0});
const restart=()=>request(ipcPending,id=>agent.stdin.write(JSON.stringify({id,method:'runtime/prepare_restart',params:{}})+'\n'));
const transportRestart=()=>request(ipcPending,id=>agent.stdin.write(JSON.stringify({id,method:'runtime/prepare_transport_restart',params:{}})+'\n'));
const command=long=>process.platform==='win32'?{program:'powershell',args:['-NoProfile','-Command',long?'Start-Sleep -Seconds 30':'Start-Sleep -Milliseconds 800; Set-Content -LiteralPath finished.txt -Value done'],yieldMs:0}:{program:'/bin/sh',args:['-c',long?'sleep 30':'sleep 0.8; printf done > finished.txt'],yieldMs:0};
try{
 await until(()=>connections===1,'Agent ready');
 const first=await exec(command(false));assert.equal(first.ok,true);assert.equal(first.result.running,true);
 assert.equal((await poll(first.result.sessionId)).result.running,true);
 const busy=await restart();assert.equal(busy.ok,false);assert.match(busy.error,/AGENT_BUSY/);
 const routeBusy=await transportRestart();assert.equal(routeBusy.ok,false);assert.match(routeBusy.error,/AGENT_BUSY/);
 await until(async()=>{try{await access(join(root,'finished.txt'));return true;}catch{return false;}},'actual command finishes without polling');
 let ended;await until(async()=>{ended=await poll(first.result.sessionId);return ended.result?.running===false;},'authoritative terminal result');
 assert.equal(ended.result.sessionId,first.result.sessionId);assert.equal(ended.result.completion.ok,true);
 const second=await exec(command(true));assert.equal(second.result.running,true);
 socket.close();await until(()=>connections===2,'Agent reconnect after session cleanup');
 const missing=await poll(second.result.sessionId);assert.equal(missing.ok,false);assert.equal(missing.error,'COMMAND_SESSION_NOT_FOUND');
 // Keep TCP open but stop reading, matching a disappeared network interface.
 const blackhole=socket;blackhole._socket.pause();
 await until(()=>connections===3,'half-open connection heartbeat recovery',45000);
 blackhole._socket.resume();blackhole.terminate();
 assert.deepEqual(await restart().then(r=>({ok:r.ok,result:r.result})),{ok:true,result:{ready:true}});
 const oldSocket=socket;const drained=new Promise(resolve=>oldSocket.once('close',resolve));
 assert.equal((await transportRestart()).ok,true);await drained;
 assert.equal(oldSocket.readyState,3,'idle transport closes before parent replaces Agent');
 console.log(JSON.stringify({ok:true,root,checks:['real yielded command keeps local and transport restart guards busy','command finishes without model poll','terminal completion response','reconnect closes sessions and returns exact NOT_FOUND','half-open connection recovers without command replay','idle transport closes before parent replacement','local restart only ready after process cleanup']}));
}finally{
 if(agent.exitCode===null){const exited=new Promise(r=>agent.once('exit',r));agent.kill();await exited;}
 for(const client of server.clients)client.terminate();await new Promise(r=>server.close(r));
}
