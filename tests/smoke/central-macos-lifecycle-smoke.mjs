// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Tests the packaged native guardian with disposable process-tree fixtures.
// This is lifecycle evidence only, not real-model/service acceptance.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [app,node]=process.argv.slice(2);
assert.equal(process.platform,'darwin');assert(path.isAbsolute(app));assert(path.isAbsolute(node));
const output=path.join(root,'target/central-macos/lifecycle');await mkdir(output,{recursive:true});
const base=await mkdtemp(path.join(output,'run-'));
const fixture=path.join(base,'fixture.mjs');
await writeFile(fixture,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));
process.stdin.resume();process.stdin.on('data',()=>{if(process.env.QA_MODE==='graceful'){process.stdout.write('stopped\\n',()=>process.exit(0));}});
setInterval(()=>{},1000);
`);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
async function until(fn){for(let i=0;i<500;i++){const value=await fn();if(value)return value;await delay(20);}throw Error('LIFECYCLE_TIMEOUT');}
async function pids(cwd){return until(async()=>{try{return JSON.parse(await readFile(path.join(cwd,'pids.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return false;throw e;}});}
const checks=[];
for(const mode of ['graceful','controller-eof','force']){
  const cwd=path.join(base,mode);await mkdir(cwd);
  const guardian=spawn(app,['--central-service-guardian',node,fixture,cwd,'300'],{env:{PATH:'/usr/bin:/bin',QA_MODE:mode},stdio:['pipe','pipe','ignore']});
  const exit=new Promise(resolve=>guardian.once('close',(code,signal)=>resolve({code,signal})));
  guardian.stdout.resume();const owned=await pids(cwd);
  if(mode==='graceful')guardian.stdin.write('stop\n');
  else if(mode==='controller-eof')guardian.stdin.end();
  else guardian.kill('SIGUSR1');
  const result=await Promise.race([exit,delay(12000).then(()=>{throw Error('GUARDIAN_EXIT_TIMEOUT');})]);
  assert.equal(result.signal,null);assert.equal(result.code,mode==='graceful'?0:71);
  await until(()=>owned.every(pid=>!alive(pid)));checks.push(mode+'-entire-group-reaped');
}
const cwd=path.join(base,'controller-crash');await mkdir(cwd);
const controller=path.join(base,'controller.mjs');
await writeFile(controller,`import {spawn} from 'node:child_process';const g=spawn(process.argv[2],['--central-service-guardian',process.argv[3],process.argv[4],process.argv[5],'300'],{stdio:['pipe','ignore','ignore']});console.log(g.pid);setInterval(()=>{},1000);`);
const parent=spawn(node,[controller,app,node,fixture,cwd],{stdio:['ignore','pipe','ignore']});
let guardianId='';parent.stdout.on('data',b=>guardianId+=b);
const owned=await pids(cwd);await until(()=>/^\d+\s*$/.test(guardianId));
const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill('SIGKILL');await exited;
await until(()=>[...owned,Number(guardianId)].every(pid=>!alive(pid)));checks.push('abrupt-controller-death-reaps-guardian-and-descendants');
const report={passed:true,scope:'packaged-macos-native-process-tree',checks};
await writeFile(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
