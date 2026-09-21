// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// HTTP protocol fixtures only. All credential bytes are generated locally; no real account or model.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync,linkSync,unlinkSync,chmodSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ModelCredentialBroker} from '../../services/central-gateway/dist/model-credential-broker.js';
import {protectSyntheticFixture} from './windows-private-fixture.mjs';

const root=realpathSync(mkdtempSync(join(tmpdir(),'model-broker-'))),checks=[],audit=[],received=[],revoked=[];
protectSyntheticFixture(root);
const secretA='FAKE_ONLY_'+randomBytes(24).toString('hex'),secretB='FAKE_ONLY_'+randomBytes(24).toString('hex');
const credentialA=join(root,'alice.json'),credentialB=join(root,'bob.json'),chatFile=join(root,'chat.json'),configFile=join(root,'bindings.json');
const jwt=exp=>'e30.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.fake_signature';
const chatToken=jwt(Math.floor(Date.now()/1000)+3600);
const save=(path,value)=>{writeFileSync(path,JSON.stringify(value),{mode:0o600});protectSyntheticFixture(root,[path]);};
save(credentialA,{apiKey:secretA});save(credentialB,{apiKey:secretB});save(chatFile,{tokens:{access_token:chatToken,account_id:'fixture-chat-account',refresh_token:'FAKE_ONLY_NEVER_SEND_REFRESH'}});
const pending=new Set();let redirected=0;
const upstream=http.createServer(async(request,response)=>{
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw);received.push({headers:request.headers,path:request.url,body});
  if(request.url!=='/v1/responses'&&request.url!=='/backend-api/codex/responses'){redirected++;response.end('unexpected');return;}
  if(body.mode==='error'){response.writeHead(401,{'content-type':'application/json'});response.end(JSON.stringify({leak:secretA,refresh_token:'FAKE_ONLY_NEVER_SEND_REFRESH'}));return;}
  if(body.mode==='redirect'){response.writeHead(302,{location:`http://127.0.0.1:${upstream.address().port}/leak`});response.end(secretA);return;}
  if(body.mode==='bad-type'){response.writeHead(200,{'content-type':'text/html'});response.end(secretA);return;}
  if(body.mode==='json-error'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:secretA}}));return;}
  if(body.mode==='http-400'){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:body.diagnostic+' '+secretA}}));return;}
  if(body.mode==='http-400-detail'){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({detail:body.array?[{msg:body.diagnostic+' '+secretA}]:body.diagnostic+' '+secretA}));return;}
  if(body.mode==='http-503'){response.writeHead(503,{'content-type':'application/json'});response.end(secretA);return;}
  if(body.mode==='encoding'){response.writeHead(200,{'content-type':'text/event-stream','content-encoding':body.encoding});response.end(secretA);return;}
  if(body.mode==='invalid-json'){response.writeHead(200,{'content-type':'application/json'});response.end(secretA);return;}
  if(body.mode==='sse-crlf'){response.writeHead(200,{'content-type':'text/event-stream'});response.write(': ping\r\nevent: response.created\r\ndata: {"type":"response.created"}\r');setTimeout(()=>response.end('\n\r\ndata: [DONE]  \r\n\r\n'),20);return;}
  if(body.mode==='invalid-sse'){response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+secretA+'\n\n');return;}
  if(body.mode==='missing-type'){
    response.writeHead(200);
    if(body.fixture==='html'){response.end('<html>'+secretA+'</html>');return;}
    if(body.fixture==='error'){response.end('data: '+JSON.stringify({type:'error',error:{message:secretA}})+'\n\n');return;}
    if(body.fixture==='comments'){response.end(': '+secretA+'\n\n');return;}
    response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');return;
  }
  if(body.mode==='mime'){response.writeHead(200,{'content-type':body.mime});response.end(secretA);return;}
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  if(body.mode==='sse-error'){response.write('event: response.failed\nda');setTimeout(()=>response.end('ta: '+JSON.stringify({type:'response.failed',response:{error:{message:secretA}}})+'\n\n'),20);return;}
  if(body.mode==='hold'){
    pending.add(response);response.once('close',()=>pending.delete(response));return;
  }
  response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
});
await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
const base=`http://127.0.0.1:${upstream.address().port}`;
const config={version:1,users:{alice:{providerId:'a',enabled:true},bob:{providerId:'b',enabled:true},chat:{providerId:'chat',enabled:true}},providers:{a:{id:'a',kind:'api-key',credentialFile:credentialA,baseUrl:base+'/v1'},b:{id:'b',kind:'api-key',credentialFile:credentialB,baseUrl:base+'/v1'},chat:{id:'chat',kind:'chatgpt',credentialFile:chatFile,baseUrl:base+'/backend-api/codex'}}};
save(configFile,config);
let broker;
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn){const end=Date.now()+3000;while(Date.now()<end){if(fn())return;await delay(20);}throw Error('Fixture condition timeout');}
const request=async(token,body={},path='/v1/responses',extra={})=>{
  const response=await fetch(broker.url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...extra},body:JSON.stringify(body)});
  return {status:response.status,text:await response.text()};
};
try{
  const forbidden=join(root,'worker-data');mkdirSync(forbidden,{mode:0o700});const forbiddenConfig=join(forbidden,'models.json');save(forbiddenConfig,config);
  await assert.rejects(()=>ModelCredentialBroker.start({configFile:forbiddenConfig,forbiddenRoots:[forbidden],allowLoopbackTestProviders:true}),/MODEL_CREDENTIAL_WORKER_PATH_DENIED/);
  await assert.rejects(()=>ModelCredentialBroker.start({configFile:join(forbidden,'not-created','models.json'),forbiddenRoots:[forbidden],allowLoopbackTestProviders:true}),/MODEL_CREDENTIAL_WORKER_PATH_DENIED/);
  pass('Bindings inside Worker storage are refused, including nonexistent nested paths');
  const unsafeConfig=join(root,'unsafe-models.json');const unsafe=structuredClone(config);unsafe.providers.a.credentialFile=join(forbidden,'not-created','auth.json');save(unsafeConfig,unsafe);
  await assert.rejects(()=>ModelCredentialBroker.start({configFile:unsafeConfig,forbiddenRoots:[forbidden],allowLoopbackTestProviders:true}),/MODEL_CREDENTIAL_WORKER_PATH_DENIED/);
  const alias=join(root,'worker-alias');symlinkSync(forbidden,alias,process.platform==='win32'?'junction':'dir');unsafe.providers.a.credentialFile=join(alias,'not-created','auth.json');save(unsafeConfig,unsafe);
  await assert.rejects(()=>ModelCredentialBroker.start({configFile:unsafeConfig,forbiddenRoots:[forbidden],allowLoopbackTestProviders:true}),/MODEL_CREDENTIAL_WORKER_PATH_DENIED/);
  pass('All credential paths are checked against Worker storage, including canonical aliases and absent files');
  await assert.rejects(()=>ModelCredentialBroker.start({configFile}),/MODEL_PROVIDER_URL_INVALID/);
  pass('Loopback fixture provider is refused without explicit constructor test option');
  broker=await ModelCredentialBroker.start({configFile,allowLoopbackTestProviders:true,maxBodyBytes:1024,maxConcurrent:3,maxConcurrentPerUser:1,timeoutMs:1500,audit:event=>audit.push(event),onRevoke:user=>revoked.push(user)});
  assert.match(broker.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(broker.status('missing'),{status:'missing',code:'MODEL_CREDENTIAL_UNCONFIGURED'});assert.equal(broker.status('alice').status,'ready');
  assert.throws(()=>broker.createLease('missing'),/MODEL_CREDENTIAL_UNCONFIGURED/);
  const alice=broker.createLease('alice'),bob=broker.createLease('bob'),chat=broker.createLease('chat');
  assert.notEqual(alice.token,bob.token);assert.equal(alice.token.includes(secretA),false);
  pass('Missing user fails closed and each loopback lease is independently generated');
  const result=await request(alice.token,{userId:'bob',providerId:'b'});
  assert.equal(result.status,200);assert(result.text.includes('response.completed'));
  assert.equal(received.at(-1).headers.authorization,'Bearer '+secretA);
  assert.equal(received.at(-1).path,'/v1/responses');
  const b=await request(bob.token);assert.equal(b.status,200);assert.equal(received.at(-1).headers.authorization,'Bearer '+secretB);
  pass('Worker cannot select another user/provider through the body; successful SSE is streamed intact');
  const chatResult=await request(chat.token,{},'/responses',{'ChatGPT-Account-Id':'forged','Originator':'forged','session_id':'fixture-session','OpenAI-Beta':'responses=experimental','Cookie':'private-cookie'});
  assert.equal(chatResult.status,200);assert.equal(received.at(-1).headers.authorization,'Bearer '+chatToken);
  assert.equal(received.at(-1).headers['chatgpt-account-id'],'fixture-chat-account');assert.equal(received.at(-1).headers.originator,'codex_cli_rs');
  assert.notEqual(received.at(-1).headers.session_id,'fixture-session');assert.match(received.at(-1).headers.session_id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.equal(received.at(-1).headers.cookie,undefined);
  pass('ChatGPT authority headers are generated centrally and only bounded useful request headers pass');
  let referencesBefore=received.length;
  for(const payload of [{previous_response_id:'resp_foreign'},{conversation:'conv_foreign'},{input:[{type:'item_reference',id:'item_foreign'}]},{input:[{content:[{type:'input_file',file_id:'file_foreign'}]}]},{input:[{content:[{type:'input_image',image_url:'https://example.invalid/shared'}]}]},{prompt:{id:'managed_foreign'}}]){
    const response=await request(alice.token,payload);assert.equal(response.status,400);assert(response.text.includes('MODEL_REMOTE_REFERENCE_DENIED'));
  }
  assert.equal(received.length,referencesBefore);
  await request(alice.token,{store:true,prompt_cache_key:'same'},'/v1/responses',{session_id:'same',conversation_id:'same','x-codex-turn-state':'opaque-foreign-state'});const aScope=received.at(-1);
  await request(bob.token,{store:true,prompt_cache_key:'same'},'/v1/responses',{session_id:'same',conversation_id:'same'});const bScope=received.at(-1);
  assert.equal(aScope.body.store,false);assert.equal(bScope.body.store,false);assert.notEqual(aScope.body.prompt_cache_key,bScope.body.prompt_cache_key);
  assert.notEqual(aScope.headers.session_id,bScope.headers.session_id);assert.notEqual(aScope.headers.conversation_id,bScope.headers.conversation_id);assert.equal(aScope.headers['x-codex-turn-state'],undefined);
  pass('Provider-side history/file/template references are denied and storage/session/cache state is user-scoped');
  let before=received.length;
  for(const path of ['/v1/responses?userId=bob','/v1/responses/../models','/oauth/token','/v1/responses/extra','//v1/responses'])assert.equal((await request(alice.token,{},path)).status,404);
  assert.equal((await fetch(broker.url+'/v1/responses',{headers:{Authorization:'Bearer '+alice.token}})).status,404);
  assert.equal((await request('A'.repeat(43))).status,401);assert.equal(received.length,before);
  pass('Unknown leases, query overrides, alternate paths, and non-POST methods never reach a provider');
  const error=await request(alice.token,{mode:'error'});assert.equal(error.status,401);assert(error.text.includes('MODEL_CREDENTIAL_REJECTED'));assert(!error.text.includes(secretA));
  const redirect=await request(alice.token,{mode:'redirect'});assert.equal(redirect.status,502);assert(!redirect.text.includes(secretA));assert.equal(redirected,0);
  const bad=await request(alice.token,{mode:'bad-type'});assert.equal(bad.status,502);assert(!bad.text.includes(secretA));
  assert.equal(JSON.parse(bad.text).error.code,'MODEL_PROVIDER_CONTENT_TYPE_INVALID_HTML');
  const jsonError=await request(alice.token,{mode:'json-error'});assert.equal(jsonError.status,502);assert(!jsonError.text.includes(secretA));
  pass('Upstream errors and redirects never disclose their bodies, headers, or credentials');
  for(const [diagnostic,code] of [['Instructions are required','INSTRUCTIONS_REQUIRED'],['store must be false','STORE_DISABLED_REQUIRED'],['invalid session uuid','SESSION_FORMAT'],['stream must be true','STREAM_REQUIRED'],['Unsupported parameter','UNSUPPORTED_PARAMETER'],['This model is not supported','MODEL_UNSUPPORTED'],['input must be an array','INPUT_INVALID'],['Unknown failure',undefined]]){
    const safe=await request(alice.token,{mode:'http-400',diagnostic});assert.equal(safe.status,502);assert.equal(JSON.parse(safe.text).error.code,'MODEL_PROVIDER_HTTP_400'+(code?'_'+code:''));assert(!safe.text.includes(secretA));assert(!safe.text.includes(diagnostic));
  }
  const serviceFailure=await request(alice.token,{mode:'http-503'});assert.equal(JSON.parse(serviceFailure.text).error.code,'MODEL_PROVIDER_HTTP_503');assert(!serviceFailure.text.includes(secretA));
  for(const array of [false,true])for(const [diagnostic,code] of [['Instructions are required','INSTRUCTIONS_REQUIRED'],['Unsupported parameter: max_output_tokens','UNSUPPORTED_MAX_OUTPUT_TOKENS'],['Unknown field client_metadata','UNSUPPORTED_CLIENT_METADATA'],['store must be false','STORE_DISABLED_REQUIRED'],['invalid session uuid','SESSION_FORMAT']]){
    const safe=await request(alice.token,{mode:'http-400-detail',array,diagnostic});assert.equal(safe.status,502);assert.equal(JSON.parse(safe.text).error.code,'MODEL_PROVIDER_HTTP_400_'+code);assert(!safe.text.includes(secretA));assert(!safe.text.includes(diagnostic));
  }
  pass('Provider status and bad-request diagnostics use a closed safe code vocabulary only');
  for(const [encoding,category] of [['gzip','GZIP'],['br','BR'],['deflate','DEFLATE'],['zstd','ZSTD'],['secret-fixture-encoding','UNKNOWN']]){
    const response=await request(alice.token,{mode:'encoding',encoding});assert.equal(response.status,502);assert.equal(JSON.parse(response.text).error.code,'MODEL_PROVIDER_ENCODING_'+category+'_UNSUPPORTED');assert(!response.text.includes(secretA));
  }
  const invalidJson=await request(alice.token,{mode:'invalid-json'});assert.equal(JSON.parse(invalidJson.text).error.code,'MODEL_PROVIDER_JSON_INVALID');
  const crlf=await request(alice.token,{mode:'sse-crlf'});assert.equal(crlf.status,200);assert(crlf.text.includes('[DONE]'));assert.equal(received.at(-1).headers['accept-encoding'],'identity');
  const invalidSse=await request(alice.token,{mode:'invalid-sse'});assert.equal(invalidSse.status,502);assert(!invalidSse.text.includes(secretA));
  assert(audit.some(event=>event.errorCode==='MODEL_PROVIDER_SSE_JSON_INVALID'));
  pass('Content type, compression, JSON and SSE failures have safe stage codes; split CRLF and DONE framing succeeds');
  for(const [mime,category] of [['text/event-stream, application/json','DUPLICATE'],['application/x-ndjson','NDJSON'],['application/jsonl','JSONL'],['application/x-event-stream','X_EVENT_STREAM'],['application/x-fixture-unknown','UNKNOWN']]){
    const response=await request(alice.token,{mode:'mime',mime,stream:true});assert.equal(response.status,502);assert.equal(JSON.parse(response.text).error.code,'MODEL_PROVIDER_CONTENT_TYPE_INVALID_'+category);assert(!response.text.includes(secretA));
  }
  assert.equal(JSON.parse((await request(alice.token,{mode:'missing-type'})).text).error.code,'MODEL_PROVIDER_CONTENT_TYPE_INVALID_MISSING');
  const missingSse=await request(alice.token,{mode:'missing-type',stream:true});assert.equal(missingSse.status,200);assert(missingSse.text.includes('response.completed'));assert.equal(received.at(-1).headers.accept,'text/event-stream');
  for(const fixture of ['html','error','comments']){const response=await request(alice.token,{mode:'missing-type',stream:true,fixture});assert.equal(response.status,502);assert(!response.text.includes(secretA));}
  await request(alice.token,{stream:false});assert.equal(received.at(-1).headers.accept,'application/json');
  pass('Missing MIME accepts only requested, validated SSE; unknown MIME, HTML, error events and comment-only responses fail closed');
  const failedSse=await fetch(broker.url+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+alice.token},body:JSON.stringify({mode:'sse-error'})});
  const reader=failedSse.body.getReader();let visible='';let terminated=false;
  try{while(true){const part=await reader.read();if(part.done)break;visible+=new TextDecoder().decode(part.value);}}catch{terminated=true;}
  assert(terminated);assert(!visible.includes(secretA));assert(!visible.includes('response.failed'));
  pass('Split SSE error diagnostics are suppressed while prior successful frames remain readable');
  const tooLarge=await request(alice.token,{input:'x'.repeat(2048)});assert.equal(tooLarge.status,413);
  assert.equal((await request(alice.token,{},'/v1/responses',{'Content-Encoding':'gzip'})).status,400);
  pass('Oversized bodies and encoded uploads are rejected before provider dispatch');
  const hold=await fetch(broker.url+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+alice.token},body:JSON.stringify({mode:'hold'})});
  const holdBody=hold.text();const heldFailure=holdBody.then(()=>false,()=>true);
  await until(()=>pending.size===1);
  assert.equal((await request(alice.token)).status,429);assert.equal((await request(bob.token)).status,200);
  broker.revokeUser('alice');assert.equal(await heldFailure,true);await until(()=>pending.size===0);
  assert.equal((await request(alice.token)).status,401);assert.equal((await request(bob.token)).status,200);
  pass('Per-user concurrency and revocation stop all of A’s active traffic while B remains healthy');
  const alice2=broker.createLease('alice');config.users.alice.enabled=false;save(configFile,config);
  assert.throws(()=>broker.createLease('alice'),/MODEL_CREDENTIAL_DISABLED/);assert.equal((await request(alice2.token)).status,401);
  assert(revoked.includes('alice'));assert(!revoked.includes('bob'));assert.equal(broker.status('alice').status,'disabled');
  assert.equal((await request(bob.token)).status,200);config.users.alice.enabled=true;save(configFile,config);
  const alice3=broker.createLease('alice');config.users.alice.providerId='b';save(configFile,config);
  assert.equal((await request(alice3.token)).status,401);const rebound=broker.createLease('alice');assert.equal((await request(rebound.token)).status,200);assert.equal(received.at(-1).headers.authorization,'Bearer '+secretB);
  config.users.alice.providerId='a';save(configFile,config);
  pass('Disabled bindings fail explicitly; rebinding invalidates old leases and requires a fresh capability');
  save(chatFile,{tokens:{access_token:jwt(Math.floor(Date.now()/1000)-60),account_id:'fixture-chat-account'}});
  assert.throws(()=>broker.createLease('chat'),/MODEL_CREDENTIAL_EXPIRED/);const expired=await request(chat.token);assert.equal(expired.status,401);assert(expired.text.includes('MODEL_CREDENTIAL_EXPIRED'));
  assert.equal(broker.status('chat').status,'expired');
  assert.equal((await request(bob.token)).status,200);
  save(chatFile,{tokens:{access_token:chatToken,account_id:'fixture-chat-account'}});assert.equal((await request(chat.token)).status,200);
  pass('Expired generated access credentials fail without refresh; replacement reloads without affecting B');
  config.providers.a.credentialFile=join(root,'does-not-exist.json');save(configFile,config);
  assert.throws(()=>broker.createLease('alice'),/MODEL_CREDENTIAL_MISSING/);
  config.providers.a.credentialFile=credentialA;save(configFile,config);
  const hardlink=join(root,'linked.json');linkSync(credentialA,hardlink);
  assert.throws(()=>broker.createLease('alice'),/MODEL_CREDENTIAL_FILE_UNSAFE/);unlinkSync(hardlink);
  if(process.platform!=='win32'){chmodSync(credentialA,0o644);assert.throws(()=>broker.createLease('alice'),/MODEL_CREDENTIAL_FILE_UNSAFE/);chmodSync(credentialA,0o600);}
  pass('Missing credentials and multiply linked files are refused (POSIX ownership/mode checked where available)');
  const held=broker.createLease('alice');
  const timeoutResponse=await fetch(broker.url+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+held.token},body:JSON.stringify({mode:'hold'})});
  await assert.rejects(()=>timeoutResponse.text());await until(()=>pending.size===0);assert.equal((await request(bob.token)).status,200);
  pass('Overall request deadline aborts a stalled SSE stream and releases concurrency slots');
  const disableLease=broker.createLease('alice');const disabledStream=await fetch(broker.url+'/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+disableLease.token},body:JSON.stringify({mode:'hold'})});
  const disabledOutcome=disabledStream.text().then(()=>false,()=>true);config.users.alice.enabled=false;save(configFile,config);
  assert.equal(await disabledOutcome,true);await until(()=>pending.size===0);
  pass('Config disablement terminates an already running stream through periodic binding reload');
  const safeAudit=JSON.stringify(audit);
  for(const secret of [secretA,secretB,chatToken,alice.token,bob.token,'FAKE_ONLY_NEVER_SEND_REFRESH'])assert(!safeAudit.includes(secret));
  assert(audit.every(event=>Object.keys(event).every(k=>['action','userId','status','errorCode'].includes(k))));
  pass('Audit records contain metadata only, without raw credentials, leases, URLs, or model content');
  const callbackCount=revoked.length;const released=broker.createLease('bob');released.release();assert.equal(revoked.length,callbackCount);
  assert.equal((await request(released.token)).status,401);assert.equal((await request(bob.token)).status,200);
  pass('Automatic invalidation notifies only its owning user; normal lease release does not stop sibling Workers');
  await broker.close();assert.throws(()=>broker.createLease('bob'),/MODEL_BROKER_CLOSED/);
  pass('Closing the broker invalidates leases and stops its listener');
  save(join(root,'result.json'),{ok:true,fixtureOnly:true,checks});console.log(JSON.stringify({ok:true,checks:checks.length,root}));
}finally{
  await broker?.close();for(const response of pending)response.destroy();upstream.closeAllConnections();await new Promise(done=>upstream.close(done));
}
