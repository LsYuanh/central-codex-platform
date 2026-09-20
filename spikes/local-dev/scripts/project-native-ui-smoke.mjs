// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Opt-in existing Windows debug executable + Vite; isolated WebView storage and Agent.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

export async function runNativeProjectUi({port,paths,root,client}) {
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
  const output=resolve('target/project-ui-qa');await mkdir(output,{recursive:true});
  let occupied=false;
  try {occupied=(await fetch('http://127.0.0.1:19336/json/version',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
  assert(!occupied,'Native QA port 19336 is already occupied; do not attach another app');
  const app=spawn(process.env.PROJECT_DESKTOP_BINARY??resolve('target/debug/desktop-spike.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,
    WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19336',
    CODEXIA_GATEWAY_AGENT_URL:`ws://127.0.0.1:${port}/ws/agent?userId=project-native&deviceId=project-native`,
    CODEXIA_WORKSPACE_ROOT:paths.output,CODEXIA_LOCAL_AGENT_PATH:process.env.AGENT_SMOKE_BINARY??resolve('target/debug/local-agent.exe')}});
  let browser,page,closed=false;app.once('exit',()=>{closed=true;});
  try {
    let endpoint;for(let i=0;i<100;i++){try{endpoint=(await (await fetch('http://127.0.0.1:19336/json/version')).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}await delay(150);}
    assert(endpoint,'Native WebView debugger missing');browser=await chromium.connectOverCDP(endpoint);
    for(let i=0;i<80;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>/localhost|127\.0\.0\.1/.test(p.url()));if(page)break;await delay(100);}
    assert(page,'Native app page missing');
    const view=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('desktop_config'));
    assert.equal(view.effective.deviceId,'project-native');assert.equal(view.effective.workspaceRoot.toLowerCase(),paths.output.toLowerCase());
    const request=await client(view.effective.userId,'project-native');await request('session.initialize');
    let project;for(let i=0;i<50;i++){try{project=(await request('project.save',{name:'客户端项目',folders:[paths.b,paths.extra]})).project;break;}catch(e){if(!String(e).includes('AGENT_OFFLINE'))throw e;await delay(100);}}
    assert(project,'Native Agent did not connect');
    await page.getByRole('button',{name:'项目详情：客户端项目'}).focus();
    await page.getByRole('button',{name:'项目详情：客户端项目'}).click();
    await page.getByRole('button',{name:'编辑项目',exact:true}).click();
    assert.equal(await page.locator('.project-manual-path').count(),0,'Native must use folder picker');
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';});await delay(170);
    await page.screenshot({path:join(output,'native-edit-light.png')});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await delay(170);
    await page.screenshot({path:join(output,'native-edit-dark.png')});
    await page.getByRole('textbox',{name:'项目名称',exact:true}).fill('客户端项目已编辑');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await page.getByRole('button',{name:'客户端项目已编辑',exact:true}).waitFor();
    console.log('PROJECT_NATIVE_UI_OK: actual Tauri WebView, managed real Agent, edit/save, light/dark, native picker entry');
  } catch(error){if(page&&!page.isClosed()){await page.screenshot({path:join(output,'native-failure.png')}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(0,2000));}throw error;}
  finally {
    await browser?.close().catch(()=>{});
    if(!closed)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true,timeout:10000});
    for(let i=0;i<50&&!closed;i++)await delay(100);
    if(!closed)app.kill();
  }
}
