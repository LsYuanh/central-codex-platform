// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { WebSocketServer } from "ws";
import { createEnvelope, parseEnvelope } from "@central-codex-spike/agentrpc-types";
import { localAgentExecutable } from "./client-smoke-platform.mjs";

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(spikeRoot, "tests", "fixtures", "workspace");
const agentExecutable = localAgentExecutable(spikeRoot);
const port = await findFreePort(4390);
const server = new WebSocketServer({host:"127.0.0.1",port});
const events = [];
let cancelAck = false;
let cancelSent = false;
let resolveResult;
let rejectResult;
const result = new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
const requestId = crypto.randomUUID();
const taskId = crypto.randomUUID();
const command = process.platform === "win32"
  ? {program:"powershell",args:["-NoProfile","-Command","Write-Output before-cancel; Start-Sleep -Seconds 30; Write-Output should-not-run"],cwd:".",timeoutMs:60_000}
  : {program:"/bin/sh",args:["-c","printf 'before-cancel\\n'; sleep 30; printf 'should-not-run\\n'"],cwd:".",timeoutMs:60_000};

server.on("connection",(socket)=>socket.on("message",raw=>{
  const parsed=parseEnvelope(String(raw));
  if("error" in parsed){rejectResult(new Error(parsed.error.message));return;}
  const message=parsed.envelope;
  if(message.type==="agent.hello"){
    socket.send(JSON.stringify(createEnvelope("agent.hello_ack",{accepted:true,server:"stream-smoke",capabilities:["agent.event","job.cancel"],heartbeatIntervalMs:10_000})));
    socket.send(JSON.stringify(createEnvelope("agent.request",{method:"exec",params:command,operationId:requestId,idempotencyKey:requestId},{requestId,taskId})));
    return;
  }
  if(message.type==="agent.event"){
    events.push(message.payload);
    if(!cancelSent && String(message.payload.chunk??"").includes("before-cancel")){
      cancelSent=true;
      socket.send(JSON.stringify(createEnvelope("job.cancel",{reason:"smoke_test"},{requestId,taskId})));
    }
    return;
  }
  if(message.type==="job.cancel_ack"){
    cancelAck=message.payload.accepted===true;
    return;
  }
  if(message.type==="agent.response" && message.requestId===requestId) resolveResult(message.payload);
}));

const agent=spawn(agentExecutable,["--workspace-root",workspaceRoot,"--gateway-url",`ws://127.0.0.1:${port}`],{cwd:spikeRoot,stdio:["ignore","pipe","pipe"],windowsHide:true});
agent.stderr.on("data",chunk=>process.stderr.write(chunk));
try{
  let timeout;
  const response=await Promise.race([result,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("stream smoke timed out")),15_000);})]);
  clearTimeout(timeout);
  assert.equal(response.ok,false);
  assert.match(response.error,/COMMAND_CANCELLED/);
  assert.equal(cancelAck,true);
  assert.ok(events.some(event=>event.stream==="stdout"&&String(event.chunk??"").includes("before-cancel")));
  assert.ok(!events.some(event=>String(event.chunk??"").includes("should-not-run")));
  const sequences=events.map(event=>event.sequence);
  assert.deepEqual(sequences,[...sequences].sort((left,right)=>left-right));
  console.log("COMMAND_STREAM_SMOKE_OK");
}finally{
  agent.kill();
  await new Promise(resolve=>server.close(resolve));
}

async function findFreePort(preferredPort){
  for(let candidate=preferredPort;candidate<preferredPort+100;candidate+=1){
    const available=await new Promise(resolve=>{const probe=net.createServer();probe.once("error",()=>resolve(false));probe.listen(candidate,"127.0.0.1",()=>probe.close(()=>resolve(true)));});
    if(available)return candidate;
  }
  throw new Error("no free stream smoke port");
}
