// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Opt-in real Local Agent + native authenticated UI socket + one real model Turn.
// The native controller owns the Job, credential import and device revocation.
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';

const namespace='com.centralcodex.harnessqa.central-live',marker='yuan-zhou-remote-workspace/1';
const formal4510=process.argv.length===3&&process.argv[2]==='--formal-4510';
const hash=value=>createHash('sha256').update(value).digest('hex');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const check=(value,code)=>{if(!value)throw Error(code);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const children=new Set(),pending=new Map(),toolCalls=new Map();
let failure,config,agent,helper,agentExit,helperExit,deviceId,connected=false,threadId,turnId,turnDone,assistant='',socketRevoked=false,localRemoved=false,agentTerminal=false,completed=false,controllerEnded=false;
let inputBuffer=Buffer.alloc(0),bootstrapResolve,bootstrapReject;
const bootstrap=new Promise((resolve,reject)=>{bootstrapResolve=resolve;bootstrapReject=reject;});
function fail(code){
  if(failure)return;failure=code;
  // Release any pending RPC immediately, so an unexpected tool is cancelled
  // without waiting for the normal model RPC timeout.
  for(const task of pending.values())task.reject(Error(code));pending.clear();
}
process.stdin.on('data',chunk=>{
  if(config){fail('QA_UNEXPECTED_CONTROLLER_INPUT');return;}
  inputBuffer=Buffer.concat([inputBuffer,chunk]);if(inputBuffer.length>65536){bootstrapReject(Error('QA_BOOTSTRAP_LIMIT'));return;}
  const end=inputBuffer.indexOf(10);if(end<0)return;
  try{check(end===inputBuffer.length-1,'QA_BOOTSTRAP_EXTRA');config=JSON.parse(inputBuffer.subarray(0,end).toString('utf8'));bootstrapResolve(config);}catch{bootstrapReject(Error('QA_BOOTSTRAP_INVALID'));}finally{inputBuffer.fill(0);inputBuffer=Buffer.alloc(0);}
});
process.stdin.on('end',()=>{controllerEnded=true;fail('QA_CONTROLLER_CLOSED');bootstrapReject(Error('QA_CONTROLLER_CLOSED'));});
process.stdin.on('error',()=>fail('QA_CONTROLLER_FAILED'));
const watchdog=setTimeout(()=>fail('QA_TOTAL_TIMEOUT'),255000);
async function until(predicate,ms,code){const deadline=Date.now()+ms;while(!predicate()){if(failure)throw Error(failure);if(Date.now()>=deadline)throw Error(code);await delay(25);}if(failure)throw Error(failure);}
function regular(filename){check(typeof filename==='string'&&path.isAbsolute(filename)&&!filename.split(/[\\/]/).some(p=>p==='..'),'QA_PATH_INVALID');const stat=lstatSync(filename);check(stat.isFile()&&!stat.isSymbolicLink(),'QA_BINARY_INVALID');return realpathSync(filename);}
function writeHelper(message){check(helper&&!helper.stdin.destroyed,'QA_UI_UNAVAILABLE');const bytes=Buffer.from(JSON.stringify(message)+'\n');helper.stdin.write(bytes,()=>bytes.fill(0));}
function send(message){writeHelper({kind:'send',message});}
async function request(operation,payload={},timeout=45000){
  const requestId=randomUUID();let resolve,reject;const response=new Promise((r,j)=>{resolve=r;reject=j;});
  pending.set(requestId,{resolve,reject,operation});send({type:'request',requestId,operation,payload});
  const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('QA_RPC_TIMEOUT'));},timeout);
  try{return await response;}finally{clearTimeout(timer);pending.delete(requestId);}
}
function gatewayMessage(message){
  if(message.type==='response'){
    const task=pending.get(message.requestId);if(task){pending.delete(message.requestId);if(!message.ok)emit({phase:'rpc-failed',operation:task.operation,errorCode:String(message.error??'').match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/)?.[0]??'UNCLASSIFIED'});message.ok?task.resolve(message.data):task.reject(Error('QA_GATEWAY_REQUEST_FAILED'));}return;
  }
  if(message.type==='approval.request'){
    const allowed=config.legacyWorkspace===true&&message.method==='device/fileChange/requestApproval'
      &&message.data?.deviceId===deviceId&&message.data?.threadId===threadId
      &&message.data?.patch===config.patch&&message.data?.expectedVersions?.['compatibility-proof.txt']==='missing'
      &&message.data?.expectedPaths===undefined&&!config.patchApproved;
    send({type:'approval.response',requestId:message.requestId,result:{decision:allowed?'accept':'decline'}});
    if(!allowed)fail('QA_UNEXPECTED_APPROVAL');else config.patchApproved=true;
    return;
  }
  if(message.type!=='event')return;
  const data=message.data??{};
  if(threadId&&data.threadId&&data.threadId!==threadId)return;
  if(message.eventType==='assistant.delta'){
    assistant+=typeof data.delta==='string'?data.delta:'';if(assistant.length>1024*1024)fail('QA_ASSISTANT_OUTPUT_LIMIT');
  }
  if(message.eventType==='turn.completed')turnDone=data.turn;
  if(message.eventType==='device.tool.started'){
    emit({phase:'model-tool',tool:data.tool});
    const allowedTools=config.creator?['device_skill_load','device_skill_draft','device_write_file','device_read_text','device_workspace_read_text']:['device_workspace_context','device_workspace_read_text','device_exec',...(config.skills?['device_skill_load']:[]),...(config.legacyWorkspace?['device_workspace_apply_patch']:[])];
    if(!allowedTools.includes(data.tool)){fail('QA_UNEXPECTED_TOOL');return;}
    if(data.tool==='device_exec'&&(data.program!==config.powershell||data.cwd!==config.toolCwd))fail('QA_UNEXPECTED_COMMAND');
    if(toolCalls.size>=(config.creator?20:12))fail('QA_TOO_MANY_TOOLS');
    toolCalls.set(data.requestId,{tool:data.tool,done:false});
  }
  if(message.eventType==='device.tool.completed'){
    const call=toolCalls.get(data.requestId);if(!call){fail('QA_TOOL_RECEIPT_UNMATCHED');return;}
    call.done=true;call.succeeded=data.status==='succeeded';call.exitCode=data.exitCode;
    if(!call.succeeded||(call.tool==='device_exec'&&data.exitCode!==0))fail('QA_MODEL_TOOL_FAILED');
  }
  if(message.eventType==='gateway.runtime_unavailable'||(message.eventType==='codex.notification'&&message.name==='gateway/runtimeUnavailable'))fail('QA_RUNTIME_UNAVAILABLE');
}
function launch(binary,args,options){
  const child=spawn(binary,args,{...options,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});children.add(child);child.stdin.on('error',()=>{});
  const exit=new Promise(resolve=>{child.once('error',()=>{fail('QA_CHILD_SPAWN_FAILED');resolve({code:null,spawnFailed:true});});child.once('close',(code,signal)=>{children.delete(child);resolve({code,signal});});});
  let stderrBytes=0;child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>1024*1024)fail('QA_CHILD_DIAGNOSTIC_LIMIT');const code=chunk.toString().match(/\bQA_HELPER_[A-Z_]+\b/)?.[0];if(code)fail(code);});
  return {child,exit};
}
async function cleanup(){
  // If an unexpected tool was observed, request Turn cancellation before close.
  if(!completed&&threadId&&helper&&!helper.stdin.destroyed){try{send({type:'request',requestId:randomUUID(),operation:'conversation.turn.cancel',payload:{threadId,...(turnId?{turnId}:{})}});}catch{}}
  if(helper&&!helper.stdin.destroyed)helper.stdin.end();
  for(const child of children)if(child!==helper)child.kill();
  if(children.size){await Promise.race([Promise.all([agentExit,helperExit].filter(Boolean)),delay(5000)]);}
  for(const child of children)child.kill();
}
try{
  check(process.platform==='win32'&&(process.argv.length===2||formal4510),'QA_WINDOWS_STDIN_ONLY');
  await Promise.race([bootstrap,new Promise((_,reject)=>setTimeout(()=>reject(Error('QA_BOOTSTRAP_TIMEOUT')),15000).unref())]);
  check(config&&Object.keys(config).every(key=>['gateway','caPath','code','agentBinary','helperBinary','workspace','output','model','legacyWorkspace','projects','skills','creator'].includes(key)),'QA_BOOTSTRAP_FIELDS');
  check(config.creator===undefined||['explicit','implicit'].includes(config.creator)&&!config.skills&&!config.projects&&!config.legacyWorkspace,'QA_CREATOR_MODE_INVALID');
  const gateway=new URL(config.gateway);check(gateway.protocol==='wss:'&&(formal4510?gateway.hostname==='192.0.2.10'&&gateway.port==='4510':['localhost','127.0.0.1'].includes(gateway.hostname)&&gateway.port&&gateway.port!=='4510')&&gateway.pathname==='/ws'&&!gateway.search&&!gateway.hash&&!gateway.username&&!gateway.password,'QA_TARGET_INVALID');
  config.agentBinary=regular(config.agentBinary);config.helperBinary=regular(config.helperBinary);if(config.caPath)config.caPath=regular(config.caPath);else check(config.code?.startsWith("yzpair1."),"QA_CA_REQUIRED");
  check(path.isAbsolute(config.workspace)&&path.isAbsolute(config.output)&&!existsSync(config.output),'QA_OUTPUT_INVALID');
  check(['gpt-6-astra','gpt-6-sol'].includes(config.model),'QA_MODEL_INVALID');
  check(typeof config.code==='string'&&(/^[A-Za-z0-9_-]{43}$/.test(config.code)||config.code.length<=98304&&/^yzpair1\.[A-Za-z0-9_-]+$/.test(config.code)),'QA_PAIR_CODE_INVALID');
  const workspace=realpathSync(config.workspace),root=path.dirname(workspace),tokenRoot=path.join(root,'central-live-token-data');
  check(lstatSync(workspace).isDirectory()&&!lstatSync(config.workspace).isSymbolicLink()&&!existsSync(tokenRoot),'QA_WORKSPACE_INVALID');
  check(config.legacyWorkspace===undefined||typeof config.legacyWorkspace==='boolean','QA_LEGACY_MODE_INVALID');
  check((config.projects===undefined||typeof config.projects==='boolean')&&!(config.projects&&config.legacyWorkspace),'QA_PROJECT_MODE_INVALID');
  const project=config.legacyWorkspace?workspace:path.join(root,'external-project');
  if(!config.legacyWorkspace)mkdirSync(project);config.project=realpathSync(project);
  config.toolCwd=config.legacyWorkspace||config.projects?'.':config.project;
  const toolPath=name=>config.legacyWorkspace||config.projects?name:path.join(project,name);
  config.patch='*** Begin Patch\n*** Add File: compatibility-proof.txt\n+legacy-patch-ok\n*** End Patch';
  config.powershell=regular(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'));
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','proof.ps1'];
  const inputMarker='QA_INPUT_'+randomBytes(24).toString('hex');
  const proofScript="$ErrorActionPreference='Stop'\n$proof='QA_EXEC_'+[Guid]::NewGuid().ToString('N')\n[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'proof.txt'),$proof)\n[Console]::Out.WriteLine($proof)\n";
  writeFileSync(path.join(project,'input.txt'),inputMarker,{flag:'wx'});writeFileSync(path.join(project,'proof.ps1'),proofScript,{flag:'wx'});
  const env={};for(const name of ['SystemRoot','WINDIR','SystemDrive','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'])if(process.env[name])env[name]=process.env[name];
  ({child:helper,exit:helperExit}=launch(config.helperBinary,formal4510?['--formal-4510']:[],{cwd:workspace,env}));
  let output=Buffer.alloc(0),outputBytes=0;
  helper.stdout.on('data',chunk=>{
    outputBytes+=chunk.length;if(outputBytes>8*1024*1024){fail('QA_HELPER_TOTAL_OUTPUT_LIMIT');return;}
    output=Buffer.concat([output,chunk]);if(output.length>1024*1024){fail('QA_HELPER_FRAME_LIMIT');return;}
    let end;while((end=output.indexOf(10))>=0){const line=output.subarray(0,end);output=output.subarray(end+1);try{
      const frame=JSON.parse(line.toString('utf8'));
      if(frame.kind==='paired'){check(typeof frame.deviceId==='string'&&/^[a-f0-9-]{36}$/.test(frame.deviceId),'QA_DEVICE_ID_INVALID');deviceId=frame.deviceId;if(!config.caPath){const bundledPath=regular(frame.caPath);check(bundledPath.startsWith(tokenRoot+path.sep),"QA_CA_OUTSIDE_TOKEN_ROOT");config.caPath=bundledPath;}}
      else if(frame.kind==='connected')connected=true;
      else if(frame.kind==='message')gatewayMessage(frame.message);
      else if(frame.kind==='closed'){socketRevoked=frame.code===4001&&frame.reason==='DEVICE_REVOKED';if(!socketRevoked)fail('QA_UI_UNEXPECTED_CLOSE');helper.stdin.end();}
      else if(frame.kind==='cleanup')localRemoved=frame.localRemoved===true;
      else fail('QA_HELPER_PROTOCOL_INVALID');
    }catch{fail('QA_HELPER_PROTOCOL_INVALID');}}
  });
  writeHelper({gateway:config.gateway,caPath:config.caPath,code:config.code,tokenRoot,namespace});config.code='';
  await until(()=>deviceId&&connected,25000,'QA_NATIVE_PAIR_TIMEOUT');
  const agentUrl=new URL(config.gateway);agentUrl.pathname='/ws/agent';agentUrl.searchParams.set('deviceId',deviceId);
  ({child:agent,exit:agentExit}=launch(config.agentBinary,['--workspace-root',workspace,'--gateway-url',agentUrl.toString()],{cwd:workspace,env:{...env,YUAN_PLATFORM_NAMESPACE:namespace,YUAN_PLATFORM_CA:config.caPath,YUAN_PLATFORM_DATA_DIR:tokenRoot}}));
  agent.stdout.on('data',()=>{});
  let agentDiagnostic='';agent.stderr.on('data',chunk=>{agentDiagnostic=(agentDiagnostic+chunk.toString('utf8')).slice(-8192);if(/(?:^|\r?\n)Error: "?DEVICE_REVOKED"?\r?(?:\n|$)/.test(agentDiagnostic))agentTerminal=true;});
  const initialized=await request('session.initialize',{clientInfo:{name:'central-live-client-qa',version:'1'}});
  check(typeof initialized?.userAgent==='string'&&initialized.userAgent.includes(marker),'QA_RUNTIME_MARKER_MISSING');
  const catalog=await request('model.list',{limit:100,includeHidden:false});
  check(catalog?.data?.some(model=>model.id===config.model),'QA_MODEL_NOT_LISTED');
  emit({phase:'model-listed',model:config.model});
  let ready=false;const onlineDeadline=Date.now()+20000;
  while(!ready&&Date.now()<onlineDeadline){try{const context=await request('device.workspace.context',{},4000);ready=context?.ok===true;}catch{}if(!ready)await delay(200);if(failure)throw Error(failure);}
  check(ready,'QA_REAL_AGENT_OFFLINE');
  const directPath=config.projects?path.join(project,'input.txt'):toolPath('input.txt');
  const directRead=await request('device.workspace.read_text',{path:directPath});check(directRead?.ok===true&&directRead.result?.content===inputMarker,'QA_REAL_AGENT_READ_FAILED');
  if(formal4510){
    agent.kill();await agentExit;
    ({child:agent,exit:agentExit}=launch(config.agentBinary,['--workspace-root',workspace,'--gateway-url',agentUrl.toString()],{cwd:workspace,env:{...env,YUAN_PLATFORM_NAMESPACE:namespace,YUAN_PLATFORM_CA:config.caPath,YUAN_PLATFORM_DATA_DIR:tokenRoot}}));
    agent.stdout.on('data',()=>{});agentDiagnostic='';agentTerminal=false;
    agent.stderr.on('data',chunk=>{agentDiagnostic=(agentDiagnostic+chunk.toString('utf8')).slice(-8192);if(/(?:^|\r?\n)Error: "?DEVICE_REVOKED"?\r?(?:\n|$)/.test(agentDiagnostic))agentTerminal=true;});
    let reconnected=false;const end=Date.now()+20000;
    while(!reconnected&&Date.now()<end){try{const read=await request('device.workspace.read_text',{path:directPath},2000);reconnected=read?.ok===true&&read.result?.content===inputMarker;}catch{}if(!reconnected)await delay(200);}
    check(reconnected,'QA_REAL_AGENT_RECONNECT_FAILED');emit({phase:'reconnected',deviceId,persistedCredentialVerified:true});
  }
  if(config.legacyWorkspace){
    writeFileSync(path.join(root,'outside.txt'),'outside-sentinel',{flag:'wx'});
    const denied=await request('device.workspace.read_text',{path:'../outside.txt'});
    check(denied?.ok===false&&/WORKSPACE_PATH_DENIED/.test(denied.errorCode??denied.error??''),'QA_LEGACY_BOUNDARY_NOT_ENFORCED');
  }
  emit({phase:'paired',deviceId});
  let evidence,summary;
  if(config.creator){
    const catalog=await request('skill.list');
    const creator=catalog.skills.find(s=>s.id==='yuan-zhou-skill-creator');
    check(creator?.source==='builtin'&&creator.enabled&&creator.automatic,'QA_BUILTIN_CREATOR_MISSING');
    check(!catalog.skills.some(s=>s.name==='skill-creator'&&s.source==='builtin'),'QA_CENTRAL_CREATOR_MIXED');
    const before=new Set(catalog.drafts.map(d=>d.id));
    const name='qa-created-'+randomUUID();
    const thread=await request('conversation.create',{model:config.model});threadId=thread?.thread?.id;
    check(typeof threadId==='string','QA_THREAD_MISSING');
    const prompt=`${config.creator==='explicit'?'$yuan-zhou-skill-creator ':''}请创建一个远舟个人技能，名称 ${name}，用于用户明确要求生成 QA 问候语时输出一句问候。本次方案已经由我确认，不再追问或等待确认：生成 SKILL.md（合法 frontmatter、用途、输入输出、触发条件），references/guide.md（包含测试标记 ${inputMarker}），assets/template.txt（问候模板），scripts/greet.ps1（只输出 Hello QA，说明无参数、输出和失败处理），runtime.json（windows、powershell）。正文引用这些相对路径。必须通过创建技能流程申请已登记的客户端草稿，再用 device_write_file 写入该目录的这五个文件；只可读取创建技能说明和本次草稿，不可访问其他文件。仅生成，不执行任何脚本或命令。生成后提醒在我的技能预览并保存，不能声称已保存。`;
    const turn=await request('conversation.turn.create',{threadId,model:config.model,effort:'low',clientMessageId:randomUUID(),...(config.creator==='explicit'?{skills:[{id:creator.id,revision:creator.revision}]}:{}),input:[{type:'text',text:prompt}]});turnId=turn?.turn?.id;
    await until(()=>turnDone,180000,'QA_MODEL_TURN_TIMEOUT');
    check(turnDone.status==='completed'&&!turnDone.error,'QA_MODEL_TURN_FAILED');
    const calls=[...toolCalls.values()];
    check(calls.some(c=>c.tool==='device_skill_load'&&c.succeeded)&&calls.filter(c=>c.tool==='device_skill_draft'&&c.succeeded).length===1&&calls.filter(c=>c.tool==='device_write_file'&&c.succeeded).length===5,'QA_CREATOR_TOOL_EVIDENCE_MISSING');
    const after=await request('skill.list');
    const drafts=after.drafts.filter(d=>!before.has(d.id));
    check(drafts.length===1&&!after.skills.some(s=>s.name===name),'QA_CREATOR_DRAFT_REGISTRATION_FAILED');
    const draft=drafts[0],localRoot=path.join(process.env.LOCALAPPDATA,'com.centralcodex.localspike','skills-v1');
    check(typeof draft.path==='string'&&path.resolve(draft.path).startsWith(localRoot+path.sep),'QA_SKILL_DRAFT_PATH_INVALID');
    for(const relative of ['SKILL.md','references/guide.md','assets/template.txt','scripts/greet.ps1','runtime.json']){
      const stat=lstatSync(path.join(draft.path,relative));check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0,'QA_CREATOR_CLIENT_FILE_MISSING');
    }
    check(readFileSync(path.join(draft.path,'references/guide.md'),'utf8').includes(inputMarker),'QA_CREATOR_MARKER_MISSING');
    const preview=await request('skill.preview',{id:draft.id});
    const saved=(await request('skill.save',{previewId:preview.previewId})).skill;
    check(saved.name===name,'QA_CREATOR_SAVE_FAILED');
    const history=await request('conversation.read',{threadId,includeTurns:true});
    check(history.thread?.turns?.some(t=>t.id===turnId&&t.status==='completed'),'QA_RESUMED_HISTORY_MISSING');
    await request('skill.remove',{id:saved.id,revision:saved.revision});
    await request('conversation.archive',{threadId});
    evidence={actualLocalAgent:true,builtinCreatorNativeDiscoveryVerified:true,creatorTrigger:config.creator,registeredClientDraftVerified:true,completePackageVerified:true,manualPreviewSaveVerified:true,noScriptExecution:true,turnCompleted:true,skillRemoved:true};
    summary={inputSha256:hash(inputMarker),toolCount:calls.length,marker};
  }else{
  let catalogProject,personalSkill;
  if(config.skills){
    check(!config.legacyWorkspace&&!config.projects&&initialized.platformCapabilities?.skills===true,'QA_SKILL_CAPABILITY_MISSING');
    const draft=(await request('skill.draft',{creationKey:randomUUID()})).draft;
    const localRoot=path.join(process.env.LOCALAPPDATA,'com.centralcodex.localspike','skills-v1');
    check(typeof draft?.path==='string'&&path.resolve(draft.path).startsWith(localRoot+path.sep),'QA_SKILL_DRAFT_PATH_INVALID');
    const name='qa-skill-'+randomUUID();
    mkdirSync(path.join(draft.path,'scripts'));mkdirSync(path.join(draft.path,'references'));
    writeFileSync(path.join(draft.path,'scripts/proof.ps1'),proofScript,{flag:'wx'});
    writeFileSync(path.join(draft.path,'references/input.txt'),inputMarker,{flag:'wx'});
    writeFileSync(path.join(draft.path,'SKILL.md'),`---\nname: ${name}\ndescription: "Authorized client skill deployment proof"\n---\nBefore use call device_skill_load with name ${name}. Let R be its returned CLIENT directory. Read R/references/input.txt with device_workspace_read_text. Execute exactly once device_exec with program ${JSON.stringify(config.powershell)}, args ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",R+"/scripts/proof.ps1"], cwd ${JSON.stringify(config.toolCwd)}. Then read ${JSON.stringify(toolPath('proof.txt'))}. Reply only with the two exact random markers. Do not edit files, inspect other directories, run central commands, or call other tools.\n`,{flag:'wx'});
    const preview=await request('skill.preview',{id:draft.id});
    personalSkill=(await request('skill.save',{previewId:preview.previewId})).skill;
    check((await request('skill.list')).skills.some(s=>s.id===personalSkill.id),'QA_NATIVE_SKILL_DISCOVERY_FAILED');
    emit({phase:'skill-saved',skillId:personalSkill.id,revision:personalSkill.revision});
  }
  if(config.projects){
    check(initialized.platformCapabilities?.projects===true,'QA_PROJECT_CAPABILITY_MISSING');
    catalogProject=(await request('project.save',{name:'项目发布验证',folders:[project,workspace],creationKey:randomUUID()})).project;
    check(catalogProject?.folders[0]===project,'QA_PROJECT_CREATE_FAILED');
  }
  const thread=await request('conversation.create',{model:config.model,...(catalogProject?{projectId:catalogProject.id,projectRevision:catalogProject.revision}:{})});threadId=thread?.thread?.id;check(typeof threadId==='string','QA_THREAD_MISSING');
  if(catalogProject){
    check(thread.thread.clientProject?.folders[0]===project,'QA_PROJECT_SNAPSHOT_MISSING');
    catalogProject=(await request('project.save',{...catalogProject,folders:[workspace,project]})).project;
    // Native Codex persists a new Thread after its first Turn; do not resume an
    // empty Thread. Executing below must still use the captured old directory.
  }
  const prompt=`This is an authorized, isolated client QA project ${config.legacyWorkspace?'inside the legacy workspace':'outside the default output directory'}. Perform exactly: 1. device_workspace_read_text path ${JSON.stringify(toolPath('input.txt'))}. 2. device_exec with ${JSON.stringify({program:config.powershell,args,cwd:config.toolCwd})}. Run that command exactly once. 3. device_workspace_read_text path ${JSON.stringify(toolPath('proof.txt'))}. ${config.legacyWorkspace?'4. Call device_workspace_apply_patch exactly once with this patch (approval is provided): '+JSON.stringify(config.patch)+'. ':''}Final answer contains only the two exact markers read from input.txt and proof.txt. Do not call other tools, write/edit files except the explicitly requested patch, inspect other directories, run central commands, or rerun the command. The pre-created script generates its random marker only when Local Agent runs it.`;
  const turn=await request('conversation.turn.create',{threadId,model:config.model,effort:'low',...(personalSkill?{clientMessageId:randomUUID(),skills:[{id:personalSkill.id,revision:personalSkill.revision}]}:{}),input:[{type:'text',text:personalSkill?`$${personalSkill.name} Follow this selected personal skill exactly. Its resources are on the client. Run its proof script once as instructed and return the two markers.`:prompt}]});turnId=turn?.turn?.id;
  await until(()=>turnDone,180000,'QA_MODEL_TURN_TIMEOUT');
  check(turnDone.status==='completed'&&!turnDone.error,'QA_MODEL_TURN_FAILED');
  const reads=[...toolCalls.values()].filter(call=>call.tool==='device_workspace_read_text'&&call.done&&call.succeeded),execs=[...toolCalls.values()].filter(call=>call.tool==='device_exec');
  check(reads.length>=2&&execs.length===1&&execs[0].done&&execs[0].succeeded&&execs[0].exitCode===0,'QA_MODEL_TOOL_EVIDENCE_MISSING');
  const proofPath=path.join(project,'proof.txt'),proofStat=lstatSync(proofPath);check(proofStat.isFile()&&!proofStat.isSymbolicLink()&&proofStat.nlink===1&&proofStat.size<=128,'QA_PROOF_FILE_UNSAFE');
  const proof=readFileSync(proofPath,'utf8');check(/^QA_EXEC_[a-f0-9]{32}$/.test(proof)&&assistant.includes(inputMarker)&&assistant.includes(proof),'QA_RANDOM_PROOF_NOT_REPRODUCED');
  check(readFileSync(path.join(project,'proof.ps1'),'utf8')===proofScript,'QA_PROOF_SCRIPT_CHANGED');
  evidence={actualLocalAgent:true,externalProjectVerified:!config.legacyWorkspace,legacyWorkspaceVerified:!!config.legacyWorkspace,defaultOutputDirectory:workspace,projectDirectory:project,workspaceReadVerified:true,modelToolReadVerified:true,modelToolExecVerified:true,randomProofVerified:true,turnCompleted:true,runtimeMarkerVerified:true};
  summary={inputSha256:hash(inputMarker),proofSha256:hash(proof),toolReadCount:reads.length,toolExecCount:execs.length,marker};
  if(config.legacyWorkspace){
    check(config.patchApproved===true&&readFileSync(path.join(project,'compatibility-proof.txt'),'utf8')==='legacy-patch-ok\n','QA_LEGACY_PATCH_FAILED');
    const patches=[...toolCalls.values()].filter(c=>c.tool==='device_workspace_apply_patch');
    check(patches.length===1&&patches[0].done&&patches[0].succeeded,'QA_LEGACY_PATCH_RECEIPT_MISSING');
    evidence.legacyPatchVerified=true;
  }
  const resumed=await request('conversation.resume',{threadId});
  if(catalogProject)check(resumed.thread?.clientProject?.folders[0]===project,'QA_PROJECT_SNAPSHOT_CHANGED');
  const history=await request('conversation.read',{threadId,includeTurns:true});
  check(history.thread?.turns?.some(t=>t.id===turnId&&t.status==='completed'),'QA_RESUMED_HISTORY_MISSING');
  evidence.resumeHistoryVerified=true;
  if(personalSkill){
    const calls=[...toolCalls.values()].filter(c=>c.tool==='device_skill_load');
    check(calls.length===1&&calls[0].succeeded,'QA_SKILL_LOAD_NOT_VERIFIED');
    const recorded=JSON.stringify(history.thread.turns.find(t=>t.id===turnId)).replace(/\\+/g,'/');
    check(recorded.includes('scripts/proof.ps1')&&recorded.includes('references/input.txt'),'QA_SKILL_RESOURCES_NOT_USED');
    await request('skill.remove',{id:personalSkill.id,revision:personalSkill.revision});
    check(!(await request('skill.list')).skills.some(s=>s.id===personalSkill.id),'QA_SKILL_REMOVE_FAILED');
    evidence.managedSkillNativeInputVerified=true;evidence.skillResourceExecutionVerified=true;evidence.skillRemoved=true;
  }
  if(catalogProject){
    await request('project.remove',{id:catalogProject.id,revision:catalogProject.revision});
    check(!(await request('project.list')).projects.some(p=>p.id===catalogProject.id),'QA_PROJECT_REMOVE_FAILED');
    const retained=await request('conversation.resume',{threadId});
    check(retained.thread?.clientProject?.folders[0]===project,'QA_PROJECT_REMOVAL_LOST_SNAPSHOT');
    evidence.projectCatalogVerified=true;evidence.immutableProjectSnapshotVerified=true;evidence.relativeProjectExecutionVerified=true;
  }
  await request('conversation.archive',{threadId});
  }
  completed=true;emit({phase:'completed',deviceId,evidence,summary});
  await until(()=>socketRevoked&&localRemoved,35000,'QA_REVOKE_NOT_OBSERVED');
  let exited=false,agentResult;agentExit.then(result=>{agentResult=result;exited=true;});await until(()=>exited,10000,'QA_AGENT_DID_NOT_EXIT');
  check(!agentResult.spawnFailed&&agentResult.signal===null&&agentTerminal,'QA_AGENT_REVOKE_EXIT_UNCONFIRMED');
  const helperResult=await helperExit;check(helperResult.code===0,'QA_HELPER_CLEANUP_FAILED');
  writeFileSync(config.output,JSON.stringify({passed:true,evidence,summary,deviceId,agentExited:true,revoked:true,localTokenRemoved:true,postExecutionVerificationOnly:true,realRemoteDeviceVerified:formal4510,formal4510Modified:formal4510},null,2),{flag:'wx'});
  emit({phase:'revoked',deviceId,agentExited:true});
}catch(error){
  // Diagnostic persistence must not prevent the controller from revoking the test device.
  try{if(config?.output&&!existsSync(config.output))writeFileSync(config.output,JSON.stringify({passed:false,assistant,turnDone,tools:[...toolCalls.values()]},null,2),{flag:'wx'});}catch{}
  const code=/^QA_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'QA_LIVE_CLIENT_FAILED';emit({phase:'failed',code});process.exitCode=1;
}finally{clearTimeout(watchdog);await cleanup();process.stdin.pause();}
