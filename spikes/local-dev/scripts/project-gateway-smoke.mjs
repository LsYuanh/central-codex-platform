// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real client Agent + real gateway, protocol fixture for the central App Server only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {WebSocket} from 'ws';
import {ProjectCatalog,projectDeviceParams} from '../services/test-gateway/dist/projects.js';

assert.equal(projectDeviceParams('C:\\项目','exec',{}).cwd,'C:\\项目\\.');
assert.equal(projectDeviceParams('/client/project','workspace/read_text',{path:'../other/a'}).path,'/client/project/../other/a');
assert.throws(()=>projectDeviceParams('C:\\project','exec',{cwd:'D:relative'}),/PROJECT_PATH_INVALID/);
assert.equal(projectDeviceParams('C:\\project','file/copy',{sourcePath:'a',path:'b'}).sourcePath,'C:\\project\\a');
const patch='*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch';
const mapped=projectDeviceParams('/client/project','workspace/apply_patch',{patch,expectedVersions:{'a.txt':'v','b.txt':'missing'}});
assert.match(mapped.patch,/Move to: \/client\/project\/b.txt/);
assert.equal(mapped.expectedVersions['/client/project/a.txt'],'v');
assert.deepEqual(projectDeviceParams('/client/project','workspace/apply_patch',mapped),mapped);
assert.throws(()=>new ProjectCatalog({}),/CORRUPT/);

