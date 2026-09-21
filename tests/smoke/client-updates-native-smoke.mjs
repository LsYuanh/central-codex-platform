// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createServer } from "node:https";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
mkdirSync("target",{recursive:true});const dir=mkdtempSync(resolve("target/update-native-"));
const ca=join(dir,"ca.pem"),key=join(dir,"key.pem"),config=join(dir,"openssl.cnf");
writeFileSync(config,"[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
assert.equal(spawnSync(process.env.OPENSSL_BIN??(process.platform==="win32"?"C:/Program Files/Git/usr/bin/openssl.exe":"openssl"),["req","-x509","-newkey","rsa:2048","-nodes","-days","2","-keyout",key,"-out",ca,"-config",config],{windowsHide:true}).status,0);
const leaf=join(dir,"server.pem"),leafKey=join(dir,"server.key"),csr=join(dir,"server.csr"),ext=join(dir,"server.cnf");
writeFileSync(ext,"basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
const openssl=process.env.OPENSSL_BIN??(process.platform==="win32"?"C:/Program Files/Git/usr/bin/openssl.exe":"openssl");
assert.equal(spawnSync(openssl,["req","-new","-newkey","rsa:2048","-nodes","-keyout",leafKey,"-out",csr,"-subj","/CN=localhost"],{windowsHide:true}).status,0);
assert.equal(spawnSync(openssl,["x509","-req","-in",csr,"-CA",ca,"-CAkey",key,"-CAcreateserial","-days","2","-out",leaf,"-extfile",ext],{windowsHide:true}).status,0);
const payload=resolve("tests/fixtures/update-payload.txt"),signature=readFileSync(payload+".sig","utf8").trim();
let origin,redirected=false;
const server=createServer({cert:readFileSync(leaf),key:readFileSync(leafKey)},(req,res)=>{
  if(req.url==="/redirect"){res.writeHead(302,{Location:origin+"/must-not-follow"});res.end();return;}
  if(req.url==="/must-not-follow"){redirected=true;res.writeHead(500);res.end();return;}
  if(req.url.startsWith("/client-updates/")&&req.headers.authorization!=="Bearer fixture-token"){res.writeHead(401);res.end();return;}
  if(req.url==="/client-updates/files/payload.exe"){res.end(readFileSync(payload));return;}
  res.setHeader("Content-Type","application/json");res.end(JSON.stringify({version:req.url==="/current"?"0.1.0":req.url==="/older"?"0.0.9":"0.2.0",notes:"Native TLS signature QA",url:origin+"/client-updates/files/payload.exe",signature}));
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));origin=`https://127.0.0.1:${server.address().port}`;
try{
  const child=spawn("cargo",["test","-p","desktop-spike","native_https_signature_acceptance","--offline","--","--ignored","--nocapture"],{env:{...process.env,UPDATE_QA_ORIGIN:origin,UPDATE_QA_CA:ca,UPDATE_QA_PAYLOAD:payload,UPDATE_QA_SIGNATURE:payload+".sig"},stdio:"inherit",windowsHide:true});
  const status=await new Promise((r,j)=>{child.on("error",j);child.on("exit",r);});assert.equal(status,0);assert(!redirected);
  console.log("CLIENT_UPDATES_NATIVE_OK: paired CA, authenticated manifest/download, valid signature, tamper refusal, version comparison, redirect refusal");
}finally{await new Promise(r=>server.close(r));}
