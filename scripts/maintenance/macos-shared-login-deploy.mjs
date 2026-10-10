// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {formalDirectory} from './operator-config.mjs';
// Explicit operator deployment for the authorized central Mac; not a product runtime.
import {readFile,writeFile,mkdir,rename,open,access,realpath} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {request} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('CENTRAL_MAC_REQUIRED');
const work=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Build snapshots may live under artifacts while the live profile/toolchain stays
// at the original deployment root. Never copy private profile data into a snapshot.
if(process.env.CENTRAL_MACOS_DEPLOY_ROOT&&!path.isAbsolute(process.env.CENTRAL_MACOS_DEPLOY_ROOT))throw Error('ABSOLUTE_DEPLOY_ROOT_REQUIRED');
const repo=process.env.CENTRAL_MACOS_DEPLOY_ROOT??work;
// Separate each release's immutable staging/backup evidence from earlier deployments.
const runName=process.env.CENTRAL_MACOS_DEPLOY_NAME??'';
if(!/^[a-z0-9][a-z0-9-]{2,79}$/.test(runName))throw Error('INVALID_DEPLOY_NAME');
const runDir=path.join(repo,'artifacts',runName);
const formal=formalDirectory();
const profile=path.join(homedir(),'Library/Application Support/com.yuanzhou.central');
const installed=path.join(homedir(),'Applications/远舟中央管理.app');
const staged=path.join(runDir,'next.app'),backup=path.join(runDir,'previous.app');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,v,exclusive=false)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:exclusive?'wx':'w'});
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const command=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',env:{...process.env,LC_ALL:'en_US.UTF-8'},timeout:180000,maxBuffer:1048576});
const ca=await readFile(path.join(formal,'ca.pem'));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
async function api(route,body,token) {
  return new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    const req=request({hostname:'127.0.0.1',port:4510,path:route,method:bytes?'POST':'GET',ca,timeout:5000,
      headers:{...(bytes?{'content-type':'application/json','content-length':bytes.length}:{}),...(token?{authorization:`Bearer ${token}`}:{})}},res=>{
      let text='';res.on('data',b=>{text+=b;if(text.length>1048576)req.destroy(Error('RESPONSE_LIMIT'));});
      res.on('end',()=>{try{const v=JSON.parse(text);if(res.statusCode!==200||!v.ok)throw Error('CENTRAL_API_FAILED');resolve(v);}catch{reject(Error('CENTRAL_API_FAILED'));}});
    });req.on('error',()=>reject(Error('CENTRAL_UNREACHABLE')));req.on('timeout',()=>req.destroy());req.end(bytes,()=>bytes?.fill(0));
  });
}
async function status() {
  const login=await json(path.join(formal,'admin-login.json'));
  const auth=await api('/auth/admin/login',login);login.password='';
  const token=auth.data.accessToken;
  const workers=await api('/workers',undefined,token);
  const model=await api('/model-access',undefined,token);
  const health=await api('/healthz');
  if(!Array.isArray(workers.workers)||workers.workers.some(w=>!Number.isSafeInteger(w.activeTurns)||w.activeTurns<0))throw Error('WORKER_STATUS_INVALID');
  return {ok:health.ok,devices:health.devices,clients:health.clients,workers:workers.workers.length,
    activeTurns:workers.workers.reduce((n,w)=>n+w.activeTurns,0),model:model.modelAccess.status};
}
function cargoEnv(extra) {
  return {...process.env,DEVELOPER_DIR:'/Library/Developer/CommandLineTools',
    CARGO_HOME:path.join(repo,'artifacts/macos-tools/cargo'),RUSTUP_HOME:path.join(repo,'artifacts/macos-tools/rustup'),
    CARGO_TARGET_DIR:path.join(work,'target'),CARGO_BUILD_JOBS:'2',TMPDIR:path.join(runDir,'tmp'),
    CENTRAL_MACOS_RELEASE_OPT_IN:'1',CENTRAL_MACOS_APP_DATA:profile,...extra};
}
async function nativeSwitch(state,preflight) {
  const log=await open(path.join(runDir,preflight?'preflight.log':'native-switch.log'),'w',0o600);
  try {
    const child=spawn(path.join(repo,'artifacts/macos-tools/cargo/bin/cargo'),
      ['test','-p','central-app','--bin','central-app','--locked','--offline','switch_formal_macos_runtime','--','--ignored','--nocapture'],
      {cwd:work,env:cargoEnv({CENTRAL_MACOS_RELEASE_PREFLIGHT:preflight?'1':'0',
        CENTRAL_MACOS_RESOURCES:path.join(preflight?staged:installed,'Contents/Resources'),
        CENTRAL_MACOS_PACKAGE_ID:state.built.packageId,CENTRAL_MACOS_PREVIOUS_PACKAGE_ID:state.config.runtimePackageId,
        CENTRAL_MACOS_EXPECTED_REVISION:String(state.config.revision),CENTRAL_MACOS_LINK_EXISTING_LOGIN:'1',
        CENTRAL_MACOS_PREVIOUS_ACCOUNT_ID:state.deployment.accountId,CENTRAL_MACOS_RELEASE_REPORT:path.join(runDir,'native-report.json')}),
        stdio:['ignore',log.fd,log.fd]});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    if(code!==0)throw Error(preflight?'NATIVE_PREFLIGHT_FAILED':'NATIVE_SWITCH_FAILED');
  } finally {await log.close();}
}
async function quit(running) {
  if(running.installed!==installed)throw Error('INSTALLED_PATH_CHANGED');
  if(!alive(running.pid))return;
  if(command('/bin/ps',['-p',String(running.pid),'-o','comm=']).trim()!==path.join(installed,'Contents/MacOS/central-app'))throw Error('RUNNING_IDENTITY_CHANGED');
  const pairs=command('/bin/ps',['-axo','pid=,ppid=']).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));
  const owned=new Set([running.pid]);for(let i=0;i<12;i++)for(const [pid,parent]of pairs)if(owned.has(parent))owned.add(pid);
  command('/usr/bin/osascript',['-e','tell application id "com.yuanzhou.central" to quit']);
  for(let i=0;i<450&&[...owned].some(alive);i++)await delay(100);
  if([...owned].some(alive))throw Error('OWNED_PROCESS_CLEANUP_FAILED');
  return owned.size;
}
async function start(accountId,packageId) {
  if(!/^[a-f0-9]{32}$/.test(accountId))throw Error('ACCOUNT_ID_INVALID');
  const log=await open(path.join(runDir,'central-app.log'),'a',0o600);
  const child=spawn(path.join(installed,'Contents/MacOS/central-app'),['--start-account',accountId],{
    detached:true,env:{HOME:homedir(),USER:process.env.USER,LOGNAME:process.env.LOGNAME,LANG:'en_US.UTF-8',PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['ignore',log.fd,log.fd]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();await log.close();
  await save(path.join(formal,'running-app.json'),{pid:child.pid,installed,packageId});
  for(let i=0;i<120;i++){if(!alive(child.pid))throw Error('NEW_APP_EXITED');try{const h=await api('/healthz');if(h.ok)return child.pid;}catch{}await delay(1000);}
  throw Error('START_TIMEOUT');
}
async function restore(state) {
  if(!await exists(backup))throw Error('PREVIOUS_APP_NOT_BACKED_UP');
  const snapshot=path.join(runDir,'profile-before');
  if(!await exists(path.join(snapshot,'central-data')))throw Error('FULL_PROFILE_BACKUP_REQUIRED');
  const current=await json(path.join(formal,'running-app.json'));
  await quit(current);
  if(await exists(installed))await rename(installed,path.join(runDir,`failed-app-${Date.now()}.app`));
  await rename(backup,installed);
  // App Server may migrate history databases. Restore the complete stopped
  // profile, preserving both the snapshot and failed version for diagnosis.
  const restored=path.join(runDir,`restore-profile-${Date.now()}`);
  command('/usr/bin/ditto',[snapshot,restored]);
  await rename(profile,path.join(runDir,`failed-profile-${Date.now()}`));
  await rename(restored,profile);
  await save(path.join(formal,'deployment.json'),state.deployment);
  const pid=await start(state.deployment.accountId,state.config.runtimePackageId);
  await save(path.join(runDir,'rollback-result.json'),{restored:true,pid,status:await status()});
}
const action=process.argv[2];
if(action==='--status')console.log(JSON.stringify(await status()));
else if(action==='--verify') {
  const state=await json(path.join(runDir,'state-before.json'));
  const result=await json(path.join(runDir,'result.json'));
  const running=await json(path.join(formal,'running-app.json'));
  const cfg=(await json(path.join(profile,'config/central-config.json'))).config;
  if(cfg.runtimePackageId!==result.packageId||cfg.revision!==result.revision||running.pid!==result.pid||!alive(running.pid))throw Error('DEPLOYMENT_STATE_CHANGED');
  if(JSON.stringify({...cfg,revision:state.config.revision,runtimePackageId:state.config.runtimePackageId})!==JSON.stringify(state.config))throw Error('OTHER_CONFIG_CHANGED');
  const reference=await json(path.join(profile,'central-secrets/model-accounts-v1',`${result.accountId}.private`));
  if(reference.schemaVersion!==2||reference.source!=='codex-home'||Object.keys(reference).sort().join(',')!=='accountId,importedAt,schemaVersion,source')throw Error('REFERENCE_NOT_METADATA_ONLY');
  const version=command('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(installed,'Contents/Info.plist')]).trim();
  if(version!==state.built.appVersion)throw Error('INSTALLED_VERSION_CHANGED');
  command('/usr/bin/codesign',['--verify','--deep','--strict',installed]);
  const host=await readFile(path.join(installed,'Contents/Resources/central-service',result.packageId,'app/gateway/dist/native-service-host.js'),'utf8');
  if(!host.includes('accountUpdatesReady')||!host.includes('account/update'))throw Error('GATEWAY_UPDATE_SUPPORT_MISSING');
  if(!host.includes('runtimeUpdatesReady')||!host.includes('update/verify'))throw Error('RUNTIME_UPDATE_SUPPORT_MISSING');
  const resource=path.join(installed,'Contents/Resources/central-service',result.packageId);
  const manifest=await json(path.join(resource,'manifest.json'));
  const upstream=await json(path.join(work,'harness/upstream.json'));
  if(manifest.upstream.version!==upstream.version||manifest.upstream.commit!==upstream.commit)throw Error('RUNTIME_VERSION_CHANGED');
  const verified={verified:true,version,runtimeVersion:manifest.upstream.version,packageId:result.packageId,referenceOnly:true,otherConfigurationPreserved:true,gatewaySupportsUpdates:true,status:await status()};
  await save(path.join(runDir,'verification.json'),verified);console.log(JSON.stringify(verified));
}
else if(action==='--prepare') {
  const built=await json(path.join(work,'target/central-macos/latest-build.json'));
  const appVersion=(await json(path.join(work,'apps/central/src-tauri/tauri.conf.json'))).version;
  if(built.appVersion!==appVersion||built.app!==path.join(work,'target/debug/bundle/macos/远舟中央管理.app'))throw Error('BUILD_CHANGED');
  const config=(await json(path.join(profile,'config/central-config.json'))).config;
  // This deployment snapshots the full profile, including all persisted history.
  if(await realpath(config.dataDirectory)!==path.join(await realpath(profile),'central-data'))throw Error('EXTERNAL_DATA_BACKUP_REQUIRED');
  const deployment=await json(path.join(formal,'deployment.json'));
  const running=await json(path.join(formal,'running-app.json'));
  if(running.installed!==installed||!alive(running.pid))throw Error('FORMAL_APP_NOT_RUNNING');
  if(await exists(staged))throw Error('STAGING_EXISTS');
  command('/usr/bin/ditto',[built.app,staged]);command('/usr/bin/codesign',['--verify','--deep','--strict',staged]);
  await mkdir(path.join(runDir,'tmp'),{recursive:true,mode:0o700});
  const state={built,config,deployment,running};
  await nativeSwitch(state,true);
  await save(path.join(runDir,'state-before.json'),state,true);
  console.log(JSON.stringify({prepared:true,version:built.appVersion,packageId:built.packageId,status:await status()}));
} else if(action==='--switch') {
  const state=await json(path.join(runDir,'state-before.json'));
  if(await exists(backup))throw Error('SWITCH_ALREADY_STARTED');
  const live=await status();if(live.activeTurns!==0)throw Error('ACTIVE_TURNS_WAIT_REQUIRED');
  const current=await json(path.join(formal,'running-app.json'));
  if(current.pid!==state.running.pid)throw Error('RUNNING_APP_CHANGED');
  const config=(await json(path.join(profile,'config/central-config.json'))).config;
  if(JSON.stringify(config)!==JSON.stringify(state.config))throw Error('CONFIG_CHANGED');
  await quit(current);
  try {
    command('/usr/bin/ditto',[profile,path.join(runDir,'profile-before')]);
    await rename(installed,backup);
    await rename(staged,installed);
    await nativeSwitch(state,false);
    const report=await json(path.join(runDir,'native-report.json'));
    if(report.credentialSource!=='codex-shared'||report.packageId!==state.built.packageId)throw Error('SHARED_LOGIN_NOT_SELECTED');
    const pid=await start(report.accountId,report.packageId);
    await save(path.join(formal,'deployment.json'),{...state.deployment,accountId:report.accountId,revision:report.revision,packageId:report.packageId});
    const currentStatus=await status();if(currentStatus.model!=='ready')throw Error('MODEL_NOT_READY');
    const result={deployed:true,version:state.built.appVersion,pid,...report,status:currentStatus};
    await save(path.join(runDir,'result.json'),result,true);
    console.log(JSON.stringify(result));
  } catch(e) {
    if(await exists(backup))await restore(state);
    else await start(state.deployment.accountId,state.config.runtimePackageId);
    throw Error(`DEPLOY_FAILED_ROLLED_BACK:${e.message}`);
  }
} else if(action==='--rollback') {
  const state=await json(path.join(runDir,'state-before.json'));
  const current=await status();if(current.activeTurns!==0)throw Error('ACTIVE_TURNS_WAIT_REQUIRED');
  await restore(state);console.log(JSON.stringify({rolledBack:true}));
} else throw Error('Usage: --status | --verify | --prepare | --switch | --rollback');
