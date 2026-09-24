// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real isolated central gateway/Harness/model, native device token and Windows Agent.
// QA_HANDOFF_FILE belongs to a disposable QA account, never a production identity.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import https from 'node:https';
import {tmpdir} from 'node:os';
const gateway=process.env.HARNESS_GATEWAY_URL,caPath=process.env.QA_CA_FILE,handoff=process.env.QA_HANDOFF_FILE;
assert(gateway&&caPath&&handoff,'Provide isolated QA gateway, CA and handoff paths');
assert.notEqual(new URL(gateway).port,'4510');
const account=JSON.parse(await readFile(handoff,'utf8')),ca=await readFile(caPath),origin=gateway.replace('wss:','https:').replace(/\/ws$/,'');
await mkdir('target',{recursive:true});const root=await mkdtemp(resolve('target/task-control-live-')),tokenRoot=join(root,'token'),workspace=await mkdtemp(join(tmpdir(),'yuan-goal-fixture-'));await mkdir(tokenRoot);
const marker='CLIENT_GOAL_'+randomUUID(),sample=join(workspace,'sample.txt'),output=join(workspace,'verified.txt');await writeFile(sample,marker);
const children=[],events=[],pending=new Map();let connected=false,deviceId,goalThread,client,diagnostics='';
const start=(binary,args,env={})=>{const p=spawn(resolve(binary),args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});children.push(p);p.stderr.on('data',d=>diagnostics=(diagnostics+d).slice(-2000));p.stdin.on('error',()=>{});return p;};
const until=async(test,label,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
const post=(route,body,token)=>new Promise((r,j)=>{const req=https.request(origin+route,{method:'POST',ca,agent:false,headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>{try{const v=JSON.parse(text);v.ok?r(v.data):j(Error(v.error));}catch(e){j(e);}});});req.on('error',j);req.end(JSON.stringify(body));});
const request=(operation,payload={})=>new Promise((r,j)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);j(Error('Unknown result: '+operation));},60000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?r(m.data):j(Error(m.error));});client.stdin.write(JSON.stringify({kind:'send',message:{type:'request',requestId,operation,payload}})+'\n');});
try {
 const login=await post('/auth/login',{username:account.username,password:account.password});
 const {code}=await post('/auth/admin/pair-code',{userId:account.userId},login.accessToken);
 client=start('target/debug/examples/central-live-client.exe',[]);
 createInterface({input:client.stdout}).on('line',line=>{
  const frame=JSON.parse(line);if(frame.kind==='paired')deviceId=frame.deviceId;if(frame.kind==='connected')connected=true;
  if(frame.kind==='message'){const m=frame.message;events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);
   if(m.type==='approval.request')client.stdin.write(JSON.stringify({kind:'send',message:{type:'approval.response',requestId:m.requestId,result:m.method==='item/tool/requestUserInput'?{answers:Object.fromEntries((m.data.questions??[]).map(q=>[q.id,{answers:['Use only the temporary test files specified. Proceed with the plan.']}]))}:{decision:'reject'}}})+'\n');
  }
 });
 const namespace='com.centralcodex.harnessqa.central-live';
 client.stdin.write(JSON.stringify({gateway,caPath,code,tokenRoot,namespace})+'\n');await until(()=>connected,'native pairing',20000);
 const agent=start('target/debug/local-agent.exe',['--workspace-root',workspace,'--gateway-url',gateway.replace('/ws','/ws/agent')+'?deviceId='+deviceId],{YUAN_PLATFORM_NAMESPACE:namespace,YUAN_PLATFORM_DATA_DIR:tokenRoot,YUAN_PLATFORM_CA:caPath});agent.stdout.resume();
 await until(async()=>{try{return (await request('device.workspace.context')).ok;}catch{return false;}},'Windows Agent',30000);
 const init=await request('session.initialize',{clientInfo:{name:'yuan-plan-goal-live-qa',version:'1'}});assert.equal(init.platformCapabilities.goals,true);assert.equal(init.platformCapabilities.planMode,true);
 const planned=(await request('conversation.create',{model:'gpt-6-sol'})).thread.id;
 const plan=await request('conversation.turn.create',{threadId:planned,clientMessageId:randomUUID(),collaborationMode:{mode:'plan',settings:{model:'gpt-6-sol',reasoning_effort:'low',developer_instructions:null}},input:[{type:'text',text:`Plan only. Read the client text file ${JSON.stringify(sample)} using device_read_text. Propose a short plan to copy its exact content into a new file ${JSON.stringify(output)} and read it back to verify. Do not create or modify files yet. Return a proposed_plan block. No questions are needed for this isolated fixture.`}]});
 await until(()=>events.some(e=>e.eventType==='turn.completed'&&e.data?.threadId===planned&&e.data.turn.id===plan.turn.id),'real model plan');
 const history=await request('conversation.read',{threadId:planned,includeTurns:true});assert(history.thread.turns.some(t=>t.items.some(i=>i.type==='plan')),'native plan is in history');
 await assert.rejects(readFile(output),/ENOENT/);assert.equal(await readFile(sample,'utf8'),marker);
 goalThread=(await request('conversation.create',{model:'gpt-6-sol'})).thread.id;
 if(process.env.QA_IDLE_RECOVERY==='1'){
  const warm=await request('conversation.turn.create',{threadId:goalThread,clientMessageId:randomUUID(),input:[{type:'text',text:'This is a readiness check. Reply Ready. Do not create a goal or call any tools.'}]});
  await until(()=>events.some(e=>e.eventType==='turn.completed'&&e.data?.threadId===goalThread&&e.data.turn.id===warm.turn.id),'materialized goal thread');
  // Test gateway is explicitly configured with a 1-second idle eviction timeout.
  await new Promise(r=>setTimeout(r,4500));
 }
 await request('conversation.goal.set',{threadId:goalThread,status:'active',tokenBudget:40000,objective:`Complete this authorized isolated client-file task. Read ${JSON.stringify(sample)} with device_read_text. Copy its exact content to the NEW file ${JSON.stringify(output)} with device_write_file; then read the output back and compare. Do not modify other files, use skills, or run commands. Only after real read-back verification, use update_goal status complete. The file content is a random acceptance marker, never guess it.`});
 await until(()=>events.some(e=>e.name==='thread/goal/updated'&&e.data?.threadId===goalThread&&e.data.goal.status==='complete'),'real model goal completion');
 assert.equal(await readFile(output,'utf8'),marker);
 const goal=(await request('conversation.goal.get',{threadId:goalThread})).goal;assert.equal(goal.status,'complete');assert(goal.tokensUsed>0);
 assert(events.some(e=>e.name==='device/tool/completed'&&e.data?.threadId===goalThread&&e.data.tool==='device_write_file'&&e.data.status==='succeeded'));
 const result={ok:true,root,checks:['authenticated-WSS','native-device-token','Windows-Local-Agent','real-central-model-plan','plan-no-write','real-goal-start',...(process.env.QA_IDLE_RECOVERY==='1'?['idle-Worker-goal-recovery']:[]),'client-write-and-readback','native-goal-completion','native-usage'],tokensUsed:goal.tokensUsed,source:'isolated central gpt-6-sol and real Windows Agent'};
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} catch(error){console.error(JSON.stringify({root,error:String(error),recent:events.slice(-5).map(e=>({type:e.type,name:e.name,eventType:e.eventType})),diagnostics}));throw error;}
finally {
 if(goalThread)try{await request('conversation.turn.cancel',{threadId:goalThread});}catch{}
 for(const child of children)if(child.exitCode===null)child.kill();
}
