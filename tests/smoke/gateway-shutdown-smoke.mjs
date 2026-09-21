// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Signal delivery is injected only into this QA child; no product control endpoint.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {once} from 'node:events';

const root=await mkdtemp(join(tmpdir(),'gateway-shutdown-'));
const directory=join(root,'remote-worker');await mkdir(directory);
await writeFile(join(directory,'app-server'),'require("fs").writeFileSync("worker.pid",String(process.pid));process.stdin.resume();');
const preload=join(root,'qa-signal.mjs');
await writeFile(preload,'process.on("message",message=>{if(message==="qa-stop")process.emit("SIGTERM");});');
const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));assert.notEqual(port,4510);
const env={};for(const [key,value] of Object.entries(process.env))if(/^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key))env[key]=value;
Object.assign(env,{TEST_GATEWAY_HOST:'127.0.0.1',TEST_GATEWAY_PORT:String(port),TEST_GATEWAY_STATE_FILE:join(root,'state.json'),CODEX_BIN:process.execPath});
const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,resolve('services/central-gateway/dist/index.js')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
let output='',workerPid;
for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-16384);});
const exited=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
try{
  const deadline=Date.now()+10_000;let ready=false;
  while(Date.now()<deadline){
    assert.equal(child.exitCode,null,output);
    try{workerPid=Number(await readFile(join(directory,'worker.pid'),'utf8'));const response=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(500)});ready=response.ok&&workerPid>0;if(ready)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(ready,output);process.kill(workerPid,0);
  child.send('qa-stop');
  const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('QA_SHUTDOWN_TIMEOUT')),8000);timer.unref();})]);
  assert.equal(result.code,0,output);
  assert.throws(()=>process.kill(workerPid,0));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(500)}));
  console.log(JSON.stringify({ok:true,scope:'gateway-graceful-shutdown',realGateway:true,realChild:true,credentialsUsed:false,checks:['signal handler waits for child exit','gateway exits successfully after drain','worker no longer exists','listen port closes']}));
}finally{
  if(child.exitCode===null&&child.signalCode===null)child.kill();
  if(workerPid){try{process.kill(workerPid);}catch{}}
}
