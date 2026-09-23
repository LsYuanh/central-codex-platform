// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/model-picker-ui-'));
const efforts=['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}));
const models=[{id:'gpt-6-astra',model:'gpt-6-astra',displayName:'GPT-6-Astra',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:efforts,serviceTiers:[{id:'priority',name:'Fast'},{id:'flex',name:'Flex'}]},
 {id:'standard-only',model:'standard-only',displayName:'Standard only',supportedReasoningEfforts:efforts,serviceTiers:[]}];
const errors=[],calls=[];
const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>gateway.once('listening',r));
gateway.on('connection',socket=>socket.on('message',raw=>{
 const q=JSON.parse(String(raw));if(q.type!=='request')return;calls.push(q.operation);
 let data={},error;
 switch(q.operation){
  case 'session.initialize':data={userAgent:'model-picker-qa'};break;
  case 'model.list':data={data:models};break;
  case 'conversation.list':data={data:[]};break;
  default:error=`Unexpected operation: ${q.operation}`;
 }
 socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:!error,...(error?{error}:{data})}));
}));
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await server.listen();
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const page=await browser.newPage({viewport:{width:1200,height:760}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(url=>{if(!localStorage.getItem('codexia.desktop.settings.v1'))localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'}));},`ws://127.0.0.1:${gateway.address().port}/ws?userId=qa&deviceId=qa`);
 await page.goto(server.resolvedUrls.local[0]);await page.locator('.connection-summary').filter({hasText:'已连接'}).waitFor();
 const trigger=page.locator('.model-picker > summary'),popover=page.locator('.model-picker-popover'),badge=page.locator('.model-picker-fast');
 const section=index=>page.locator('.model-picker-submenu').nth(index);
 const speed=async name=>{if(await section(2).getAttribute('open')===null)await section(2).locator('summary').click();await section(2).getByRole('button',{name,exact:true}).click();};
 await page.locator('[contenteditable=true]').fill('Preserve this draft');const before=calls.length;
 assert.equal(await badge.count(),0);await trigger.click();assert.equal(Math.round((await popover.boundingBox()).width),260);
 await section(1).locator('summary').click();assert.equal(await popover.getByText('更快消耗使用额度',{exact:true}).count(),0);
 assert.equal(await section(1).getByRole('button').count(),6);
 assert.equal(Math.round((await section(1).getByRole('button').first().boundingBox()).height),28);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.screenshot({path:join(output,`effort-${theme}.png`)});
 }
 await speed('Fast');await badge.waitFor();assert.match(await trigger.getAttribute('aria-label'),/Fast/);
 assert.equal(await page.locator('[contenteditable=true]').innerText(),'Preserve this draft');assert.equal(calls.length,before);
 await page.screenshot({path:join(output,'speed-fast.png')});await page.keyboard.press('Escape');
 await page.screenshot({path:join(output,'composer-fast.png')});assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 await page.reload();await badge.waitFor();await trigger.click();await speed('Flex');await badge.waitFor({state:'hidden'});
 await speed('Fast');await badge.waitFor();await speed('标准');await badge.waitFor({state:'hidden'});
 await speed('Fast');await section(0).locator('summary').click();await section(0).getByRole('button',{name:'Standard only',exact:true}).click();await badge.waitFor({state:'hidden'});
 await section(0).getByRole('button',{name:'GPT-6-Astra · 默认',exact:true}).click();assert.equal(await badge.count(),0);
 await speed('Fast');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#desktop-language').click();await page.getByRole('option',{name:'English',exact:true}).click();
 await page.getByRole('button',{name:'Back to app',exact:true}).click();await trigger.click();await section(1).locator('summary').click();
 assert.match(await trigger.getAttribute('aria-label'),/Accelerated mode: Fast/);assert(!await popover.innerText().then(t=>t.includes('Uses your allowance faster')));
 await page.setViewportSize({width:400,height:700});const box=await popover.boundingBox();assert(box.x>=0&&box.x+box.width<=400);assert.equal(Math.round(box.width),260);
 await page.screenshot({path:join(output,'effort-en-narrow.png')});
 const touch=await browser.newPage({viewport:{width:400,height:700},hasTouch:true});
 await touch.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url})),`ws://127.0.0.1:${gateway.address().port}/ws?userId=touch&deviceId=touch`);
 await touch.goto(server.resolvedUrls.local[0]);await touch.locator('.model-picker-name').filter({hasText:'GPT-6-Astra'}).waitFor();await touch.locator('.model-picker > summary').click();
 await touch.locator('.model-picker-submenu').nth(1).locator('summary').click();
 const sizes=await touch.locator('.model-picker-row,.model-picker-submenu[open] button').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));assert(sizes.every(height=>height>=44));
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'MODEL_PICKER_UI_OK',output}));
}finally{await browser.close();for(const socket of gateway.clients)socket.terminate();await new Promise(r=>gateway.close(r));await server.close();}
