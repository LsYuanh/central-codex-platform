// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real compiled Mac App Server, deterministic catalog endpoint, no provider login.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
assert.equal(process.platform,'darwin');
const [binaryArg,modelsArg,versionArg]=process.argv.slice(2);
assert(binaryArg&&modelsArg&&process.env.HARNESS_QA_ROOT);
const pin=JSON.parse(readFileSync(new URL('./upstream.json',import.meta.url)));
const version=versionArg??pin.version;
assert(/^\d+\.\d+\.\d+$/.test(version));
const root=mkdtempSync(join(resolve(process.env.HARNESS_QA_ROOT),'catalog-smoke-'));
const home=join(root,'home'),worker=join(root,'worker');mkdirSync(home);mkdirSync(worker);
const template=JSON.parse(readFileSync(modelsArg)).models[0];
const model={...template,slug:'fixture-remote-only',display_name:'Remote catalog fixture',visibility:'list',supported_in_api:true};
const requests=[];const token='synthetic-broker-token';
const server=createServer((req,res)=>{
  requests.push({url:req.url,authorization:req.headers.authorization});
  if(req.url!==`/v1/models?client_version=${version}`||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:[model]}));
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
writeFileSync(join(home,'config.toml'),`model = "fixture-remote-only"\nmodel_provider = "central_broker"\ncli_auth_credentials_store = "file"\n[model_providers.central_broker]\nname = "Central Broker"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nenv_key = "CODEX_MODEL_BROKER_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
let child,stderr='',next=0;const pending=new Map();
function rpc(method,params){return new Promise((resolve,reject)=>{
  const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CATALOG_RPC_TIMEOUT:${method}:${stderr.slice(-1200)}`));},30000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
  child.stdin.write(JSON.stringify({id,method,params})+'\n');
});}
try{
  child=spawn(resolve(binaryArg),[],{cwd:worker,env:{...process.env,CODEX_HOME:home,CODEX_REMOTE_WORKSPACE:'1',CODEX_REMOTE_AUTH_MODE:'broker',CODEX_REMOTE_MODEL_CATALOG:'1',CODEX_MODEL_BROKER_TOKEN:token,OPENAI_API_KEY:'',CODEX_API_KEY:'',RUST_LOG:'warn'},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-6000);});
  child.on('exit',()=>{for(const p of pending.values())p.reject(Error('CATALOG_PROCESS_EXITED'));pending.clear();});
  createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const init=await rpc('initialize',{clientInfo:{name:'catalog-smoke',version:'1'},capabilities:{experimentalApi:true}});
  assert.match(init.userAgent,/yuan-zhou-remote-workspace\/1/);
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  for(let i=0;i<2;i++){
    const list=await rpc('model/list',{includeHidden:false});
    assert.deepEqual(list.data.map(m=>m.id),['fixture-remote-only'],'Remote catalog must replace bundled fallback and survive cache reuse');
    assert.equal(list.data[0].displayName,'Remote catalog fixture');
  }
  assert(requests.length>0,'App Server must fetch the broker catalog');
  assert(requests.every(r=>r.url.endsWith(`client_version=${version}`)));
  console.log(JSON.stringify({status:'HARNESS_MODEL_CATALOG_OK',version,requests:requests.length,realModel:false}));
}finally{
  if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
  server.closeAllConnections();await new Promise(done=>server.close(done));
}
