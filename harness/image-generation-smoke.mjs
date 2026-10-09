// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Compiled native extension + deterministic provider, without a real login.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
assert.equal(process.platform,'darwin','native image transport is qualified on central Mac');
const binary=resolve(process.argv[2]),run=realpathSync(mkdtempSync(join(process.env.HARNESS_QA_ROOT??tmpdir(),'image-native-')));
const home=join(run,'home'),worker=join(run,'worker');mkdirSync(home);mkdirSync(worker);
const png='iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR4nO3NMQ0AAAwDoPpXVllVsWMJGCA9FoFAIBAIBAKBQPAlGGDXYIj+Um+RAAAAAElFTkSuQmCC';
const canary=join(worker,'reference.png');writeFileSync(canary,Buffer.from(png,'base64'));
let child,nextId=0,scenario='generate',step=0,stderr='',failure;
const pending=new Map(),events=[],requests=[],images=[];
const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`timeout ${method}: ${stderr.slice(-1500)}`));},30000);
  pending.set(id,{resolve:r=>{clearTimeout(timer);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result);},reject});send({id,method,params});
});
const until=async(test,label)=>{const deadline=Date.now()+35000;while(!test()){if(failure)throw failure;if(Date.now()>deadline)throw Error(`timeout ${label}: ${stderr.slice(-2000)}`);await new Promise(r=>setTimeout(r,50));}};
const model=createServer(async(req,res)=>{
  try{
    const parts=[];for await(const c of req)parts.push(c);const body=JSON.parse(Buffer.concat(parts));
    if(req.url.includes('/images/')){
      images.push({scenario,path:req.url,body});
      res.writeHead(scenario==='failure'?403:200,{'content-type':'application/json'});
      res.end(JSON.stringify(scenario==='failure'?{error:{message:'fixture failure'}}:{created:1,data:[{b64_json:png}],background:'opaque'}));return;
    }
    assert(req.url.endsWith('/responses'));requests.push({scenario,body});
    let item;
    if(step++===0){
      const args={prompt:'draw a blue square'};
      if(scenario==='edit')args.num_last_images_to_include=1;
      if(scenario==='host-path')args.referenced_image_paths=[canary];
      item={type:'function_call',call_id:`image-${scenario}`,namespace:scenario==='forged'?'foreign':'image_gen',name:'imagegen',arguments:JSON.stringify(args)};
    }else item={type:'message',id:`answer-${requests.length}`,role:'assistant',content:[{type:'output_text',text:'Fixture finished.'}]};
    const response={id:`response-${requests.length}`};
    res.writeHead(200,{'content-type':'text/event-stream'});res.end([{type:'response.created',response},{type:'response.output_item.done',item},{type:'response.completed',response:{...response,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
  }catch(e){failure=e;res.writeHead(500);res.end();}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
writeFileSync(join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="yuan_broker"\n[model_providers.yuan_broker]\nname="Central model access"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
try{
  child=spawn(binary,[],{cwd:worker,env:{...process.env,CODEX_REMOTE_WORKSPACE:'1',CODEX_REMOTE_AUTH_MODE:'broker',CODEX_REMOTE_IMAGE_GENERATION:'1',CODEX_HOME:home,OPENAI_API_KEY:'',CODEX_API_KEY:'',RUST_LOG:'warn'},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-12000));child.on('error',e=>failure=e);
  createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);p.resolve(m);}else events.push(m);}catch(e){failure=e;}});
  const init=await rpc('initialize',{clientInfo:{name:'image_qa',version:'1'},capabilities:{experimentalApi:true}});assert.match(init.userAgent,/yuan-zhou-image-generation\/1/);send({method:'initialized',params:{}});
  let generatedThread;
  for(scenario of ['generate','edit','host-path','forged','plan','failure']){
    step=0;
    const threadId=scenario==='edit'?generatedThread:(await rpc('thread/start',{})).thread.id;
    if(scenario==='generate')generatedThread=threadId;
    const before=events.length,imageCount=images.length;
    await rpc('turn/start',{threadId,input:[{type:'text',text:scenario}],...(scenario==='plan'?{collaborationMode:{mode:'plan',settings:{model:'gpt-5.4',reasoning_effort:null,developer_instructions:null}}}:{})});
    await until(()=>events.slice(before).some(e=>e.method==='turn/completed'),'turn '+scenario);
    const completed=events.slice(before).filter(e=>e.method==='item/completed'&&e.params.item.type==='imageGeneration').map(e=>e.params.item);
    if(['generate','edit'].includes(scenario)){
      assert.equal(completed.length,1,JSON.stringify(requests.filter(r=>r.scenario===scenario).map(r=>r.body.input)));assert.equal(completed[0].status,'completed');assert.equal(completed[0].result,png);assert.equal(completed[0].savedPath??null,null);
      assert.equal(images.length,imageCount+1);assert.equal(images.at(-1).body.model,'gpt-image-2');
      if(scenario==='edit'){assert.equal(images.at(-1).path,'/v1/images/edits');assert.equal(images.at(-1).body.images[0].image_url,'data:image/png;base64,'+png);}
    }else if(scenario==='failure'){assert.equal(completed[0]?.status,'failed');}
    else assert.equal(images.length,imageCount,'denied tool reached image provider');
  }
  assert.match(JSON.stringify(requests.filter(r=>r.scenario==='host-path')),/REMOTE_IMAGE_PATH_DENIED/);
  assert.match(JSON.stringify(requests.filter(r=>r.scenario==='plan')),/PLAN_MODE_READ_ONLY/);
  const specs=requests[0].body.tools;assert(specs.some(t=>t.type==='namespace'&&t.name==='image_gen'));
  assert(!existsSync(join(home,'generated_images')));assert(!existsSync(join(worker,'generated_images')));
  assert.deepEqual(readdirSync(worker),['reference.png']);
  assert.equal((await rpc('thread/read',{threadId:generatedThread,includeTurns:true})).thread.turns.flatMap(t=>t.items).filter(i=>i.type==='imageGeneration'&&i.result===png).length,2);
  console.log(JSON.stringify({ok:true,run,checks:['native-image-namespace','generate','edit-last-generated','no-central-file-access','no-central-save','foreign-namespace-denied','plan-denied','generation-failure','history-inline-results']}));
}finally{child?.kill();model.closeAllConnections();await new Promise(r=>model.close(r));}
