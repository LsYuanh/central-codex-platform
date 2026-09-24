// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
async function chooseLanguage(page, label) {
 await page.locator('#desktop-language').click();
 await page.getByRole('option',{name:label,exact:true}).click();
}
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/language-ui-'));
const errors=[],calls=[];let connections=0;
const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>gateway.once('listening',r));
gateway.on('connection',socket=>{connections++;socket.on('message',raw=>{
 const q=JSON.parse(String(raw));if(q.type!=='request')return;calls.push(q.operation);
 let data={},error;
 switch(q.operation){
  case 'session.initialize':data={userAgent:'language-qa',platformCapabilities:{projects:true,skills:true}};break;
  case 'model.list':data={data:[]};break;
  case 'project.list':data={projects:[]};break;
  case 'skill.list':data={skills:[],drafts:[]};break;
  case 'conversation.list':data={data:q.payload.archived?[{id:'archive-1',name:'用户自己的标题',updatedAt:1758540000,archived:true}]:[]};break;
  default:error=`Unexpected fixture operation: ${q.operation}`;
 }
 socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:!error,...(error?{error}:{data})}));
});});
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await server.listen();
const browser=await chromium.launch({headless:true,channel:'msedge'});
let qaServer;
try {
 const page=await browser.newPage({viewport:{width:1224,height:816}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(url=>{if(!localStorage.getItem('codexia.desktop.settings.v1'))localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'}));},`ws://127.0.0.1:${gateway.address().port}/ws?userId=qa&deviceId=qa`);
 const url=server.resolvedUrls.local[0];await page.goto(url);
 await page.locator('.connection-summary').filter({hasText:'已连接'}).waitFor();
 for(const socket of gateway.clients)socket.send(JSON.stringify({type:'event',name:'turn/started',data:{threadId:'background-language-qa',turn:{id:'turn-language-qa'}}}));
 await page.locator('.conversation-list-heading small').filter({hasText:'1 个进行中'}).waitFor();
 await page.locator('[contenteditable=true]').fill('我的草稿 stays unchanged');
 await page.getByRole('button',{name:'设置',exact:true}).click();
 const picker=page.locator('#desktop-language');await picker.waitFor();
 const before=connections,requests=calls.length;
 await chooseLanguage(page,'English');await page.getByRole('heading',{name:'General & connection',exact:true}).waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.equal(connections,before);assert.equal(calls.length,requests,'Language switch must not issue RPCs');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.screenshot({path:join(output,`general-en-${theme}.png`)});
  await picker.click();await page.getByRole('option',{name:'English',exact:true}).waitFor();
  assert.equal(await page.getByRole('option',{name:'English',exact:true}).getAttribute('aria-selected'),'true');
  await page.screenshot({path:join(output,`language-menu-${theme}.png`)});
  await page.keyboard.press('Escape');assert.equal(await picker.getAttribute('aria-expanded'),'false');
 }
 const rows=await page.locator('.theme-settings-card .settings-field').evaluateAll(items=>items.map(item=>({height:item.getBoundingClientRect().height,top:getComputedStyle(item).paddingTop,bottom:getComputedStyle(item).paddingBottom})));
 assert.equal(rows.length,2);assert.equal(rows[0].height,rows[1].height);assert.equal(rows[0].top,rows[0].bottom);assert.equal(rows[1].top,rows[1].bottom);
 await picker.click();await page.getByRole('heading',{name:'General & connection',exact:true}).click();assert.equal(await picker.getAttribute('aria-expanded'),'false');
 await picker.focus();
 await page.keyboard.press('Home');await page.keyboard.press('Enter');await page.getByRole('heading',{name:'常规与连接',exact:true}).waitFor();
 await page.keyboard.press('End');await page.keyboard.press('Enter');await page.getByRole('heading',{name:'General & connection',exact:true}).waitFor();
 await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowUp');await page.keyboard.press('Escape');assert.equal(await picker.innerText(),'English');
 await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert.equal(await picker.getAttribute('aria-expanded'),'false');
 await page.getByRole('button',{name:'Archived chats',exact:true}).click();
 await page.getByText('用户自己的标题',{exact:true}).waitFor();await page.getByText('1 chat',{exact:true}).waitFor();
 assert.match(await page.locator('time').innerText(),/September/);
 await page.getByRole('button',{name:'Delete all',exact:true}).click();
 await page.getByRole('dialog',{name:'Delete all archived chats?'}).waitFor();
 await page.screenshot({path:join(output,'delete-en.png')});await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'My skills',exact:true}).click();await page.getByRole('heading',{name:'My skills',exact:true}).waitFor();
 await page.screenshot({path:join(output,'skills-en.png')});
 await page.getByRole('button',{name:'Updates',exact:true}).click();await page.getByRole('heading',{name:'Updates',exact:true}).waitFor();
 await page.screenshot({path:join(output,'updates-en.png')});
 await page.getByRole('button',{name:'Back to app',exact:true}).click();assert.equal(await page.locator('[contenteditable=true]').innerText(),'我的草稿 stays unchanged');
 await page.locator('.conversation-list-heading small').filter({hasText:'1 running'}).waitFor();
 for(const socket of gateway.clients)socket.send(JSON.stringify({type:'event',name:'turn/completed',data:{threadId:'background-language-qa',turn:{id:'turn-language-qa',status:'completed'}}}));
 await page.locator('.conversation-list-heading small').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'General & connection',exact:true}).click();
 await page.setViewportSize({width:400,height:700});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(output,'general-en-narrow.png')});
 await picker.click();await page.screenshot({path:join(output,'language-menu-narrow.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.keyboard.press('Escape');
 await page.setViewportSize({width:1224,height:816});await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();
 assert.equal(await picker.innerText(),'English');
 // Failure is visible and must preserve the previously selected language.
 await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='yuanzhou.desktop.language.v1')throw new Error('blocked');return window.originalSetItem.call(this,key,value);};});
 await chooseLanguage(page,'简体中文');await page.getByRole('alert').filter({hasText:'Language preference could not be confirmed'}).waitFor();assert.equal(await picker.innerText(),'English');
 await page.evaluate(()=>Storage.prototype.setItem=window.originalSetItem);await chooseLanguage(page,'简体中文');await page.getByRole('heading',{name:'常规与连接',exact:true}).waitFor();
 await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
 // Independent components also react to language changes; no root remount required.
 await writeFile(join(output,'components.html'),`<html><body><div id="root"></div><script type="module" src="/@fs/${resolve('tests/fixtures/language-qa.tsx').replaceAll('\\','/')}"></script></body></html>`);
 qaServer=await createServer({root:output,configFile:false,plugins:[react()],cacheDir:join(output,'.vite-components'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await qaServer.listen();
 await page.goto(`${qaServer.resolvedUrls.local[0]}components.html`);
 await page.getByText('Trigger notices',{exact:true}).click();await page.getByTestId('notice').filter({hasText:'技能 我的技能'}).waitFor();
 await chooseLanguage(page,'English');await page.getByTestId('notice').filter({hasText:'Skill 我的技能 changed'}).waitFor();
 assert.equal(await page.getByTestId('native').innerText(),'Local Agent channel unavailable: 磁盘错误. Apply settings again');
 assert.equal(await page.getByTestId('raw').innerText(),'未知远端错误：原文保留');
 assert.equal(await page.getByTestId('one').innerText(),'1 chat');assert.equal(await page.getByTestId('many').innerText(),'2 chats');
 await page.locator('.result-notice').filter({hasText:'JSON incomplete or invalid; raw text preserved'}).waitFor();
 await page.getByText('用户原文：设置',{exact:true}).waitFor();await page.getByText('打印中文',{exact:true}).waitFor();
 const unresolved=await page.locator('[data-catalogue]').evaluateAll(rows=>rows.filter(row=>row.textContent.includes('{{')).map(row=>row.getAttribute('data-catalogue')));assert.deepEqual(unresolved,[]);
 const update=page.getByRole('button',{name:'Update: version 9.0.0'});await update.hover();await page.waitForTimeout(250);assert.equal(Math.round((await update.boundingBox()).width),64);
 await chooseLanguage(page,'简体中文');await page.getByTestId('notice').filter({hasText:'技能 我的技能'}).waitFor();
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'LANGUAGE_UI_OK',output,checks:['switch without RPC/reconnect','draft retained','Chinese user content untouched','restart persistence','storage failure retry','existing notices and native errors switch','raw remote errors untouched','plural/date formats','memoized JSON locale refresh','catalogue interpolation','light/dark/narrow layouts']}));
} finally {await browser.close();for(const socket of gateway.clients)socket.terminate();await new Promise(r=>gateway.close(r));await server.close();await qaServer?.close();}
