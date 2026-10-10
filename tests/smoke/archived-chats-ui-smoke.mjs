// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {loadPlaywright} from '../support/playwright.mjs';
// Real App and adapter with an isolated loopback fixture; no user history is deleted.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await loadPlaywright();
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/archived-chats-ui-'));
const project={id:'project-qa',name:'设计项目',folders:['C:\\qa'],revision:1};
let rows=Array.from({length:102},(_,i)=>({id:`archive-${i}`,name:i===101?'第二页项目聊天':i===0?'无项目聊天':`历史聊天 ${i}`,updatedAt:1758540000-i*60,archived:true,clientProject:i===101?project:undefined}));
const calls=[],unexpected=[],errors=[];let pageMode='normal',deleteMode='partial',pendingPage;
const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>gateway.once('listening',r));
gateway.on('connection',socket=>socket.on('message',raw=>{
 const q=JSON.parse(String(raw));if(q.type!=='request')return;calls.push(q);
 let data={},error;
 const reply=()=>socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:!error,...(error?{error}:{data})}));
 switch(q.operation){
  case 'session.initialize':data={userAgent:'archive-qa',platformCapabilities:{projects:true}};break;
  case 'model.list':data={data:[]};break;
  case 'project.list':data={projects:[project]};break;
  case 'conversation.list':{
   if(!q.payload.archived){data={data:[]};break;}
   const offset=q.payload.cursor?Number(q.payload.cursor):0;
   data={data:rows.slice(offset,offset+100),nextCursor:offset+100<rows.length?String(offset+100):null};
   if(q.payload.cursor&&pageMode==='error')error='第二页加载失败';
   if(q.payload.cursor&&pageMode==='cycle')data.nextCursor=q.payload.cursor;
   if(q.payload.cursor&&pageMode==='hold'){pendingPage=reply;return;}
   break;
  }
  case 'conversation.delete':
   if(deleteMode==='partial'&&q.payload.threadId==='archive-101')error='模拟存储失败';
   else rows=rows.filter(row=>row.id!==q.payload.threadId);
   break;
  case 'conversation.unarchive':rows=rows.filter(row=>row.id!==q.payload.threadId);break;
  default:unexpected.push(q.operation);error='Unexpected fixture operation';
 }
 reply();
}));
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await server.listen();
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const page=await browser.newPage({viewport:{width:1224,height:816}});page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'})),`ws://127.0.0.1:${gateway.address().port}/ws?userId=qa&deviceId=qa`);
 await page.goto(server.resolvedUrls.local[0]);await page.locator('.connection-summary').filter({hasText:'已连接'}).waitFor();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'已归档聊天',exact:true}).click();
 const all=page.getByRole('button',{name:'全部删除',exact:true}),refresh=page.getByRole('button',{name:'刷新归档对话'}),search=page.getByRole('searchbox',{name:'搜索已归档聊天'}),filter=page.getByRole('combobox',{name:'筛选项目'});
 await page.getByText('第二页项目聊天',{exact:true}).waitFor();assert.equal(await page.locator('.archived-thread-row').count(),102);assert(await all.isEnabled());
 await search.fill('第二页');assert.equal(await page.locator('.archived-thread-row').count(),1);
 await filter.selectOption('none');await page.getByText('没有匹配的已归档聊天',{exact:true}).waitFor();
 await filter.selectOption(project.id);assert.equal(await page.locator('.archived-thread-row').count(),1);
 const modal=page.getByRole('dialog',{name:'删除所有已归档聊天？'});
 await all.click();await modal.waitFor();assert.match(await modal.innerText(),/102 个聊天/);
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});assert.equal(calls.filter(c=>c.operation==='conversation.delete').length,0);
 await search.fill('');await filter.selectOption('all');
 pageMode='hold';await refresh.click();await page.getByText('正在加载已归档聊天…',{exact:true}).waitFor();assert(await all.isDisabled());
 while(!pendingPage)await new Promise(r=>setTimeout(r,10));pendingPage();pendingPage=undefined;await page.getByText('正在加载已归档聊天…',{exact:true}).waitFor({state:'hidden'});assert(await all.isEnabled());
 for(const mode of ['error','cycle']){
  pageMode=mode;await refresh.click();await page.getByRole('alert').filter({hasText:mode==='error'?'第二页加载失败':'分页异常'}).waitFor();assert(await all.isDisabled());assert.equal(await page.locator('.archived-thread-row').count(),102);
 }
 pageMode='normal';await refresh.click();await page.getByRole('alert').waitFor({state:'hidden'});
 // Shorten fixture only after verifying >100 pagination; refresh uses the same production flow.
 rows=rows.filter(r=>['archive-0','archive-1','archive-2','archive-3','archive-4','archive-5','archive-101'].includes(r.id));await refresh.click();
 await page.waitForFunction(()=>document.querySelectorAll('.archived-thread-row').length===7);
 for(const theme of ['light','dark']){
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;},theme);
  await page.screenshot({path:join(output,`list-${theme}.png`)});
  await all.click();await modal.waitFor();await page.screenshot({animations:'disabled',path:join(output,`bulk-${theme}.png`)});await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
 }
 await page.setViewportSize({width:400,height:640});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert(await page.locator('.archived-thread-list').first().evaluate(e=>e.scrollWidth<=e.clientWidth));
 await page.screenshot({path:join(output,'list-narrow.png')});
 await page.getByRole('button',{name:'取消归档：无项目聊天',exact:true}).click();await page.getByText('已取消归档，可在主页继续聊天。',{exact:true}).waitFor();
 assert.equal(rows.length,6);
 await page.setViewportSize({width:1224,height:816});await search.fill('第二页');
 await all.click();await modal.waitFor();assert.match(await modal.innerText(),/6 个聊天/);
 await modal.getByRole('button',{name:'删除',exact:true}).click();await modal.getByRole('alert').filter({hasText:'已删除 5 个，1 个未删除'}).waitFor();
 assert.equal(rows.length,1);assert.equal(await page.locator('.archived-thread-row').count(),1);
 const successful=calls.filter(c=>c.operation==='conversation.delete'&&c.payload.threadId!=='archive-101').length;assert.equal(successful,5);
 deleteMode='success';await modal.getByRole('button',{name:'重试删除',exact:true}).click();await modal.waitFor({state:'hidden'});
 await page.getByText('暂无已归档聊天',{exact:true}).waitFor();assert(await all.isDisabled());assert(await refresh.evaluate(e=>e===document.activeElement));
 assert.equal(calls.filter(c=>c.operation==='conversation.delete'&&c.payload.threadId!=='archive-101').length,5,'Successful deletions are not replayed');
 assert.equal(calls.filter(c=>c.operation==='conversation.delete'&&c.payload.threadId==='archive-101').length,2);
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({status:'ARCHIVED_CHATS_UI_OK',output,checks:['102 rows across cursors','load and cycle failures disable bulk delete','search and project intersection','all ignores filters with explicit count','grouped light/dark/narrow layouts','restore','partial bulk failure retains record','explicit retry skips successful IDs','focus restoration after emptying list']}));
}finally{await browser.close();for(const socket of gateway.clients)socket.terminate();await new Promise(r=>gateway.close(r));await server.close();}
