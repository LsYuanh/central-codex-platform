// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Synthetic provider only; checks the credential boundary and real output broker.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ModelCredentialBroker} from '../../services/central-gateway/dist/model-credential-broker.js';
import {OutputBroker} from '../../services/central-gateway/dist/outputs.js';
import {SkillStore} from '../../services/central-gateway/dist/skills.js';
import {IMAGEGEN_ID} from '../../services/central-gateway/dist/builtin-imagegen.js';
import {legacyImageOutput} from '../../services/central-gateway/dist/image-generation.js';
const root=realpathSync(mkdtempSync(join(tmpdir(),'image-generation-')));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR4nO3NMQ0AAAwDoPpXVllVsWMJGCA9FoFAIBAIBAKBQPAlGGDXYIj+Um+RAAAAAElFTkSuQmCC','base64');
const received=[],errors=[],pending=new Set();let aborted=false;
const upstream=http.createServer(async(req,res)=>{
  try{
    const parts=[];for await(const c of req)parts.push(c);const body=JSON.parse(Buffer.concat(parts));
    received.push({path:req.url,headers:req.headers,body});
    assert.match(req.url,/^\/backend-api\/codex\/images\/(generations|edits)$/);
    if(body.prompt==='hold'){pending.add(res);res.on('close',()=>{pending.delete(res);aborted=true;});return;}
    if(body.prompt==='error'){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({secret:'DO_NOT_LEAK'}));return;}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({created:1,data:[{b64_json:body.prompt==='invalid'?'not an image':png.toString('base64'),generation_id:'provider-state'}],background:'opaque',secret:'DO_NOT_LEAK'}));
  }catch(e){errors.push(e);res.writeHead(500);res.end();}
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${upstream.address().port}`;
const config={version:1,users:{alice:{providerId:'chat',enabled:true},bob:{providerId:'chat',enabled:true},api:{providerId:'api',enabled:true}},providers:{chat:{id:'chat',kind:'chatgpt',credentialFile:join(root,'chat.json'),baseUrl:base+'/backend-api/codex'},api:{id:'api',kind:'api-key',credentialFile:join(root,'api.json'),baseUrl:base+'/v1'}}};
const token='e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';
const broker=await ModelCredentialBroker.start({configFile:join(root,'config.json'),allowLoopbackTestProviders:true,memorySource:{readConfig:()=>config,readCredential:ref=>ref.endsWith('api.json')?{apiKey:'SYNTHETIC_ONLY'}:{tokens:{access_token:token,account_id:'fixture'}}}});
const alice=broker.createLease('alice'),bob=broker.createLease('bob'),api=broker.createLease('api');
const request=async(lease,body,path='/v1/images/generations')=>{
  const res=await fetch(broker.url+path,{method:'POST',headers:{authorization:'Bearer '+lease.token,'content-type':'application/json','x-codex-image-turn-id':'same-turn','chatgpt-account-id':'forged'},body:JSON.stringify(body)});
  return {status:res.status,text:await res.text()};
};
const body={model:'gpt-image-2',prompt:'a blue square',background:'auto',quality:'auto',size:'auto'};
try{
  assert(broker.imageGenerationAvailable('alice'));assert(!broker.imageGenerationAvailable('api'));
  const generated=await request(alice,body);assert.equal(generated.status,200,generated.text);assert(!generated.text.includes('DO_NOT_LEAK'));assert(!generated.text.includes('provider-state'));
  assert.deepEqual(received[0].body,body);assert.equal(received[0].headers['chatgpt-account-id'],'fixture');
  await request(bob,body);assert.notEqual(received[0].headers['x-codex-image-turn-id'],received[1].headers['x-codex-image-turn-id']);
  const edited=await request(alice,{...body,images:[{image_url:'data:image/png;base64,'+png.toString('base64')}]},'/images/edits');assert.equal(edited.status,200,edited.text);
  const count=received.length;
  for(const bad of [{...body,model:'other'},{...body,n:2},{...body,prompt:''},{...body,previous_response_id:'foreign'},{...body,path:'/private/secret'}, {...body,stream:true}])assert.equal((await request(alice,bad)).status,400);
  for(const image_url of ['https://example.com/private.png','file:///private.png','data:image/png;base64,invalid'])assert.equal((await request(alice,{...body,images:[{image_url}]},'/images/edits')).status,400);
  assert.equal((await request(api,body)).status,403);
  assert.equal((await request(alice,body,'/images/generations?redirect=x')).status,404);
  assert.equal(received.length,count,'invalid requests reached provider');
  const denied=await request(alice,{...body,prompt:'error'});assert.equal(denied.status,401);assert(!denied.text.includes('DO_NOT_LEAK'));
  assert.equal((await request(alice,{...body,prompt:'invalid'})).status,502);
  const held=request(alice,{...body,prompt:'hold'}).catch(()=>({status:0}));
  const deadline=Date.now()+3000;while(!pending.size&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert(pending.size);alice.release();await held;
  for(let i=0;i<50&&!aborted;i++)await new Promise(r=>setTimeout(r,10));assert(aborted,'revocation did not abort image provider');

  const skills=new SkillStore(join(root,'skills.json'));assert(!skills.list('a').some(s=>s.id===IMAGEGEN_ID));skills.setImageGeneration('a',true);
  const skill=skills.get('a',IMAGEGEN_ID);skills.update('a',{id:skill.id,revision:skill.revision,enabled:true,automatic:false});assert.equal(skills.get('a',IMAGEGEN_ID).automatic,false);assert.equal(skills.get('a','yuan-zhou-skill-creator').automatic,true);
  assert.throws(()=>skills.update('a',{id:skill.id},true),/READONLY/);skills.setImageGeneration('a',false);assert.throws(()=>skills.resolve('a',IMAGEGEN_ID),/UNAVAILABLE/);
  const reloaded=new SkillStore(join(root,'skills.json'));reloaded.setImageGeneration('a',true);assert.equal(reloaded.get('a',IMAGEGEN_ID).automatic,false);

  const summary={deviceId:'client',deviceKey:'installation'},states=[],chunks=[];let commits=0,offline=false;
  const outputs=new OutputBroker({summary:()=>summary,deviceKey:()=>offline?undefined:'installation',changed:(_t,o)=>states.push(o.status),call:async(_d,method,p)=>{
    if(method==='file/write_begin')return {ok:true,result:{transferId:'transfer'}};
    if(method==='file/write_chunk'){chunks.push(Buffer.from(p.data,'base64'));return {ok:true,result:{nextOffset:p.offset+chunks.at(-1).length}};}
    if(method==='file/write_commit'){commits++;const bytes=Buffer.concat(chunks);return {ok:true,result:{verified:true,path:'C:\\client-output\\image.png',name:'image.png',kind:'image',version:'v1',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};}
    return {ok:true,result:{}};
  }});
  const item={id:'image',type:'imageGeneration',status:'in_progress'};
  await outputs.image('thread','turn',item);assert.equal(outputs.list('thread')[0].status,'generating');
  const complete={...item,status:'completed',result:png.toString('base64'),savedPath:'/central/DO_NOT_READ'};
  offline=true;await outputs.image('thread','turn',complete);assert.equal(outputs.list('thread')[0].status,'failed');offline=false;
  await outputs.retry('thread','image',{turns:[{items:[complete]}]});assert.equal(outputs.list('thread')[0].status,'saved');assert.equal(commits,1);assert(Buffer.concat(chunks).equals(png));
  await outputs.image('thread','turn',complete);assert.equal(commits,1,'duplicate event saved twice');
  await outputs.image('thread','turn',{...item,id:'cancel'});outputs.finishGeneration('thread');assert.equal(outputs.list('thread')[1].status,'generationFailed');
  await outputs.image('thread','turn',{...item,id:'error',status:'failed'});assert.equal(outputs.list('thread')[2].status,'generationFailed');
  const legacy=JSON.parse(JSON.stringify(outputs.list('thread'),(_k,v)=>legacyImageOutput(v)));
  assert.equal(legacy[2].status,'failed');assert.equal(outputs.list('thread')[2].status,'generationFailed','legacy serialization must not mutate stored status');
  await outputs.image('thread','next-turn',{...item,id:'next-image'});
  outputs.finishGeneration('thread','turn');assert.equal(outputs.list('thread')[3].status,'generating','previous turn cleanup must not interrupt next turn');
  outputs.finishGeneration('thread');assert.equal(outputs.list('thread')[3].status,'generationFailed');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['chatgpt-only','exact-routes','inline-references','user-scoped-headers','redacted-errors','revocation-cancels-image','skill-gate-preferences','generation-vs-save','offline-save-retry','idempotent-save','interrupted-terminal-state']}));
}finally{await broker.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
