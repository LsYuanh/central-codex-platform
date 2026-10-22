// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Local CONNECT/TLS fixtures: no real credentials, upstream traffic or system setting changes.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {webcrypto} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import 'reflect-metadata';
import {X509CertificateGenerator,SubjectAlternativeNameExtension,BasicConstraintsExtension,KeyUsagesExtension,KeyUsageFlags} from '@peculiar/x509';
import {ModelCredentialBroker} from '../../services/central-gateway/dist/model-credential-broker.js';
import {ModelTransport,bypassModelProxy,validateModelProxy} from '../../services/central-gateway/dist/model-proxy.js';

const check=(name)=>console.log('PASS '+name);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));
for(const value of [{httpsProxy:'socks5://localhost:1'},{httpsProxy:'http://localhost:1/private'},{httpsProxy:'http://localhost:1?secret=x'},{noProxy:'<local>'},{NODE_OPTIONS:'untrusted'}])assert.throws(()=>validateModelProxy(value),/MODEL_PROXY_CONFIG_INVALID/);
for(const [host,rule,expected] of [['127.0.0.2','127.0.0.0/8',true],['[::1]','::1',true],['[::2]','::1',false],['foo.example.test','.example.test',true],['other.test','example.test',false],['example.test','*',true]])assert.equal(bypassModelProxy(new URL('https://'+host),rule),expected);
check('strict bootstrap proxy DTO and domain/IP/CIDR bypass rules');

const algorithm={name:'ECDSA',namedCurve:'P-256',hash:'SHA-256'};
const keys=await webcrypto.subtle.generateKey(algorithm,true,['sign','verify']);
const cert=await X509CertificateGenerator.createSelfSigned({serialNumber:'01',name:'CN=chatgpt.com',keys,signingAlgorithm:algorithm,
  notBefore:new Date(Date.now()-60000),notAfter:new Date(Date.now()+3600000),extensions:[new BasicConstraintsExtension(true,0,true),new KeyUsagesExtension(KeyUsageFlags.digitalSignature|KeyUsageFlags.keyCertSign,true),new SubjectAlternativeNameExtension([{type:'dns',value:'chatgpt.com'}])]},webcrypto);
