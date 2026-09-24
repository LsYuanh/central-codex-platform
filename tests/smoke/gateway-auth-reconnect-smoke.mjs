// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Exercises the actual socket/client classes with an in-memory Tauri IPC boundary.
// No native process, network, credential store, or GUI is used.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
await mkdir(resolve('target'),{recursive:true});
const root=await mkdtemp(resolve('target/gateway-auth-reconnect-'));
for(const name of ['gateway-auth-error','platform-pairing-state','native-gateway-socket','platform-gateway-client','gateway-ui-events','i18n','native-invoke','locales/en','locales/native-en']){
  const source=await readFile(resolve(`apps/desktop/src/${name}.ts`),'utf8');
  const code=stripTypeScriptTypes(source,{mode:'transform'}).replace(/from "\.\/([\w/.-]+)"/g,(_,path)=>`from "./${path.replace(/\.ts$/,'')}.js"`);
  await mkdir(dirname(join(root,`${name}.js`)),{recursive:true});
  await writeFile(join(root,`${name}.js`),code);
}
await writeFile(join(root,'package.json'),'\{"type":"module"\}\n');
const timers=new Map(),connections=[],pageEvents=new EventTarget();let nextTimer=0,nextCallback=0,nextOpenError,nextCloseBeforeOpen,deferNextOpen;
globalThis.isTauri=true;
globalThis.window={
  addEventListener:pageEvents.addEventListener.bind(pageEvents),removeEventListener:pageEvents.removeEventListener.bind(pageEvents),
  setTimeout(callback,delay){const id=++nextTimer;timers.set(id,{callback,delay});return id;},
  clearTimeout(id){timers.delete(id);},
  __TAURI_INTERNALS__:{
    transformCallback(){return ++nextCallback;},unregisterCallback(){},
    async invoke(command,args){
      if(command==='attachment_request')return {deviceId:'qa-device'};
      if(command==='platform_ws_open'){
        const entry={id:args.connectionId,channel:args.onEvent};connections.push(entry);
        if(nextOpenError){const error=nextOpenError;nextOpenError=undefined;throw Error(error);}
        const close=nextCloseBeforeOpen;nextCloseBeforeOpen=undefined;
        if(deferNextOpen){deferNextOpen=false;return;}
        queueMicrotask(()=>entry.channel.onmessage(close?{type:'close',code:close}:{type:'open'}));return;
      }
      if(command==='platform_ws_send'){
        const entry=connections.find(c=>c.id===args.connectionId);assert(entry);
        if(args.data===null){entry.closed=true;return;}
        const message=JSON.parse(args.data);
        if(message.operation==='session.initialize')queueMicrotask(()=>entry.channel.onmessage({type:'message',data:JSON.stringify({type:'response',requestId:message.requestId,ok:true,data:{platformCapabilities:{remoteWorkspace:true}}})}));
        else entry.lastRequest=message;
        return;
      }
      throw Error('Unexpected synthetic IPC command');
    },
  },
};
const {PlatformGatewayClient}=await import(pathToFileURL(join(root,'platform-gateway-client.js')).href);
const {normalizeGatewayUiEvent}=await import(pathToFileURL(join(root,'gateway-ui-events.js')).href);
const {exactGatewayAuthCode}=await import(pathToFileURL(join(root,'gateway-auth-error.js')).href);
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const latest=()=>connections.at(-1);
function fixture(){const client=new PlatformGatewayClient('wss://qa.invalid/ws');const events=[];client.subscribe(e=>events.push(e));return {client,events};}
function noRetry(events){assert.equal(events.filter(e=>e.method==='gateway/reconnecting').length,0);assert.equal(timers.size,0,'Terminal close must leave no handshake, RPC or reconnect timer');}
const checks=[];
for(const code of ['DEVICE_REVOKED','AUTH_REQUIRED','AUTH_MODE_UNSUPPORTED','DEVICE_TOKEN_REQUIRED','DEVICE_TOKEN_STORAGE_UNSAFE','DEVICE_TOKEN_STORAGE_CORRUPT','DEVICE_TOKEN_STORAGE_UNAVAILABLE']){
  const {client,events}=fixture();await client.connect();
  const waiting=client.request('model/list').then(()=>({resolved:true}),error=>({error}));
  latest().channel.onmessage({type:'close',code});
  const pending=await waiting;assert(pending.error instanceof Error);assert.equal(client.connected,false);noRetry(events);
  const closed=events.find(e=>e.method==='gateway/disconnected');assert.equal(closed.params.code,code);assert.equal(closed.params.retryable,false);assert(closed.params.error.includes('设置'));
  const normalized=normalizeGatewayUiEvent(closed);assert.equal(normalized.kind,'connection');assert.equal(normalized.state,'offline');assert.equal(normalized.retryable,false);assert.equal(normalized.error,closed.params.error);
  latest().channel.onmessage({type:'close',code});await flush();assert.equal(events.filter(e=>e.method==='gateway/disconnected').length,1);noRetry(events);client.close();
  checks.push(`${code} closes pending work once and never schedules reconnect`);
}
{
  const {client,events}=fixture();await client.connect();const count=connections.length;
  latest().channel.onmessage({type:'close'});assert.equal(events.filter(e=>e.method==='gateway/reconnecting').length,1);
  const timer=[...timers.entries()].find(([,value])=>value.delay===1000);assert(timer,'Ordinary transport close retains backoff retry');timers.delete(timer[0]);timer[1].callback();await flush();
  assert.equal(connections.length,count+1);assert.equal(client.connected,true);assert(events.some(e=>e.method==='gateway/reconnected'));client.close();assert.equal(timers.size,0);
  checks.push('ordinary network close reconnects and manual close cancels timers');
}
{
  const {client,events}=fixture();await client.connect();latest().channel.onmessage({type:'close'});
  nextOpenError='Error: AUTH_REQUIRED';const timer=[...timers.entries()].find(([,value])=>value.delay===1000);timers.delete(timer[0]);timer[1].callback();await flush();
  assert.equal(client.connected,false);assert.equal(timers.size,0);assert.equal(events.filter(e=>e.method==='gateway/reconnecting').length,1);
  assert(events.some(e=>e.method==='gateway/disconnected'&&e.params.code==='AUTH_REQUIRED'));client.close();
  checks.push('authorization error during a network retry stops further attempts');
}
{
  const {client,events}=fixture();nextCloseBeforeOpen='DEVICE_REVOKED';await assert.rejects(client.connect(),/已被管理员撤销/);noRetry(events);client.close();
  latest().channel.onmessage({type:'open'});await flush();assert.equal(client.connected,false);noRetry(events);
  checks.push('terminal close before open rejects immediately without waiting for timeout');
}
{
  const {client,events}=fixture();await client.connect();const request=client.request('model/list').catch(error=>error);
  const pending=latest().lastRequest;latest().channel.onmessage({type:'message',data:JSON.stringify({type:'response',requestId:pending.requestId,ok:false,error:'AUTH_REQUIRED'})});
  assert.match((await request).message,/授权已失效/);noRetry(events);assert.equal(client.connected,false);client.close();
  checks.push('explicit authorization RPC failure closes the native connection terminally');
}
{
  const secret='DO_NOT_REFLECT_PRIVATE_VALUE';assert.equal(exactGatewayAuthCode('DEVICE_REVOKED '+secret),undefined);
  const {client,events}=fixture();await client.connect();latest().channel.onmessage({type:'close',code:'DEVICE_REVOKED '+secret});
  assert(events.some(e=>e.method==='gateway/reconnecting'));assert(!JSON.stringify(events).includes(secret));client.close();assert.equal(timers.size,0);
  checks.push('unknown close diagnostics cannot expose secrets or masquerade as a terminal code');
}
for(const code of ['CENTRAL_CERT_NAME_MISMATCH','CENTRAL_CERT_UNTRUSTED','CENTRAL_CONNECTION_TIMEOUT','CENTRAL_CONNECTION_REFUSED']){
  const {client}=fixture();nextOpenError=code;await assert.rejects(client.connect(),new RegExp(code));client.close();assert.equal(timers.size,0);
}
checks.push('typed TLS and network failures remain actionable through the actual native socket boundary');
for(const code of ['CENTRAL_CONNECTION_LIMIT','CENTRAL_PAGE_CHANGED','CENTRAL_IDENTITY_MISMATCH']){
  const {client}=fixture();nextOpenError=code;await assert.rejects(client.connect(),new RegExp(code));client.close();assert.equal(timers.size,0);
}
{
  const {i18n}=await import(pathToFileURL(join(root,'i18n.js')).href);
  await i18n.changeLanguage('en');
  const {client}=fixture();nextOpenError='已有中央连接，请先关闭';
  await assert.rejects(client.connect(),/leftover client connections.*CENTRAL_CONNECTION_LIMIT/);client.close();
  nextOpenError='Unknown private diagnostic';const next=fixture();
  await assert.rejects(next.client.connect(),error=>/CENTRAL_CLIENT_CONNECTION_FAILED/.test(error.message)&&!/(TLS|certificate|private)/.test(error.message));next.client.close();
  await i18n.changeLanguage('zh-CN');
  checks.push('local failures and localized legacy errors stay distinct from TLS; unknown details stay private');
}
{
  for(let i=0;i<6;i++){
    const {client,events}=fixture();await client.connect();const entry=latest();
    pageEvents.dispatchEvent(new Event('pagehide'));await flush();
    assert(entry.closed);assert.equal(client.connected,false);noRetry(events);
  }
  const {client,events}=fixture();deferNextOpen=true;
  const connecting=client.connect().catch(error=>error);await flush();const entry=latest();
  pageEvents.dispatchEvent(new Event('pagehide'));await connecting;
  entry.channel.onmessage({type:'open'});await flush();
  assert(entry.closed,'late handshake is closed after its page was discarded');noRetry(events);
  checks.push('six page reloads close native sockets without reconnect; a late open is closed too');
}
await writeFile(join(root,'result.json'),JSON.stringify({ok:true,checks,source:'actual TypeScript native socket and gateway client with in-memory IPC and deterministic timers'},null,2));
console.log(JSON.stringify({ok:true,checks:checks.length,result:join(root,'result.json')}));
