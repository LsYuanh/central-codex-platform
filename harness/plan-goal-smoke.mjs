// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real pinned App Server and dispatcher; deterministic model, isolated histories.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const binary=resolve(process.argv[2]),run=mkdtempSync(join(process.env.HARNESS_QA_ROOT??tmpdir(),'plan-goal-'));
const home=join(run,'home'),worker=join(run,'worker');mkdirSync(home);mkdirSync(worker);
let child,nextId=0,scenario='plan',step=0,stderr='',failure;
const pending=new Map(),events=[],requests=[],deviceCalls=[],questions=[];
const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  // These goal RPCs simulate explicit UI actions, including pause and resume.
  if(method==='thread/goal/set'||method==='thread/goal/clear')params={...params,origin:'user'};
  const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`timeout ${method}: ${stderr.slice(-1500)}`));},30000);
  pending.set(id,{resolve:r=>{clearTimeout(timer);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result);}});send({id,method,params});
});
const until=async(test,label)=>{const deadline=Date.now()+35000;while(!test()){if(failure)throw failure;if(Date.now()>deadline)throw Error(`timeout ${label}: ${stderr.slice(-2000)}`);await new Promise(r=>setTimeout(r,50));}};
const tool=(name,args)=>({type:'function_call',call_id:`call-${requests.length}`,name,arguments:JSON.stringify(args)});
const answer=text=>({type:'message',id:`answer-${requests.length}`,role:'assistant',content:[{type:'output_text',text}]});
const model=createServer(async(req,res)=>{
  try{
    if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
    const parts=[];for await(const chunk of req)parts.push(chunk);
    const body=JSON.parse(Buffer.concat(parts));requests.push({scenario,body});
    if(requests.length>25)throw Error('unbounded continuation');
    let item;
    if(scenario==='plan'){
      item=step===0?tool('device_write_file',{path:join(run,'FORBIDDEN'),text:'must not write'}):step===1?tool('request_user_input',{questions:[{id:'scope',header:'Scope',question:'Which scope?',options:[{label:'Small',description:'One file'},{label:'Large',description:'All files'}]}]}):answer('<proposed_plan>\nInspect the client, implement, and verify.\n</proposed_plan>');
    }else if(scenario==='goal'){
      item=step===0||step===2?tool('device_workspace_context',{}):step===1?answer('A checkpoint; the objective still needs verification.'):step===3?tool('update_goal',{status:'complete'}):answer('Verified complete.');
    }else if(scenario==='budget')item=step===0?tool('device_workspace_context',{}):answer('Budget reached; investigation remains incomplete.');
    else if(scenario==='pause'){item=tool('device_workspace_context',{});await new Promise(r=>setTimeout(r,200));}
    else item=answer('Waiting for user.');
    step++;
    const response={id:`response-${requests.length}`};
    const stream=[{type:'response.created',response},{type:'response.output_item.done',item},{type:'response.completed',response:{...response,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}];
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(stream.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
  }catch(e){failure=e;res.writeHead(500);res.end('fixture error');}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
writeFileSync(join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
try{
  child=spawn(binary,[],{cwd:worker,env:{...process.env,CODEX_REMOTE_WORKSPACE:'1',CODEX_HOME:home,OPENAI_API_KEY:'',CODEX_API_KEY:'',RUST_LOG:'warn'},windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-12000));
  child.on('error',e=>failure=e);
  createInterface({input:child.stdout}).on('line',line=>{
    try{
      const m=JSON.parse(line);
      if(m.method==='item/tool/call'){
        deviceCalls.push(m);assert.notEqual(m.params.tool,'device_write_file','plan write escaped dispatcher');
        send({id:m.id,result:{success:true,contentItems:[{type:'inputText',text:'{"source":"client-fixture","verified":true}'}]}});
      }else if(m.method==='item/tool/requestUserInput'){
        questions.push(m);send({id:m.id,result:{answers:{scope:{answers:['Small']}}}});
      }else if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);p.resolve(m);}
      else events.push(m);
    }catch(e){failure=e;}
  });
  const init=await rpc('initialize',{clientInfo:{name:'plan_goal_qa',version:'1'},capabilities:{experimentalApi:true}});
  assert.match(init.userAgent,/yuan-zhou-plan-goal\/1/);send({method:'initialized',params:{}});
  assert((await rpc('collaborationMode/list')).data.some(m=>m.mode==='plan'));
  const tools=[{type:'function',name:'device_workspace_context',description:'Read client context',inputSchema:{type:'object',properties:{}}},{type:'function',name:'device_write_file',description:'Write client text',inputSchema:{type:'object',properties:{path:{type:'string'},text:{type:'string'}}}}];
  const planned=(await rpc('thread/start',{dynamicTools:tools})).thread.id;
  await rpc('turn/start',{threadId:planned,input:[{type:'text',text:'Plan only'}],collaborationMode:{mode:'plan',settings:{model:'gpt-5.4',reasoning_effort:null,developer_instructions:null}}});
  await until(()=>events.some(e=>e.method==='turn/completed'&&e.params.threadId===planned),'plan completion');
  assert.equal(questions.length,1);assert.equal(deviceCalls.length,0);assert(!existsSync(join(run,'FORBIDDEN')));
  assert.match(JSON.stringify(requests),/PLAN_MODE_READ_ONLY/);
  assert(events.some(e=>e.method==='item/completed'&&e.params.item.type==='plan'));
  scenario='goal';step=0;
  const threadId=(await rpc('thread/start',{dynamicTools:tools})).thread.id;
  const created=await rpc('thread/goal/set',{threadId,objective:'Read client context twice across turns, then mark complete.',status:'active',tokenBudget:2000});
  assert.equal(created.goal.objective,'Read client context twice across turns, then mark complete.');
  await until(()=>events.some(e=>e.method==='thread/goal/updated'&&e.params.threadId===threadId&&e.params.goal.status==='complete'),'goal completion');
  const goal=(await rpc('thread/goal/get',{threadId})).goal;
  assert.equal(goal.status,'complete');assert(goal.tokensUsed>0);
  assert(new Set(deviceCalls.filter(c=>c.params.threadId===threadId).map(c=>c.params.turnId)).size>=2,'native continuation must start another turn');
  await until(()=>events.filter(e=>e.method==='turn/completed'&&e.params.threadId===threadId).length>=2,'goal final turn');
  scenario='budget';step=0;
  const limited=(await rpc('thread/start',{dynamicTools:tools})).thread.id;
  await rpc('thread/goal/set',{threadId:limited,objective:'Keep investigating until budget reached.',status:'active',tokenBudget:1});
  await until(()=>events.some(e=>e.method==='thread/goal/updated'&&e.params.threadId===limited&&e.params.goal.status==='budgetLimited'),'budget stop');
  await until(()=>events.some(e=>e.method==='turn/completed'&&e.params.threadId===limited),'budget turn end');
  // Native budgetLimited is sticky until explicitly reactivated; pause must not resume it.
  await rpc('thread/goal/set',{threadId:limited,status:'paused'});
  assert.equal((await rpc('thread/goal/get',{threadId:limited})).goal.status,'budgetLimited');
  await rpc('thread/goal/clear',{threadId:limited});assert.equal((await rpc('thread/goal/get',{threadId:limited})).goal,null);
  const paused=(await rpc('thread/start',{dynamicTools:tools})).thread.id;
  await rpc('thread/goal/set',{threadId:paused,objective:'Wait for explicit resume.',status:'paused'});
  assert.equal((await rpc('thread/goal/get',{threadId:paused})).goal.status,'paused');
  assert(!events.some(e=>e.method==='turn/started'&&e.params.threadId===paused));
  scenario='pause';step=0;
  await rpc('thread/goal/set',{threadId:paused,status:'active'});
  await until(()=>events.some(e=>e.method==='turn/started'&&e.params.threadId===paused),'pause active turn');
  await rpc('thread/goal/set',{threadId:paused,status:'paused'});
  const activePauseTurn=events.find(e=>e.method==='turn/started'&&e.params.threadId===paused).params.turn.id;
  await rpc('turn/interrupt',{threadId:paused,turnId:activePauseTurn});
  await until(()=>events.some(e=>e.method==='turn/completed'&&e.params.threadId===paused),'pause interrupted turn');
  const pausedStarts=events.filter(e=>e.method==='turn/started'&&e.params.threadId===paused).length;
  await new Promise(r=>setTimeout(r,300));
  assert.equal(events.filter(e=>e.method==='turn/started'&&e.params.threadId===paused).length,pausedStarts);
  assert.equal((await rpc('thread/goal/get',{threadId:paused})).goal.status,'paused');
  scenario='goal';step=0;await rpc('thread/goal/set',{threadId:paused,status:'active'});
  await until(()=>events.some(e=>e.method==='thread/goal/updated'&&e.params.threadId===paused&&e.params.goal.status==='complete'),'explicit goal resume');
  console.log(JSON.stringify({ok:true,run,checks:['plan-write-denied','structured-questions','plan-item','goal-api','native-cross-turn-continuation','evidence-completion','token-accounting','budget-stop','pause-clear','pause-interrupt-no-continuation','explicit-resume'],requests:requests.length}));
}finally{
  child?.kill();model.closeAllConnections();await new Promise(r=>model.close(r));
}
