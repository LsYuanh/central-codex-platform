// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Protocol-only fixtures. This does not stand in for central harness acceptance.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, writeFile, access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {randomUUID} from "node:crypto";
import net from "node:net";
import {WebSocket} from "ws";

const root=await mkdtemp(join(tmpdir(),"harness-gateway-"));
await mkdir(join(root,"remote-worker"));
await writeFile(join(root,"state.json"),JSON.stringify({version:1,futureRoot:{preserved:true},users:{owner:[{id:'legacy-metadata-smoke',futureEntry:'kept',summary:{id:'legacy-metadata-smoke',deviceId:'a',deviceKey:'a-key',futureSummary:['kept']}}]}}));
await writeFile(join(root,"remote-worker","app-server"), `
const readline=require('node:readline');let next=0,lastTool,lastInstructions,lastTools;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);let result={};
 if(q.method==='model/list'&&q.params?.fixtureCrash)process.exit(9);
 if(!q.method){lastTool=q.result;return;}
 if(q.method==='initialize')result={userAgent:process.env.BAD_HARNESS?'stock-codex':'codex yuan-zhou-remote-workspace/1'};
 if(q.method==='thread/start')result={thread:{id:'thread-'+ ++next}};
 if(q.method==='thread/resume')result={thread:{id:q.params.threadId}};
 if(q.method==='thread/start'||q.method==='thread/resume')lastInstructions=q.params.developerInstructions;
 if(q.method==='thread/start')lastTools=q.params.dynamicTools;
 if(q.method==='thread/read')result={thread:{id:q.params.threadId},lastTool,lastInstructions,lastTools};
 if(q.method==='turn/start')result={turn:{id:'turn-'+ ++next}};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
 if(q.method==='turn/start'&&q.params.input?.[0]?.text==='patch')process.stdout.write(JSON.stringify({id:'patch-tool-'+next,method:'item/tool/call',params:{threadId:q.params.threadId,turnId:result.turn.id,tool:'device_workspace_apply_patch',arguments:{patch:'*** Begin Patch\\n*** Add File: example.txt\\n+hello\\n*** End Patch'}}})+'\\n');
});`);
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const gateway=spawn(process.execPath,[resolve('services/test-gateway/dist/index.js')],{env:{...process.env,CODEX_BIN:process.execPath,TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:join(root,'state.json')},stdio:['ignore','pipe','pipe'],windowsHide:true});
let log='';gateway.stderr.on('data',d=>log+=d);gateway.stdout.on('data',d=>log+=d);
const sockets=[];
const legacy=process.env.LEGACY_AGENT==='1';
const capabilities=[...(legacy?[]:['client-paths/v1']),'remote-workspace/v1','workspace/context','workspace/search','workspace/read_text','workspace/git_status','workspace/git_diff','workspace/apply_patch'];
function envelope(type,payload,requestId){return {protocol:'agentrpc',version:1,type,timestamp:new Date().toISOString(),nonce:randomUUID(),...(requestId?{requestId}:{}),payload};}
async function connect(path){const s=new WebSocket(`ws://127.0.0.1:${port}${path}`);sockets.push(s);await new Promise((r,j)=>{s.once('open',r);s.once('error',j);});return s;}
let onRequest,onApproval;
async function agent(deviceId,workspaceRoot='C:/client-project') {
 const s=await connect(`/ws/agent?deviceId=${deviceId}`);
 const ack=new Promise(r=>s.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='agent.hello_ack')r();}));
 s.on('message',raw=>{const m=JSON.parse(raw);if(m.type!=='agent.request')return;
   if(m.payload.method==='workspace/context')s.send(JSON.stringify(envelope('agent.response',{ok:true,result:{workspaceRoot,os:'windows',rules:[]}},m.requestId)));
   else onRequest?.(s,m);
 });
 s.send(JSON.stringify(envelope('agent.hello',{deviceId,agent:{version:'test',os:'windows',arch:'x64',deviceKey:deviceId+'-key',workspaceRoot,capabilities}})));await ack;return s;
}
async function client(userId,deviceId){const s=await connect(`/ws?userId=${userId}&deviceId=${deviceId}`);let n=0;const pending=new Map();s.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='response')pending.get(m.requestId)?.(m);if(m.type==='approval.request')onApproval?.(s,m);});return (operation,payload={})=>new Promise((r,j)=>{const requestId=String(++n),timer=setTimeout(()=>{pending.delete(requestId);j(Error('timeout '+operation));},5000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?r(m.data):j(Error(m.error));});s.send(JSON.stringify({type:'request',requestId,operation,payload}));});}
try{
 for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const a=await agent('a'),b=await agent('b');const request=await client('owner','a');await request('session.initialize');
 if(process.env.BAD_HARNESS)throw Error('Stock runtime unexpectedly accepted');
 await assert.rejects(request('test.history.legacy_create'),/history fixture controls are disabled/);
 await request('conversation.resume',{threadId:'legacy-metadata-smoke'});
 const migrated=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
 assert.deepEqual(migrated.futureRoot,{preserved:true});
 assert.equal(migrated.users.owner[0].futureEntry,'kept');
 assert.deepEqual(migrated.users.owner[0].summary.futureSummary,['kept']);
 assert.equal(migrated.users.owner[0].summary.remoteWorkspace.policy,'remote-workspace/v1');
 const threadId=(await request('conversation.create')).thread.id;
 const policy=await request('conversation.read',{threadId});
 assert.match(policy.lastInstructions,legacy?/Legacy workspace client/:/Client path policy/);
 assert.match(policy.lastTools.find(t=>t.name==='device_exec').description,legacy?/cwd must be omitted or workspace-relative/:/cwd accepts an absolute client directory/);
 assert.match(policy.lastTools.find(t=>t.name==='device_workspace_read_text').inputSchema.properties.path.description,legacy?/Workspace-relative/:/Absolute client path/);
 await request('conversation.resume',{threadId});
 assert.match((await request('conversation.read',{threadId})).lastInstructions,legacy?/Legacy workspace client/:/Client path policy/);
 await assert.rejects(request('conversation.turn.create',{threadId,input:[],cwd:'/central'}),/REMOTE_POLICY_OVERRIDE/);
 await assert.rejects(request('conversation.resume',{threadId,config:{}}),/REMOTE_POLICY_OVERRIDE/);
 const wrongDevice=await client('owner','b');await assert.rejects(wrongDevice('conversation.resume',{threadId}),/another device/);
 const wrongUser=await client('other','a');await assert.rejects(wrongUser('conversation.read',{threadId}),/does not belong/);
 onRequest=(s,m)=>{assert.equal(m.payload.params.__remoteWorkspace.deviceKey,'a-key');
   b.send(JSON.stringify(envelope('agent.response',{ok:true,result:{content:'forged-from-b'}},m.requestId)));
   setTimeout(()=>s.send(JSON.stringify(envelope('agent.response',{ok:true,result:{content:'actual-client-a'}},m.requestId))),50);
 };
 assert.equal((await request('device.workspace.read_text',{path:'file.txt'})).result.content,'actual-client-a');
 await assert.rejects(request('device.workspace.read_text',{path:'x',__remoteWorkspace:{deviceId:'b'}}),/selected by the central broker/);
 let applied=0;
 onRequest=(s,m)=>{const p=m.payload.params;assert.equal(m.payload.method,'workspace/apply_patch');if(!p.dryRun){applied++;assert.equal('expectedPaths' in p,!legacy);assert.equal(p.patchHash,'preview-hash');assert.equal(p.expectedVersions['example.txt'],'missing');}
   s.send(JSON.stringify(envelope('agent.response',p.dryRun?{ok:true,result:{patchHash:'preview-hash',expectedVersions:{'example.txt':'missing'},...(legacy?{}:{expectedPaths:{'example.txt':'C:/client-project/example.txt'}})}}:{ok:false,errorCode:'VERSION_CONFLICT',error:'changed after approval'},m.requestId)));
 };
 const approval=(decision)=>new Promise(resolve=>{onApproval=(s,m)=>{assert.equal(m.data.deviceId,'a');assert.equal(m.data.workspaceRoot,'C:/client-project');assert.match(m.data.patch,/Add File/);s.send(JSON.stringify({type:'approval.response',requestId:m.requestId,result:{decision}}));resolve();};});
 const denied=approval('decline');await request('conversation.turn.create',{threadId,input:[{type:'text',text:'patch'}]});await denied;
 await new Promise(r=>setTimeout(r,80));assert.equal(applied,0);assert.equal((await request('conversation.read',{threadId})).lastTool.success,false);
 const approved=approval('accept');await request('conversation.turn.create',{threadId,input:[{type:'text',text:'patch'}]});await approved;
 await new Promise(r=>setTimeout(r,80));assert.equal(applied,1);assert.match(JSON.stringify((await request('conversation.read',{threadId})).lastTool),/VERSION_CONFLICT/);

 // Malformed previews must fail before approval in both versions. New Agents
 // additionally must never fall back to the old protocol when targets are absent.
 for(const result of [{expectedVersions:{}}, ...(legacy?[]:[{patchHash:'hash',expectedVersions:{}}])]) {
   let unexpectedApproval=false;
   onApproval=()=>{unexpectedApproval=true;};
   onRequest=(s,m)=>s.send(JSON.stringify(envelope('agent.response',{ok:true,result},m.requestId)));
   await request('conversation.turn.create',{threadId,input:[{type:'text',text:'patch'}]});
   await new Promise(r=>setTimeout(r,100));
   assert.equal(unexpectedApproval,false);assert.equal(applied,1);
   assert.match(JSON.stringify((await request('conversation.read',{threadId})).lastTool),/PATCH_PREPARE_FAILED/);
 }


 // An approval cannot survive replacement of its Agent session, even if the
 // installation identity and workspace remain the same.
 let heldReconnectApproval, writesAfterReconnect=0;
 onRequest=(s,m)=>{if(!m.payload.params.dryRun)writesAfterReconnect++;
   s.send(JSON.stringify(envelope('agent.response',{ok:true,result:{patchHash:'hash',expectedVersions:{'example.txt':'missing'},...(legacy?{}:{expectedPaths:{'example.txt':'C:/client-project/example.txt'}})}},m.requestId)));
 };
 const previewBeforeReconnect=new Promise(r=>{onApproval=(s,m)=>{heldReconnectApproval={s,m};r();};});
 await request('conversation.turn.create',{threadId,input:[{type:'text',text:'patch'}]});await previewBeforeReconnect;
 const oldAgentClosed=new Promise(r=>a.once('close',r));a.close();await oldAgentClosed;await agent('a');
 heldReconnectApproval.s.send(JSON.stringify({type:'approval.response',requestId:heldReconnectApproval.m.requestId,result:{decision:'accept'}}));
 await new Promise(r=>setTimeout(r,100));assert.equal(writesAfterReconnect,0);
 assert.equal((await request('conversation.read',{threadId})).lastTool.success,false);

 onRequest=s=>s.close();
 const unknown=await request('device.exec',{program:'test'});assert.equal(unknown.ok,false);assert.equal(unknown.errorCode,'AGENT_DISCONNECTED');assert.equal(unknown.retryable,false);
 await new Promise(r=>setTimeout(r,100));await agent('a','C:/different-project');
 if(legacy)await assert.rejects(request('conversation.resume',{threadId}),/original workspace directory/);
 else await request('conversation.resume',{threadId});
 const crashThread=(await request('conversation.create')).thread.id;
 let staleApproval;let writesAfterCrash=0;
 onRequest=(s,m)=>{if(!m.payload.params.dryRun)writesAfterCrash++;s.send(JSON.stringify(envelope('agent.response',{ok:true,result:{patchHash:'hash',expectedVersions:{'example.txt':'missing'},...(legacy?{}:{expectedPaths:{'example.txt':'C:/client-project/example.txt'}})}},m.requestId)));};
 const heldApproval=new Promise(r=>{onApproval=(s,m)=>{staleApproval={s,m};r();};});
 await request('conversation.turn.create',{threadId:crashThread,input:[{type:'text',text:'patch'}]});await heldApproval;
 await assert.rejects(request('model.list',{fixtureCrash:true}),/exited/);
 staleApproval.s.send(JSON.stringify({type:'approval.response',requestId:staleApproval.m.requestId,result:{decision:'accept'}}));
 await new Promise(r=>setTimeout(r,80));assert.equal(writesAfterCrash,0);
 assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).enforcedRuntimeReady,false);
 await assert.rejects(request('conversation.turn.create',{threadId:crashThread,input:[]}),/REMOTE_HARNESS_NOT_READY/);
 console.log((legacy?'LEGACY_AGENT_COMPAT_OK: ':'CLIENT_PATHS_AGENT_OK: ')+'HARNESS_GATEWAY_SMOKE_OK: policy overrides, user/device/workspace binding, forged response, patch approval/refusal/version conflict, unknown result, no retry, runtime crash cancels stale approvals');
}catch(error){if(process.env.BAD_HARNESS&&/REMOTE_HARNESS_REQUIRED/.test(String(error)))console.log('HARNESS_STOCK_REJECTED_OK');else {console.error(log);throw error;}}
finally{for(const s of sockets)s.close();gateway.kill();}

