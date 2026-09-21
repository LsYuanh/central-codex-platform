// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function exerciseComposerProjectPicker({page,paths,request,native=false}) {
  const out=resolve('target/composer-project-qa');await mkdir(out,{recursive:true});
  const a=(await request('project.save',{name:'选择器甲',folders:[paths.b]})).project;
  const b=(await request('project.save',{name:'选择器乙',folders:[paths.extra]})).project;
  const composer=page.getByRole('textbox',{name:'发送消息',exact:true});
  const trigger=page.locator('.composer-project-trigger');
  const newDraft=async()=>{await page.locator('.sidebar-primary-action').click();await trigger.waitFor();};
  const sidebarDraft=async name=>{const button=page.getByRole('button',{name:`在${name}中新建对话`,exact:true});await button.focus();await button.click();};
  const choose=async name=>{await trigger.click();await page.getByRole('combobox',{name:'搜索项目'}).fill(name);await page.getByRole('option').click();};
  await newDraft();assert.equal(await trigger.innerText(),'选择项目');
  // The shell padding and footer gap should behave like the text entry area.
  const assertComposerFocused=()=>page.waitForFunction(()=>document.activeElement===document.querySelector('.composer .composer-editor'));
  const shell=page.locator('.composer-shell');
  const shellBox=await shell.boundingBox();
  for(const position of [{x:shellBox.width/2,y:4},{x:shellBox.width/2,y:shellBox.height-4}]) {
    await trigger.focus();await shell.click({position});await assertComposerFocused();
  }
  const model=page.locator('.model-picker > summary');
  await model.click();assert.equal(await page.locator('.model-picker').getAttribute('open'),'');
  assert.equal(await composer.evaluate(el=>el===document.activeElement),false,'model menu must retain focus');
  await page.keyboard.press('Escape');
  // Selecting a destination must not overwrite another project's saved draft.
  await sidebarDraft(b.name);await composer.fill('乙独立草稿');
  await sidebarDraft(a.name);await composer.fill('当前草稿');
  await choose(b.name);assert.equal(await composer.innerText(),'当前草稿');
  await sidebarDraft(b.name);assert.equal(await composer.innerText(),'乙独立草稿');
  await sidebarDraft(a.name);assert.equal(await composer.innerText(),'当前草稿');
  assert.equal(await trigger.innerText(),a.name);
  if(native){
    await composer.evaluate(el=>{const data=new DataTransfer();const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5YQAAAAASUVORK5CYII='),c=>c.charCodeAt(0));data.items.add(new File([bytes],'test.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));});
    await page.locator('.composer .attachment-card').waitFor();
  }
  await choose(b.name);await page.locator('.composer-project-chip').hover();await page.getByRole('button',{name:'取消项目选择',exact:true}).click();
  assert.equal(await trigger.innerText(),'选择项目');assert.equal(await composer.innerText(),'当前草稿');
  if(native){assert.equal(await page.locator('.composer .attachment-card').count(),1);await page.locator('.composer .attachment-card button').click();}
  await trigger.click();const search=page.getByRole('combobox',{name:'搜索项目'});
  await search.fill('不存在的项目');await page.getByText('没有匹配的项目',{exact:true}).waitFor();
  await search.fill('notes');assert(await page.getByRole('option').count()>0);
  await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
  await trigger.click();await search.fill(b.name);await page.keyboard.press('Enter');assert.equal(await trigger.innerText(),b.name);
  assert.equal(await composer.innerText(),'当前草稿');
  const before=(await request('conversation.list')).data.length;
  await trigger.click();await page.getByRole('button',{name:'新建项目',exact:true}).click();
  await page.getByRole('dialog',{name:'添加项目'}).waitFor();
  if(native){assert.equal(await page.locator('.project-manual-path').count(),0);await page.getByRole('button',{name:'取消',exact:true}).click();}
  else {
    await page.getByRole('textbox',{name:'项目名称',exact:true}).fill('从输入框新建');
    await page.getByRole('textbox',{name:'本机目录路径'}).fill(paths.extra);await page.getByRole('button',{name:'添加',exact:true}).click();
    await page.getByRole('button',{name:'创建',exact:true}).click();await page.locator('.project-dialog').waitFor({state:'detached'});
    assert.equal(await trigger.innerText(),'从输入框新建');assert.equal(await composer.innerText(),'当前草稿');
    assert.equal((await request('conversation.list')).data.length,before,'creating a project must not submit the composer form');
  }
  await choose(b.name);
  for(const theme of ['light','dark']){
    await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
    await page.mouse.move(800,80);await page.screenshot({path:join(out,`${native?'native':'browser'}-${theme}-selected.png`)});
    await trigger.click();await page.screenshot({path:join(out,`${native?'native':'browser'}-${theme}-menu.png`)});await page.keyboard.press('Escape');
  }
  if(!native){await page.setViewportSize({width:480,height:760});await trigger.click();const box=await page.locator('.composer-project-popover').boundingBox();assert(box.x>=0&&box.x+box.width<=480&&box.y>=0);await page.screenshot({path:join(out,'browser-narrow.png')});await page.keyboard.press('Escape');await page.setViewportSize({width:1170,height:810});}
  await composer.fill('选择项目后发送');await page.getByRole('button',{name:'发送',exact:true}).click();await trigger.waitFor({state:'detached'});
  await assertComposerFocused();
  await page.locator('.conversation-project-context summary').waitFor();
  const selected=(await request('conversation.list')).data.find(t=>t.clientProject?.id===b.id);
  assert(selected);assert.equal(selected.clientProject.folders[0],b.folders[0]);
  // Deleted selection must fail explicitly instead of silently using default cwd.
  await newDraft();await choose(a.name);await composer.fill('项目被移除时保留草稿');await request('project.remove',{id:a.id,revision:a.revision});
  await page.getByRole('button',{name:a.name,exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('项目暂不可用，请刷新项目列表或重新选择项目；草稿已保留',{exact:true}).waitFor();assert.equal(await composer.innerText(),'项目被移除时保留草稿');
  await assertComposerFocused();
  await trigger.click();await page.getByRole('button',{name:'不在项目中工作',exact:true}).click();
  const existing=new Set((await request('conversation.list')).data.map(t=>t.id));
  await composer.focus();await page.keyboard.press('Enter');await trigger.waitFor({state:'detached'});
  await assertComposerFocused();
  const plain=(await request('conversation.list')).data.find(t=>!existing.has(t.id));assert(plain);assert.equal(plain.clientProject,undefined);
  await newDraft();await composer.fill('发送期间主动切换焦点');
  await page.evaluate(()=>{
    window.composerFocusMoved=false;
    const input=document.querySelector('.composer .composer-editor');
    const observer=new MutationObserver(()=>{
      if(input.isContentEditable)return;
      observer.disconnect();
      document.querySelector('.model-picker > summary').focus();
      window.composerFocusMoved=true;
    });
    observer.observe(input,{attributes:true,attributeFilter:['contenteditable']});
  });
  await page.keyboard.press('Enter');await trigger.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelector('.composer .composer-editor').isContentEditable);
  assert(await page.evaluate(()=>window.composerFocusMoved),'focus must move during the pending send');
  assert(await model.evaluate(el=>el===document.activeElement),'send completion must not steal deliberately moved focus');
  console.log(`COMPOSER_PROJECT_${native?'NATIVE':'BROWSER'}_OK: destination, draft preservation, search/keyboard, create/cancel, clear, immutable snapshot, deleted-project failure, default directory${native?', actual clipboard attachment preserved':''}`);
}

export async function runComposerProjectUi({port,paths,request}) {
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
  const browser=await chromium.launch({channel:'msedge',headless:true});let page;
  try {
    const context=await browser.newContext({viewport:{width:1170,height:810}});
    await context.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'})),`ws://127.0.0.1:${port}/ws?userId=project-owner&deviceId=project-device`);
    page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(process.env.PROJECT_UI_URL??'http://127.0.0.1:1420');
    await page.getByRole('button',{name:'项目 B',exact:true}).waitFor();
    await exerciseComposerProjectPicker({page,paths,request});assert.deepEqual(errors,[]);
  }catch(error){if(page)await page.screenshot({path:resolve('target/composer-project-qa/browser-failure.png')});throw error;}finally{await browser.close();}
}