const root=await mkdtemp(join(tmpdir(),'yuanzhou-project-'));
const paths={output:join(root,'output'),a:join(root,'project-a'),b:join(root,'project-b'),extra:join(root,'notes')};
await Promise.all(Object.values(paths).map(p=>mkdir(p)));
await writeFile(join(paths.a,'AGENTS.md'),'Project A rule: PROJECT_A_ONLY\n');
await writeFile(join(paths.b,'AGENTS.md'),'Project B rule: PROJECT_B_ONLY\n');
await writeFile(join(paths.a,'marker.txt'),'CLIENT_PROJECT_A');
await writeFile(join(paths.b,'marker.txt'),'CLIENT_PROJECT_B');
await mkdir(join(root,'remote-worker'));
await writeFile(join(root,'remote-worker','app-server'),`
const readline=require('node:readline');let n=0;const threads=new Map(),tools=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if(!q.method){const t=tools.get(q.id);if(t)threads.get(t).lastTool=q.result;return;}
 let result={};
 if(q.method==='initialize')result={userAgent:'codex yuan-zhou-remote-workspace/1'};
 if(q.method==='model/list')result={data:[]};
 if(q.method==='thread/start'){if('projectId' in q.params || 'cwd' in q.params)throw Error('platform field leaked'); const t={id:'project-thread-'+process.pid+'-'+ ++n,name:'项目测试',turns:[],instructions:q.params.developerInstructions};threads.set(t.id,t);result={thread:t};}
 if(q.method==='thread/list')result={data:[...threads.values()]};
 if(q.method==='thread/name/set'){threads.get(q.params.threadId).name=q.params.name;}
 if(q.method==='thread/read')result={thread:threads.get(q.params.threadId)||{id:q.params.threadId,turns:[]}};
 if(q.method==='thread/resume'){let t=threads.get(q.params.threadId)||{id:q.params.threadId,turns:[]};t.instructions=q.params.developerInstructions;threads.set(t.id,t);result={thread:t};}
 if(q.method==='turn/start')result={turn:{id:'turn-'+ ++n}};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
 if(q.method==='turn/start'){
   const text=q.params.input[0]?.text;let spec;try{spec=JSON.parse(text);}catch{};
   if(text==='SIDEBAR_STREAM'){
     const emit=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\\n');
     emit('turn/started',{threadId:q.params.threadId,turn:result.turn});
     for(const [ms,delta] of [[100,'第一段'],[1700,'第二段']])setTimeout(()=>emit('item/agentMessage/delta',{threadId:q.params.threadId,turnId:result.turn.id,itemId:'reply-'+result.turn.id,delta}),ms);
     setTimeout(()=>emit('turn/completed',{threadId:q.params.threadId,turn:{...result.turn,status:'completed'}}),1800);
   }
   if(spec?.tool){const id='tool-'+ ++n;tools.set(id,q.params.threadId);threads.get(q.params.threadId).lastTool=null;process.stdout.write(JSON.stringify({id,method:'item/tool/call',params:{threadId:q.params.threadId,turnId:result.turn.id,tool:spec.tool,arguments:spec.args||{}}})+'\\n');}
 }
});`);
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const processes=[],sockets=[];let logs='';
const env={...process.env,CODEX_BIN:process.execPath,TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:join(root,'state.json')};
function start(file,args,extra={}){const p=spawn(file,args,{env:{...env,...extra},stdio:['pipe','pipe','pipe'],windowsHide:true});processes.push(p);p.stderr.on('data',d=>logs=(logs+d).slice(-6000));p.stdout.resume();return p;}
let gateway;
async function startGateway(){gateway=start(process.execPath,[resolve('services/test-gateway/dist/index.js')]);for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:'+port+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,80));}throw Error(logs);}
async function client(user='project-owner',device='project-device'){
 const s=new WebSocket('ws://127.0.0.1:'+port+'/ws?userId='+user+'&deviceId='+device);sockets.push(s);await new Promise((r,j)=>{s.once('open',r);s.once('error',j);});let n=0;const pending=new Map();
 s.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='response')pending.get(m.requestId)?.(m);if(m.type==='approval.request')s.send(JSON.stringify({type:'approval.response',requestId:m.requestId,result:{decision:'accept'}}));});
 return (operation,payload={})=>new Promise((r,j)=>{const id=String(++n),timer=setTimeout(()=>{pending.delete(id);j(Error('timeout '+operation));},20000);pending.set(id,m=>{clearTimeout(timer);pending.delete(id);m.ok?r(m.data):j(Error(m.error));});s.send(JSON.stringify({type:'request',requestId:id,operation,payload}));});
}
async function tool(request,threadId,tool,args={}){await request('conversation.turn.create',{threadId,input:[{type:'text',text:JSON.stringify({tool,args})}]});for(let i=0;i<160;i++){const data=await request('conversation.read',{threadId});if(data.thread.lastTool){const answer=data.thread.lastTool;assert.equal(answer.success,true,JSON.stringify(answer));return JSON.parse(answer.contentItems[0].text).result;}await new Promise(r=>setTimeout(r,50));}throw Error('tool timeout');}
const timer=setTimeout(()=>{for(const p of processes)p.kill();throw Error('PROJECT_GATEWAY_TIMEOUT '+logs);},90000);
try {
 await startGateway();
 start(process.env.AGENT_SMOKE_BINARY??resolve('target/debug/local-agent.exe'),['--workspace-root',paths.output,'--gateway-url',`ws://127.0.0.1:${port}/ws/agent?deviceId=project-device`,'--attachment-stdio']);
 const request=await client();
 assert.equal((await request('session.initialize')).platformCapabilities.projects,true);
 let a;
 for(let i=0;i<50;i++){try{a=(await request('project.save',{name:'项目 A',folders:[paths.a,paths.extra],creationKey:'project-create-a'})).project;break;}catch(e){if(!String(e).includes('AGENT_OFFLINE'))throw e;}await new Promise(r=>setTimeout(r,100));}
 assert(a,'Agent connected');
 assert.equal((await request('project.save',{name:'项目 A',folders:[paths.a,paths.extra],creationKey:'project-create-a'})).project.id,a.id,'idempotent creation');
 const b=(await request('project.save',{name:'项目 B',folders:[paths.b]})).project;
 await assert.rejects(request('project.save',{name:'不存在',folders:[join(root,'missing')]}),/PATH_NOT_FOUND|not found|系统找不到/);
 await assert.rejects(request('project.save',{name:'文件',folders:[join(paths.a,'marker.txt')]}),/not a directory/);
 await assert.rejects(request('project.save',{name:'重复目录',folders:[paths.a,join(paths.a,'.')]}),/DUPLICATE_FOLDER/);
 const other=await client('other-owner');assert.deepEqual((await other('project.list')).projects,[]);
 await assert.rejects(other('project.remove',{id:a.id,revision:a.revision}),/NOT_FOUND/);
 const wrongDevice=await client('project-owner','other-device');assert.deepEqual((await wrongDevice('project.list')).projects,[]);
 const ta=(await request('conversation.create',{projectId:a.id,projectRevision:a.revision})).thread;
 const tb=(await request('conversation.create',{projectId:b.id,projectRevision:b.revision})).thread;
 assert.match(ta.instructions,/PROJECT_A_ONLY/);assert.doesNotMatch(ta.instructions,/PROJECT_B_ONLY/);
 assert.equal(ta.clientProject.id,a.id);
 const [ra,rb]=await Promise.all([tool(request,ta.id,'device_read_file',{path:'marker.txt'}),tool(request,tb.id,'device_read_file',{path:'marker.txt'})]);
 assert.equal(ra.content,'CLIENT_PROJECT_A');assert.equal(rb.content,'CLIENT_PROJECT_B');
 const cwd=await tool(request,ta.id,'device_exec',{program:process.execPath,args:['-e','process.stdout.write(process.cwd())']});
 assert.equal(cwd.stdout.toLowerCase(),paths.a.toLowerCase());
 await tool(request,ta.id,'device_workspace_apply_patch',{patch:'*** Begin Patch\n*** Add File: created.txt\n+client project only\n*** End Patch'});
 assert.equal((await readFile(join(paths.a,'created.txt'),'utf8')).trim(),'client project only');
 await assert.rejects(readFile(join(paths.output,'created.txt')));
 const edited=(await request('project.save',{...a,name:'重命名 A',folders:[paths.b,paths.extra]})).project;
 await assert.rejects(request('project.save',{...a,folders:a.folders}),/PROJECT_CONFLICT/);
 await assert.rejects(request('conversation.create',{projectId:a.id,projectRevision:a.revision}),/PROJECT_CONFLICT/);
 assert.equal((await request('conversation.resume',{threadId:ta.id})).thread.clientProject.folders[0],a.folders[0]);
 await assert.rejects(request('conversation.turn.create',{threadId:ta.id,clientMessageId:randomUUID(),input:[],projectId:b.id}),/SNAPSHOT_IMMUTABLE/);
 await request('project.remove',{id:a.id,revision:edited.revision});
 assert.equal((await request('project.list')).projects.length,1,'remove only target');
 assert.equal((await request('conversation.list')).data.find(t=>t.id===ta.id).clientProject.id,a.id,'removed grouping retains snapshot');
 const state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));assert.equal(state.projects.length,1);
 for(const s of sockets)s.close();
 gateway.kill();await new Promise(r=>gateway.once('exit',r));await startGateway();
 const reconnected=await client();await reconnected('session.initialize');
 assert.equal((await reconnected('project.list')).projects[0].id,b.id);
 for(let i=0;i<50;i++){try{await reconnected('conversation.resume',{threadId:ta.id});break;}catch(e){if(!String(e).includes('AGENT_OFFLINE'))throw e;}await new Promise(r=>setTimeout(r,100));}
 assert.equal((await tool(reconnected,ta.id,'device_read_file',{path:'marker.txt'})).content,'CLIENT_PROJECT_A');
 await rename(paths.a,paths.a+'-moved');
 await assert.rejects(reconnected('conversation.turn.create',{threadId:ta.id,input:[]}),/PROJECT_DIRECTORY_UNAVAILABLE/);
 if(process.argv.includes('--ui')) await (await import('./project-ui-smoke.mjs')).runProjectUi({port,paths});
 if(process.argv.includes('--sidebar-ui')) await (await import('./sidebar-drag-ui-smoke.mjs')).runSidebarUi({port,paths,request:reconnected});
 if(process.argv.includes('--native-ui')) await (await import('./project-native-ui-smoke.mjs')).runNativeProjectUi({port,paths,root,client});
 console.log('PROJECT_GATEWAY_SMOKE_OK: catalog isolation, directory validation, creation replay, revisions, restart, immutable thread snapshots, concurrent client paths, actual client cwd and approved patch, removed directory fails closed');
} finally {clearTimeout(timer);for(const s of sockets)s.close();for(const p of processes)if(p.exitCode===null)p.kill();}
