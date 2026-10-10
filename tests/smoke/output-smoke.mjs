// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {required} from '../../scripts/maintenance/operator-config.mjs';
// Real central gateway + independent native Agent. Only test files are used.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {WebSocket} from "ws";
import {OutputBroker} from "../../services/central-gateway/dist/outputs.js";
import {deflateSync} from "node:zlib";
import {localAgentExecutable,locationCommand,failureCommand} from "./client-smoke-platform.mjs";
const deviceId=`output-smoke-${randomUUID()}`;
const dir=mkdtempSync(join(tmpdir(),"codexia-output-smoke-"));const root=join(dir,"workspace");mkdirSync(root);
const url=new URL(required('OUTPUT_GATEWAY_URL'));url.searchParams.set("userId",deviceId);url.searchParams.set("deviceId",deviceId);
const agentUrl=new URL(url);agentUrl.pathname="/ws/agent";
const agent=spawn(localAgentExecutable(),["--workspace-root",root,"--gateway-url",agentUrl.href,"--allow-insecure-lan","--attachment-stdio"],{stdio:["pipe","pipe","pipe"],windowsHide:true});
let next=0;const localPending=new Map();const pending=new Map();const events=[];
createInterface({input:agent.stdout}).on("line",line=>{const reply=JSON.parse(line);const p=localPending.get(reply.id);if(p){localPending.delete(reply.id);reply.ok?p.resolve(reply.result):p.reject(new Error(reply.error));}});
const ipc=(method,params={})=>new Promise((resolve,reject)=>{const id=String(++next);localPending.set(id,{resolve,reject});agent.stdin.write(JSON.stringify({id,method,params})+"\n");});
const ws=new WebSocket(url);let onlineResolve;const online=new Promise(r=>onlineResolve=r);
ws.on("message",raw=>{const m=JSON.parse(String(raw));if(m.agent==="online")onlineResolve();if(m.type==="event")events.push(m);const p=pending.get(m.requestId);if(m.type==="response"&&p){pending.delete(m.requestId);m.ok?p.resolve(m.data):p.reject(new Error(m.error));}});
const request=(operation,payload={})=>new Promise((resolve,reject)=>{const requestId=String(++next);pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({type:"request",requestId,operation,payload}));});
const deadline=setTimeout(()=>{console.error("OUTPUT_SMOKE_TIMEOUT");ws.terminate();agent.kill();process.exitCode=1;},process.env.OUTPUT_IMAGE_SMOKE==="1"?360_000:180_000);
const savedTests=[];
try {
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});await online;
  const identity=await ipc("attachment/identity");const paths=await ipc("file/output_paths");
  // Exercise the same image-output broker with a real Agent; no host file read in broker.
  const summary={deviceId,deviceKey:identity.deviceKey};const transitions=[];
  let failOnce=true;
  const broker=new OutputBroker({summary:()=>summary,deviceKey:()=>identity.deviceKey,changed:(_,output)=>transitions.push(output.status),call:async(_,method,params)=>{
    if(failOnce&&method==="file/write_commit"){failOnce=false;await ipc(method,params);return {ok:false,error:"simulated lost commit response"};}
    try{return {ok:true,result:await ipc(method,params)};}catch(e){return {ok:false,error:String(e)};}
  }});
  const image={type:"imageGeneration",id:randomUUID(),status:"completed",failure:null,result:fixturePng().toString("base64")};
  await broker.image("test", "image-turn", image);savedTests.push(join(paths.outputDirectory,broker.list("test")[0].name));assert.equal(broker.list("test")[0].status,"failed");
  await broker.retry("test",image.id,{thread:{turns:[{id:"image-turn",items:[image]}]}});
  const saved=broker.list("test")[0];assert.equal(saved.status,"saved",saved.error);savedTests.push(saved.path);
  assert.equal(createHash("sha256").update(readFileSync(saved.path)).digest("hex"),saved.sha256);
  assert.equal(saved.path.startsWith(paths.outputDirectory),true);assert.equal(transitions.at(-1),"saved");
  const before=saved.version;await broker.image("test","image-turn",image);assert.equal(saved.version,before);
  const preview=await ipc("attachment/output_preview",{path:saved.path,version:saved.version});assert(preview.url.startsWith("data:image/jpeg;base64,"));
  // Verify absolute command cwd, ordinary writes and actionable failures on the client.
  const outside=join(dir,"outside");mkdirSync(outside);
  const cwdReply=await request("device.exec",{...locationCommand,cwd:outside});assert(cwdReply.result.stdout.toLowerCase().includes(outside.toLowerCase()));
  const failedCommand=await request("device.exec",{...failureCommand,cwd:outside});
  assert.equal(failedCommand.ok,false);assert.match(failedCommand.error,/COMMAND_FAILED/);
  const file=await ipc("file/write_text",{path:join(outside,"note.txt"),content:"first"});
  await assert.rejects(ipc("file/write_text",{path:file.path,content:"changed"}),/FILE_EXISTS/);
  await ipc("file/write_text",{path:file.path,content:"changed",overwrite:true,expectedVersion:file.version});assert.equal(readFileSync(file.path,"utf8"),"changed");
  if(process.env.OUTPUT_SKIP_MODEL==="1") {
    console.log(JSON.stringify({result:"OUTPUT_AGENT_SMOKE_OK",imageRecovery:true,absoluteCwd:true,overwriteVersion:true,commandFailure:true}));
  } else {
  // Real model selects the new device write tool and publishes a verified result.
  await request("session.initialize",{clientInfo:{name:"output-smoke",version:"0.1.0"}});
  const thread=await request("conversation.create",{});const threadId=thread.thread.id;
  const target=join(outside,"model-written.txt");const marker=`CLIENT-WRITE-${randomUUID()}`;
  await request("conversation.turn.create",{threadId,clientMessageId:randomUUID(),attachments:[],input:[{type:"text",text:`Integration test: use device_write_file to create ${JSON.stringify(target)} containing exactly ${marker}. Do not use shell or image generation. Report the verified path.`}]});
  await waitUntil(()=>events.some(e=>e.eventType==="turn.completed"&&e.data?.threadId===threadId),90_000);
  const history=await request("conversation.read",{threadId,includeTurns:true});
  assert(existsSync(target),"Model did not create client output");assert.equal(readFileSync(target,"utf8"),marker);
  const output=history.outputs.find(o=>o.path===target);assert.equal(output?.status,"saved");assert.equal(output?.deviceId,deviceId);
  assert(events.some(e=>e.name==="output/state"&&e.data?.output?.path===target));
  const compatPath=join(outside,"compat-written.txt");
  const eventStart=events.length;
  await request("conversation.turn.create",{threadId,clientMessageId:randomUUID(),attachments:[],input:[{type:"text",text:`Compatibility integration test: call device_exec with program="codexia.files" and args=["write_text", ${JSON.stringify(JSON.stringify({path:compatPath,content:marker}))}]. Use exactly this broker operation and do not invoke another writing tool. Report its result.`}]});
  await waitUntil(()=>events.slice(eventStart).some(e=>e.eventType==="turn.completed"&&e.data?.threadId===threadId),90_000);
  assert.equal(readFileSync(compatPath,"utf8"),marker);
  if(process.env.OUTPUT_IMAGE_SMOKE==="1"){
    const imageStart=events.length;
    await request("conversation.turn.create",{threadId,clientMessageId:randomUUID(),attachments:[],input:[{type:"text",text:"Image output integration test: use the native image generation tool to generate one simple image of a solid green circle on a white background. Generate directly without clarification. Do not use shell or file writing tools to draw it. When generation completes, use device_list_outputs to report the verified client path."}]});
    await waitUntil(()=>events.slice(imageStart).some(e=>e.eventType==="turn.completed"&&e.data?.threadId===threadId),180_000);
    const imageHistory=await request("conversation.read",{threadId,includeTurns:true});
    const generated=imageHistory.outputs.find(o=>o.source==="generatedImage");
    if(generated)savedTests.push(generated.path??join(paths.downloads,generated.name));
    assert.equal(generated?.status,"saved",generated?.error??"No native image output");
    assert.equal(createHash("sha256").update(readFileSync(generated.path)).digest("hex"),generated.sha256);
    assert(events.slice(imageStart).some(e=>e.name==="output/state"&&e.data?.output?.id===generated.id&&e.data.output.status==="saved"),"No live image output event");
    console.log(JSON.stringify({result:"OUTPUT_NATIVE_IMAGE_SMOKE_OK",threadId,outputId:generated.id,clientPath:generated.path}));
  }
  console.log(JSON.stringify({result:"OUTPUT_REAL_SMOKE_OK",threadId,clientPath:target,outputId:output.id,imageRecovery:true,absoluteCwd:true,overwriteVersion:true,commandFailure:true,compatibilityWrite:true}));
  }
} finally {
  clearTimeout(deadline);ws.close();agent.kill();
  for(const path of savedTests)if(path&&path.includes("generated-"))rmSync(path,{force:true});
  rmSync(dir,{recursive:true,force:true});
}
async function waitUntil(check,ms){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error("Timed out");await new Promise(r=>setTimeout(r,200));}}
function fixturePng(){
  const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;
  const raw=Buffer.alloc(32*(32*3+1));for(let y=0;y<32;y++)for(let x=0;x<32;x++)raw[y*97+1+x*3+1]=255;
  const chunk=(name,data)=>{const type=Buffer.from(name);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);let crc=0xffffffff;for(const byte of Buffer.concat([type,data])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const check=Buffer.alloc(4);check.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,type,data,check]);};
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
