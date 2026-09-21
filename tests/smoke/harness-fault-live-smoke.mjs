// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real central runtime + real Windows Agent. The relay only drops selected frames/connections.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, access, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket, WebSocketServer} from 'ws';

if (!process.env.HARNESS_GATEWAY_URL) throw Error('Explicit isolated gateway URL required');
const gateway = new URL(process.env.HARNESS_GATEWAY_URL);
assert.notEqual(gateway.port,'4510','Refusing production gateway');
const mode = process.env.HARNESS_FAULT_PHASE ?? 'transport';
assert(['transport','model','restart','runtime'].includes(mode));
const root = (await realpath(await mkdtemp(join(tmpdir(),'harness-fault-')))).replace(/^\\\\\?\\/,'');
const deviceId = `harness-fault-${randomUUID()}`;
gateway.searchParams.set('userId',deviceId); gateway.searchParams.set('deviceId',deviceId);
const remoteAgent = new URL(gateway); remoteAgent.pathname='/ws/agent'; remoteAgent.searchParams.delete('userId');
await writeFile(join(root,'AGENTS.md'),'This is an isolated fault acceptance fixture. Follow exact single attempts; never retry failed or uncertain writes. All operations use the bound Windows device.\n');
const relay = new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(r=>relay.once('listening',r));
const frames=[], checks=[], threads=[], sockets=new Set();
let pair, generation=0, responseDrop, agent;
relay.on('connection',local=>{
  const upstream=new WebSocket(remoteAgent); const queued=[];
  sockets.add(local); sockets.add(upstream); pair={local,upstream};
  upstream.on('open',()=>{for(const frame of queued) upstream.send(frame);});
  local.on('message',raw=>{
    const value=JSON.parse(String(raw)); frames.push({direction:'from-agent',value});
    if(responseDrop?.(value)){responseDrop=undefined; upstream.close();local.close();return;}
    if(upstream.readyState===WebSocket.OPEN)upstream.send(String(raw));else queued.push(String(raw));
  });
  upstream.on('message',raw=>{
    const value=JSON.parse(String(raw));frames.push({direction:'to-agent',value});
    if(value.type==='agent.hello_ack')generation++;
    if(local.readyState===WebSocket.OPEN)local.send(String(raw));
  });
  for(const [a,b] of [[local,upstream],[upstream,local]]){
    a.on('close',()=>{sockets.delete(a);b.close();});a.on('error',()=>b.close());
  }
});
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
async function until(fn,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,60));}throw Error(`Timed out: ${label}`);}
function launchAgent(){
  agent=spawn(resolve(process.env.LOCAL_AGENT_BIN??'target/harness-agent/debug/local-agent.exe'),['--workspace-root',root,'--gateway-url',`ws://127.0.0.1:${relay.address().port}/ws/agent?deviceId=${deviceId}`,'--attachment-stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  agent.stdout.resume();agent.stderr.resume();return agent;
}
async function connect(){
  const socket=new WebSocket(gateway); const events=[],pending=new Map();let approval;
  socket.on('message',raw=>{const m=JSON.parse(String(raw));events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);if(m.type==='approval.request')void approval?.(m);});
  socket.on('close',()=>{for(const finish of pending.values())finish({ok:false,error:'RESULT_UNKNOWN: UI transport closed; do not replay'});});
  await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});
  const request=(operation,payload={})=>new Promise((r,j)=>{
    if(operation==='session.initialize')payload={clientInfo:{name:'harness-fault-acceptance',version:'1'},...payload};
    const requestId=randomUUID();const timer=setTimeout(()=>{pending.delete(requestId);j(Error(`RESULT_UNKNOWN: ${operation} response timeout`));},65000);
    pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?r(m.data):j(Error(m.error));});
    socket.send(JSON.stringify({type:'request',requestId,operation,payload}));
  });
  return {socket,events,request,setApproval(fn){approval=fn;},respond(m,decision){socket.send(JSON.stringify({type:'approval.response',requestId:m.requestId,result:{decision}}));}};
}
let client;
const capture=promise=>promise.then(result=>({result}),error=>({error:String(error)}));
const command=(code,timeoutMs=6000)=>({program:process.execPath,args:['-e',code],timeoutMs});
const processAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
function slowCode(label){return `const fs=require('fs');fs.writeFileSync('${label}.pid',String(process.pid));console.log('FAULT_READY_${label}');setTimeout(()=>{fs.writeFileSync('${label}.finished','unexpected completion');process.exit(0)},30000)`;}
async function checkStopped(label){const pid=Number(await readFile(join(root,`${label}.pid`),'utf8'));await until(()=>!processAlive(pid),`${label} process exited`,10000);assert(!await exists(join(root,`${label}.finished`)));}
async function newThread(){const id=(await client.request('conversation.create')).thread.id;threads.push(id);return id;}
async function turn(threadId,text){const result=await client.request('conversation.turn.create',{threadId,clientMessageId:randomUUID(),input:[{type:'text',text}]});return result.turn.id;}
async function completed(threadId,turnId){return until(()=>client.events.find(e=>e.eventType==='turn.completed'&&e.data?.threadId===threadId&&e.data?.turn?.id===turnId),'native Turn completion',180000);}
function toolEvents(threadId,turnId){return client.events.filter(e=>e.name==='device/tool/completed'&&e.data?.threadId===threadId&&e.data?.turnId===turnId);}
const patchFor=name=>`*** Begin Patch\n*** Update File: ${name}\n@@\n-value=before\n+value=after\n*** End Patch`;
function record(name,detail={}){checks.push({name,...detail});console.log(JSON.stringify({phase:'check-passed',name,...detail}));}
try{
  client=await connect();await client.request('session.initialize');
  await assert.rejects(client.request('device.workspace.read_text',{path:'x'}),/AGENT_OFFLINE/);
  record('offline-before-operation');
  launchAgent();await until(()=>generation>0,'real Agent registered');
  assert.equal((await client.request('device.workspace.context')).result.os,'windows');
  if(mode==='transport'){
    const timeout=await client.request('device.exec',command(slowCode('timeout'),1000));
    assert.equal(timeout.ok,false);assert.match(timeout.errorCode??timeout.error,/COMMAND_TIMEOUT/);await checkStopped('timeout');record('command-timeout-cleans-process');
    const started=generation;
    const disconnected=capture(client.request('device.exec',command(slowCode('disconnect'),20000)));
    await until(()=>exists(join(root,'disconnect.pid')),'running client command');pair.upstream.close();pair.local.close();
    const result=await disconnected;assert.equal(result.result?.errorCode,'AGENT_DISCONNECTED');assert.equal(result.result.retryable,false);
    await checkStopped('disconnect');await until(()=>generation>started,'Agent reconnect');record('agent-transport-loss-cancels-process-and-reconnects');
    const before=generation;const writeFrameStart=frames.length;
    responseDrop=m=>m.type==='agent.response'&&frames.slice(writeFrameStart).some(f=>f.direction==='to-agent'&&f.value.requestId===m.requestId&&f.value.payload?.params?.args?.[1]?.includes('COMMITTED_ONCE'));
    const lost=capture(client.request('device.exec',command("require('fs').appendFileSync('committed.txt','once\\n');console.log('COMMITTED_ONCE')")));
    const uncertain=await lost;assert.equal(uncertain.result?.errorCode,'AGENT_DISCONNECTED');assert.equal(uncertain.result.retryable,false);
    await until(()=>generation>before,'Agent reconnect after lost response');
    assert.equal((await client.request('device.workspace.read_text',{path:'committed.txt'})).result.content,'once\n');
    assert.equal(frames.filter(f=>f.direction==='to-agent'&&f.value.payload?.params?.args?.[1]?.includes('COMMITTED_ONCE')).length,1);
    record('committed-response-loss-reconciled-without-replay');
    const oldGeneration=generation;
    const exiting=capture(client.request('device.exec',command(slowCode('agentexit'),20000)));
    await until(()=>exists(join(root,'agentexit.pid')),'Agent-owned command started');agent.kill();
    assert.equal((await exiting).result?.errorCode,'AGENT_DISCONNECTED');await checkStopped('agentexit');
    launchAgent();await until(()=>generation>oldGeneration,'Agent restart');record('agent-process-exit-cleans-descendants');
  }
  if(mode==='model'){
    for(const kind of ['reject','conflict','cancel-approval','ui-close','lost-patch-result']){
      const path=`${kind}.txt`;await writeFile(join(root,path),'value=before\n');const threadId=await newThread();
      const patch=patchFor(path);let approvalCount=0,held;const frameStart=frames.length;let lostApplied=false;
      if(kind==='lost-patch-result')responseDrop=m=>{
        const request=frames.slice(frameStart).find(f=>f.direction==='to-agent'&&f.value.requestId===m.requestId)?.value;
        if(m.type==='agent.response'&&request?.payload?.method==='workspace/apply_patch'&&request.payload.params.dryRun===false&&m.payload?.ok){lostApplied=true;return true;}return false;
      };
      client.setApproval(async m=>{
        approvalCount++;
        assert.equal(m.method,'device/fileChange/requestApproval');assert.equal(m.data.deviceId,deviceId);assert.equal(m.data.workspaceRoot,root);assert.equal(m.data.patch.trim(),patch);
        if(approvalCount>1){client.respond(m,'reject');return;}
        held=m;
        if(kind==='conflict')await writeFile(join(root,path),'value=external-change\n');
        if(!['cancel-approval','ui-close'].includes(kind))client.respond(m,kind==='reject'?'reject':'accept');
      });
      const turnId=await turn(threadId,`Fault acceptance: call device_workspace_apply_patch exactly ONCE with this exact patch, then finish. A rejection, conflict, interruption or uncertain result is EXPECTED. Do not retry, read/write other files or substitute other tools.\n${patch}`);
      await until(()=>held,'actual model patch approval',120000);
      if(kind==='cancel-approval'){await client.request('conversation.turn.cancel',{threadId,turnId});client.respond(held,'accept');}
      if(kind==='ui-close'){
        client.socket.close();await new Promise(r=>setTimeout(r,250));client=await connect();await client.request('session.initialize');
        client.respond(held,'accept');
        await until(async()=>{const h=await client.request('conversation.read',{threadId,includeTurns:true});return h.thread.turns.find(t=>t.id===turnId)?.status==='completed';},'UI reconnect history terminal',120000);
      }else await completed(threadId,turnId);
      const applies=frames.slice(frameStart).filter(f=>f.direction==='to-agent'&&f.value.payload?.method==='workspace/apply_patch'&&f.value.payload.params.dryRun===false);
      const text=await readFile(join(root,path),'utf8');
      if(kind==='lost-patch-result'){assert(lostApplied);assert.equal(text,'value=after\n');assert.equal(applies.length,1);assert(toolEvents(threadId,turnId).some(e=>e.data.status==='unknown'));}
      else if(kind==='conflict'){assert.equal(text,'value=external-change\n');assert.equal(applies.length,1);assert.match(JSON.stringify(toolEvents(threadId,turnId)),/VERSION_CONFLICT/);}
      else{assert.equal(text,'value=before\n');assert.equal(applies.length,0);}
      assert.equal(approvalCount,1);responseDrop=undefined;client.setApproval(undefined);record(kind,{threadId,turnId});
      await until(async()=>{try{return (await client.request('device.workspace.context')).ok;}catch{return false;}},'Agent ready for next scenario');
    }
    const threadId=await newThread();const code=slowCode('turncancel');
    const turnId=await turn(threadId,`Run device_exec once with program=${JSON.stringify(process.execPath)} args=${JSON.stringify(['-e',code])}, timeoutMs=60000. This is an authorized isolated cancellation test; never retry this command.`);
    await until(()=>exists(join(root,'turncancel.pid')),'model command started',120000);
    await client.request('conversation.turn.cancel',{threadId,turnId});await completed(threadId,turnId);await checkStopped('turncancel');
    await until(()=>toolEvents(threadId,turnId).some(e=>e.data.status==='cancelled'),'client cancellation terminal');record('native-turn-interrupt-cleans-client-process',{threadId,turnId});
  }
  if(mode==='restart'||mode==='runtime'){
    const threadId=await newThread();const messageId=randomUUID();const code=slowCode('gatewayrestart');
    const payload={threadId,clientMessageId:messageId,input:[{type:'text',text:`Run device_exec exactly once with program=${JSON.stringify(process.execPath)} args=${JSON.stringify(['-e',code])}, timeoutMs=60000. This is an isolated restart test; never retry this command.`}]};
    const turnId=(await client.request('conversation.turn.create',payload)).turn.id;
    await until(()=>exists(join(root,'gatewayrestart.pid')),'model command ready for gateway restart',120000);
    if(mode==='runtime'){
      console.log(JSON.stringify({phase:'READY_FOR_RUNTIME_CRASH',threadId,turnId,deviceId,root}));
      await until(()=>client.events.some(e=>e.name==='gateway/runtimeUnavailable'),'operator crashes only pinned QA runtime',180000);
      await checkStopped('gatewayrestart');
      await until(()=>toolEvents(threadId,turnId).some(e=>e.data.status==='unknown'),'runtime loss produces unknown tool terminal');
      await assert.rejects(client.request('conversation.turn.create',{threadId,input:[{type:'text',text:'Do not execute; this submission must be rejected while runtime is down.'}]}),/REMOTE_HARNESS_NOT_READY/);
      record('central-runtime-crash-cancels-client-execution-without-fallback',{threadId,turnId});
    }
    console.log(JSON.stringify({phase:'READY_FOR_GATEWAY_RESTART',threadId,turnId,deviceId,root}));
    await until(()=>client.socket.readyState===WebSocket.CLOSED,'operator restarts only QA gateway',180000);await checkStopped('gatewayrestart');
    await until(async()=>{try{client=await connect();return true;}catch{return false;}},'QA gateway returned',120000);
    await client.request('session.initialize');await until(async()=>{try{return (await client.request('device.workspace.context')).ok;}catch{return false;}},'Agent re-registered');
    const status=await client.request('conversation.message.status',{threadId,clientMessageId:messageId});assert.equal(status.status,'sent');assert.equal(status.turnId,turnId);
    const resumed=await client.request('conversation.resume',{threadId});assert.equal(resumed.thread.id,threadId);
    assert.equal(resumed.thread.turns?.find(t=>t.id===turnId)?.status,'interrupted','Restart must restore a terminal interrupted Turn');
    const deduplicated=await client.request('conversation.turn.create',payload);assert.equal(deduplicated.turn.id,turnId);
    assert.equal(frames.filter(f=>f.direction==='to-agent'&&f.value.payload?.params?.args?.[1]?.includes("'gatewayrestart.pid'")).length,1);
    record('gateway-restart-retains-binding-history-and-submission-fence',{threadId,turnId,nativeTurnStatuses:resumed.thread.turns?.map(t=>({id:t.id,status:t.status}))});
  }
  const evidence={ok:true,source:'real-central-runtime-windows-agent',mode,root,deviceId,checks};
  await writeFile(join(root,'fault-results.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}catch(error){console.error(JSON.stringify({ok:false,mode,root,deviceId,checks,error:String(error),recent:client?.events.slice(-4)}));throw error;}
finally{
  responseDrop=undefined;
  for(const threadId of threads){try{await client.request('conversation.archive',{threadId});}catch{}}
  client?.socket.close();agent?.kill();for(const socket of sockets)socket.terminate();relay.close();
  // On a regression, terminate only exact test-owned children whose PID markers prove ownership.
  for(const label of ['timeout','disconnect','agentexit','turncancel','gatewayrestart']){
    try{const pid=Number(await readFile(join(root,`${label}.pid`),'utf8'));if(processAlive(pid))process.kill(pid);}catch{}
  }
}
