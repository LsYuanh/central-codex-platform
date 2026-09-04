// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Negative protocol cases against the REAL gateway; synthetic devices never execute a model turn.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createEnvelope } from "../packages/agentrpc-types/dist/index.js";
const base=process.env.ATTACHMENT_GATEWAY_URL??"ws://192.0.2.10:4510/ws";
const userId=`attachment-contract-${randomUUID()}`;const deviceId=userId;
const clients=[];const timeout=setTimeout(()=>{for(const client of clients)client.close();throw new Error("Contract smoke timed out");},30000);
async function connect(device,agent=false){
  const url=new URL(base);url.searchParams.set("userId",userId);url.searchParams.set("deviceId",device);if(agent)url.pathname="/ws/agent";
  const socket=new WebSocket(url);clients.push(socket);const pending=new Map();let n=0;
  socket.on("message",raw=>{const m=JSON.parse(String(raw));const p=pending.get(m.requestId);if(m.type==="response"&&p){pending.delete(m.requestId);m.ok?p.resolve(m.data):p.reject(new Error(m.error));}});
  await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
  return {socket,request:(operation,payload={})=>new Promise((resolve,reject)=>{const requestId=String(++n);pending.set(requestId,{resolve,reject});socket.send(JSON.stringify({type:"request",requestId,operation,payload}));})};
}
try{
  const ui=await connect(deviceId);await ui.request("session.initialize",{clientInfo:{name:"attachment-contract-smoke",version:"0.1.0"}});
  const thread=await ui.request("conversation.create",{});const threadId=thread.thread.id;
  const ref={id:randomUUID(),source:"localFile",path:"C:\\contract-fixture.png",kind:"image",name:"fixture.png",mimeType:"image/png",bytes:100,version:"1:1"};
  const payload={threadId,clientMessageId:randomUUID(),input:[{type:"text",text:"Protocol rejection probe, do not start a turn."}],attachments:[ref]};
  await assert.rejects(ui.request("conversation.turn.create",{...payload,attachments:[{...ref,path:"C:\\fakepath\\image.png"}]}),/引用无效/);
  await assert.rejects(ui.request("conversation.turn.create",payload),/离线|升级/);
  const old=await connect(deviceId,true);
  const ready=new Promise(resolve=>old.socket.on("message",raw=>{if(JSON.parse(String(raw)).type==="agent.hello_ack")resolve();}));
  old.socket.send(JSON.stringify(createEnvelope("agent.hello",{agent:{version:"0.1.0",os:"windows",arch:"x86_64",capabilities:["workspace/list","read_file","exec"]}})));await ready;
  await assert.rejects(ui.request("conversation.turn.create",payload),/升级/);
  const other=await connect(`other-${randomUUID()}`);
  await assert.rejects(other.request("conversation.turn.create",payload),/另一台设备/);
  // Upgrade the synthetic device and hold the stat reply until cancellation is acknowledged.
  old.socket.send(JSON.stringify(createEnvelope("agent.hello",{agent:{version:"0.1.0",os:"windows",arch:"x86_64",capabilities:["attachments/v1","file/stat","file/read_image","file/read_chunk","file/close_transfer"]}})));
  await new Promise(r=>setTimeout(r,100));
  let statRequest;
  const received=new Promise(resolve=>old.socket.on("message",raw=>{const m=JSON.parse(String(raw));if(m.type==="agent.request"){statRequest=m;resolve();}}));
  const canceled=ui.request("conversation.turn.create",payload);const rejection=assert.rejects(canceled,/取消/);
  await received;
  const cancel=await ui.request("conversation.message.cancel",{threadId,clientMessageId:payload.clientMessageId});assert.equal(cancel.status,"failed");
  old.socket.send(JSON.stringify(createEnvelope("agent.response",{ok:true,result:ref},{requestId:statRequest.requestId})));
  await rejection;
  const status=await ui.request("conversation.message.status",{threadId,clientMessageId:payload.clientMessageId});assert.equal(status.status,"failed");assert.equal(status.turnId,undefined);
  console.log("ATTACHMENT_CONTRACT_SMOKE_OK: fakepath, offline, legacy Agent, wrong device, cancellation before turn/start");
}finally{clearTimeout(timeout);for(const client of clients)client.close();}
