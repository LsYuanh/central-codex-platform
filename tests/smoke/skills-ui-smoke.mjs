// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual Tauri WebView; use a debug binary built with the isolated QA identifier.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
export async function runSkillsUi({root,client,bundle}){
 const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
 const output=join(root,'ui');await mkdir(output);
 const env={...process.env,WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19337',CODEXIA_WORKSPACE_ROOT:client.workspace,CODEXIA_LOCAL_AGENT_PATH:resolve('target/debug/local-agent.exe')};delete env.CODEXIA_GATEWAY_AGENT_URL;
 const app=spawn(resolve('target/debug/desktop-spike.exe'),[],{env,windowsHide:true,stdio:'ignore'});let browser,page,closed=false;app.once('exit',()=>closed=true);
 try{
  let endpoint;for(let i=0;i<100;i++){try{endpoint=(await (await fetch('http://127.0.0.1:19337/json/version')).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}await delay(150);}assert(endpoint);
  browser=await chromium.connectOverCDP(endpoint);for(let i=0;i<80;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('127.0.0.1:1420'));if(page)break;await delay(100);}assert(page);
  const input=page.getByRole('textbox',{name:'一体配对码'});
  if(!await input.isVisible())await page.getByRole('button',{name:'打开连接设置',exact:true}).click();
  await input.fill(bundle);bundle='';await page.getByRole('button',{name:'配对并连接',exact:true}).click();
  await page.getByText(/配置已保存并应用。中央网关已连接/).waitFor({timeout:60000});
  await page.getByRole('button',{name:'我的技能',exact:true}).click();
  await page.getByText('skill-proof',{exact:true}).waitFor();
  await page.getByRole('button',{name:'查看',exact:true}).click();await page.getByRole('dialog').waitFor();
  assert.match(await page.locator('.skill-file-content').innerText(),/Use scripts/);
  await page.locator('.skill-file-select select').selectOption('scripts/proof.ps1');await page.getByText('Write-Output "CLIENT_SKILL_EXECUTION"',{exact:true}).waitFor();
  for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:join(output,'detail-'+theme+'.png')});}
  await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);
  await page.getByRole('button',{name:'创建技能',exact:true}).click();
  await page.getByRole('textbox',{name:'发送消息'}).waitFor();
  const prompt=await page.getByRole('textbox',{name:'发送消息'}).innerText();assert.match(prompt,/个人技能/);
  await page.getByRole('button',{name:'我的技能',exact:true}).click();
  const state=JSON.parse(await readFile(join(root,'personal-skills.json'),'utf8')),draft=state.drafts.find(d=>d.path&&prompt.includes(JSON.stringify(d.path)));assert(draft);
  await writeFile(join(draft.path,'SKILL.md'),'---\nname: ui-proof\ndescription: "界面创建保存验证"\n---\nOnly use client tools.\n');
  await page.getByRole('button',{name:'预览并保存',exact:true}).click();await page.getByRole('heading',{name:'预览 · ui-proof'}).waitFor();
  await page.screenshot({path:join(output,'preview.png')});await page.getByRole('button',{name:'确认保存',exact:true}).click();await page.getByText('ui-proof',{exact:true}).waitFor();
  const row=page.locator('.skill-row').filter({hasText:'ui-proof'});await row.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await row.count(),1);
  await page.screenshot({path:join(output,'skills-list.png')});
  await page.getByRole('button',{name:'返回应用',exact:true}).click();await page.locator('summary[aria-label="选择技能"]').click();await page.getByRole('button',{name:/^ui-proof/}).click();assert.equal(await page.locator('.composer-skill-mention[data-skill-name="ui-proof"]').count(),1);
  await page.screenshot({path:join(output,'composer.png')});
  console.log('SKILLS_NATIVE_UI_OK: actual Tauri, pairing, list, resource preview, create draft, save, delete cancellation, composer selection, light/dark');
 }catch(error){if(page&&!page.isClosed()){await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-2200));}throw error;}
 finally{
  if(page&&!page.isClosed())await page.evaluate(async()=>{const view=await window.__TAURI_INTERNALS__.invoke('desktop_config');await window.__TAURI_INTERNALS__.invoke('platform_account',{gateway:view.saved.gatewayUrl,action:'disconnect',input:{}});}).catch(()=>{});
  await browser?.close();if(!closed)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${app.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});for(let i=0;i<30&&!closed;i++)await delay(100);if(!closed)app.kill();
 }
}
