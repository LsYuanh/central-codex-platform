// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function runSidebarUi({port,paths,request}) {
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const out=resolve('target/sidebar-drag-qa');await mkdir(out,{recursive:true});let page;
 try {
  const project=(await request('project.list')).projects[0];
  const other=(await request('project.save',{name:'目标项目',folders:[paths.extra]})).project;
  const ids=[];for(const name of ['拖拽一','拖拽二','拖拽三']){const t=(await request('conversation.create',{projectId:project.id,projectRevision:project.revision})).thread;await request('conversation.rename',{threadId:t.id,name});ids.push(t.id);}
  const recent=(await request('conversation.create')).thread;await request('conversation.rename',{threadId:recent.id,name:'最近对话'});
  const context=await browser.newContext({viewport:{width:1170,height:810}});
  await context.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'})),`ws://127.0.0.1:${port}/ws?userId=project-owner&deviceId=project-device`);
  page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1420');
  const row=id=>page.locator(`[data-thread-id="${id}"]`),group=id=>page.locator(`[data-thread-group="${id??''}"]`);
  await group(project.id).locator(`[data-thread-id="${ids[2]}"]`).waitFor();
  async function drag(id,target,fraction=.5,cancel=false){
   await row(id).locator('.conversation-select').waitFor();await target.waitFor();
   const a=await row(id).locator('.conversation-select').boundingBox(),b=await target.boundingBox();
   await page.mouse.move(a.x+65,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+65,b.y+b.height*fraction,{steps:12});
   if(cancel)await page.keyboard.press('Escape');await page.mouse.up();
  }
  const order=async()=>(await group(project.id).locator('[data-thread-id]').evaluateAll(es=>es.map(e=>e.dataset.threadId))).filter(id=>ids.includes(id));
  await drag(ids[2],row(ids[0]),.15);assert.equal((await order())[0],ids[2]);
  const before=await order();await drag(ids[0],row(ids[2]),.1,true);assert.deepEqual(await order(),before);
  await drag(ids[0],group(other.id).locator('.project-row'));assert.equal(await group(other.id).locator(`[data-thread-id="${ids[0]}"]`).count(),1);
  await drag(ids[0],group(null).locator('.conversation-list-heading'));assert.equal(await group(null).locator(`[data-thread-id="${ids[0]}"]`).count(),1);
  await page.reload();await row(ids[0]).waitFor();assert.equal(await group(null).locator(`[data-thread-id="${ids[0]}"]`).count(),1);
  assert.equal((await request('conversation.read',{threadId:ids[0]})).thread.clientProject.folders[0],project.folders[0]);
  const stable=await order();await row(ids[2]).locator('.conversation-select').click();await page.getByRole('button',{name:'刷新对话',exact:true}).click();assert.deepEqual(await order(),stable,'opening and refreshing must not reorder');
  // A background Turn promotes its Thread; later stream chunks do not override a drag.
  await request('conversation.turn.create',{threadId:ids[1],input:[{type:'text',text:'SIDEBAR_STREAM'}]});
  await page.waitForFunction(({p,id})=>document.querySelector(`[data-thread-group="${p}"] [data-thread-id]`)?.getAttribute('data-thread-id')===id,{p:project.id,id:ids[1]});
  await drag(ids[1],row(ids[2]),.9);
  await new Promise(r=>setTimeout(r,1900));assert.equal((await order())[0],ids[2]);
  // Failed storage writes preserve the last saved order and surface an error.
  await page.evaluate(()=>{const original=Storage.prototype.setItem;window.__restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(k.startsWith('yuanzhou-thread-layout-v1:'))throw Error('quota');return original.call(this,k,v);};});
  await drag(ids[1],row(ids[2]),.1);assert.equal((await order())[0],ids[2]);await page.getByRole('alert').filter({hasText:'列表偏好保存失败'}).waitFor();await page.evaluate(()=>window.__restoreStorage());
  const more=page.getByRole('button',{name:'更多操作：拖拽一'});
  await more.focus();await page.keyboard.press('ArrowDown');
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(),['复制对话 ID','重命名','归档对话']);
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'归档对话');
  await page.keyboard.press('Escape');assert.equal(await more.evaluate(el=>el===document.activeElement),true);
  await page.screenshot({path:join(out,'organized.png')});assert.deepEqual(errors,[]);
  console.log('SIDEBAR_DRAG_UI_OK: pointer reorder, Escape, cross-project/recent, reload, unchanged cwd, background activity, streaming dedup, storage failure, reduced menu and keyboard focus');
 }catch(e){if(page){await page.screenshot({path:join(out,'failure.png')});console.error((await page.locator('body').innerText()).slice(0,1600));}throw e;}finally{await browser.close();}
}