if(!process.env.BAD_HARNESS){
 const broken=await mkdtemp(join(tmpdir(),'harness-state-corrupt-'));
 await mkdir(join(broken,'remote-worker'));
 await writeFile(join(broken,'state.json'),'{"version":1,');
 await writeFile(join(broken,'remote-worker','app-server'),"require('node:fs').writeFileSync('INFERENCE_STARTED','unexpected');");
 const rejected=spawn(process.execPath,[resolve('services/test-gateway/dist/index.js')],{env:{...process.env,CODEX_BIN:process.execPath,TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:'0',TEST_GATEWAY_STATE_FILE:join(broken,'state.json')},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let error='';rejected.stderr.on('data',chunk=>error+=chunk);rejected.stdout.resume();
 const timer=setTimeout(()=>rejected.kill(),10000);
 const exitCode=await new Promise(r=>rejected.once('exit',r));clearTimeout(timer);
 assert.notEqual(exitCode,0);assert.match(error,/GATEWAY_STATE_CORRUPT/);
 assert.equal(await readFile(join(broken,'state.json'),'utf8'),'{"version":1,');
 await assert.rejects(access(join(broken,'remote-worker','INFERENCE_STARTED')));
 console.log('HARNESS_STATE_STARTUP_GUARD_OK: legacy extensions preserved; corrupted state rejected before inference spawn');
}
