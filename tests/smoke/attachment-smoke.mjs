// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real gateway only. Fixture files live OUTSIDE the configured workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { localAgentExecutable } from "./client-smoke-platform.mjs";
const url=new URL(process.env.ATTACHMENT_GATEWAY_URL??"ws://192.0.2.10:4510/ws");
const deviceId=`attachment-smoke-${randomUUID()}`;url.searchParams.set("deviceId",deviceId);url.searchParams.set("userId",deviceId);
const agentUrl=new URL(url);agentUrl.pathname="/ws/agent";
const dir=mkdtempSync(join(tmpdir(),"codexia-attachment-smoke-"));
const timers=new Set();
const deadline=setTimeout(()=>{console.error("ATTACHMENT_SMOKE_TIMEOUT");process.exitCode=1;cleanup();},180_000);timers.add(deadline);
const png=fixturePng();const picture=join(dir,"two-colors.png");writeFileSync(picture,png);
const note=join(dir,"client-note.txt");const secret=`CLIENT-${randomUUID()}`;writeFileSync(note,secret);
if(process.env.ATTACHMENT_FIXTURE_ONLY === "1") {clearTimeout(deadline);console.log(JSON.stringify({dir,picture,note}));process.exit(0);}
const agent=spawn(localAgentExecutable(),["--workspace-root",resolve("tests/fixtures/workspace"),"--gateway-url",agentUrl.href,"--allow-insecure-lan","--attachment-stdio"],{stdio:["pipe","pipe","pipe"],windowsHide:true});
const localPending=new Map();let n=0;
createInterface({input:agent.stdout}).on("line",line=>{const r=JSON.parse(line);const p=localPending.get(r.id);if(p){localPending.delete(r.id);r.ok?p.resolve(r.result):p.reject(new Error(r.error));}});
const ipc=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;localPending.set(id,{resolve,reject});agent.stdin.write(JSON.stringify({id,method,params})+"\n");});
const ws=new WebSocket(url);const pending=new Map();const events=[];
let onlineResolve;const online=new Promise(r=>onlineResolve=r);
ws.on("message",raw=>{const msg=JSON.parse(String(raw));if((msg.type==="device.status"||msg.type==="gateway.ready")&&msg.agent==="online")onlineResolve();if(msg.type==="event")events.push(msg);const p=pending.get(msg.requestId);if(msg.type==="response"&&p){pending.delete(msg.requestId);msg.ok?p.resolve(msg.data):p.reject(new Error(msg.error));}});
const request=(operation,payload={})=>new Promise((resolve,reject)=>{const requestId=String(++n);pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({type:"request",requestId,operation,payload}));});
function cleanup(){for(const timer of timers)clearTimeout(timer);ws.close();agent.kill();rmSync(dir,{recursive:true,force:true});}
try{
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});await online;
  const localStat=await ipc("file/stat",{path:picture});assert.equal(localStat.bytes,png.length);assert(png.length>1024*1024);
  const preview=await ipc("attachment/preview",{path:picture,version:localStat.version});assert(preview.url.startsWith("data:image/jpeg;base64,"));
  const textStat=await ipc("file/stat",{path:note});
  const read=await request("device.file.read_text",{path:note,version:textStat.version});assert.equal(read.result.content,secret);
  const begin=await ipc("attachment/import_begin");
  for(let offset=0;offset<png.length;offset+=256*1024)await ipc("attachment/import_chunk",{transferId:begin.transferId,offset,data:png.subarray(offset,offset+256*1024).toString("base64")});
  const imported=await ipc("attachment/import_commit",{transferId:begin.transferId});assert.equal(imported.bytes,png.length);
  await request("session.initialize",{clientInfo:{name:"attachment-smoke",version:"0.1.0"}});
  const thread=await request("conversation.create",{});const threadId=thread.thread.id;
  const ref={...localStat,id:randomUUID(),source:"localFile"};const textRef={...textStat,id:randomUUID(),source:"localFile"};
  const invalidId=randomUUID();
  await assert.rejects(request("conversation.turn.create",{threadId,clientMessageId:invalidId,input:[{type:"text",text:"probe invalid version"}],attachments:[{...ref,version:"changed"}]}),/变化/);
  assert.equal((await request("conversation.message.status",{threadId,clientMessageId:invalidId})).status,"failed");
  const clientMessageId=randomUUID();
  const payload={threadId,clientMessageId,input:[{type:"text",text:"This is an attachment integration test. Describe the color on the LEFT half and RIGHT half of the attached picture. Then use device_read_text to read the attached client-note.txt and quote its exact content. Do not use any other tools. Reply in one sentence."}],attachments:[ref,textRef]};
  const submitted=await request("conversation.turn.create",payload);assert.equal(submitted.submission.status,"sent");
  const duplicate=await request("conversation.turn.create",payload);assert.equal(duplicate.turn.id,submitted.turn.id);
  await waitUntil(()=>events.some(e=>e.eventType==="turn.completed"&&e.data?.threadId===threadId),120_000);
  const history=await request("conversation.read",{threadId,includeTurns:true});
  const saved=history.attachmentSubmissions.find(s=>s.clientMessageId===clientMessageId);
  assert.equal(saved.attachments.length,2);assert.equal(saved.attachments[0].deviceId,deviceId);assert.equal(saved.turnId,submitted.turn.id);
  const text=events.filter(e=>e.eventType==="assistant.delta").map(e=>e.data?.delta??"").join("");
  assert(text.includes(secret),"Model did not read the client file");assert(/red|红/i.test(text)&&/blue|蓝/i.test(text),"Model did not describe both colors");
  assert(!JSON.stringify(history).includes("data:image/png;base64,"),"History leaked full image payload to UI");
  const listed=await request("conversation.list",{});
  const listedThread=(listed.data??listed.threads??[]).find(t=>t.id===threadId);
  assert(listedThread,"Attachment thread missing from list");
  assert(!String(listedThread.preview??"").includes("[platform-message:"),"Internal attachment marker leaked into thread preview");
  console.log(JSON.stringify({result:"ATTACHMENT_REAL_SMOKE_OK",threadId,deviceId,imageBytes:png.length,previewBytes:preview.url.length,reply:text,attachmentStates:saved.attachments.map(a=>a.state)}));
}finally{cleanup();}
async function waitUntil(check,ms){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error("Turn completion timed out");await new Promise(r=>setTimeout(r,250));}}
function fixturePng(){
  const width=900,height=900;const raw=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const off=y*(width*3+1)+1+x*3;raw[off+(x<width/2?0:2)]=255;}
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const chunk=(name,data)=>{const type=Buffer.from(name);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([len,type,data,crc]);};
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw,{level:0})),chunk("IEND",Buffer.alloc(0))]);
}
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
