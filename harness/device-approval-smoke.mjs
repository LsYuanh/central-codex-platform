// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real native dispatcher/Guardian, deterministic model and device transport fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ModelCredentialBroker} from '../services/central-gateway/dist/model-credential-broker.js';
const binary=resolve(process.argv[2]);
mkdirSync('target',{recursive:true});
const run=mkdtempSync(resolve('target/device-review-native-')),home=join(run,'home'),worker=join(run,'worker');
mkdirSync(home);mkdirSync(worker);
let child,next=0,scenario='ask',step=0,stderr='',failure,broker,lease;
const pending=new Map(),events=[],requests=[],reviews=[],completions=[];
const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method,params={})=>new Promise((resolve,reject)=>{
 const id=++next,timer=setTimeout(()=>reject(Error('RPC timeout '+method)),30000);
 pending.set(id,m=>{clearTimeout(timer);pending.delete(id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});send({id,method,params});
});
async function until(test,label){const deadline=Date.now()+90000;while(!test()){if(failure)throw failure;if(Date.now()>deadline)throw Error(`${label}: ${stderr.slice(-3000)}`);await new Promise(r=>setTimeout(r,30));}}
const message=text=>({type:'message',id:`m-${requests.length}`,role:'assistant',content:[{type:'output_text',text}]});
const model=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST'||!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
  const parts=[];for await(const b of req)parts.push(b);const body=JSON.parse(Buffer.concat(parts));requests.push({scenario,headers:req.headers,body});
  const isReview=JSON.stringify(body.text??{}).includes('risk_level') || req.headers['x-openai-subagent']==='guardian';
  let item;
  if(isReview){
   reviews.push({scenario,body});
   item=message(JSON.stringify({risk_level:scenario==='deny'?'high':'low',user_authorization:scenario==='deny'?'low':'high',outcome:scenario==='deny'?'deny':'allow',rationale:scenario==='deny'?'Fixture explicit denial':'Fixture authorized local operation'}));
  }else if(step++===0){item={type:'function_call',call_id:`call-${scenario}`,name:'device_exec',arguments:JSON.stringify({program:'powershell',args:['-NoProfile','-Command','Write-Output reviewed'],cwd:'C:/client/project'})};}
  else item=message('Completed fixture turn.');
  if(requests.length>25)throw Error('Unexpected review loop');
  const response={id:`r-${requests.length}`};
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end([{type:'response.created',response},{type:'response.output_item.done',item},{type:'response.completed',response:{...response,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}].map(v=>`data: ${JSON.stringify(v)}\n\n`).join(''));
 }catch(error){failure=error;res.writeHead(500);res.end();}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
writeFileSync(join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
try{
 if(process.platform==='win32'){
  const reference=join(run,'fixture.memory'),bindings={version:1,users:{fixture:{providerId:'fixture',enabled:true}},providers:{fixture:{id:'fixture',kind:'api-key',credentialFile:reference,baseUrl:`http://127.0.0.1:${model.address().port}/v1`}}};
  broker=await ModelCredentialBroker.start({configFile:join(run,'bindings.json'),allowLoopbackTestProviders:true,memorySource:{readConfig:()=>bindings,readCredential:()=>({apiKey:'SYNTHETIC_REVIEW_FIXTURE'})}});
  lease=await broker.createPipeLease('fixture','review-fixture');
  const launcher=resolve(process.argv[3]??'target/w162/windows-isolation-probe.exe');
  child=spawn(launcher,[join(run,'isolated'),'--model-runtime-binary',binary],{cwd:run,env:{...process.env,YUAN_QA_MODEL_PORT:String(lease.forwardPort),YUAN_QA_MODEL_CA_PEM:lease.certificatePem,YUAN_QA_MODEL_LEASE:lease.token},windowsHide:true,stdio:['pipe','pipe','pipe']});
 } else child=spawn(binary,[],{cwd:worker,env:{...process.env,CODEX_REMOTE_WORKSPACE:'1',CODEX_HOME:home,OPENAI_API_KEY:'',CODEX_API_KEY:'',RUST_LOG:'warn'},windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',b=>stderr=(stderr+b).slice(-16000));child.on('error',e=>failure=e);
 createInterface({input:child.stdout}).on('line',line=>{try{
  const m=JSON.parse(line);
  if(m.method==='item/tool/call'){
   assert.equal(m.params.namespace,'yuan_zhou_device_approval','unreviewed device dispatch');
   if(m.params.tool==='prepare'){
    assert.equal(m.params.arguments.tool,'device_exec');
    const data={token:'ticket-'+scenario,mode:scenario==='deny'?'auto':scenario,action:{tool:'device_exec',arguments:m.params.arguments.arguments,deviceId:'client-fixture',source:'client',defaultOutputDirectory:'C:/client/output'}};
    send({id:m.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]}});
   }else{
    assert.equal(m.params.tool,'complete');assert.equal(m.params.arguments.token,'ticket-'+scenario);
    completions.push({scenario,...m.params.arguments});send({id:m.id,result:{success:m.params.arguments.outcome==='approved',contentItems:[{type:'inputText',text:'client-fixture result'}]}});
   }
  }else if(m.id!==undefined&&pending.has(m.id))pending.get(m.id)(m);else events.push(m);
 }catch(error){failure=error;}});
 const init=await rpc('initialize',{clientInfo:{name:'device-review-qa',version:'1'},capabilities:{experimentalApi:true}});
 assert.match(init.userAgent,/yuan-zhou-device-approval\/1/);send({method:'initialized',params:{}});
 for(const mode of ['ask','full','auto','deny']){
  scenario=mode;step=0;
  const thread=(await rpc('thread/start',{dynamicTools:[{type:'function',name:'device_exec',description:'Execute a command on the connected client',inputSchema:{type:'object',properties:{program:{type:'string'},args:{type:'array',items:{type:'string'}},cwd:{type:'string'}},required:['program','args']}}]})).thread.id;
  await rpc('turn/start',{threadId:thread,input:[{type:'text',text:'Run Write-Output reviewed on the client project. Do not change anything else.'}]});
  await until(()=>events.some(e=>e.method==='turn/completed'&&e.params.threadId===thread),mode+' completion');
  assert.equal(completions.find(c=>c.scenario===mode)?.outcome,{ask:'manual',full:'approved',auto:'approved',deny:'denied'}[mode],JSON.stringify({completions,reviews:reviews.length}));
 }
 assert(!reviews.some(r=>['ask','full'].includes(r.scenario)));
 assert(reviews.some(r=>r.scenario==='auto'),'native Guardian must actually call the model');
 assert(reviews.some(r=>r.scenario==='deny'));
 assert.match(JSON.stringify(reviews),/C:\/client\/project/);
 await assert.rejects(rpc('command/exec',{command:['echo','must-not-run']}),/REMOTE_WORKSPACE/);
 writeFileSync(join(run,'result.json'),JSON.stringify({ok:true,source:'real native Guardian with model/device fixtures',reviews:reviews.map(r=>r.scenario),completions},null,2));
 console.log(JSON.stringify({ok:true,run,checks:['native-review-model-called','manual-and-full-skip-review','deny-preserved','client-path-context','central-exec-denied']}));
}catch(error){writeFileSync(join(run,'failure.json'),JSON.stringify({error:String(error),stderr,requests,completions,events},null,2));throw error;}
finally{
 if(child&&child.exitCode===null){child.stdin.end();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill();}
 lease?.release();await broker?.close();model.closeAllConnections();await new Promise(r=>model.close(r));
}
