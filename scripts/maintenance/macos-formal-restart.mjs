// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Authorized installed-App quit/restart acceptance. Run only after test turns finish.
import {readFile,writeFile,open,rename,copyFile} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {request} from 'node:https';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dir=path.join(root,'artifacts/central-macos/formal-migration-20260911');
const running=JSON.parse(await readFile(path.join(dir,'running-app.json'),'utf8'));
const deployment=JSON.parse(await readFile(path.join(dir,'deployment.json'),'utf8'));
const ca=await readFile(deployment.caPath);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const pairs=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number));
const owned=new Set([running.pid]);for(let n=0;n<8;n++)for(const [pid,parent]of pairs)if(owned.has(parent))owned.add(pid);
execFileSync('/usr/bin/osascript',['-e','tell application id "com.yuanzhou.central" to quit'],{timeout:30000});
for(let i=0;i<1500&&[...owned].some(alive);i++)await delay(20);
if([...owned].some(alive))throw Error('NATIVE_QUIT_TREE_REMAINED');
console.log(JSON.stringify({nativeQuitVerified:true,ownedProcessesExited:owned.size}));
if(process.argv[2]==='--refresh-installed') {
  const built=JSON.parse(await readFile(path.join(root,'target/central-macos/latest-build.json'),'utf8'));
  if(running.installed!==path.join(homedir(),'Applications/远舟中央管理.app')||built.app!==path.join(root,'target/debug/bundle/macos/远舟中央管理.app'))throw Error('INSTALL_PATH_CHANGED');
  const backup=path.join(dir,'installed-before-final-'+Date.now());
  await rename(running.installed,backup);
  try{
    execFileSync('/usr/bin/ditto',[built.app,running.installed]);
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',running.installed]);
  }catch(error){
    await rename(running.installed,path.join(dir,'failed-install-'+Date.now())).catch(()=>{});
    await rename(backup,running.installed);throw error;
  }
  await copyFile(built.dmg,path.join(homedir(),'Downloads/远舟中央管理_0.1.0_aarch64_20260911.dmg'));
}
const log=await open(path.join(dir,'central-app.log'),'a',0o600);
const app=spawn(path.join(running.installed,'Contents/MacOS/central-app'),['--start-account',deployment.accountId],{env:{HOME:homedir(),USER:process.env.USER,LOGNAME:process.env.LOGNAME,LANG:'en_US.UTF-8',PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},detached:true,stdio:['ignore',log.fd,log.fd]});app.unref();await log.close();
await writeFile(path.join(dir,'running-app.json'),JSON.stringify({...running,pid:app.pid}),{mode:0o600});
async function health(){return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:4510,path:'/healthz',ca,timeout:2000},res=>{let b='';res.on('data',s=>b+=s);res.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy());req.end();});}
let ready;for(let n=0;n<120;n++){try{const h=await health();if(h.ok){ready=h;break;}}catch{}await delay(1000);}
if(!ready)throw Error('NATIVE_RESTART_FAILED');
const report={nativeQuitVerified:true,ownedProcessesExited:owned.size,restartVerified:true,pid:app.pid,health:ready};
await writeFile(path.join(dir,'native-restart-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
