// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Central-only actual Rust auth integration. All token bytes are invented fixtures.
// Never point this script at a real auth file; it creates every credential itself.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
assert.equal(process.platform,'darwin','Run actual Codex only on the central Mac');
const here=dirname(fileURLToPath(import.meta.url)), binary=resolve(process.argv[2]);
const root=mkdtempSync(join(process.env.HARNESS_QA_ROOT??here,'auth-refresh-'));
const jwt=claims=>`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const claims={'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account',chatgpt_user_id:'fixture-user',chatgpt_plan_type:'pro'},email:'fixture@example.invalid'};
const id=jwt(claims), access=jwt({...claims,exp:Math.floor(Date.now()/1000)+3600});
const seed=()=>({auth_mode:'chatgpt',OPENAI_API_KEY:null,tokens:{id_token:id,access_token:access,refresh_token:'FAKE_ONLY_refresh_before',account_id:'fixture-account'},last_refresh:new Date().toISOString()});
let refreshCalls=0, modelCalls=0, fixtureError;
const mock=createServer(async(req,res)=>{
  try {
    if(req.url==='/oauth/token') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      assert.equal(body.grant_type,'refresh_token');
      assert.equal(body.refresh_token,'FAKE_ONLY_refresh_before','Only this script\'s fake credential may reach this endpoint');
      refreshCalls++;res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id_token:id,access_token:access,refresh_token:'FAKE_ONLY_refresh_after'}));return;
    }
    if(req.url.endsWith('/responses')) {modelCalls++;res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture access token expired',type:'authentication_error',code:'token_expired'}}));return;}
    res.writeHead(404,{'content-type':'application/json'});res.end('{}');
  }catch(error){fixtureError=error;res.writeHead(500);res.end('fixture failed');}
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${mock.address().port}`;
const cases=[];
const running=new Set();
function setup(name,shared=false,expired=false) {
  const run=join(root,name),home=join(run,'home'),worker=join(run,'worker');
  mkdirSync(home,{recursive:true});mkdirSync(worker);
  const auth=seed();if(expired)auth.tokens.access_token=jwt({...claims,exp:1});
  const source=shared?join(run,'fake-shared-auth.json'):join(home,'auth.json');
  writeFileSync(source,JSON.stringify(auth),{mode:0o600});if(shared)symlinkSync(source,join(home,'auth.json'));
  writeFileSync(join(home,'config.toml'),`model="gpt-5.4"\nmodel_provider="fixture"\ncli_auth_credentials_store="file"\nchatgpt_base_url="${base}/backend-api"\n[model_providers.fixture]\nname="fixture"\nbase_url="${base}/v1"\nwire_api="responses"\nrequires_openai_auth=true\nrequest_max_retries=0\nstream_max_retries=0\n`);
  return {run,home,worker,source,shared};
}
async function launch(paths,unguarded=false) {
  let stderr='',nextId=0;const pending=new Map(),notifications=[];
  const env={...process.env,CODEX_HOME:paths.home,CODEX_REMOTE_WORKER_DIR:paths.worker,CODEX_REMOTE_BINARY:binary,CODEX_REMOTE_AUTH_FILE:paths.shared?paths.source:'/dev/null',CODEX_REFRESH_TOKEN_URL_OVERRIDE:`${base}/oauth/token`,CODEX_REVOKE_TOKEN_URL_OVERRIDE:`${base}/oauth/revoke`,CODEX_REMOTE_WORKSPACE:'1',CODEX_EXEC_SERVER_URL:'none',CODEX_REMOTE_AUTH_MODE:'caller-cannot-override',OPENAI_API_KEY:'',CODEX_API_KEY:'',RUST_LOG:'warn',TMPDIR:paths.worker};
  const child=unguarded?spawn('/usr/bin/sandbox-exec',['-f',join(here,'worker.sb'),'-D',`HARNESS_BINARY=${binary}`,'-D',`CODEX_HOME=${paths.home}`,'-D',`WORKER_DIR=${paths.worker}`,'-D',`AUTH_FILE=${paths.source}`,binary],{cwd:paths.worker,env,stdio:['pipe','pipe','pipe']}):spawn('/bin/sh',[join(here,'launch-central.sh'),'app-server'],{cwd:paths.worker,env,stdio:['pipe','pipe','pipe']});
  running.add(child);child.once('exit',()=>running.delete(child));
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000);});
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  createInterface({input:child.stdout}).on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}if(pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);}else notifications.push(message);});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error(`RPC timeout ${method}; ${stderr}`));},20000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});send({id,method,params});});
  const stop=async()=>{child.stdin.end();child.kill('SIGTERM');if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('exit',resolve));};
  try {const result=await rpc('initialize',{clientInfo:{name:'auth_fixture',version:'1'},capabilities:{experimentalApi:true}});assert.match(result.result?.userAgent??'',/yuan-zhou-remote-workspace\/1/);send({method:'initialized',params:{}});}
  catch(error){await stop();throw error;}
  return {rpc,notifications,stop,stderr:()=>stderr};
}
try {
  // Demonstrate the pre-fix risk with generated fake credentials only: network rotation
  // succeeds, then the strict OS profile rejects saving through the external symlink.
  const unsafe=setup('unguarded-fake-shared',true);let child=await launch(unsafe,true);
  let before=refreshCalls;await child.rpc('account/read',{refreshToken:true});
  assert.equal(refreshCalls-before,1);assert.equal(JSON.parse(readFileSync(unsafe.source)).tokens.refresh_token,'FAKE_ONLY_refresh_before');
  assert.match(child.stderr(),/Operation not permitted|Permission denied/i);await child.stop();
  cases.push({name:'unguarded fake shared token',networkRefresh:1,persisted:false,proves:'OS write denial happens after authority refresh'});

  const isolated=setup('isolated-owned');child=await launch(isolated);before=refreshCalls;
  await child.rpc('account/read',{refreshToken:true});assert.equal(refreshCalls-before,1);
  const persisted=JSON.parse(readFileSync(isolated.source));assert.equal(persisted.tokens.refresh_token,'FAKE_ONLY_refresh_after');assert(Date.now()-Date.parse(persisted.last_refresh)<60000);await child.stop();
  child=await launch(isolated);before=refreshCalls;const account=await child.rpc('account/read',{refreshToken:false});assert.equal(account.result?.account?.type,'chatgpt');assert.equal(refreshCalls,before);assert.equal(JSON.parse(readFileSync(isolated.source)).tokens.refresh_token,'FAKE_ONLY_refresh_after');await child.stop();
  cases.push({name:'isolated owned fake token',networkRefresh:1,persisted:true,restartReload:true,unnecessaryRefreshAfterRestart:false});

  const guarded=setup('guarded-expired-shared',true,true);const original=readFileSync(guarded.source,'utf8');child=await launch(guarded);before=refreshCalls;
  const started=Date.now();await child.rpc('account/read',{refreshToken:true});
  assert.equal(refreshCalls,before,'Launcher must override a caller-supplied refresh endpoint');
  const thread=await child.rpc('thread/start',{ephemeral:true});assert(thread.result?.thread?.id,JSON.stringify(thread));
  await child.rpc('turn/start',{threadId:thread.result.thread.id,input:[{type:'text',text:'Exercise the fixture 401 terminal behavior.'}]});
  while(Date.now()-started<20000&&!child.notifications.some(m=>m.method==='turn/completed'))await new Promise(resolve=>setTimeout(resolve,50));
  const terminal=child.notifications.find(m=>m.method==='turn/completed');assert(terminal,`No terminal within 20s: ${child.stderr()}`);
  assert.equal(terminal.params.turn.status,'failed');assert.equal(refreshCalls,before);assert(modelCalls>0&&modelCalls<=3,`Unexpected model retries: ${modelCalls}`);
  assert.equal(readFileSync(guarded.source,'utf8'),original);assert.match(child.stderr(),/shared-readonly.*refresh\/revoke disabled/);
  const error=terminal.params.turn.error?.message??JSON.stringify(terminal.params.turn.error);
  await child.stop();cases.push({name:'guarded expired shared fake token',callerEndpointOverridden:true,networkRefresh:0,credentialUnchanged:true,model401Requests:modelCalls,terminal:'failed',terminalMs:Date.now()-started,error});
  assert(!fixtureError,String(fixtureError));
  const result={status:'HARNESS_AUTH_REFRESH_OK',realCredentials:false,realAuthority:false,realRust:true,strictOsProfile:true,root,cases};
  writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {
  for(const child of running){child.stdin.end();child.kill('SIGTERM');}
  mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
}
