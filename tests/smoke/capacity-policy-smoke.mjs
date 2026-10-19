// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {WorkerManager} from '../../services/central-gateway/dist/worker-manager.js';
import {ModelCredentialBroker} from '../../services/central-gateway/dist/model-credential-broker.js';
import {prepareAttachments,parseAttachments} from '../../services/central-gateway/dist/attachments.js';
import {validateSkillFiles} from '../../services/central-gateway/dist/skills.js';
const root=mkdtempSync(resolve('target/capacity-policy-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const bridges=new Map();let manager,releaseRead;
manager=new WorkerManager({root,perUser:true,maxWorkers:2,perUserTurns:1,totalTurns:1,maxRequests:1,idleMs:20,cooldownMs:0,event(){},create(user){const bridge={alive:true,enforcedRuntimeReady:true,respond(){},close(){this.alive=false;manager.exited(user,this);},async request(method,p){if(method==='thread/read')return new Promise(resolve=>{releaseRead=()=>resolve({thread:{turns:[]}});});return {turn:{id:'turn-'+p.threadId}};}};bridges.set(user,bridge);return bridge;}});
try{
 const a=manager.forUser('a'),b=manager.forUser('b');await a.request('turn/start',{threadId:'one'});
 let sent=false;const waiting=b.request('turn/start',{threadId:'two'}).then(v=>{sent=true;return v;});await delay(60);assert.equal(sent,false);assert.equal(manager.snapshot().length,2,'queued worker cannot be reaped');
 manager.notification('a',bridges.get('a'),{method:'turn/completed',params:{threadId:'one',turn:{id:'turn-one'}}});assert.equal((await waiting).turn.id,'turn-two');
 let stop=false;const cancelled=a.request('turn/start',{threadId:'cancelled'},()=>{if(stop)throw Error('USER_STOPPED');});await delay(30);stop=true;await assert.rejects(cancelled,/USER_STOPPED/);
 let laterSent=false;const later=a.request('turn/start',{threadId:'after'}).then(value=>{laterSent=true;return value;});await delay(30);
 const blocking=a.request('thread/read',{threadId:'one'});await delay(30);assert(releaseRead);
 manager.notification('b',bridges.get('b'),{method:'turn/completed',params:{threadId:'two',turn:{id:'turn-two'}}});await delay(50);
 assert.equal(laterSent,false,'a newly free turn slot must not bypass an occupied request slot');releaseRead();await blocking;assert.equal((await later).turn.id,'turn-after');
}finally{manager.close();}
const buffer=Buffer.alloc(6*1024*1024,7),tiny=Buffer.from('fixture');const refs=parseAttachments(Array.from({length:11},(_,i)=>({id:'image-'+i,name:'image.png',path:`C:/fixture/image-${i}.png`,kind:'image',source:'localFile',mimeType:'image/png',version:'v1',bytes:i<2?buffer.length:tiny.length})));
const prepared=await prepareAttachments(refs,'device',async(method,p)=>{
 const ref=refs.find(r=>r.path===p.path||r.id===p.transferId),bytes=ref&&ref.bytes===buffer.length?buffer:tiny;
 if(method==='file/stat')return {ok:true,result:ref};
 if(method==='file/read_image')return {ok:true,result:{transferId:ref.id,totalBytes:ref.bytes,mimeType:ref.mimeType}};
 if(method==='file/read_chunk'){const chunk=bytes.subarray(p.offset,p.offset+256*1024);return {ok:true,result:{transferId:p.transferId,offset:p.offset,sequence:p.offset/(256*1024),totalBytes:bytes.length,data:chunk.toString('base64'),done:p.offset+chunk.length===bytes.length}};}
 return {ok:true,result:{}};
},()=>true,()=>{});assert.equal(prepared.input.filter(i=>i.type==='image').length,11);
const file=(path,text)=>{const bytes=Buffer.from(text);return {path,bytes:bytes.length,data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};};
const files=[file('SKILL.md','---\nname: large-skill\ndescription: "capacity fixture"\n---\n'+'text\n'.repeat(15000)),...Array.from({length:65},(_,i)=>file(`a/b/c/d/e/f/g/${i}.txt`,'x')),file('assets/large.bin','x'.repeat(9*1024*1024))];assert.equal(validateSkillFiles(files).name,'large-skill');
const partial=await prepareAttachments(parseAttachments([{id:'doc',name:'doc.pdf',path:'C:/fixture/doc.pdf',kind:'document',source:'localFile',mimeType:'application/pdf',version:'v1',bytes:100}]),'device',async(method)=>({ok:true,result:method==='file/stat'?{version:'v1',bytes:100,kind:'document'}:{content:'first page',nextSection:2,truncated:false}}),()=>true,()=>{});assert.equal(partial.attachments[0].state,'partial');assert.match(partial.input[1]?.text??partial.input[0].text,/untrusted/);
const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const value=JSON.parse(Buffer.concat(chunks));
 if(value.test==='large-json'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({output:'x'.repeat(33*1024*1024)}));}
 else if(value.test==='large-sse'){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',text:'x'.repeat(5*1024*1024)}})+'\n\n');}
 else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({inputLength:value.input.length}));}
});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const config={version:1,users:{fixture:{enabled:true,providerId:'fixture'}},providers:{fixture:{id:'fixture',kind:'api-key',credentialFile:join(root,'unused.json'),baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`}}};
const broker=await ModelCredentialBroker.start({configFile:join(root,'unused-config.json'),allowLoopbackTestProviders:true,memorySource:{readConfig:()=>config,readCredential:()=>({apiKey:'SYNTHETIC_ONLY'})}});
try{const lease=broker.createLease('fixture');const send=async body=>{const r=await fetch(broker.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+lease.token,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r;};
 assert.equal((await (await send({input:'x'.repeat(33*1024*1024)})).json()).inputLength,33*1024*1024);
 assert.equal((await (await send({test:'large-json'})).json()).output.length,33*1024*1024);
 assert((await (await send({test:'large-sse',stream:true})).text()).length>5*1024*1024);
}finally{await broker.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
console.log('CAPACITY_POLICY_SMOKE_OK: queued admission/cancel; 11 images, 12 MiB total; large/deep skill; partial document state; 33 MiB model request/JSON and 5 MiB SSE');
