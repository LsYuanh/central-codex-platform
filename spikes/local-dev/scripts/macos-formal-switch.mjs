// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit authorized 4510 migration. The previous gateway remains intact on disk.
import {readFile,writeFile,mkdir,access,open} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const dir=path.join(root,'artifacts/central-macos/formal-migration-20260911');
if(process.platform!=='darwin')throw Error('MACOS_REQUIRED');
const rollback=JSON.parse(await readFile(path.join(dir,'rollback.json'),'utf8'));
const deployment=JSON.parse(await readFile(path.join(dir,'deployment.json'),'utf8'));
const built=JSON.parse(await readFile(path.join(root,'spikes/local-dev/target/central-macos/latest-build.json'),'utf8'));
const ca=await readFile(deployment.caPath);
const installed=path.join(homedir(),'Applications/远舟中央管理.app');
try{await access(installed);throw Error('INSTALL_DESTINATION_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(path.dirname(installed),{recursive:true});
execFileSync('/usr/bin/ditto',[built.app,installed]);
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
const original=JSON.parse(await readFile(path.join(root,'services/test-gateway/data/test-gateway-state.json'),'utf8'));
// Only counts are reported; legacy history stays in its original directory/backup.
console.log(JSON.stringify({legacyStateFields:Object.keys(original),oldPid:rollback.pid}));
const listener=()=>{try{return execFileSync('/usr/sbin/lsof',['-tiTCP:4510','-sTCP:LISTEN'],{encoding:'utf8'}).trim();}catch{return '';}};
if(listener()!==String(rollback.pid))throw Error('ORIGINAL_LISTENER_CHANGED');
const health=await (await fetch('http://127.0.0.1:4510/healthz')).json();
await delay(5000);
const latest=await (await fetch('http://127.0.0.1:4510/healthz')).json();
if(latest.sequence!==health.sequence)throw Error('ORIGINAL_GATEWAY_ACTIVE_RETRY_REQUIRED');
await writeFile(path.join(dir,'before-switch-health.json'),JSON.stringify(latest),{flag:'wx',mode:0o600});
const oldChildren=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)).filter(v=>v[1]===rollback.pid).map(v=>v[0]);
process.kill(rollback.pid,'SIGTERM');
for(let i=0;i<500&&listener();i++)await delay(20);
if(listener())throw Error('OLD_GATEWAY_DID_NOT_STOP');
console.log(JSON.stringify({oldStopped:true,oldChildren}));
const log=await open(path.join(dir,'central-app.log'),'a',0o600);
const app=spawn(path.join(installed,'Contents/MacOS/central-app'),['--start-account',deployment.accountId],{detached:true,env:{HOME:homedir(),USER:process.env.USER,LOGNAME:process.env.LOGNAME,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'},stdio:['ignore',log.fd,log.fd]});
app.unref();await log.close();
await writeFile(path.join(dir,'running-app.json'),JSON.stringify({pid:app.pid,installed,packageId:built.packageId}),{flag:'wx',mode:0o600});
async function tlsHealth(){return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:4510,path:'/healthz',ca,timeout:2000},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy());req.end();});}
let healthy;
for(let i=0;i<120;i++){try{const value=await tlsHealth();if(value.ok){healthy=value;break;}}catch{}await delay(1000);}
if(!healthy){
  try{process.kill(app.pid,'SIGTERM');}catch{}
  for(let i=0;i<30&&listener();i++)await delay(1000);
  execFileSync('/usr/bin/python3',[path.join(root,'spikes/local-dev/scripts/macos-formal-rollback.py'),'restore'],{env:{...process.env,DEVELOPER_DIR:'/Library/Developer/CommandLineTools'}});
  throw Error('NEW_SERVICE_FAILED_OLD_SERVICE_RESTORED');
}
await writeFile(path.join(dir,'after-switch-health.json'),JSON.stringify(healthy),{flag:'wx',mode:0o600});
console.log(JSON.stringify({switched:true,pid:app.pid,installed,gateway:deployment.gateway,health:healthy}));
