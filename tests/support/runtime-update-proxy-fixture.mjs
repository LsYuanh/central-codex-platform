// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Synthetic loopback-only CONNECT/TLS endpoints for the native updater tests.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {webcrypto} from 'node:crypto';
import 'reflect-metadata';
import {X509CertificateGenerator,SubjectAlternativeNameExtension,BasicConstraintsExtension,KeyUsagesExtension,KeyUsageFlags} from '@peculiar/x509';
const algorithm={name:'ECDSA',namedCurve:'P-256',hash:'SHA-256'};
const rootKeys=await webcrypto.subtle.generateKey(algorithm,true,['sign','verify']);
const keys=await webcrypto.subtle.generateKey(algorithm,true,['sign','verify']);
const dates={notBefore:new Date(Date.now()-60000),notAfter:new Date(Date.now()+3600000)};
const ca=await X509CertificateGenerator.createSelfSigned({serialNumber:'01',name:'CN=Updater fixture root',keys:rootKeys,signingAlgorithm:algorithm,...dates,extensions:[new BasicConstraintsExtension(true,0,true),new KeyUsagesExtension(KeyUsageFlags.keyCertSign,true)]},webcrypto);
const cert=await X509CertificateGenerator.create({serialNumber:'02',subject:'CN=github.com',issuer:ca.subject,publicKey:keys.publicKey,signingKey:rootKeys.privateKey,signingAlgorithm:algorithm,...dates,extensions:[new BasicConstraintsExtension(false,undefined,true),new KeyUsagesExtension(KeyUsageFlags.digitalSignature,true),new SubjectAlternativeNameExtension(['github.com','api.github.com','release-assets.githubusercontent.com'].map(value=>({type:'dns',value})).concat([{type:'ip',value:'127.0.0.1'}]))]},webcrypto);
const key=Buffer.from(await webcrypto.subtle.exportKey('pkcs8',keys.privateKey));
const targets=[],requests=[];
const upstream=https.createServer({cert:cert.toString('pem'),key:`-----BEGIN PRIVATE KEY-----\n${key.toString('base64')}\n-----END PRIVATE KEY-----`},(req,res)=>{
  requests.push({path:req.url,range:req.headers.range,userAgent:req.headers['user-agent'],hasAuthorization:!!req.headers.authorization});
  if(req.url.startsWith('/ranged')){
    const total=5*1024*1024+7,match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');
    if(!match){res.writeHead(400);return res.end();}
    const start=Number(match[1]),end=Number(match[2]);
    // Fail the second chunk once: retries must retain the verified first chunk.
    const seen=requests.filter(r=>r.path===req.url&&r.range===req.headers.range).length;
    if(req.url==='/ranged'&&start>0&&seen===1){res.writeHead(503);return res.end();}
    res.writeHead(206,{'content-range':`bytes ${req.url==='/ranged-wrong'?start+1:start}-${end}/${total}`});
    return res.end(Buffer.alloc(end-start+1,9));
  }
  if(req.url==='/redirect'){res.writeHead(302,{location:'https://release-assets.githubusercontent.com/archive'});return res.end();}
  if(req.url==='/forbidden'){res.writeHead(302,{location:'https://untrusted.invalid/archive'});return res.end();}
  if(req.url==='/missing'){res.writeHead(404);return res.end();}
  if(req.url==='/truncated'){res.writeHead(200,{'content-length':'64'});res.write('partial');return setTimeout(()=>res.destroy(),25);}
  if(req.url==='/large')return res.end(Buffer.alloc(3*1024*1024,7));
  if(req.url==='/stats')return res.end(JSON.stringify({targets,requests}));
  res.end(req.url==='/oversize'?'x'.repeat(33):'ok');
});
const proxy=http.createServer((_req,res)=>{res.writeHead(500);res.end();});
proxy.on('connect',(req,socket,head)=>{
  targets.push(req.url);
  if(!['github.com:443','api.github.com:443','release-assets.githubusercontent.com:443'].includes(req.url))return socket.destroy();
  const remote=net.connect(upstream.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);});
  socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());remote.on('error',()=>socket.destroy());
});
await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
console.log(JSON.stringify({proxy:`http://127.0.0.1:${proxy.address().port}`,direct:`https://127.0.0.1:${upstream.address().port}`,ca:ca.toString('pem')}));
process.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(1),45000).unref();
