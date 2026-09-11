// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Developer QA only. This script never reads credential contents via security(1).
// Usage: node rc-native-macos-qa.mjs prepare|start|status|cleanup
//   --qa-root /absolute/new-run-directory --app /absolute/RC.app
//   --helper /absolute/examples/platform-acceptance --ca /absolute/server-ca.pem
// prepare consumes {"password":"..."} ONLY on stdin; never use a shell literal.
// Close the QA window normally before cleanup. No GUI/security-dialog automation.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';

const namespace='com.centralcodex.harnessqa.rc20260909';
const gateway='wss://192.0.2.10:4529/ws',origin='https://192.0.2.10:4529';
const names=['desktop-runtime-v1.json','platform-ca-v1.json'];
const services=['platform-v1','device-tls-v1.key','device-tls-v1.certificate'].map(s=>`${namespace}.${s}`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function directory(path){const s=lstatSync(path);assert(s.isDirectory()&&!s.isSymbolicLink()&&realpathSync(path)===path,`QA directory must be canonical: ${path}`);}
function regular(path){const s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&realpathSync(path)===path,`QA file must be canonical and unlinked: ${path}`);}
function run(file,args,options={}){return spawnSync(file,args,{encoding:'utf8',timeout:30_000,maxBuffer:1024*1024,...options});}
function cleanEnv(){const env={...process.env};for(const key of Object.keys(env))if(/^(CODEXIA_|DYLD_|PLATFORM_)/.test(key))delete env[key];return env;}
function parseArgs(){
  const [action,...args]=process.argv.slice(2);assert(['prepare','start','status','cleanup'].includes(action),'Expected prepare, start, status or cleanup');
  assert(args.length===8,'Expected --qa-root, --app, --helper and --ca');const options={};
  for(let i=0;i<args.length;i+=2){assert(['--qa-root','--app','--helper','--ca'].includes(args[i])&&!options[args[i]],'Invalid or duplicate option');assert(isAbsolute(args[i+1]),'All paths must be absolute');options[args[i]]=resolve(args[i+1]);}
  return {action,root:options['--qa-root'],app:options['--app'],helper:options['--helper'],ca:options['--ca']};
}
function certificate(value){return Object.fromEntries(['state','expiresAt','renewAfter','fingerprint','error'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));}

