// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/context-menu-ui-'));
const source=resolve('apps/desktop/src').replaceAll('\\','/');
await writeFile(join(output,'index.html'),'<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(join(output,'fixture.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';
import{initializeContextMenu}from'${source}/context-menu.ts';import{ThreadActions}from'${source}/ThreadActions.tsx';import'${source}/styles.css';
window.disposeMenu=initializeContextMenu();window.restartMenu=()=>{window.disposeMenu();window.disposeMenu=initializeContextMenu();};window.events=[];window.actions=[];
document.addEventListener('contextmenu',e=>window.events.push({id:e.target.id,prevented:e.defaultPrevented,trusted:e.isTrusted}));
createRoot(document.getElementById('root')).render(<main style={{padding:32,display:'grid',gap:16,maxWidth:600}}>
<div id="blank" tabIndex={0}>空白区域</div><p id="text">可选择的对话内容</p><a id="link" href="#fixture">链接</a>
<input id="input" aria-label="输入" defaultValue="编辑文本"/><textarea id="textarea" aria-label="多行输入" defaultValue="多行文本"/>
<div id="editable" contentEditable suppressContentEditableWarning role="textbox" aria-label="编辑器">编辑器文本</div>
<div id="custom" onContextMenu={()=>window.actions.push('context')}>自定义菜单事件</div>
<ThreadActions title="测试对话" disabled={false} rename={()=>window.actions.push('rename')} archive={()=>window.actions.push('archive')}/></main>);`);
const server=await createServer({configFile:false,root:output,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});
await server.listen();const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const page=await browser.newPage({viewport:{width:900,height:700}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.resolvedUrls.local[0]);await page.locator('#input').waitFor();
 for(const id of ['blank','text','link','input','textarea','editable','custom']){
  await page.locator('#'+id).click({button:'right'});
  assert.deepEqual(await page.evaluate(()=>window.events.at(-1)),{id,prevented:true,trusted:true});
 }
 assert.deepEqual(await page.evaluate(()=>window.actions),['context'],'custom handlers still receive the event');
 const eventCount=await page.evaluate(()=>window.events.length);
 await page.locator('#blank').focus();await page.keyboard.press('Shift+F10');
 assert.equal(await page.evaluate(()=>window.events.length),eventCount+1,'keyboard menu request is observed');
 assert.deepEqual(await page.evaluate(()=>window.events.at(-1)),{id:'blank',prevented:true,trusted:true});
 for(const id of ['input','textarea','editable']){
  const field=page.locator('#'+id);await field.click();await page.keyboard.press('Control+a');
  assert(await field.evaluate(el=>el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement?el.selectionEnd>el.selectionStart:!!getSelection()?.toString()),id+' text remains selectable');
  await page.keyboard.type('edited');
  assert.equal(await field.evaluate(el=>'value'in el?el.value:el.textContent),'edited');
  // Check shortcut/event cancellation without reading or overwriting the user's clipboard.
  assert(await field.evaluate(el=>['c','v','x','z','a'].every(key=>[false,true].every(meta=>el.dispatchEvent(new KeyboardEvent('keydown',{key,ctrlKey:!meta,metaKey:meta,bubbles:true,cancelable:true}))))));
  assert(await field.evaluate(el=>['copy','cut','paste'].every(type=>el.dispatchEvent(new Event(type,{bubbles:true,cancelable:true})))));
 }
 await page.getByRole('button',{name:'更多操作：测试对话'}).click();
 await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.actions),['context','rename']);
 await page.getByRole('button',{name:'更多操作：测试对话'}).focus();await page.keyboard.press('ArrowDown');
 await page.getByRole('menuitem',{name:'重命名',exact:true}).click({button:'right'});
 assert.equal(await page.evaluate(()=>window.events.at(-1).prevented),true,'portaled menu is covered');
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0);
 await page.evaluate(()=>{window.restartMenu();window.restartMenu();window.disposeMenu();});
 assert(await page.locator('#blank').evaluate(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),'cleanup removes listeners after reinitialization');
 await page.screenshot({path:join(output,'verified.png')});assert.deepEqual(errors,[]);
 console.log('CONTEXT_MENU_UI_OK '+output);
}finally{await browser.close();await server.close();}
