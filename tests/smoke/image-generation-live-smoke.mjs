// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit isolated QA only: real model, pinned Mac Harness and Windows Agent.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import https from 'node:https';
const gateway=process.env.HARNESS_GATEWAY_URL,caPath=process.env.QA_CA_FILE,handoff=process.env.QA_HANDOFF_FILE;
assert(gateway&&caPath&&handoff,'Provide isolated QA gateway, CA and handoff paths');
const endpoint=new URL(gateway);
assert(endpoint.protocol==='wss:'&&['localhost','127.0.0.1'].includes(endpoint.hostname)&&endpoint.port&&endpoint.port!=='4510'&&endpoint.pathname==='/ws'&&!endpoint.search&&!endpoint.username&&!endpoint.password&&!endpoint.hash,'Use an isolated loopback WSS gateway or diagnostic tunnel');
const account=JSON.parse(await readFile(handoff,'utf8')),ca=await readFile(caPath),origin=gateway.replace('wss:','https:').replace(/\/ws$/,'');
await mkdir('target',{recursive:true});const root=await mkdtemp(resolve('target/image-generation-live-')),tokenRoot=join(root,'token'),workspace=join(root,'client-output');await mkdir(tokenRoot);await mkdir(workspace);
const children=[],events=[],pending=new Map();let connected=false,deviceId,threadId,client,diagnostics='',login;
const start=(binary,args,env={})=>{const p=spawn(resolve(binary),args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,...env}});children.push(p);p.stderr.on('data',d=>diagnostics=(diagnostics+d).slice(-2000));p.stdin.on('error',()=>{});return p;};
const until=async(test,label,ms=300000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
const post=(route,body,token)=>new Promise((r,j)=>{const req=https.request(origin+route,{method:'POST',ca,agent:false,headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>{try{const v=JSON.parse(text);v.ok?r(v.data):j(Error(v.error));}catch(e){j(e);}});});req.setTimeout(15000,()=>req.destroy(Error('QA_AUTH_TIMEOUT')));req.on('error',j);req.end(JSON.stringify(body));});
const request=(operation,payload={})=>new Promise((r,j)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);j(Error('Unknown result: '+operation));},60000);pending.set(requestId,m=>{clearTimeout(timer);pending.delete(requestId);m.ok?r(m.data):j(Error(m.error));});client.stdin.write(JSON.stringify({kind:'send',message:{type:'request',requestId,operation,payload}})+'\n');});
try{
  login=await post('/auth/login',{username:account.username,password:account.password});
  const {code}=await post('/auth/admin/pair-code',{userId:account.userId},login.accessToken);
  client=start('target/debug/examples/central-live-client.exe',[]);
  createInterface({input:client.stdout}).on('line',line=>{
    const frame=JSON.parse(line);if(frame.kind==='paired')deviceId=frame.deviceId;if(frame.kind==='connected')connected=true;
    if(frame.kind==='message'){const m=frame.message;events.push(m);if(m.type==='response')pending.get(m.requestId)?.(m);
      if(m.type==='approval.request')client.stdin.write(JSON.stringify({kind:'send',message:{type:'approval.response',requestId:m.requestId,result:{decision:'reject'}}})+'\n');
    }
  });
  const namespace='com.centralcodex.harnessqa.central-live';client.stdin.write(JSON.stringify({gateway,caPath,code,tokenRoot,namespace})+'\n');await until(()=>connected,'native pairing',20000);
  const agent=start('target/debug/local-agent.exe',['--workspace-root',workspace,'--gateway-url',gateway.replace('/ws','/ws/agent')+'?deviceId='+deviceId],{YUAN_PLATFORM_NAMESPACE:namespace,YUAN_PLATFORM_DATA_DIR:tokenRoot,YUAN_PLATFORM_CA:caPath});
  const localPending=new Map();
  createInterface({input:agent.stdout}).on('line',line=>{const reply=JSON.parse(line);localPending.get(reply.id)?.(reply);});
  const local=(method,params)=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{localPending.delete(id);reject(Error('LOCAL_RPC_TIMEOUT'));},20000);localPending.set(id,r=>{clearTimeout(timer);localPending.delete(id);r.ok?resolve(r.result):reject(Error(r.error));});agent.stdin.write(JSON.stringify({id,method,params})+'\n');});
  await until(async()=>{try{return (await request('device.workspace.context')).ok;}catch{return false;}},'Windows Agent',30000);
  const init=await request('session.initialize',{clientInfo:{name:'yuan-image-live-qa',version:'1'},imageOutputStates:1});assert.equal(init.platformCapabilities.imageGeneration,true,JSON.stringify(init.platformCapabilities));
  const catalog=await request('skill.list');const skill=catalog.skills.find(s=>s.id==='yuan-zhou-imagegen');assert(skill);
  threadId=(await request('conversation.create',{model:'gpt-6-sol'})).thread.id;
  const attachments=process.env.QA_EDIT_IMAGE?[{...await local('file/stat',{path:resolve(process.env.QA_EDIT_IMAGE)}),id:randomUUID(),source:'localFile'}]:[];
  const subject=attachments.length?'Edit the attached sailboat image using image_gen.imagegen with num_last_images_to_include=1: change the boat hull to red and preserve everything else.':'Generate exactly one image using image_gen.imagegen: a simple small blue sailboat floating on calm pale water, minimalist flat illustration, no text.';
  const turn=await request('conversation.turn.create',{threadId,clientMessageId:randomUUID(),skills:[{id:skill.id,revision:skill.revision}],attachments,input:[{type:'text',text:subject+' This is an authorized image integration test; act directly, do not ask questions. Do not use shell or draw through code. After generation, use device_list_outputs to verify that Local Agent saved it to this client. If image generation fails, report the failure and stop; do not retry generation.'}]});
  await until(()=>events.some(e=>e.eventType==='turn.completed'&&e.data?.threadId===threadId&&e.data.turn.id===turn.turn.id),'real image generation');
  const history=await request('conversation.read',{threadId,includeTurns:true});
  const output=history.outputs.find(o=>o.source==='generatedImage');
  if(output?.status!=='saved'){
    const messages=history.thread.turns.flatMap(t=>t.items??[]).filter(i=>i.type==='agentMessage').map(i=>i.text);
    await writeFile(join(root,'failure.json'),JSON.stringify({output,messages},null,2));
    throw Error(output?.error??'No native image output; inspect local failure.json');
  }
  assert.equal(output.deviceId,deviceId);assert(output.path.startsWith(workspace));
  const bytes=await readFile(output.path);assert.equal(createHash('sha256').update(bytes).digest('hex'),output.sha256);
  assert(events.some(e=>e.name==='output/state'&&e.data?.output?.status==='generating'));
  assert(events.some(e=>e.name==='output/state'&&e.data?.output?.status==='saved'));
  const before=output.version;await request('conversation.resume',{threadId});const restored=await request('conversation.read',{threadId,includeTurns:true});assert.equal(restored.outputs.find(o=>o.id===output.id)?.version,before);
  const result={ok:true,root,threadId,output,checks:['authenticated-WSS','native-device-token',attachments.length?'real-central-image-edit-with-client-attachment':'real-central-image-generation','builtin-skill','Windows-Local-Agent-save','client-SHA256','live-generation-and-save-states','history-resume']};
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({root,error:String(error),diagnostics}));throw error;}
finally{
  if(threadId)try{await request('conversation.turn.cancel',{threadId});}catch{}
  for(const child of children)if(child.exitCode===null)child.kill();
  if(deviceId&&login)await post('/auth/device/revoke',{deviceId,requestId:randomUUID()},login.accessToken);
}