async function main(){
  assert.equal(process.platform,'darwin','This support script is macOS only');
  const {action,root,app,helper,ca}=parseArgs();
  assert(root.startsWith('/Users/operator/central-harness-qa-20260909/'),'QA run directory must stay inside the approved isolated central QA root');
  assert(basename(root).startsWith('rc-native-'),'Use a distinct rc-native-* run directory');
  directory(dirname(root));directory(app);regular(helper);regular(ca);
  const info=join(app,'Contents','Info.plist');regular(info);
  for(const [key,expected] of [['CFBundleIdentifier',namespace],['CFBundleExecutable','yuan-zhou-rc']]){
    const result=run('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,info]);assert(result.status===0&&result.stdout.trim()===expected,`Unexpected QA app ${key}`);
  }
  const desktop=join(app,'Contents','MacOS','yuan-zhou-rc'),agent=join(app,'Contents','MacOS','local-agent');regular(desktop);regular(agent);
  const config=join(homedir(),'Library','Application Support',namespace);
  directory(dirname(config));if(existsSync(config))directory(config);
  const recordPath=join(root,'record.json'),workspace=join(root,'workspace'),backup=join(root,'backup');
  const binaryHashes={desktop:hash(readFileSync(desktop)),agent:hash(readFileSync(agent)),helper:hash(readFileSync(helper)),ca:hash(readFileSync(ca))};
  function writeRecord(record){const next=join(root,'record.next.json');assert(!existsSync(next),'Unfinished record update; preserve it for review');writeFileSync(next,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(next,recordPath);}
  function native(input,{allowFailure=false}={}){
    const request=Buffer.from(JSON.stringify({namespace,gateway,ca,...input}));
    let result;try{result=run(helper,[],{input:request,env:cleanEnv(),timeout:60_000});}finally{request.fill(0);}
    if(result.status!==0){if(allowFailure)return {ok:false};throw Error(`Native QA ${input.action} failed or timed out; Keychain access may require local authorization. No permission dialog was handled and no credential output retained.`);}
    let response;try{response=JSON.parse(result.stdout);}catch{throw Error('Native QA returned invalid JSON; output suppressed');}
    assert(response.ok===true,'Native QA action rejected');return response;
  }
  function vaultServices(){return services.map(service=>{
    // No -w/-g, no password output, no access-control or keychain-setting changes.
    const result=run('/usr/bin/security',['find-generic-password','-s',service]);
    assert(result.status===0||result.status===44,'Cannot establish Keychain metadata state; preserve all existing state');
    return {service,present:result.status===0};
  });}
  function processes(){
    const result=run('/bin/ps',['-ww','-axo','pid=,ppid=,comm=']);assert.equal(result.status,0,'Cannot establish QA process state');
    return result.stdout.split('\n').flatMap(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m&&[desktop,agent].includes(m[3])?[{pid:Number(m[1]),ppid:Number(m[2]),executable:m[3]}]:[];});
  }
  function assertStopped(){assert.equal(processes().length,0,'Close the exact isolated QA app and wait for its Agent to exit first');}
  let record;
  if(action==='prepare'){
    assertStopped();assert(!existsSync(root),'Use a fresh QA run directory; never overwrite an earlier run');
    assert(vaultServices().every(s=>!s.present),'QA namespace already contains Keychain entries; preserve them');
    let bytes=Buffer.alloc(0);for await(const chunk of process.stdin){assert(bytes.length+chunk.length<=16_384,'Input too large');bytes=Buffer.concat([bytes,chunk]);}
    let input;try{input=JSON.parse(bytes.toString('utf8'));}catch{throw Error('Invalid preparation JSON; input suppressed');}finally{bytes.fill(0);}
    assert(typeof input.password==='string'&&input.password.length>0,'Password required on stdin');
    mkdirSync(root,{mode:0o700});mkdirSync(backup,{mode:0o700});
    const files=names.map(name=>{const path=join(config,name);if(!existsSync(path))return {name,existed:false};regular(path);const bytes=readFileSync(path);writeFileSync(join(backup,name),bytes,{flag:'wx',mode:0o600});return {name,existed:true,originalHash:hash(bytes)};});
    record={version:1,namespace,gateway,ca,app,helper,config,workspace,backup,binaryHashes,files,stage:'setup-started',preparedAt:new Date().toISOString(),samples:[]};writeRecord(record);
    let identity;try{identity=native({action:'setup',username:'rcmac',password:input.password,name:'RC macOS 20260909'}).data;}finally{input.password=undefined;}
    assert(identity.deviceId&&identity.userId&&identity.sessionId,'Native pairing identity missing');
    record.identity={deviceId:identity.deviceId,userId:identity.userId,sessionId:identity.sessionId,certificate:certificate(identity.certificate)};record.stage='paired';writeRecord(record);
    mkdirSync(workspace,{mode:0o700});if(!existsSync(config))mkdirSync(config,{mode:0o700});
    const configs=[{gatewayUrl:gateway,userId:identity.userId,deviceId:identity.deviceId,workspaceRoot:workspace},{[origin]:ca}];
    for(let i=0;i<files.length;i++){const file=files[i],path=join(config,file.name),bytes=Buffer.from(JSON.stringify(configs[i],null,2)+'\n');if(file.existed){regular(path);assert.equal(hash(readFileSync(path)),file.originalHash,'Existing QA config changed');}else assert(!existsSync(path),'QA config appeared during pairing');file.qaHash=hash(bytes);writeRecord(record);writeFileSync(path,bytes,{mode:0o600});}
    record.stage='configured';writeRecord(record);console.log(JSON.stringify({ok:true,namespace,recordPath,deviceId:record.identity.deviceId,certificate:record.identity.certificate}));return;
  }
  directory(root);regular(recordPath);record=JSON.parse(readFileSync(recordPath,'utf8'));
  for(const [key,value] of Object.entries({version:1,namespace,gateway,ca,app,helper,config,workspace,backup}))assert.equal(record[key],value,`QA record ${key} mismatch`);
  assert.deepEqual(record.binaryHashes,binaryHashes,'QA binaries/CA changed; preserve run and review before continuing');
  assert.deepEqual(record.files.map(f=>f.name),names);assert.notEqual(record.stage,'cleaned','Run already cleaned');directory(backup);
  if(action==='start'){
    assert.equal(record.stage,'configured');assertStopped();
    for(const file of record.files){regular(join(config,file.name));assert.equal(hash(readFileSync(join(config,file.name))),file.qaHash,'QA config changed');}
    const publicCertificate=certificate(native({action:'certificate-status'}).data);assert(['valid','renewing'].includes(publicCertificate.state),'Certificate is unusable; explicit repair required');
    const child=spawn(desktop,[],{cwd:workspace,env:cleanEnv(),detached:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('QA app launch failed')));});child.unref();
    record.launch={pid:child.pid,at:new Date().toISOString()};writeRecord(record);console.log(JSON.stringify({ok:true,launched:true,pid:child.pid,verification:'Run status after startup; close the QA window normally before cleanup'}));return;
  }
  if(action==='status'){
    const sample={at:new Date().toISOString(),processes:processes(),certificate:certificate(native({action:'certificate-status'}).data)};
    record.samples.push(sample);assert(record.samples.length<=1000,'QA sample limit reached');writeRecord(record);console.log(JSON.stringify({ok:true,...sample}));return;
  }
  assertStopped();
  // Validate both backups and current files before modifying credentials or configuration.
  for(const file of record.files){const path=join(config,file.name),original=join(backup,file.name);if(file.existed){regular(original);assert.equal(hash(readFileSync(original)),file.originalHash);}else assert(!existsSync(original));if(existsSync(path)){regular(path);const value=hash(readFileSync(path));assert(value===file.qaHash||(file.existed&&value===file.originalHash),'QA configuration changed; preserve it');}else assert(!file.existed,'Original QA config disappeared');}
  let remoteLogoutConfirmed=false;
  if(vaultServices().some(s=>s.present)){remoteLogoutConfirmed=native({action:'logout'},{allowFailure:true}).ok;if(!remoteLogoutConfirmed)native({action:'cleanup'});}
  assert(vaultServices().every(s=>!s.present),'QA Keychain entries remain; cleanup not complete');
  for(const file of record.files){const path=join(config,file.name);if(file.existed)writeFileSync(path,readFileSync(join(backup,file.name)),{mode:0o600});else if(existsSync(path))unlinkSync(path);}
  for(const file of record.files){const path=join(config,file.name);if(file.existed)assert.equal(hash(readFileSync(path)),file.originalHash);else assert(!existsSync(path));}
  record.stage='cleaned';record.cleanup={at:new Date().toISOString(),remoteLogoutConfirmed,localCredentialsRemoved:true,configurationRestored:true,processesStopped:true};writeRecord(record);console.log(JSON.stringify({ok:true,...record.cleanup,recordPath}));
}
main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
