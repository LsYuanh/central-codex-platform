// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { ClientUpdates, validateRelease } from "../services/test-gateway/dist/client-updates.js";
await mkdir("target", {recursive:true});
const root=await mkdtemp(resolve("target/client-updates-"));
const signature=Buffer.from("untrusted comment: protocol fixture\n"+"A".repeat(130)).toString("base64");
const file="0.2.0-windows-x86_64.exe";
const release={version:"0.2.0",notes:"更新测试",pub_date:new Date().toISOString(),platforms:{"windows-x86_64":{file,signature}}};
validateRelease(release);
for(const bad of [null,{...release,version:"0.2"},{...release,platforms:{}},{...release,platforms:{"windows-x86_64":{file:"../secret",signature}}},{...release,platforms:{"darwin-aarch64":{file,signature}}}])assert.throws(()=>validateRelease(bad));
await writeFile(join(root,"latest.json"),JSON.stringify(release));await writeFile(join(root,file),"protocol installer fixture");
const service=new ClientUpdates(root);
assert.throws(()=>service.prepare("a","lease",true),/BUSY/);
service.prepare("a","lease",false);assert(service.locked("a"));assert(!service.locked("b"));
assert.throws(()=>service.prepare("a","second",false),/BUSY/);
service.release("a","wrong");assert(service.locked("a"));service.release("a","lease");assert(!service.locked("a"));
service.prepare("a","second",false,"0.2.0");service.resume("a","0.1.0");assert(service.locked("a"));service.resume("b","0.2.0");assert(service.locked("a"));service.resume("a","0.2.0");assert(!service.locked("a"));
const server=createServer((req,res)=>void service.serve(req,res,new URL(req.url,"http://localhost")));
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const origin=`http://127.0.0.1:${server.address().port}`;
try{
  const manifest=await fetch(origin+"/client-updates/latest.json");assert.equal(manifest.status,200);assert.equal(manifest.headers.get("cache-control"),"no-store");
  const json=await manifest.json();assert.equal(json.version,"0.2.0");assert(json.platforms["windows-x86_64"].url.endsWith("/client-updates/files/"+file));
  const artifact=await fetch(origin+"/client-updates/files/"+file);assert.equal(await artifact.text(),"protocol installer fixture");
  assert.equal((await fetch(origin+"/client-updates/files/unknown.exe")).status,404);
  assert.equal((await fetch(origin+"/client-updates/files/%2e%2e%2fsecret")).status,404);
  assert.equal((await fetch(origin+"/client-updates/latest.json",{method:"POST"})).status,405);
  await writeFile(join(root,"latest.json"),"invalid");assert.equal((await fetch(origin+"/client-updates/latest.json")).status,503);
  console.log("CLIENT_UPDATES_PROTOCOL_OK: manifest, file allowlist, malformed release, lease isolation and retry");
}finally{await new Promise(r=>server.close(r));}
