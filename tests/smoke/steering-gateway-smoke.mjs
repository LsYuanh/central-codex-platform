// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import net from "node:net";

// Protocol fixture only: never used as a product transport or inference fallback.
const folder = await mkdtemp(join(tmpdir(), "codexia-steering-test-"));
await mkdir(join(folder,"remote-worker"));
await writeFile(join(folder,"remote-worker","app-server"), `
const readline = require('node:readline');
const threads = new Map(); let next = 1;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line), p=q.params||{}; let result={}; let error;
 if(q.method==='initialize') result={userAgent:'protocol-fixture yuan-zhou-remote-workspace/1'};
 if(q.method==='thread/start') {const id='thread-'+next++; threads.set(id,[]); result={thread:{id}};}
 if(q.method==='turn/start') {const turns=threads.get(p.threadId), turn={id:'turn-'+next++,status:'inProgress',items:[{type:'userMessage',content:p.input}]};turns.push(turn); result={turn};}
 if(q.method==='thread/read') result={thread:{id:p.threadId,turns:threads.get(p.threadId)}};
 if(q.method==='turn/interrupt') {threads.get(p.threadId).at(-1).status='interrupted';}
 if(q.method==='turn/steer') {
   const turn=threads.get(p.threadId).at(-1);
   if(turn.status!=='inProgress') error={code:-32600,message:'no active turn'};
   else if(turn.id!==p.expectedTurnId) error={code:-32600,message:'expected turn does not match'};
   else {turn.items.push({type:'userMessage',content:p.input}); result={turnId:turn.id};}
 }
 const reply=()=>process.stdout.write(JSON.stringify({id:q.id,...(error?{error}:{result})})+'\\n');
 if(q.method==='turn/steer' && p.input?.[0]?.text==='lost-ack')setTimeout(reply,300);else reply();
});
`);
const probe=net.createServer(); await new Promise(r=>probe.listen(0,"127.0.0.1",r)); const port=probe.address().port; await new Promise(r=>probe.close(r));
const gateway=spawn(process.execPath,[resolve("services/central-gateway/dist/index.js")],{cwd:folder,env:{...process.env,CODEX_BIN:process.execPath,TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_HOST:"127.0.0.1",TEST_GATEWAY_STATE_FILE:join(folder,"state.json")},stdio:["ignore","pipe","pipe"],windowsHide:true});
let log=""; gateway.stderr.on("data",data=>log+=data); gateway.stdout.on("data",data=>log+=data);
const sockets=[];
async function client(userId) {
 const socket=new WebSocket(`ws://127.0.0.1:${port}/ws?userId=${userId}&deviceId=steering-test-device`); sockets.push(socket);
 await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
 let next=0; const pending=new Map();
 socket.on("message",raw=>{const q=JSON.parse(raw);if(q.type==='response')pending.get(q.requestId)?.(q);});
 return (operation,payload={})=>new Promise((resolve,reject)=>{
  const requestId=String(++next);const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('protocol timeout'));},5000);
  pending.set(requestId,q=>{clearTimeout(timer);pending.delete(requestId);q.ok?resolve(q.data):reject(new Error(q.error));});
  socket.send(JSON.stringify({type:"request",requestId,operation,payload}));
 });
}
try {
 for(let n=0;n<60;n++){try{if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const agent=new WebSocket(`ws://127.0.0.1:${port}/ws/agent?deviceId=steering-test-device`);sockets.push(agent);
 await new Promise((r,j)=>{agent.once('open',r);agent.once('error',j);});
 const frame=(type,payload,requestId)=>({protocol:'agentrpc',version:1,type,timestamp:new Date().toISOString(),nonce:crypto.randomUUID(),requestId,payload});
 const ready=new Promise(r=>agent.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='agent.hello_ack')r();if(m.type==='agent.request')agent.send(JSON.stringify(frame('agent.response',{ok:true,result:{workspaceRoot:'C:/fixture',rules:[]}},m.requestId)));}));
 agent.send(JSON.stringify(frame('agent.hello',{deviceId:'steering-test-device',agent:{version:'fixture',os:'windows',arch:'x64',deviceKey:'steering-fixture-key',workspaceRoot:'C:/fixture',capabilities:['client-paths/v1','remote-workspace/v1','workspace/context']}})));await ready;
 const request=await client("steering-owner"); await request("session.initialize");
 const threadId=(await request("conversation.create")).thread.id;
 const turnId=(await request("conversation.turn.create",{threadId,clientMessageId:"message-original",input:[{type:"text",text:"first"}]})).turn.id;
 const steer={threadId,expectedTurnId:turnId,clientMessageId:"message-steer-one",input:[{type:"text",text:"second"}]};
 assert.equal((await request("conversation.turn.steer",steer)).turnId,turnId);
 assert.equal((await request("conversation.turn.steer",steer)).started,false);
 await assert.rejects(request("conversation.turn.steer",{...steer,input:[{type:"text",text:"different"}]}),/正文不一致/);
 await request("conversation.turn.steer",{...steer,clientMessageId:"message-steer-two",input:[{type:"text",text:"third"}]});
 const other=await client("other-owner"); await assert.rejects(other("conversation.turn.steer",{...steer,clientMessageId:"message-other-user"}));
 await assert.rejects(request("conversation.turn.steer",{...steer,clientMessageId:"message-wrong-turn",expectedTurnId:"wrong"}),/does not match/);
 await assert.rejects(request("conversation.turn.steer",{...steer,clientMessageId:"message-override",model:"anything"}),/运行配置/);
 const history=await request("conversation.read",{threadId,includeTurns:true});
 assert.equal(history.thread.turns.length,1); assert.equal(history.thread.turns[0].items.length,3);
 assert.deepEqual(history.attachmentSubmissions.filter(s=>s.status==='sent').map(s=>s.content),["first","second","third"]);
 // Lose the connection before the delayed acknowledgement; reconcile without a resend.
 void request("conversation.turn.steer",{...steer,clientMessageId:"message-lost-ack",input:[{type:"text",text:"lost-ack"}]}).catch(()=>{});
 sockets[1].close(); const resumed=await client("steering-owner");
 await new Promise(resolve=>setTimeout(resolve,400));
 assert.equal((await resumed("conversation.message.status",{threadId,clientMessageId:"message-lost-ack"})).status,"sent");
 assert.equal((await resumed("conversation.read",{threadId,includeTurns:true})).thread.turns[0].items.length,4);
 assert.equal((await resumed("conversation.message.status",{threadId,clientMessageId:steer.clientMessageId})).status,"sent");
 await resumed("conversation.turn.cancel",{threadId,turnId});
 await assert.rejects(resumed("conversation.turn.steer",{...steer,clientMessageId:"message-after-stop"}),/no active turn/);
 assert.equal((await resumed("conversation.read",{threadId,includeTurns:true})).thread.turns.length,1);
 console.log("STEERING_GATEWAY_SMOKE_OK: routing, deduplication, ordering, ownership, mismatch, overrides, reconnect, stop");
} catch(error) {console.error(log);throw error;}
finally {for(const socket of sockets)socket.close();gateway.kill();}
