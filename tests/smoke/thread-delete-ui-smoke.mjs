// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual App + adapter; loopback protocol fixture, never a production Thread.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/thread-delete-ui-'));
let mode='legacy',deleted=false;const calls=[],unexpected=[];
const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>gateway.once('listening',r));
gateway.on('connection',socket=>socket.on('message',raw=>{
  const q=JSON.parse(String(raw));if(q.type!=='request')return;
  calls.push(q.operation);let data={},error;
  switch(q.operation){
    case 'session.initialize': data={userAgent:'delete-ui-protocol-fixture',platformCapabilities:{projects:true}};break;
    case 'model.list':data={data:[]};break;
    case 'project.list':data={projects:[]};break;
    case 'conversation.list':data={data:q.payload?.archived&&!deleted?[{id:'delete-ui-only',name:'删除回归临时对话',archived:true,isArchived:true,preview:'QA'}]:[]};break;
    case 'conversation.delete':
      assert.equal(q.payload.threadId,'delete-ui-only');
      if(mode==='legacy')error='App Server request failed: {"code":-32602,"message":"REMOTE_WORKSPACE_UNSUPPORTED: thread/delete"}';
      else if(mode==='timeout')error='conversation.delete 请求超时';
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
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'对话管理',exact:true}).click();
  const remove=page.getByRole('button',{name:'永久删除对话：删除回归临时对话',exact:true});await remove.waitFor();
  page.once('dialog',dialog=>dialog.dismiss());await remove.click();assert.equal(calls.filter(c=>c==='conversation.delete').length,0);
  page.once('dialog',dialog=>dialog.accept());await remove.click();
  await page.getByRole('alert').filter({hasText:'升级中央服务'}).waitFor();assert(await remove.isVisible());
  assert(!await page.getByRole('alert').innerText().then(text=>text.includes('REMOTE_WORKSPACE_UNSUPPORTED')));
  assert.equal(calls.filter(c=>c==='conversation.delete').length,1);
  await page.screenshot({path:join(output,'legacy-error.png')});
  mode='timeout';page.once('dialog',dialog=>dialog.accept());await remove.click();await page.getByRole('alert').filter({hasText:'请求超时'}).waitFor();assert(await remove.isVisible());
  mode='success';page.once('dialog',dialog=>dialog.accept());await remove.click();await page.getByText('暂无归档对话',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c==='conversation.delete').length,3);
  await page.getByRole('button',{name:'刷新归档对话',exact:true}).click();await page.getByText('暂无归档对话',{exact:true}).waitFor();
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'THREAD_DELETE_UI_OK',output,checks:['cancel sends no request','legacy denial in Chinese and row retained','timeout row retained','success then refresh remains deleted','no automatic retry']}));
}finally{await browser.close();for(const socket of gateway.clients)socket.terminate();await new Promise(r=>gateway.close(r));await server.close();}
