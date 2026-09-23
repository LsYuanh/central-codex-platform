// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real compiled App Server, isolated synthetic history, no model or user credentials.
// This exercises the application boundary, not Windows AppContainer/macOS sandbox qualification.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir, mkdtemp, writeFile, readFile, readdir, access} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

assert(process.argv[2], 'Usage: node harness/thread-delete-smoke.mjs BUILT_APP_SERVER');
const binary=resolve(process.argv[2]);await access(binary);
await mkdir('target',{recursive:true});
const root=await mkdtemp(resolve('target/thread-delete-runtime-'));
const home=join(root,'home'),otherHome=join(root,'other-user-home'),worker=join(root,'worker'),client=join(root,'client-files');
for(const path of [home,otherHome,worker,client])await mkdir(path);
const sentinel=join(client,'keep.txt');await writeFile(sentinel,'CLIENT_FILE_MUST_SURVIVE');
const workerSentinel=join(worker,'keep.txt');await writeFile(workerSentinel,'WORKER_FILE_MUST_SURVIVE');
await writeFile(join(home,'config.toml'),'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n');
const id=randomUUID(),survivor=randomUUID(),timestamp='2026-09-23T00:00:00Z';
async function seed(directory,threadId,preview) {
  const sessions=join(directory,'sessions','2026','09','23');await mkdir(sessions,{recursive:true});
  const path=join(sessions,`rollout-2026-09-23T00-00-00-${threadId}.jsonl`);
  const lines=[
    {timestamp,type:'session_meta',payload:{id:threadId,session_id:threadId,timestamp,cwd:client,originator:'thread-delete-qa',cli_version:'0.153.4',source:'cli',model_provider:'openai'}},
    {timestamp,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:preview}]}},
    {timestamp,type:'event_msg',payload:{type:'user_message',message:preview,kind:'plain'}},
  ];
  await writeFile(path,lines.map(row=>JSON.stringify(row)).join('\n')+'\n');return path;
}
const original=await seed(home,id,'DELETE_ONLY_THIS_HISTORY');
const keep=await seed(home,survivor,'KEEP_OTHER_HISTORY');
const foreign=await seed(otherHome,id,'FOREIGN_USER_HISTORY');
const keepBytes=await readFile(keep),foreignBytes=await readFile(foreign);
let processHandle,stderr='',next=0,reader;const pending=new Map(),notifications=[];
const send=message=>processHandle.stdin.write(JSON.stringify(message)+'\n');
function rpc(method,params={}) {
  return new Promise((resolve,reject)=>{
    const requestId=++next,timer=setTimeout(()=>{pending.delete(requestId);reject(Error(`RPC timeout: ${method}; ${stderr.slice(-1200)}`));},30000);
    pending.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    send({id:requestId,method,params});
  });
}
async function start() {
  // Explicit environment prevents inheriting another runtime's broker or model credentials.
  const env={};for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{HOME:home,USERPROFILE:home,TEMP:worker,TMP:worker,TMPDIR:worker,CODEX_HOME:home,CODEX_REMOTE_WORKSPACE:'1',CODEX_REMOTE_AUTH_MODE:'isolated-file',CODEX_EXEC_SERVER_URL:'none',RUST_LOG:'warn'});
  processHandle=spawn(binary,[],{cwd:worker,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  processHandle.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
  processHandle.on('error',error=>{for(const p of pending.values())p.reject(error);pending.clear();});
  processHandle.on('exit',code=>{for(const p of pending.values())p.reject(Error(`App Server exited ${code}; ${stderr}`));pending.clear();});
  reader=createInterface({input:processHandle.stdout});reader.on('line',line=>{
    let value;try{value=JSON.parse(line);}catch{return;}
    if(value.method){notifications.push(value);if(value.id!==undefined)send({id:value.id,error:{code:-32601,message:'No tools allowed in history-only QA'}});return;}
    const entry=pending.get(value.id);if(entry){pending.delete(value.id);entry.resolve(value);}
  });
  const initialized=await rpc('initialize',{clientInfo:{name:'thread-delete-runtime-qa',version:'1'},capabilities:{experimentalApi:true}});
  assert.match(initialized.result?.userAgent??'',/yuan-zhou-remote-workspace\/1/,JSON.stringify(initialized));send({method:'initialized'});
}
async function stop() {
  if(!processHandle?.pid||processHandle.exitCode!==null||processHandle.signalCode!==null)return;
  const child=processHandle;
  await new Promise(resolve=>{const timer=setTimeout(()=>child.kill(),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();});
  reader?.close();
}
async function paths(directory) {
  const result=[];for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){
    const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await paths(path));else result.push(path);
  }return result;
}
try {
  await start();
  for(const method of ['command/exec','fs/readFile','fs/delete','thread/deleteAll']) {
    const denied=await rpc(method,{path:sentinel,command:['cmd','/c','exit']});assert(denied.error,`${method} unexpectedly allowed`);
    if(method==='command/exec'||method==='fs/readFile')assert.match(denied.error.message,/REMOTE_WORKSPACE_UNSUPPORTED/);
  }
  const before=await rpc('thread/read',{threadId:id,includeTurns:true});assert.equal(before.result?.thread?.id,id,JSON.stringify(before));
  const archived=await rpc('thread/archive',{threadId:id});assert(archived.result,JSON.stringify(archived));
  await assert.rejects(access(original),{code:'ENOENT'});
  const archivedFiles=(await paths(join(home,'archived_sessions'))).filter(path=>path.includes(id));assert(archivedFiles.length>0,'No persisted archived history');
  const deleted=await rpc('thread/delete',{threadId:id});assert.deepEqual(deleted.result,{},JSON.stringify(deleted));
  assert((await rpc('thread/read',{threadId:id,includeTurns:true})).error,'Deleted history remained readable');
  assert(!(await paths(home)).some(path=>path.includes(id)),'Deleted rollout remains on disk');
  assert(notifications.some(value=>value.method==='thread/deleted'&&value.params.threadId===id),'Missing deletion notification');
  assert.equal((await rpc('thread/read',{threadId:survivor})).result?.thread?.id,survivor);
  await stop();await start();
  assert((await rpc('thread/read',{threadId:id,includeTurns:true})).error,'Deleted history reappeared after restart');
  const list=await rpc('thread/list',{archived:true,limit:100,modelProviders:[]});assert(list.result,JSON.stringify(list));
  assert(!(list.result.data??[]).some(row=>row.id===id),'Deleted history reappeared in archived list');
  assert.equal((await rpc('thread/read',{threadId:survivor})).result?.thread?.id,survivor);
  assert.deepEqual(await readFile(keep),keepBytes);assert.deepEqual(await readFile(foreign),foreignBytes);
  assert.equal(await readFile(sentinel,'utf8'),'CLIENT_FILE_MUST_SURVIVE');assert.equal(await readFile(workerSentinel,'utf8'),'WORKER_FILE_MUST_SURVIVE');
  const result={status:'THREAD_DELETE_RUNTIME_OK',binary,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),root,model:false,realUserData:false,checks:['archive then delete','rollout removal','read/list after restart','other thread and foreign home preserved','client/worker files preserved','filesystem/command RPC denied']};
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await stop();await writeFile(join(root,'stderr.log'),stderr);}