const key=Buffer.from(await webcrypto.subtle.exportKey('pkcs8',keys.privateKey));
const defaults=tls.getCACertificates();
tls.setDefaultCACertificates([...defaults,cert.toString('pem')]);
const sockets=new Set(),seen=[],connects=[];
let mode='normal',broker;
const upstream=https.createServer({cert:cert.toString('pem'),key:'-----BEGIN PRIVATE KEY-----\n'+key.toString('base64')+'\n-----END PRIVATE KEY-----'},async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  seen.push({url:req.url,headers:req.headers,text});
  if(req.url.startsWith('/backend-api/codex/models')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:[{slug:'fixture-model',display_name:'Fixture',visibility:'list',supported_reasoning_levels:[]}]}));return;}
  if(req.url.endsWith('/images/generations')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({created:1,data:[{b64_json:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}]}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: {"type":"response.created"}\n\n');
  if(mode!=='hold')res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
});
const proxy=http.createServer((_req,res)=>{res.writeHead(500);res.end();});
const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});};
upstream.on('connection',track);proxy.on('connection',track);
proxy.on('connect',(req,socket,head)=>{
  connects.push({url:req.url,headers:req.headers});
  assert.equal(req.url,'chatgpt.com:443');
  if(mode==='connect-hold'){socket.on('end',()=>socket.destroy());socket.resume();return;}
  const remote=net.connect(upstream.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);});
  track(remote);socket.on('close',()=>remote.destroy());remote.on('error',()=>socket.destroy());remote.on('close',()=>socket.destroy());
});
await listen(upstream);await listen(proxy);
const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
const root=mkdtempSync(join(tmpdir(),'model-proxy-'));
const token='e30.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.synthetic';
const config={version:1,users:{fixture:{providerId:'chat',enabled:true}},providers:{chat:{id:'chat',kind:'chatgpt',credentialFile:join(root,'credential.memory')}}};
const audit=[];
try{
  broker=await ModelCredentialBroker.start({configFile:join(root,'bindings.memory'),memorySource:{readConfig:()=>config,readCredential:()=>({tokens:{access_token:token,account_id:'fixture-account'}})},proxy:{httpsProxy:proxyUrl},audit:e=>audit.push(e)});
  const lease=broker.createLease('fixture');
  const request=(body={},path='/v1/responses')=>fetch(broker.url+path,{method:'POST',headers:{authorization:'Bearer '+lease.token,'content-type':'application/json'},body:JSON.stringify(body)});
  let response=await request({stream:true});assert.equal(response.status,200);assert.match(await response.text(),/response.completed/);
  response=await fetch(broker.url+'/v1/models?client_version=0.163.0',{headers:{authorization:'Bearer '+lease.token}});assert.equal(response.status,200);assert.equal((await response.json()).models[0].slug,'fixture-model');
  await broker.verifyCatalog('fixture','0.163.0');
  response=await request({model:'gpt-image-2',prompt:'synthetic fixture'},'/v1/images/generations');assert.equal(response.status,200);assert.equal((await response.json()).created,1);
  assert(seen.every(r=>r.headers.authorization==='Bearer '+token));
  assert(connects.length>=3);assert(connects.every(r=>r.headers.authorization===undefined));
  assert(!JSON.stringify(connects).includes(token));
  check('broker SSE, images, leased catalog and update-validation catalog use CONNECT with TLS and no credential leakage');

  mode='hold';response=await request({stream:true});assert.equal(response.status,200);
  const reader=response.body.getReader();assert.equal((await reader.read()).done,false);lease.release();await assert.rejects(()=>reader.read());
  check('lease cancellation closes an in-flight proxied stream');

  mode='connect-hold';const hanging=broker.createLease('fixture');const count=connects.length;
  const pending=fetch(broker.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+hanging.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)}).then(async r=>({status:r.status,text:await r.text()}));
  const end=Date.now()+2000;while(connects.length===count&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
  assert.equal(connects.length,count+1);hanging.release();
  const cancelled=await pending;assert.equal(cancelled.status,503);assert.match(cancelled.text,/MODEL_REQUEST_CANCELLED/);
  const closedBy=Date.now()+1500;while(sockets.size&&Date.now()<closedBy)await new Promise(r=>setTimeout(r,10));
  assert.equal(sockets.size,0,'cancelled CONNECT must release its proxy socket');
  mode='normal';
  check('lease cancellation also terminates a stalled CONNECT handshake');

  tls.setDefaultCACertificates(defaults);
  const transport=new ModelTransport({httpsProxy:proxyUrl});
  const before=seen.length;
  const url=new URL('https://chatgpt.com/backend-api/codex/models');
  await assert.rejects(()=>new Promise((resolve,reject)=>{const req=https.get(url,{agent:transport.agent(url),signal:AbortSignal.timeout(3000)},res=>{res.resume();resolve();});req.on('error',reject);}),error=>['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  transport.close();assert.equal(seen.length,before);
  check('untrusted upstream TLS certificate is rejected through the proxy');

  for(const socket of sockets)socket.destroy();await close(proxy);
  const next=broker.createLease('fixture');
  response=await fetch(broker.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+next.token,'content-type':'application/json'},body:'{}'});
  const failure=await response.text();assert.equal(response.status,502);assert.match(failure,/MODEL_PROVIDER_REQUEST_TRANSPORT_FAILED_/);
  assert.equal(seen.length,before);assert(!failure.includes(proxyUrl));assert(!failure.includes(token));
  assert(!JSON.stringify(audit).includes(proxyUrl));
  check('proxy outage fails with redacted terminal error and no direct fallback or replay');
}finally{
  tls.setDefaultCACertificates(defaults);await broker?.close();for(const socket of sockets)socket.destroy();await close(proxy);await close(upstream);
}
