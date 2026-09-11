// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Developer-only lifecycle control for the explicitly authorized central 4529 QA.
// This is never part of client execution or the product routing path.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import https from 'node:https';

assert.equal(process.platform, 'darwin', 'Run on the central Mac only');
const qa = '/Users/operator/central-harness-qa-20260909';
const node = '/Users/operator/central-codex-platform/artifacts/macos-tools/node/bin/node';
const binary = join(qa, 'codex-3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/target/debug/codex-app-server');
const rc = process.argv.includes('--rc');
const tokenQa = process.argv.includes('--token');
const cwd = join(qa, tokenQa ? 'rc-client-source' : 'gateway'), worker = join(qa, 'live-data/remote-worker');
assert(!(rc && tokenQa), 'Select only one QA batch');
const mtlsSecurity = tokenQa ? 'p5-token-security' : rc ? 'p5-rc-security' : 'p5-mtls-security';
const mtlsWorkers = tokenQa ? 'live-data/token-workers' : rc ? 'live-data/rc-workers' : 'live-data/mtls-workers';
const mtlsState = tokenQa ? 'live-data/p5-token-state.json' : rc ? 'live-data/p5-rc-state.json' : 'live-data/p5-mtls-state.json';
const mtlsAudit = tokenQa ? 'live-data/p5-token-audit' : rc ? 'live-data/p5-rc-audit' : 'live-data/p5-mtls-audit';
const statePath = join(qa, tokenQa ? 'qa-token-control-state.json' : rc ? 'qa-rc-control-state.json' : 'qa-control-state.json');
const requestedAction = process.argv[2] ?? 'status';
const action = requestedAction === 'start-token' ? 'start-mtls' : requestedAction;
if (tokenQa) assert(['start-token','clean-mtls-sessions','status','stop'].includes(requestedAction), 'Token QA supports only isolated lifecycle');
if (requestedAction === 'start-token') assert(tokenQa, 'start-token requires --token');
if (rc) assert(['start-mtls','clean-mtls-sessions','status','stop'].includes(action), 'RC control supports only isolated mTLS lifecycle');
assert(['start', 'start-secure', 'start-workers', 'start-isolated', 'start-mtls', 'model-disable', 'model-enable', 'clean-isolated-sessions', 'clean-mtls-sessions', 'status', 'stop', 'crash-runtime', 'crash-user'].includes(action), 'Usage: qa-control.mjs start|start-secure|start-workers|start-isolated|start-mtls|clean-isolated-sessions|clean-mtls-sessions|status|stop|crash-runtime|crash-user USER_ID');
const workerRootFor = state => join(qa, (state.mtls || state.token) ? mtlsWorkers : state.isolated ? 'live-data/isolated-workers' : 'live-data/workers');
const securityFor = state => join(qa, (state.mtls || state.token) ? mtlsSecurity : state.isolated ? 'p5-isolated-security' : 'p5-workers-security');
const command = (file, args) => {
  try { return execFileSync(file, args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
  catch (error) { if (error.status === 1) return ''; throw error; }
};
const pids = text => text.split(/\s+/).filter(Boolean).map(Number);
const listener = port => pids(command('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']));
const info = pid => ({pid, command:command('/bin/ps',['-p',String(pid),'-o','command=']), cwd:command('/usr/sbin/lsof',['-a','-p',String(pid),'-d','cwd','-Fn']).split('\n').find(x=>x.startsWith('n'))?.slice(1), started:command('/bin/ps',['-p',String(pid),'-o','lstart='])});
const children = pid => pids(command('/usr/bin/pgrep',['-P',String(pid)]));
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
const health = async port => {
  const mtls = action.startsWith('start') ? action === 'start-mtls' : (load()?.mtls || load()?.token);
  if(port===4529 && (['start-secure','start-workers','start-isolated','start-mtls'].includes(action)||load()?.secure))return new Promise(resolve=>{const req=https.get(`https://192.0.2.10:${port}/healthz`,{ca:readFileSync(join(qa,mtls?`${mtlsSecurity}/server-ca.pem`:'p5-security/cert.pem')),timeout:3000},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{resolve(JSON.parse(raw));}catch{resolve(null);}});});req.on('error',()=>resolve(null));req.on('timeout',()=>{req.destroy();resolve(null);});});
  try { return await (await fetch(`http://192.0.2.10:${port}/healthz`,{signal:AbortSignal.timeout(3000)})).json(); } catch { return null; }
};
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath,'utf8')) : null;
const save = state => writeFileSync(statePath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const validateGateway = state => {
  const actual=info(state.gateway.pid);
  assert.equal(actual.command,`${node} services/test-gateway/dist/index.js`,'Gateway PID command changed');
  assert.equal(actual.cwd,cwd,'Gateway cwd changed');
  assert.equal(actual.started,state.gateway.started,'Gateway PID was reused');
  assert(listener(4529).includes(actual.pid),'Recorded gateway does not own 4529');
  return actual;
};
const validateFork = (pid,parent) => {
  const actual=info(pid);
  assert.equal(actual.command,binary,'Child is not the pinned QA fork');
  if(load()?.perUser){
    const prefix=workerRootFor(load())+'/';
    assert(actual.cwd?.startsWith(prefix)&&/^[a-f0-9]{64}\/runtime$/.test(actual.cwd.slice(prefix.length)),'Fork outside per-user QA directories');
  }else assert.equal(actual.cwd,worker,'Fork worker path changed');
  assert.equal(command('/bin/ps',['-p',String(pid),'-o','ppid=']),String(parent),'Fork parent changed');
  assert.deepEqual(children(pid),[],'Unexpected fork descendants; inspect before stopping');
  return actual;
};
if(['start','start-secure','start-workers','start-isolated','start-mtls'].includes(action)) {
  assert.deepEqual(listener(4529),[],'4529 already has a listener; use status, do not replace it');
  const prior=load();
  if(prior?.gateway) assert(!info(prior.gateway.pid).command,'Previous managed gateway still exists');
  assert.equal(realpathSync(cwd),cwd); assert.equal(realpathSync(worker),worker);
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),'673a2705de80016e2a61ecd7f7f469532bc650bf8b5bf827b4c1fc1f753d9d88','Fork fingerprint mismatch');
  const log=openSync(join(qa,'live-gateway.log'),'a',0o600);
  const processHandle=spawn(node,['services/test-gateway/dist/index.js'],{cwd,detached:true,stdio:['ignore',log,log],env:{...process.env,
    TEST_GATEWAY_HOST:'192.0.2.10',TEST_GATEWAY_PORT:'4529',TEST_GATEWAY_STATE_FILE:join(qa,action==='start-mtls'?mtlsState:action==='start-isolated'?'live-data/p5-isolated-state.json':action==='start-workers'?'live-data/p5-workers-state.json':action==='start-secure'?'live-data/p5-state.json':'live-data/state.json'),
    ...(['start-secure','start-workers','start-isolated','start-mtls'].includes(action)?{PLATFORM_AUTH_FILE:join(qa,action==='start-mtls'?`${mtlsSecurity}/auth.json`:action==='start-isolated'?'p5-isolated-security/auth.json':action==='start-workers'?'p5-workers-security/auth.json':'p5-security/auth.json'),PLATFORM_TLS_CERT:join(qa,'p5-security/cert.pem'),PLATFORM_TLS_KEY:join(qa,'p5-security/key.pem')}:{}),
    ...(action==='start-workers'?{PLATFORM_WORKER_ROOT:join(qa,'live-data/workers'),PLATFORM_AUDIT_DIR:join(qa,'live-data/p5-workers-audit'),PLATFORM_USER_TURNS:'1',PLATFORM_TOTAL_TURNS:'2',PLATFORM_MAX_WORKERS:'3'}:{}),
    ...(action==='start-isolated'?{PLATFORM_WORKER_ROOT:join(qa,'live-data/isolated-workers'),PLATFORM_AUDIT_DIR:join(qa,'live-data/p5-isolated-audit'),PLATFORM_MODEL_BINDINGS:join(qa,'p5-isolated-security/models.json'),PLATFORM_WORKER_BINARY:binary,PLATFORM_WORKER_BINARY_SHA256:'673a2705de80016e2a61ecd7f7f469532bc650bf8b5bf827b4c1fc1f753d9d88',PLATFORM_USER_TURNS:'1',PLATFORM_TOTAL_TURNS:'2',PLATFORM_MAX_WORKERS:'3'}:{}),
    ...(action==='start-mtls'?{PLATFORM_TLS_CERT:join(qa,`${mtlsSecurity}/server.pem`),PLATFORM_TLS_KEY:join(qa,`${mtlsSecurity}/server-key.pem`),PLATFORM_WORKER_ROOT:join(qa,mtlsWorkers),PLATFORM_AUDIT_DIR:join(qa,mtlsAudit),PLATFORM_MODEL_BINDINGS:join(qa,`${mtlsSecurity}/models.json`),PLATFORM_DEVICE_AUTH_MODE:tokenQa?'device-token-v1':'legacy-mtls-v1',...(!tokenQa?{PLATFORM_DEVICE_CA_CONFIG:join(qa,`${mtlsSecurity}/device-ca/device-ca.json`)}:{}),PLATFORM_WORKER_BINARY:binary,PLATFORM_WORKER_BINARY_SHA256:'673a2705de80016e2a61ecd7f7f469532bc650bf8b5bf827b4c1fc1f753d9d88',PLATFORM_USER_TURNS:'1',PLATFORM_TOTAL_TURNS:'2',PLATFORM_MAX_WORKERS:'3'}:{}),
    TEST_GATEWAY_ENABLE_CONTROLS:'1',TEST_GATEWAY_ENABLE_HISTORY_FIXTURES:'1',CODEX_BIN:join(qa,'launch-central.sh'),CODEX_REMOTE_BINARY:binary,
    CODEX_HOME:join(qa,'live-home'),CODEX_REMOTE_WORKER_DIR:worker,CODEX_REMOTE_AUTH_FILE:'/Users/operator/.codex/auth.json',
    CODEX_REFRESH_TOKEN_URL_OVERRIDE:'disabled://read-only-shared-auth',CODEX_REVOKE_TOKEN_URL_OVERRIDE:'disabled://read-only-shared-auth'}});
  closeSync(log); processHandle.unref();
  await new Promise((resolve,reject)=>{processHandle.once('spawn',resolve);processHandle.once('error',reject);});
  const state={version:1,rc,token:tokenQa,secure:action!=='start',perUser:['start-workers','start-isolated','start-mtls'].includes(action),isolated:['start-isolated','start-mtls'].includes(action),mtls:action==='start-mtls'&&!tokenQa,startedAt:new Date().toISOString(),gateway:info(processHandle.pid),forks:[],status:'starting'};
  save(state); writeFileSync(join(qa,'live-gateway.pid'),`${processHandle.pid}\n`);
  for(let n=0;n<40 && !listener(4529).includes(processHandle.pid);n++) await wait(250);
  validateGateway(state);
  state.forks=children(processHandle.pid).map(pid=>validateFork(pid,processHandle.pid));
  state.status='running'; state.health=await health(4529); state.productionBaseline={pids:listener(4510),health:await health(4510)};save(state);
  console.log(JSON.stringify(state));
} else if(['clean-isolated-sessions','clean-mtls-sessions'].includes(action)) {
  const state=load(),mtls=action==='clean-mtls-sessions';assert(state?.isolated&&Boolean(state.mtls||state.token)===mtls&&Boolean(state.token)===tokenQa&&state.status==='stopped');assert.deepEqual(listener(4529),[]);
  const file=join(securityFor(state),'auth.json'),data=JSON.parse(readFileSync(file,'utf8'));
  const names=mtls?(tokenQa?['tokenadmin','tokenuser']:rc?['rcmac','rcwindows']:['mtlsalice','mtlsbob']):['isoalice','isobob'];
  assert.equal(data.users.length,2);assert.deepEqual(data.users.map(u=>u.username).sort(),names.sort());
  for(const session of data.sessions)session.revoked=true;for(const device of data.devices)device.revoked=true;
  writeFileSync(file+'.tmp',JSON.stringify(data,null,2),{mode:0o600});renameSync(file+'.tmp',file);
  console.log(JSON.stringify({ok:true,sessionsRevoked:data.sessions.length,devicesRevoked:data.devices.length,scope:tokenQa?'stopped token QA identities only':rc?'stopped fifth-batch RC QA identities only':mtls?'stopped fourth-batch mTLS QA identities only':'stopped third-batch QA identities only'}));
} else if(action==='status') {
  const state=load();
  console.log(JSON.stringify({record:state,qaListeners:listener(4529),qaHealth:await health(4529),productionListeners:listener(4510),productionHealth:await health(4510)}));
} else {
  const state=load(); assert(state,'No QA control record; refuse untracked process signals');
  validateGateway(state);
  const forkPids=children(state.gateway.pid); forkPids.forEach(pid=>validateFork(pid,state.gateway.pid));
  if(state.perUser){state.forks=forkPids.map(pid=>validateFork(pid,state.gateway.pid));save(state);}
  assert(forkPids.every(pid=>state.forks.some(f=>f.pid===pid && f.started===info(pid).started)),'Untracked or reused fork PID');
  if(['model-disable','model-enable'].includes(action)){
    assert(state.isolated,'Isolated QA required');const userId=process.argv[3];
    const modelFile=join(securityFor(state),'models.json'), models=JSON.parse(readFileSync(modelFile,'utf8'));
    assert(Object.hasOwn(models.users,userId),'Only known QA user bindings may change');
    const changed=execFileSync(node,[join(cwd,'scripts/model-access-configure.mjs')],{input:JSON.stringify({userId,enabled:action==='model-enable'}),encoding:'utf8',env:{...process.env,PLATFORM_MODEL_BINDINGS:modelFile,PLATFORM_AUTH_FILE:join(securityFor(state),'auth.json'),PLATFORM_WORKER_ROOT:workerRootFor(state)}});console.log(changed.trim());
  } else if(action==='crash-user'){
    assert(state.perUser,'Per-user QA required');
    const userId=process.argv[3];assert(/^[a-f0-9-]{36}$/.test(userId??''));
    const auth=JSON.parse(readFileSync(join(securityFor(state),'auth.json'),'utf8'));
    const names=state.mtls?(tokenQa?['tokenadmin','tokenuser']:rc?['rcmac','rcwindows']:['mtlsalice','mtlsbob']):state.isolated?['isoalice','isobob']:['alice','bob','nativeqa','finalalice','finalbob'];
    assert(auth.users.some(u=>u.id===userId&&names.includes(u.username)),'Only generated QA users from the active batch may be crashed');
    const directory=join(workerRootFor(state),createHash('sha256').update(userId).digest('hex'),'runtime');
    const targets=state.forks.filter(f=>f.cwd===directory);assert.equal(targets.length,1);
    const actual=validateFork(targets[0].pid,state.gateway.pid);assert.equal(actual.started,targets[0].started);
    process.kill(actual.pid,'SIGKILL');console.log(JSON.stringify({userId,pid:actual.pid,kind:'SIGKILL one QA user worker'}));
  } else if(action==='crash-runtime') {
    assert.equal(forkPids.length,1,'Expected exactly one managed fork');
    process.kill(forkPids[0],'SIGKILL');
    state.lastFault={at:new Date().toISOString(),kind:'SIGKILL runtime only',pid:forkPids[0]}; save(state);
    console.log(JSON.stringify(state.lastFault));
  } else {
    process.kill(state.gateway.pid,'SIGTERM');
    for(const pid of forkPids) { try {process.kill(pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;} }
    for(let n=0;n<40 && [state.gateway.pid,...forkPids].some(pid=>info(pid).command);n++) await wait(250);
    assert([state.gateway.pid,...forkPids].every(pid=>!info(pid).command),'A managed QA process has not exited; no automatic SIGKILL');
    assert.deepEqual(listener(4529),[],'4529 still listening');
    state.status='stopped';state.stoppedAt=new Date().toISOString();state.productionAfter={pids:listener(4510),health:await health(4510)};save(state);
    console.log(JSON.stringify({status:state.status,qaPidsExited:true,port4529Closed:true,production:state.productionAfter,evidenceRetained:true}));
  }
}
