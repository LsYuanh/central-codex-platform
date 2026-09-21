// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { steerOrStart } from "../../services/central-gateway/src/steering.ts";
import { messagesFromThreadRead } from "../../apps/desktop/src/thread-history.ts";
import { appendStreamDelta } from "../../apps/desktop/src/chat-stream.ts";

const params = {threadId:"thread-a",expectedTurnId:"turn-a",input:[{type:"text",text:"change direction"}]};
const rejected = (message: string) => new Error(`App Server request failed: ${JSON.stringify({code:-32600,message})}`);
const noActive = rejected("no active turn");
async function scenario(error?: Error, status = "completed", cancelled = false, active = false) {
  const calls: string[] = [];
  const task = steerOrStart(async (method, input) => {
    calls.push(method);
    assert.equal(input.threadId, "thread-a");
    if (method === "turn/steer") { if(error) throw error; return {turnId:"turn-a"}; }
    if (method === "thread/read") return {thread:{status:{type:active?"active":"idle"},turns:[{id:"turn-a",status}]}};
    return {turn:{id:"turn-b"}};
  }, params, () => cancelled);
  return {result:await task.then(value=>value,error=>error),calls};
}
assert.deepEqual(await scenario(),{result:{turnId:"turn-a",started:false},calls:["turn/steer"]});
assert.deepEqual(await scenario(noActive),{result:{turnId:"turn-b",started:true},calls:["turn/steer","thread/read","turn/start"]});
await assert.rejects(steerOrStart(async method => {
  if (method === "turn/steer") throw noActive;
  assert.equal(method,"thread/read","a stale completed Turn must not create another Turn");
  return {thread:{turns:[{id:"turn-a",status:"completed"},{id:"newer-turn",status:"completed"}]}};
},params,()=>false),/no active turn/);
for(const error of [new Error("timeout"),new Error("socket closed"),rejected("expected turn does not match"),rejected("Method not found")]) {
  const value = await scenario(error); assert.equal(value.result,error); assert.deepEqual(value.calls,["turn/steer"]);
}
for(const [status,cancelled,active] of [["interrupted",false,false],["failed",false,false],["completed",true,false],["completed",false,true]] as const) {
  const value = await scenario(noActive,status,cancelled,active); assert.equal(value.result,noActive); assert(!value.calls.includes("turn/start"));
}
const submissions = ["first-msg","steer-one","steer-two"].map((clientMessageId,i)=>({clientMessageId,turnId:"turn-a",kind:i?"steer":"start",content:`正文 ${i}`,status:"sent",attachments:[]}));
const history = {thread:{turns:[{id:"turn-a",items:submissions.flatMap((s,i)=>[
  {type:"userMessage",id:`user-${i}`,content:[{type:"text",text:`${s.content}\n[platform-message:${s.clientMessageId}]`}]},
  {type:"agentMessage",id:`assistant-${i}`,text:`回答 ${i}`},
])}]},attachmentSubmissions:submissions};
const rows=messagesFromThreadRead(history);
assert.deepEqual(rows.filter(row=>row.role==="user").map(row=>[row.id,row.content]),submissions.map(s=>[s.clientMessageId,s.content]));
assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
assert(!JSON.stringify(rows).includes("platform-message"));
const unknown = messagesFromThreadRead({thread:{turns:[]},attachmentSubmissions:[{...submissions[1],status:"unknown"}]});
assert.equal(unknown[0].delivery,"unknown"); assert.equal(unknown[0].content,"正文 1");
const unmarked=messagesFromThreadRead({thread:{turns:[{id:"turn-a",items:[{type:"userMessage",text:"first"},{type:"userMessage",text:"second"}]}]},attachmentSubmissions:[submissions[0]]});
assert.deepEqual(unmarked.map(row=>row.content),["first","second"]);
let streamed = appendStreamDelta<{id:string;role:"user"|"assistant"|"system";content:string}>([],"before", "item-1");
streamed.push({id:"user-steer",role:"user",content:"change"});
streamed=appendStreamDelta(streamed," tail", "item-1");
streamed=appendStreamDelta(streamed,"after", "item-2");
assert.deepEqual(streamed.map(row=>row.content),["before tail","change","after"]);
assert.equal(streamed.filter(row=>row.role==="assistant").length,2);
const reloaded=messagesFromThreadRead({thread:{turns:[{items:[{id:"item-1",type:"agentMessage",text:"before"}]}]}});
assert.equal(appendStreamDelta(reloaded," tail","item-1").length,1);
console.log("STEERING_SMOKE_OK: accepted, completed-race, mismatch, timeout, stop, failure, ordered history, unknown recovery");
