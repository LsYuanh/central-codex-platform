// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit real-central acceptance. Never defaults to a local inference server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { WebSocket } from "ws";

if(!process.env.STEERING_GATEWAY_URL) throw new Error("Set STEERING_GATEWAY_URL to an explicitly selected real central gateway");
const url=new URL(process.env.STEERING_GATEWAY_URL);
const deviceId=`steering-live-${Date.now()}`;
url.searchParams.set("userId",deviceId);url.searchParams.set("deviceId",deviceId);
const agentUrl=new URL(url);agentUrl.pathname="/ws/agent";agentUrl.searchParams.delete("userId");
const agent=spawn(resolve(process.env.LOCAL_AGENT_BIN??"target/debug/local-agent.exe"),["--workspace-root",resolve("fixtures/workspace"),"--gateway-url",String(agentUrl),"--allow-insecure-lan"],{stdio:["ignore","ignore","pipe"],windowsHide:true});
let agentErrors="";agent.stderr.on("data",chunk=>agentErrors+=String(chunk));
const ws=new WebSocket(url);const pending=new Map();const events=[];let next=0;
ws.on("message",raw=>{
 const msg=JSON.parse(raw);events.push(msg);
 if(msg.type==="response")pending.get(msg.requestId)?.(msg);
});
function request(operation,payload={}){
 return new Promise((resolve,reject)=>{const requestId=String(++next);const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`${operation} timeout`));},65000);pending.set(requestId,msg=>{clearTimeout(timer);pending.delete(requestId);msg.ok?resolve(msg.data):reject(new Error(msg.error));});ws.send(JSON.stringify({type:"request",operation,requestId,payload}));});
}
async function until(predicate,label,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error(`Timed out: ${label}`);}
let threadId,turnId;
try {
 await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
 await until(()=>events.some(e=>(e.type==="device.status"||e.type==="gateway.ready")&&e.agent==="online"),"real Local Agent registration",20000);
 await request("session.initialize",{clientInfo:{name:"codexia-steering-acceptance",version:"0.1"}});
 threadId=(await request("conversation.create")).thread.id;
 const first="验证追加功能：先调用 device_exec 在客户端运行 powershell，参数为 -NoProfile -Command 和命令 Start-Sleep -Seconds 12; hostname。等待命令返回后，只输出 ORIGINAL。不要修改文件。";
 turnId=(await request("conversation.turn.create",{threadId,clientMessageId:crypto.randomUUID(),input:[{type:"text",text:first}]})).turn.id;
 console.log(JSON.stringify({phase:"started",threadId,turnId}));
 await until(()=>events.find(e=>e.name==="device/tool/started"&&e.data?.threadId===threadId),"model starts client tool");
 const additions=["调整要求：最后不要输出 ORIGINAL，改为输出 STEER_ONE，并写出刚才客户端 hostname 返回的机器名。","继续补充：最后还要包含 STEER_TWO，保留上一条对机器名和 STEER_ONE 的要求。"];
 for(const text of additions){const clientMessageId=crypto.randomUUID();const payload={threadId,expectedTurnId:turnId,clientMessageId,input:[{type:"text",text}]};const result=await request("conversation.turn.steer",payload);assert.equal(result.turnId,turnId);assert.equal(result.started,false);assert.equal((await request("conversation.turn.steer",payload)).turnId,turnId);console.log(JSON.stringify({phase:"accepted",clientMessageId,turnId}));}
 await until(()=>events.find(e=>e.eventType==="turn.completed"&&e.data?.threadId===threadId),"real completion");
 const history=await request("conversation.read",{threadId,includeTurns:true});
 const deltas=events.filter(e=>e.eventType==="assistant.delta"&&e.data?.threadId===threadId);
 assert(deltas.length>0&&deltas.every(e=>typeof e.data.itemId==="string"),"gateway must preserve assistant item IDs for stream separation");
 const turn=history.thread.turns.find(t=>t.id===turnId); assert.equal(turn.status,"completed");
 assert.deepEqual(history.attachmentSubmissions.filter(s=>s.kind==="steer").map(s=>s.content),additions);
 const response=turn.items.filter(item=>item.type==="agentMessage").map(item=>item.text??JSON.stringify(item.content)).join("\n");
 assert.match(response,/STEER_ONE/);assert.match(response,/STEER_TWO/);assert(response.toLowerCase().includes(hostname().toLowerCase()),"response must identify the Windows client");
 console.log(JSON.stringify({phase:"completed",threadId,turnId,client:hostname(),response}));
 const late=await request("conversation.turn.steer",{threadId,expectedTurnId:turnId,clientMessageId:crypto.randomUUID(),input:[{type:"text",text:"上一轮已经完成，这是结束瞬间续发验证，请只回复 LATE_OK，不调用工具。"}]});
 assert.equal(late.started,true);assert.notEqual(late.turnId,turnId);turnId=late.turnId;
 await until(()=>events.find(e=>e.eventType==="turn.completed"&&e.data?.turn?.id===turnId),"late continuation completes");
 if(process.env.STEERING_VERIFY_STOP === "1") {
  const stopText="验证停止：只调用 device_exec，在客户端运行 powershell，参数 -NoProfile -Command，命令为 Start-Sleep -Seconds 20; Write-Output STOP_SHOULD_NOT_RUN。不要修改文件。";
  turnId=(await request("conversation.turn.create",{threadId,clientMessageId:crypto.randomUUID(),input:[{type:"text",text:stopText}]})).turn.id;
  await until(()=>events.find(e=>e.name==="device/tool/started"&&e.data?.turnId===turnId),"client tool starts before stop");
  await request("conversation.turn.cancel",{threadId,turnId});
  const stopped=await until(()=>events.find(e=>e.eventType==="turn.completed"&&e.data?.turn?.id===turnId),"stopped turn completes");
  assert.equal(stopped.data.turn.status,"interrupted");
  const tool=await until(()=>events.find(e=>e.name==="device/tool/completed"&&e.data?.turnId===turnId),"client cancellation result");
  assert.equal(tool.data.status,"cancelled");
  assert(!events.some(e=>e.name==="device/tool/output"&&e.data?.turnId===turnId&&String(e.data?.chunk).includes("STOP_SHOULD_NOT_RUN")));
  console.log("STEERING_LIVE_STOP_OK: turn interrupted, client process cancelled");
 }
 console.log("STEERING_LIVE_SMOKE_OK: two steers during real client execution, duplicate protection, client hostname, normal completion fallback");
} catch(error) {console.error(JSON.stringify({threadId,turnId,agentErrors,tail:events.slice(-4)}));throw error;}
finally {
 if(threadId){
  const finished=events.some(e=>e.eventType==="turn.completed"&&e.data?.turn?.id===turnId);
  if(!finished)try{await request("conversation.turn.cancel",{threadId,turnId});}catch{}
  try{await request("conversation.archive",{threadId});}catch{}
 }
 ws.close();agent.kill();
}
