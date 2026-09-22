// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Authenticated gateway + native token storage + real Local Agent. The App Server
// is a labelled protocol fixture; real Harness loading is tested separately.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import https from 'node:https';
import net from 'node:net';
import {PlatformAuth} from '../../services/central-gateway/dist/platform-auth.js';
import {CREATOR_ID,CREATOR_MAIN} from '../../services/central-gateway/dist/builtin-creator.js';
import {SkillStore,validateSkillFiles} from '../../services/central-gateway/dist/skills.js';

await mkdir(resolve('target'),{recursive:true});
const root=await mkdtemp(resolve('target/skills-smoke-')),children=[],clients=[],checks=[];
const hash=x=>createHash('sha256').update(x).digest('hex');
const pass=x=>{checks.push(x);console.log('PASS '+x);};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let logs='';
const start=(file,args,env={})=>{const p=spawn(file,args,{env:{...process.env,...env},windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(p);p.stderr.on('data',d=>logs=(logs+d).slice(-6000));p.stdin.on('error',()=>{});return p;};
async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await delay(100);}throw Error(label+': '+logs);}
const key=join(root,'server-key.pem'),cert=join(root,'server.pem'),config=join(root,'openssl.cnf');
await writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const tls=spawnSync(process.env.OPENSSL_BIN??'C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-keyout',key,'-out',cert,'-config',config],{windowsHide:true});assert.equal(tls.status,0);
const caPath=join(root,'ca.pem');await writeFile(caPath,await readFile(cert));
const leaf=join(root,'leaf.cnf');await writeFile(leaf,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const openssl=args=>{const r=spawnSync(process.env.OPENSSL_BIN??'C:/Program Files/Git/usr/bin/openssl.exe',args,{windowsHide:true});assert.equal(r.status,0,String(r.stderr));};
const leafKey=join(root,'leaf-key.pem');openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',leafKey,'-out',join(root,'leaf.csr'),'-subj','/CN=localhost']);
openssl(['x509','-req','-in',join(root,'leaf.csr'),'-CA',caPath,'-CAkey',key,'-set_serial','1','-days','2','-out',cert,'-extfile',leaf]);
const ca=await readFile(caPath),password=randomBytes(32).toString('hex'),authFile=join(root,'auth.json');
const auth=new PlatformAuth(authFile,undefined,undefined,'device-token-v1');
const admin=await auth.createUser('skilladmin',password,'admin'),alice=await auth.createUser('skillalice',password),bob=await auth.createUser('skillbob',password);auth.close();
const fixture=`const fs=require('fs'),path=require('path'),rl=require('readline');let n=0;const threads=new Map([['legacy-skill-thread',{id:'legacy-skill-thread',turns:[]}]]),pending=new Map();const emit=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(!q.method){const spec=pending.get(q.id);if(spec){threads.get(spec.threadId).lastTool=q.result;emit('turn/completed',{threadId:spec.threadId,turn:{id:spec.turnId,status:'completed'}});}return;}
let result={};if(q.method==='initialize')result={userAgent:'protocol-fixture yuan-zhou-remote-workspace/1 yuan-zhou-managed-skills/1'};
if(q.method==='skills/list'){const root=path.join(process.cwd(),'managed-skills');const rows=JSON.parse(fs.readFileSync(path.join(root,'catalog.json')));result={data:[{skills:rows.map(v=>({name:/^name: (.+)$/m.exec(fs.readFileSync(path.join(root,v,'SKILL.md'),'utf8'))[1]})),errors:[]}]};}
if(q.method==='thread/start'){const t={id:'skill-thread-'+process.pid+'-'+ ++n,turns:[]};threads.set(t.id,t);result={thread:t};}
if(q.method==='thread/list')result={data:[...threads.values()]};
if(q.method==='thread/read'||q.method==='thread/resume')result={thread:threads.get(q.params.threadId)};
if(q.method==='turn/start'){const t=threads.get(q.params.threadId);t.input=q.params.input;t.lastTool=null;result={turn:{id:'turn-'+ ++n}};}
process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
if(q.method==='turn/start'){const text=q.params.input[0]?.text;let tool;try{tool=JSON.parse(text);}catch{};if(tool?.skill||tool?.tool){const id='tool-'+ ++n;pending.set(id,{threadId:q.params.threadId,turnId:result.turn.id});process.stdout.write(JSON.stringify({id,method:'item/tool/call',params:{threadId:q.params.threadId,turnId:result.turn.id,tool:tool.tool??'device_skill_load',arguments:tool.arguments??{name:tool.skill}}})+'\\n');}else emit('turn/completed',{threadId:q.params.threadId,turn:{...result.turn,status:'completed'}});}
});`;
for(const user of [admin,alice,bob]){const dir=join(root,'workers',hash(user.id),'runtime');await mkdir(dir,{recursive:true});await writeFile(join(dir,'app-server'),fixture);}
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const gateway=`wss://localhost:${port}/ws`,origin=`https://localhost:${port}`,namespace='com.centralcodex.harnessqa.central-live';
function post(route,body={},token){return new Promise((r,j)=>{const req=https.request(origin+route,{method:'POST',ca,agent:false,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const v=JSON.parse(raw);v.ok?r(v.data):j(Error(v.error));}catch(e){j(e);}});});req.on('error',j);req.end(JSON.stringify(body));});}
async function connect(user,login,withAgent=true){
 const tokenRoot=join(root,randomUUID());await mkdir(tokenRoot);const code=(await post('/auth/admin/pair-code',{userId:user.id},login.accessToken)).code;
 const helper=start(resolve('target/debug/examples/central-live-client.exe'),[]);const pending=new Map(),events=[];let deviceId,connected=false;
 const send=message=>helper.stdin.write(JSON.stringify({kind:'send',message})+'\n');
 createInterface({input:helper.stdout}).on('line',line=>{const frame=JSON.parse(line);if(frame.kind==='paired')deviceId=frame.deviceId;if(frame.kind==='connected')connected=true;if(frame.kind==='message'){const m=frame.message;events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);}});
 helper.stdin.write(JSON.stringify({gateway,caPath,code,tokenRoot,namespace})+'\n');await until(()=>connected,'native authenticated UI');
 const request=(operation,payload={})=>new Promise((r,j)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);j(Error('timeout '+operation));},25000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?r(m.data):j(Error(m.error));});send({type:'request',requestId,operation,payload});});
 const workspace=join(root,'workspace-'+deviceId);await mkdir(workspace);
 const env={YUAN_PLATFORM_NAMESPACE:namespace,YUAN_PLATFORM_DATA_DIR:tokenRoot,YUAN_PLATFORM_CA:caPath};
 let agent;if(withAgent){agent=start(resolve('target/debug/local-agent.exe'),['--workspace-root',workspace,'--gateway-url',gateway.replace('/ws','/ws/agent')+'?deviceId='+deviceId],env);agent.stdout.resume();await until(async()=>{try{return (await request('device.workspace.context')).ok;}catch{return false;}},'real Agent ready');}
 assert.equal((await request('session.initialize')).platformCapabilities.skills,true);
 const client={request,events,helper,agent,env,workspace,deviceId};clients.push(client);return client;
}
const fixtureFile=(path,text)=>{const bytes=Buffer.from(text);return {path,bytes:bytes.length,sha256:hash(bytes),data:bytes.toString('base64')};};
await writeFile(join(root,'state.json'),JSON.stringify({version:1,workerLayout:'per-user/v1',users:{[alice.id]:[{id:'legacy-skill-thread',summary:{id:'legacy-skill-thread'}}]}}));
try{
 const server=start(process.execPath,[resolve('services/central-gateway/dist/index.js')],{CODEX_BIN:process.execPath,PLATFORM_WORKER_ISOLATION:'protocol-fixture',TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:join(root,'state.json'),PLATFORM_AUTH_FILE:authFile,PLATFORM_TLS_CERT:cert,PLATFORM_TLS_KEY:leafKey});server.stdout.on('data',d=>logs=(logs+d).slice(-6000));
 await until(()=>logs.includes('listening'),'gateway ready');const login=await post('/auth/login',{username:'skilladmin',password});
 const a=await connect(alice,login),a2=await connect(alice,login),b=await connect(bob,login),req=a.request;
 const creationKey=randomUUID(),draft=await req('skill.draft',{creationKey});assert.equal((await req('skill.draft',{creationKey})).draft.id,draft.draft.id);
 assert.deepEqual((await a2.request('skill.list')).drafts,[]);
 await mkdir(join(draft.draft.path,'scripts'));await writeFile(join(draft.draft.path,'SKILL.md'),'---\nname: skill-proof\ndescription: "验证个人技能"\n---\nUse scripts/proof.ps1 via client tools.\n');await writeFile(join(draft.draft.path,'scripts/proof.ps1'),'Write-Output "CLIENT_SKILL_EXECUTION"\n');
 await assert.rejects(a2.request('skill.preview',{id:draft.draft.id}),/NOT_FOUND/);
 const preview=await req('skill.preview',{id:draft.draft.id});assert.equal(preview.files.length,2);
 await writeFile(join(draft.draft.path,'scripts/proof.ps1'),'throw "CHANGED_AFTER_PREVIEW"');
 const saved=(await req('skill.save',{previewId:preview.previewId})).skill;assert.equal((await req('skill.save',{previewId:preview.previewId})).skill.id,saved.id);
 assert.equal((await a2.request('skill.list')).skills[0].id,saved.id);assert.deepEqual((await b.request('skill.list')).skills.map(s=>s.id),[CREATOR_ID]);
 for(const operation of ['skill.read','skill.update','skill.remove'])await assert.rejects(b.request(operation,{id:saved.id,revision:1,enabled:false}),/NOT_FOUND/);
 pass('preview is immutable; save is idempotent; same account shares skills but not device drafts; foreign account cannot read or mutate');
 const thread=(await req('conversation.create')).thread;
 await req('conversation.turn.create',{threadId:thread.id,clientMessageId:randomUUID(),input:[{type:'text',text:'$skill-proof'}]});
 const read=await req('conversation.read',{threadId:thread.id}),input=read.thread.input;
 assert(input.some(i=>i.type==='skill'&&i.name==='skill-proof'));const resource=JSON.parse(input.find(i=>i.type==='text'&&i.text.startsWith('Selected skill resources: ')).text.slice(26));
 assert(!('instructions'in resource));assert.equal(await readFile(join(resource.directory,'scripts/proof.ps1'),'utf8'),'Write-Output "CLIENT_SKILL_EXECUTION"\n');
 const executed=await req('device.exec',{program:'powershell',args:['-NoProfile','-File',join(resource.directory,'scripts/proof.ps1')],cwd:resource.directory});assert(executed.ok,JSON.stringify(executed));assert.match(executed.result.stdout,/CLIENT_SKILL_EXECUTION/);
 await req('conversation.turn.create',{threadId:thread.id,clientMessageId:randomUUID(),input:[{type:'text',text:'Explain $unknown variable'}]});
 await assert.rejects(req('conversation.turn.create',{threadId:thread.id,clientMessageId:randomUUID(),input:[{type:'skill',name:'bad',path:'C:/secret/SKILL.md'}]}),/SKILL|skill/);
 pass('explicit mention becomes native skill input; verified full package and script execute on real client; ordinary dollar variables remain valid');
 const t2=(await a2.request('conversation.create')).thread;
 await a2.request('conversation.turn.create',{threadId:t2.id,clientMessageId:randomUUID(),input:[{type:'text',text:JSON.stringify({skill:'skill-proof'})}]});
 let tool;await until(async()=>{tool=(await a2.request('conversation.read',{threadId:t2.id})).thread.lastTool;return tool;},'dynamic skill load');assert(tool.success,JSON.stringify(tool));const loaded=JSON.parse(tool.contentItems[0].text);assert.equal(loaded.revision,1);assert.match(loaded.instructions,/Use scripts/);
 pass('dynamic discovery loads the package onto a second authenticated client');
 const creator=(await req('skill.list')).skills.find(s=>s.id===CREATOR_ID);
 assert.equal(creator.source,'builtin');assert.equal(creator.displayName,'创建技能');
 assert.equal((await req('skill.read',{id:CREATOR_ID})).content,CREATOR_MAIN);
 for(const operation of ['skill.remove','skill.draft'])await assert.rejects(req(operation,{id:CREATOR_ID,revision:creator.revision,skillId:CREATOR_ID,creationKey:randomUUID()}),/BUILTIN_READONLY/);
 await assert.rejects(req('skill.update',{id:CREATOR_ID,revision:creator.revision,enabled:false,automatic:true}),/BUILTIN_READONLY/);
 const creatorOff=(await req('skill.update',{id:CREATOR_ID,revision:creator.revision,enabled:true,automatic:false})).skill;
 assert.equal((await a2.request('skill.list')).skills.find(s=>s.id===CREATOR_ID).automatic,false);
 assert.equal((await b.request('skill.list')).skills.find(s=>s.id===CREATOR_ID).automatic,true);
 assert.equal(new SkillStore(join(root,'personal-skills.json')).get(alice.id,CREATOR_ID).automatic,false);
 const creatorProjection=join(root,'workers',hash(alice.id),'runtime','managed-skills',CREATOR_ID,String(creatorOff.revision),'agents/openai.yaml');
 assert.match(await readFile(creatorProjection,'utf8'),/false/);
 await req('conversation.turn.create',{threadId:thread.id,clientMessageId:randomUUID(),input:[{type:'text',text:'$'+CREATOR_ID}]});
 const builtinInput=(await req('conversation.read',{threadId:thread.id})).thread.input;
 assert(builtinInput.some(i=>i.type==='skill'&&i.name===CREATOR_ID));
 const builtinResource=JSON.parse(builtinInput.find(i=>i.text?.startsWith('Selected skill resources: ')).text.slice(26));
 assert.equal(await readFile(join(builtinResource.directory,'SKILL.md'),'utf8'),CREATOR_MAIN);
 pass('built-in is readonly, namespaced and loaded onto client; automatic preference is persistent and user-scoped; explicit invocation still works');
 async function draftTool(client,tid,args){
   await client.request('conversation.turn.create',{threadId:tid,clientMessageId:randomUUID(),input:[{type:'text',text:JSON.stringify({tool:'device_skill_draft',arguments:args})}]});
   let reply;await until(async()=>{reply=(await client.request('conversation.read',{threadId:tid})).thread.lastTool;return reply;},'draft tool');return reply;
 }
 await assert.rejects(req('conversation.turn.create',{threadId:'legacy-skill-thread',clientMessageId:randomUUID(),input:[{type:'text',text:'$'+CREATOR_ID}]}),/SKILL_CREATOR_NEW_THREAD_REQUIRED/);
 const oldDraft=await draftTool(a,'legacy-skill-thread',{requestKey:'old-thread-proof'});assert.equal(oldDraft.success,false);assert.match(oldDraft.contentItems[0].text,/SKILL_CREATOR_NEW_THREAD_REQUIRED/);
 pass('old tool snapshots receive an explicit new-conversation recovery error');
 const draftArgs={requestKey:'create-proof-skill-1'};
 const modelDraftReply=await draftTool(a,thread.id,draftArgs);assert(modelDraftReply.success,JSON.stringify(modelDraftReply));
 const modelDraft=JSON.parse(modelDraftReply.contentItems[0].text).draft;
 assert.equal(JSON.parse((await draftTool(a,thread.id,draftArgs)).contentItems[0].text).draft.id,modelDraft.id);
 assert((await req('skill.list')).drafts.some(d=>d.id===modelDraft.id));assert(!(await a2.request('skill.list')).drafts.some(d=>d.id===modelDraft.id));
 assert(a.events.some(e=>e.name==='skill/changed'));
 const otherDraft=JSON.parse((await draftTool(a2,t2.id,draftArgs)).contentItems[0].text).draft;assert.notEqual(otherDraft.id,modelDraft.id);
 const invalid=await draftTool(a,thread.id,{...draftArgs,path:'C:/untrusted'});assert.equal(invalid.success,false);
 const foreign=await draftTool(b,(await b.request('conversation.create')).thread.id,{...draftArgs,skillId:saved.id});assert.equal(foreign.success,false);
 await writeFile(join(modelDraft.path,'SKILL.md'),'---\nname: created-through-dialog\ndescription: "Dialog skill"\n---\nUse the current client.\n');
 const modelPreview=await req('skill.preview',{id:modelDraft.id});const modelSaved=(await req('skill.save',{previewId:modelPreview.previewId})).skill;
 assert((await a2.request('skill.list')).skills.some(s=>s.id===modelSaved.id));
 const savedRetry=await draftTool(a,thread.id,draftArgs);assert.equal(savedRetry.success,false);assert.match(savedRetry.contentItems[0].text,/ALREADY_SAVED/);
 await assert.rejects(req('skill.draft',{creationKey:CREATOR_ID}),/ID_RESERVED/);
 const reserved=await req('skill.draft',{creationKey:randomUUID()});await writeFile(join(reserved.draft.path,'SKILL.md'),CREATOR_MAIN);
 const reservedPreview=await req('skill.preview',{id:reserved.draft.id});await assert.rejects(req('skill.save',{previewId:reservedPreview.previewId}),/NAME_RESERVED/);
 pass('model-created draft is registered on the real client; stable retries reuse it; thread/device/user separation and reserved names hold; preview/save shares the package');
 const edit1=await req('skill.draft',{creationKey:randomUUID(),skillId:saved.id}),edit2=await a2.request('skill.draft',{creationKey:randomUUID(),skillId:saved.id});
 const p1=await req('skill.preview',{id:edit1.draft.id}),p2=await a2.request('skill.preview',{id:edit2.draft.id});
 const updated=(await req('skill.save',{previewId:p1.previewId})).skill;await assert.rejects(a2.request('skill.save',{previewId:p2.previewId}),/VERSION_CONFLICT/);
 const disabled=(await req('skill.update',{id:saved.id,revision:updated.revision,enabled:false,automatic:false})).skill;
 await assert.rejects(req('conversation.turn.create',{threadId:thread.id,clientMessageId:randomUUID(),input:[{type:'text',text:'$skill-proof'}]}),/DISABLED/);
 const enabled=(await req('skill.update',{id:saved.id,revision:disabled.revision,enabled:true,automatic:false})).skill;
 const projection=join(root,'workers',hash(alice.id),'runtime','managed-skills',saved.id,String(enabled.revision));assert.match(await readFile(join(projection,'agents/openai.yaml'),'utf8'),/false/);assert.deepEqual((await readdir(projection)).sort(),['SKILL.md','agents']);
 pass('editing conflicts are rejected; disabled skills cannot start; automatic matching policy reaches minimal native projection');
 const store=new SkillStore(join(root,'personal-skills.json'));assert.equal(store.list(alice.id).find(s=>s.id===saved.id).revision,enabled.revision);assert.throws(()=>store.resolve(alice.id,saved.id,1),/VERSION_CONFLICT/);
 for(const path of ['../secret','assets/CON','a\\b','x:y'])assert.throws(()=>validateSkillFiles([fixtureFile(path,'x')]),/PATH/);
 assert.throws(()=>validateSkillFiles([fixtureFile('SKILL.md','---\nname: proof\ndescription: "x"\n---'),fixtureFile('skill.md','duplicate')]),/DUPLICATE/);
 const collisionState=JSON.parse(await readFile(join(root,'personal-skills.json'),'utf8'));const collisionRow=collisionState.skills.find(s=>s.id===saved.id);
 Object.assign(collisionRow,{name:CREATOR_ID,description:creator.description,platforms:[],programs:[],files:[fixtureFile('SKILL.md',CREATOR_MAIN)]});
 const collisionFile=join(root,'collision-skills.json');await writeFile(collisionFile,JSON.stringify(collisionState));const collisionStore=new SkillStore(collisionFile);
 assert.equal(collisionStore.list(alice.id).find(s=>s.id===saved.id).nameConflict,true);assert.equal(collisionStore.list(alice.id).find(s=>s.id===saved.id).enabled,false);
 assert.throws(()=>collisionStore.resolve(alice.id,saved.id),/NAME_RESERVED/);assert.equal(collisionStore.byName(alice.id,CREATOR_ID).source,'builtin');assert.equal(collisionStore.get(alice.id,saved.id).files[0].data,collisionRow.files[0].data);
 collisionStore.project(alice.id,join(root,'collision-worker'));const collisionCatalog=JSON.parse(await readFile(join(root,'collision-worker/managed-skills/catalog.json'),'utf8'));assert(!collisionCatalog.some(v=>v.startsWith(saved.id+'/')));
 const fullFile=join(root,'full-skills.json');const fullSkills=Array.from({length:100},(_,i)=>({...collisionRow,id:'full-skill-'+i,name:'full-skill-'+i,files:[fixtureFile('SKILL.md','---\nname: full-skill-'+i+'\ndescription: "'+creator.description+'"\n---\nUse client tools.\n')]}));
 await writeFile(fullFile,JSON.stringify({version:1,skills:fullSkills,drafts:[]}));const fullStore=new SkillStore(fullFile);fullStore.project(alice.id,join(root,'full-worker'));
 assert.equal(fullStore.list(alice.id).filter(s=>s.source==='personal').length,100);assert.equal(JSON.parse(await readFile(join(root,'full-worker/managed-skills/catalog.json'),'utf8')).length,101);
 pass('restart preserves package and revision; traversal, Windows reserved names and case collisions are rejected');
 if(process.argv.includes('--native-ui')){const code=(await post('/auth/admin/pair-code',{userId:alice.id},login.accessToken)).code;const bundle='yzpair1.'+Buffer.from(JSON.stringify({version:1,gateway,token:code,caPem:ca.toString(),expiresAt:Date.now()+240000})).toString('base64url');await (await import('./skills-ui-smoke.mjs')).runSkillsUi({root,client:a,bundle});}
 const cancelled=await req('skill.draft',{creationKey:randomUUID(),skillId:saved.id});const cancelledPreview=await req('skill.preview',{id:cancelled.draft.id});await req('skill.discard',{id:cancelled.draft.id});await assert.rejects(req('skill.save',{previewId:cancelledPreview.previewId}),/EXPIRED|NOT_FOUND/);
 let latest=enabled;
 for(const runtime of [{platforms:['linux'],programs:[]},{platforms:[],programs:['codexia-skill-missing-dependency']}]){
  const d=await req('skill.draft',{creationKey:randomUUID(),skillId:saved.id});await writeFile(join(d.draft.path,'runtime.json'),JSON.stringify(runtime));const p=await req('skill.preview',{id:d.draft.id});latest=(await req('skill.save',{previewId:p.previewId})).skill;
  await assert.rejects(req('conversation.turn.create',{threadId:thread.id,clientMessageId:randomUUID(),input:[{type:'text',text:'$skill-proof'}]}),/PLATFORM_UNSUPPORTED|DEPENDENCY_MISSING/);
 }
 a.agent.kill();await delay(500);await assert.rejects(req('skill.draft',{creationKey:randomUUID()}),/AGENT_OFFLINE/);
 pass('discard invalidates preview; unsupported system, missing program and offline device have explicit failures');
 await req('skill.remove',{id:saved.id,revision:latest.revision});assert(!(await a2.request('skill.list')).skills.some(s=>s.id===saved.id));
 await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks,root,realAgent:true,realTLS:true,nativeTokenStorage:true,appServer:'protocol fixture',realModel:false},null,2));console.log('SKILLS_SMOKE_OK '+join(root,'result.json'));
}finally{for(const c of clients)c.helper.stdin.end();await delay(500);for(const p of children)p.kill();}
