// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {loadPlaywright} from '../support/playwright.mjs';
// Actual App + adapter; loopback protocol fixture, never a production Thread.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await loadPlaywright();
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/thread-delete-ui-'));
let mode='legacy',deleted=false,pendingDelete;let threadName='删除回归临时对话';const calls=[],unexpected=[];
const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>gateway.once('listening',r));
gateway.on('connection',socket=>socket.on('message',raw=>{
  const q=JSON.parse(String(raw));if(q.type!=='request')return;
  calls.push(q.operation);let data={},error;
  switch(q.operation){
    case 'session.initialize': data={userAgent:'delete-ui-protocol-fixture',platformCapabilities:{projects:true}};break;
    case 'model.list':data={data:[]};break;
    case 'project.list':data={projects:[]};break;
    case 'conversation.list':data={data:q.payload?.archived&&!deleted?[{id:'delete-ui-only',name:threadName,archived:true,isArchived:true,preview:'QA'}]:[]};break;
    case 'conversation.delete':
      assert.equal(q.payload.threadId,'delete-ui-only');
      if(mode==='legacy')error='App Server request failed: {"code":-32602,"message":"REMOTE_WORKSPACE_UNSUPPORTED: thread/delete"}';
      else if(mode==='timeout')error='conversation.delete 请求超时';
      else if(mode==='pending'){pendingDelete=()=>{deleted=true;socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:true,data:{}}));};return;}
      else deleted=true;
      break;
    default: unexpected.push(q.operation);error='Unsupported fixture operation: '+q.operation;
  }
  socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:!error,...(error?{error}:{data})}));
}));
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await server.listen();
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
  const page=await browser.newPage({viewport:{width:1040,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'})),`ws://127.0.0.1:${gateway.address().port}/ws?userId=qa&deviceId=qa`);
  await page.goto(server.resolvedUrls.local[0]);await page.locator('.connection-summary').filter({hasText:'已连接'}).waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'已归档聊天',exact:true}).click();
  const remove=page.getByRole('button',{name:'永久删除对话：删除回归临时对话',exact:true});await remove.waitFor();
  page.on('dialog',async dialog=>{errors.push('Unexpected native confirmation');await dialog.dismiss();});
  const modal=page.getByRole('dialog',{name:'删除已归档聊天？'});
  const count=()=>calls.filter(c=>c==='conversation.delete').length;
  await remove.click();await modal.waitFor();
  assert(await modal.getByRole('button',{name:'取消',exact:true}).evaluate(e=>e===document.activeElement));
  for(let i=0;i<6;i++){await page.keyboard.press('Tab');assert(await modal.evaluate(e=>e.contains(document.activeElement)));}
  await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
  assert.equal(count(),0);assert(await remove.evaluate(e=>e===document.activeElement));
  await remove.click();await page.keyboard.press('Enter');await modal.waitFor({state:'hidden'});assert.equal(count(),0);
  await remove.click();await modal.waitFor();
  assert.equal(Math.round((await modal.boundingBox()).width),520);
  await page.screenshot({animations:'disabled',path:join(output,'confirm-light.png')});
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});
  await page.screenshot({animations:'disabled',path:join(output,'confirm-dark.png')});
  await modal.getByRole('button',{name:'删除',exact:true}).click();
  await modal.getByRole('alert').filter({hasText:'升级中央服务'}).waitFor();assert(await remove.isVisible());
  assert(!(await modal.getByRole('alert').innerText()).includes('REMOTE_WORKSPACE_UNSUPPORTED'));assert.equal(count(),1);
  await page.screenshot({animations:'disabled',path:join(output,'legacy-error.png')});
  mode='timeout';await modal.getByRole('button',{name:'重试删除',exact:true}).click();
  await modal.getByRole('alert').filter({hasText:'请求超时'}).waitFor();assert.equal(count(),2);assert(await remove.isVisible());
  await modal.getByRole('button',{name:'取消',exact:true}).click();await modal.waitFor({state:'hidden'});
  threadName='长对话标题 / '+ '多层目录与中文连续内容VeryLongTitle'.repeat(18);
  await page.getByRole('button',{name:'刷新归档对话',exact:true}).click();
  const longRemove=page.getByRole('button',{name:'永久删除对话：'+threadName,exact:true});await longRemove.waitFor();
  await page.setViewportSize({width:400,height:640});await longRemove.click();
  assert((await modal.boundingBox()).width<=368);
  assert(await modal.evaluate(e=>e.scrollWidth<=e.clientWidth));
  await page.screenshot({animations:'disabled',path:join(output,'long-title-narrow.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await modal.evaluate(e=>getComputedStyle(e).animationName),'none');
  assert.equal(await modal.evaluate(e=>getComputedStyle(e,'::backdrop').animationName),'none');
  mode='pending';await modal.getByRole('button',{name:'删除',exact:true}).click();
  await modal.getByRole('button',{name:'删除中…',exact:true}).waitFor();
  assert(await modal.getByRole('button',{name:'取消',exact:true}).isDisabled());
  assert(await modal.getByRole('button',{name:'删除中…',exact:true}).isDisabled());
  await page.keyboard.press('Escape');assert(await modal.isVisible());assert.equal(count(),3);
  pendingDelete();await modal.waitFor({state:'hidden'});
  await page.getByText('暂无已归档聊天',{exact:true}).waitFor();
  const refresh=page.getByRole('button',{name:'刷新归档对话',exact:true});
  assert(await refresh.evaluate(e=>e===document.activeElement));
  await refresh.click();await page.getByText('暂无已归档聊天',{exact:true}).waitFor();
  assert.equal(count(),3);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'THREAD_DELETE_UI_OK',output,checks:['default cancel, focus trap and restoration','Escape and default Enter cancel with no request','light/dark themes and compact size','inline legacy/timeout error and explicit retry','long title narrow viewport','reduced motion including backdrop','busy locks actions and Escape','success restores fallback focus and refresh stays deleted','no native confirm or automatic retry']}));
}finally{await browser.close();for(const socket of gateway.clients)socket.terminate();await new Promise(r=>gateway.close(r));await server.close();}
