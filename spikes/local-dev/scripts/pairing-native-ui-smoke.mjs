// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Opt-in Windows Wry acceptance. Build with the isolated QA identifier first.
// SSH is used only to issue/revoke the synthetic operator test device.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const sendTurn=process.argv.includes('--send-turn');
const executionLayout=process.argv.includes('--execution-layout');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,executionLayout?'target/desktop-execution-layout-20260911':sendTurn?'target/desktop-first-send-20260911':'target/pairing-native-ui');
const workspace=path.join(output,'workspace');await mkdir(workspace,{recursive:true});
const executable=path.join(root,'target/desktop-package/x86_64-pc-windows-msvc/debug/desktop-spike.exe');
const remote='/Users/operator/central-codex-platform';
function management(action,id=''){
  if(id&&!/^[a-f0-9-]{36}$/.test(id))throw Error('INVALID_QA_DEVICE');
  const bytes=execFileSync('ssh.exe',['-i',path.join(process.env.USERPROFILE,'.ssh/id_ed25519'),'-o','BatchMode=yes','operator@192.0.2.10',`${remote}/artifacts/macos-tools/node/bin/node ${remote}/spikes/local-dev/scripts/macos-formal-management.mjs ${action}${id?' '+id:''}`],{windowsHide:true,timeout:30000,maxBuffer:131072});
  try{return JSON.parse(bytes);}finally{bytes.fill(0);}
}
const env={...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19331',CODEXIA_WORKSPACE_ROOT:workspace,CODEXIA_LOCAL_AGENT_PATH:path.join(root,'target/debug/local-agent.exe')};
delete env.CODEXIA_GATEWAY_AGENT_URL;
const app=spawn(executable,[],{env,windowsHide:true,stdio:['ignore','ignore','ignore']});
let browser,page,deviceId,conversationEvidence,layoutEvidence,passed=false,closed=false;
app.once('exit',()=>{closed=true;});
try{
  let endpoint;for(let n=0;n<100;n++){try{const response=await fetch('http://127.0.0.1:19331/json/version');endpoint=(await response.json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}await delay(250);}
  assert(endpoint,'QA WebView debugger missing');browser=await chromium.connectOverCDP(endpoint);
  for(let n=0;n<80;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));if(page)break;await delay(250);}
  assert(page,'QA WebView page missing');
  const initial=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('desktop_config'));
  assert(initial.effective.workspaceRoot.toLowerCase()===workspace.toLowerCase(),'QA workspace boundary missing');
  const input=page.locator('input[aria-label="一体配对码"]');
  if(!await input.isVisible()){
    const connection=page.getByRole('button',{name:'打开连接设置',exact:true});
    if(await connection.isVisible())await connection.click();
    else await page.getByRole('button',{name:'设置',exact:true}).click();
  }
  const unpair=page.getByRole('button',{name:'取消本机配对',exact:true});
  if(await unpair.isVisible()){await unpair.click();await page.getByText(/已取消本机配对/).waitFor({timeout:30000});}
  await input.waitFor({timeout:20000});
  await page.screenshot({path:path.join(output,'before.png'),fullPage:true});
  const pair=management('pair-bundle');await input.fill(pair.code);pair.code='';
  await page.getByRole('button',{name:'配对并连接',exact:true}).click();
  await page.getByText(/配置已保存并应用。中央网关已连接/).waitFor({timeout:60000});
  const view=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('desktop_config'));
  const status=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('platform_account',{gateway:'wss://192.0.2.10:4510/ws',action:'status',input:{}}));
  deviceId=status.deviceId;assert.equal(view.effective.workspaceRoot.toLowerCase(),workspace.toLowerCase());
  assert.equal(view.effective.deviceId,deviceId);assert(view.hasSaved&&view.running);
  assert(status.paired&&status.remoteAvailable);assert.equal(status.deviceId,deviceId);
  await page.getByText(/配置已保存并应用。中央网关已连接/).waitFor({timeout:60000});
  await page.screenshot({path:path.join(output,'paired.png'),fullPage:true});
  if(sendTurn||executionLayout){
    // Observe request metadata only; every call still goes through the real
    // native TLS socket. Never retain pairing codes or credential responses.
    await page.evaluate(()=>{
      const original=JSON.stringify;
      window.__qaConversationFrames=[];
      JSON.stringify=(frame,...rest)=>{
        if(frame?.type==='request'&&['conversation.create','conversation.turn.create'].includes(frame.operation)){
          window.__qaConversationFrames.push({operation:frame.operation,keys:Object.keys(frame.payload??{}),threadId:frame.payload?.threadId,model:frame.payload?.model,effort:frame.payload?.effort});
        }
        return original(frame,...rest);
      };
    });
    await page.getByRole('button',{name:'返回应用',exact:true}).click();
    await page.getByRole('button',{name:'新对话',exact:true}).first().click();
    await page.locator('summary[aria-label="切换模型、推理强度和速度"]').click();
    await page.locator('summary.model-picker-row').filter({hasText:/^模型/}).click();
    await page.getByRole('button',{name:/^GPT-5\.6-Sol/}).click();
    await page.locator('summary.model-picker-row').filter({hasText:/^推理强度/}).click();
    await page.getByRole('button',{name:/^high(?:✓)?$/}).click();
    await page.locator('summary[aria-label="切换模型、推理强度和速度"]').click();
    if(executionLayout){
      const {verifyExecutionLayout}=await import('./desktop-execution-layout-check.mjs');
      layoutEvidence=await verifyExecutionLayout(page,output,workspace);
    }else{
    const replies=[];
    for(let round=1;round<=2;round++){
      const marker=`YUANUIREPLY${Date.now()}ROUND${round}`;
      await page.getByRole('textbox',{name:'发送消息',exact:true}).fill(`请只回复 ${marker}，不需要执行任何工具。`);
      await page.getByRole('button',{name:'发送',exact:true}).click();
      await page.waitForFunction(expected=>{
        const error=document.querySelector('.error-banner');
        if(error?.textContent?.includes('REMOTE_POLICY_OVERRIDE'))throw Error(error.textContent);
        return [...document.querySelectorAll('.bubble-assistant .bubble-content')].some(node=>node.textContent.includes(expected))&&!document.querySelector('button[aria-label="停止当前任务"]');
      },marker,{timeout:180000});
      assert(!/REMOTE_POLICY_OVERRIDE|任务失败/.test(await page.locator('body').innerText()));
      replies.push(marker);
      console.log(JSON.stringify({uiReplyCompleted:round,model:'gpt-5.6-sol',effort:'high'}));
    }
    const frames=await page.evaluate(()=>window.__qaConversationFrames);
    const creates=frames.filter(frame=>frame.operation==='conversation.create');
    const turns=frames.filter(frame=>frame.operation==='conversation.turn.create');
    assert.equal(creates.length,1,'Expected one new conversation');
    assert.equal(turns.length,2,'Expected first send and follow-up');
    assert(turns[0].threadId&&turns[0].threadId===turns[1].threadId,'Follow-up changed conversation');
    for(const frame of frames){
      assert(!frame.keys.some(key=>['serviceName','cwd','config','sandbox','developerInstructions','dynamicTools'].includes(key)),'Client sent a gateway-owned field');
      assert.equal(frame.model,'gpt-5.6-sol');
    }
    assert(turns.every(frame=>frame.effort==='high'));
    conversationEvidence={firstSend:true,followUp:true,model:'gpt-5.6-sol',effort:'high',replies,frames};
    await page.screenshot({path:path.join(output,'conversation.png'),fullPage:true});
    }
    await page.getByRole('button',{name:'设置',exact:true}).click();
  }
  management('revoke',deviceId);
  await page.getByRole('button',{name:'取消本机配对',exact:true}).click();
  await page.getByText(/已取消本机配对/).waitFor({timeout:30000});
  passed=true;
}catch(error){
  if(page&&!page.isClosed()){await page.screenshot({path:path.join(output,'failed.png'),fullPage:true}).catch(()=>{});console.log((await page.locator('body').innerText().catch(()=>'' )).slice(-5000));}
  throw error;
}finally{
  if(deviceId&&!passed){try{management('revoke',deviceId);}catch{}}
  await browser?.close().catch(()=>{});
  if(!closed)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true,timeout:10000});
  for(let n=0;n<100&&!closed;n++)await delay(100);
  if(!closed)app.kill();
  const report={passed,normalWindowClose:closed,deviceId,workspace,syntheticProfile:'com.centralcodex.harnessqa.bundleui20260911',conversationEvidence,layoutEvidence};
  await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
