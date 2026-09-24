// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Central-only compiled-harness test. The loopback model is deterministic, needs no credentials,
// and is NOT a real model/device integration test. It tests the real Rust tool dispatcher.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(process.argv[2] ?? process.env.CODEX_REMOTE_BINARY ?? '');
assert.equal(process.platform, 'darwin', 'Run this probe on the central Mac only');
assert(existsSync(binary), 'Built codex-app-server binary required');
const run = mkdtempSync(join(process.env.HARNESS_QA_ROOT ?? here, 'boundary-smoke-'));
const home = join(run, 'codex-home'), worker = join(run, 'worker');
mkdirSync(home); mkdirSync(worker);
const sentinel = join(run, 'central-marker.txt'), sideEffect = join(run, 'FORBIDDEN-EXECUTED');
writeFileSync(sentinel, 'CENTRAL_ONLY_NEVER_MODEL_CONTEXT');
writeFileSync(join(worker, 'AGENTS.md'), 'CENTRAL_RULES_MUST_NOT_BE_LOADED');
writeFileSync(join(home, 'AGENTS.md'), 'CENTRAL_GLOBAL_RULES_MUST_NOT_BE_LOADED');
const requests = [], notifications = [], waiting = new Map();
let fixtureError, dynamicCalls = 0, stderr = '', serverProcess;
const respondSse = (res, index, item) => {
  const response = { id: `response-${index}` };
  const events = [{type:'response.created',response}, {type:'response.output_item.done',item},
    {type:'response.completed',response:{...response,usage:{input_tokens:20,output_tokens:10,total_tokens:30}}}];
  res.writeHead(200, {'content-type':'text/event-stream'});
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
};
const mock = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404);res.end();return; }
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const index=requests.length;
    if(index===1) respondSse(res,index,{type:'function_call',call_id:'builtin-escape',name:'exec_command',arguments:JSON.stringify({cmd:`touch ${sideEffect}`})});
    else if(index===2) respondSse(res,index,{type:'function_call',call_id:'client-tool',name:'device_workspace_context',arguments:'{}'});
    else if(index===3) respondSse(res,index,{type:'function_call',call_id:'draft-tool',name:'device_skill_draft',arguments:'{"requestKey":"boundary-probe"}'});
    else respondSse(res,index,{type:'message',id:'answer',role:'assistant',content:[{type:'output_text',text:'Boundary test completed.'}]});
  } catch(error) { fixtureError=error;res.writeHead(500);res.end('fixture failure'); }
});
await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve));
const port=mock.address().port;
writeFileSync(join(home,'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\ncli_auth_credentials_store = "file"\nnotify = ["/bin/sh", "-c", "touch ${sideEffect}"]\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_snapshot = true\nplugins = true\n`);
const send = message => serverProcess.stdin.write(JSON.stringify(message)+'\n');
let nextId=0;
const rpc=(method,params={}) => new Promise((resolve,reject)=>{
  const id=++nextId;
  const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`RPC timeout: ${method}; ${stderr.slice(-1200)}`));},30000);
  waiting.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});send({id,method,params});
});
try {
  serverProcess=spawn('/bin/sh',[join(here,'launch-central.sh'),'app-server'],{cwd:worker,env:{...process.env,CODEX_REMOTE_BINARY:binary,CODEX_HOME:home,CODEX_REMOTE_WORKER_DIR:worker,CODEX_REMOTE_AUTH_FILE:'/dev/null',OPENAI_API_KEY:'',CODEX_API_KEY:'',RUST_LOG:'warn'},stdio:['pipe','pipe','pipe']});
  serverProcess.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
  serverProcess.on('exit',(code,signal)=>{for(const pending of waiting.values())pending.reject(new Error(`Harness exited ${code}/${signal}; ${stderr}`));waiting.clear();});
  createInterface({input:serverProcess.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    if(message.method==='item/tool/call') {
      dynamicCalls++;
      assert.equal(message.params.tool,dynamicCalls===1?'device_workspace_context':'device_skill_draft');
      send({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:'{"source":"simulated-client-fixture","os":"windows"}'}]}});
    } else if(message.id!==undefined && waiting.has(message.id)) {
      const pending=waiting.get(message.id);waiting.delete(message.id);pending.resolve(message);
    } else notifications.push(message);
  });
  const initialized=await rpc('initialize',{clientInfo:{name:'yuan_zhou_boundary_smoke',version:'1'},capabilities:{experimentalApi:true}});
  assert.match(initialized.result?.userAgent??'',/yuan-zhou-remote-workspace\/1/);
  send({method:'initialized',params:{}});
  for(const [method,params] of [['command/exec',{command:['/bin/sh','-c',`touch ${sideEffect}`]}],['fs/readFile',{path:sentinel}]]) {
    const result=await rpc(method,params);assert.match(result.error?.message??'',/REMOTE_WORKSPACE_UNSUPPORTED/,method);
  }
  const skillDir=join(worker,'managed-skills','native-probe','1');mkdirSync(skillDir,{recursive:true});
  writeFileSync(join(skillDir,'SKILL.md'),'---\nname: native-probe\ndescription: Native managed skill verification\n---\nMANAGED_SKILL_BODY_NATIVE_LOADED\n');
  writeFileSync(join(worker,'managed-skills','catalog.json'),JSON.stringify(['native-probe/1']));
  const discovered=await rpc('skills/list',{cwds:[],forceReload:true});
  assert.equal(discovered.result?.data?.[0]?.skills?.[0]?.name,'native-probe',JSON.stringify(discovered));
  const fullCatalog=['native-probe/1'];
  for(let i=0;i<100;i++){
    const name=`capacity-probe-${i}`,relative=`${name}/1`,directory=join(worker,'managed-skills',relative);
    mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,'SKILL.md'),`---\nname: ${name}\ndescription: Capacity verification\n---\nFixture only.\n`);
    fullCatalog.push(relative);
  }
  writeFileSync(join(worker,'managed-skills','catalog.json'),JSON.stringify(fullCatalog));
  const full=await rpc('skills/list',{cwds:[],forceReload:true});
  assert.equal(full.result?.data?.flatMap(row=>row.skills).length,101,JSON.stringify(full));
  writeFileSync(join(worker,'managed-skills','catalog.json'),JSON.stringify([...fullCatalog,'native-probe/1']));
  const overflow=await rpc('skills/list',{cwds:[],forceReload:true});
  assert.equal(overflow.result?.data?.flatMap(row=>row.skills).length,0,JSON.stringify(overflow));
  writeFileSync(join(worker,'managed-skills','catalog.json'),JSON.stringify(['native-probe/1']));
  assert.equal((await rpc('skills/list',{cwds:[run]})).error?.message,'REMOTE_SKILL_SCOPE_DENIED');
  const forged=await rpc('turn/start',{threadId:'fake',input:[{type:'skill',name:'forged',path:sentinel}]});
  assert.match(forged.error?.message??'',/REMOTE_SKILL_PATH_DENIED/);
  const overridden=await rpc('thread/start' ,{cwd:run});
  assert.match(overridden.error?.message??'',/REMOTE_WORKSPACE_OVERRIDE_DENIED/);
  const thread=await rpc('thread/start',{ephemeral:true,dynamicTools:[{type:'function',name:'device_workspace_context',description:'Return the bound client workspace context.',inputSchema:{type:'object',properties:{},additionalProperties:false}},{type:'function',name:'device_skill_draft',description:'Register a client draft.',inputSchema:{type:'object',properties:{requestKey:{type:'string'}},required:['requestKey'],additionalProperties:false}},{type:'function',name:'device_bad_plugin',description:'Must be filtered.',inputSchema:{type:'object',properties:{}}}]});
  assert(thread.result?.thread?.id,JSON.stringify(thread));
  const turn=await rpc('turn/start',{threadId:thread.result.thread.id,input:[{type:'text',text:'Run the boundary fixture.'},{type:'skill',name:'native-probe',path:join(skillDir,'SKILL.md')}]});
  assert(turn.result,JSON.stringify(turn));
  const deadline=Date.now()+45000;
  while(Date.now()<deadline && !notifications.some(x=>x.method==='turn/completed')) await new Promise(resolve=>setTimeout(resolve,100));
  const completed=notifications.find(x=>x.method==='turn/completed');assert(completed,`Missing terminal notification; ${stderr}`);
  assert.equal(completed.params.turn.status,'completed',JSON.stringify(completed));
  assert.equal(requests.length,4);
  assert.match(JSON.stringify(requests[0]),/MANAGED_SKILL_BODY_NATIVE_LOADED/);
  const tools=requests[0].tools.map(tool=>tool.name);
  for(const name of ['device_workspace_context','device_skill_draft','update_plan','request_user_input'])assert(tools.includes(name),name);
  assert(tools.every(name=>['device_workspace_context','device_skill_draft','update_plan','request_user_input','get_goal','create_goal','update_goal'].includes(name)),JSON.stringify(tools));
  assert.equal(dynamicCalls,2);
  assert.match(JSON.stringify(requests[1].input),/unsupported|REMOTE_WORKSPACE/i);
  assert(!JSON.stringify(requests).includes('CENTRAL_RULES_MUST_NOT_BE_LOADED'));
  assert(!JSON.stringify(requests).includes('CENTRAL_GLOBAL_RULES_MUST_NOT_BE_LOADED'));
  assert(!JSON.stringify(requests).includes('CENTRAL_ONLY_NEVER_MODEL_CONTEXT'));
  assert(!existsSync(sideEffect),'A local command or notify hook executed');
  assert(!fixtureError,String(fixtureError));
  console.log(JSON.stringify({status:'HARNESS_RUNTIME_BOUNDARY_OK',credentials:false,realModel:false,realDevice:false,managedSkillCapacity:101,overflowDenied:true,requests:requests.length,tools,dynamicCalls,root:run}));
} finally {
  if(serverProcess) {serverProcess.stdin.end();serverProcess.kill('SIGTERM');}
  for(const pending of waiting.values())pending.resolve({error:{message:'probe ended'}});
  mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
}
