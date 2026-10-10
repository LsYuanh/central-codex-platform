// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {loadPlaywright} from '../support/playwright.mjs';
// Verify actual pointer/Tab modality against the shared input styles and initializer.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
const {chromium}=await loadPlaywright();
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/input-focus-'));
const source=resolve('apps/desktop/src').replaceAll('\\','/');
await writeFile(join(output,'index.html'),`<!doctype html><html><meta charset="utf-8"><title>Input focus QA</title>
<style>body{padding:32px;background:var(--canvas)}main{max-width:700px;display:grid;gap:16px}label{display:block} .composer-shell{position:static}button{width:max-content}</style>
<main><button id="start">焦点起点</button>
<label>普通输入<input id="plain" aria-label="普通输入"></label>
<label>配对输入<input id="password" type="password" aria-label="配对输入" autocomplete="off"></label>
<label>多行输入<textarea id="multiline" aria-label="多行输入"></textarea></label>
<label class="skills-search" id="skills-shell"><input id="skills" type="search" aria-label="搜索技能" placeholder="搜索技能"></label>
<label class="project-name" id="project-shell"><input id="project" aria-label="项目名称" placeholder="项目名称"></label>
<label class="composer-project-search" id="picker-shell"><input id="picker" role="combobox" aria-label="搜索项目" placeholder="搜索项目"></label>
<div class="composer-shell" id="composer-shell"><div id="composer" class="composer-editor" contenteditable="true" role="textbox" aria-label="消息输入">消息输入</div></div>
<button id="end">焦点终点</button></main><script type="module" src="./fixture.js"></script></html>`);
await writeFile(join(output,'fixture.js'),`import '${source}/styles.css';import {initializeInputFocus} from '${source}/input-focus.ts';window.disposeInputFocus=initializeInputFocus();`);
const server=await createServer({configFile:false,root:output,cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});
await server.listen();const browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1000,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const fields=[['plain','plain'],['password','password'],['multiline','multiline'],['skills','skills-shell'],['project','project-shell'],['picker','picker-shell'],['composer','composer-shell']];
const state=async id=>page.locator('#'+id).evaluate(el=>{const s=getComputedStyle(el);return {outline:s.outlineStyle,outlineColor:s.outlineColor,outlineWidth:s.outlineWidth,border:s.borderBottomColor,shadow:s.boxShadow};});
const neutral=color=>{const rgb=color.match(/[\d.]+/g)?.slice(0,3).map(Number);return rgb?.length===3&&rgb.every(v=>v===rgb[0]);};
try{
 await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>!!window.disposeInputFocus);
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const [id,shell] of fields){
   const field=page.locator('#'+id);await field.click();await field.pressSequentially('a');
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.inputFocus),'pointer');
   const clicked=await state(shell);assert.equal(clicked.outline,'none',id+' mouse focus has no outer ring');
   if(id==='composer')assert.equal(clicked.border,theme==='dark'?'rgb(68, 68, 68)':'rgb(228, 228, 233)');
   else assert(neutral(clicked.border),id+' border must be neutral');
   await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
   assert(await field.evaluate(el=>el===document.activeElement));const keyed=await state(shell);
   assert.equal(keyed.outline,'solid',id+' keyboard focus remains visible');assert.equal(keyed.outlineWidth,'2px');assert(neutral(keyed.outlineColor),id+' ring must be neutral');
   if(id!==shell)assert.equal((await state(id)).outline,'none',id+' has no duplicate inner ring');
   await field.click();assert.equal((await state(shell)).outline,'none',id+' pointer clears ring without requiring blur');
  }
  await page.locator('#skills').click();await page.screenshot({path:join(output,theme+'-pointer.png')});
  await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await page.screenshot({path:join(output,theme+'-keyboard.png')});
  await page.locator('#end').focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
  assert.equal((await state('end')).outline,'solid');assert.equal((await state('end')).outlineColor,theme==='dark'?'rgb(138, 180, 248)':'rgb(36, 93, 193)');
 }
 await page.setViewportSize({width:400,height:700});await page.locator('#skills').click();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(output,'narrow-keyboard.png')});
 await page.evaluate(()=>window.disposeInputFocus());await page.locator('#plain').click();await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.inputFocus),undefined,'cleanup removes both listeners');
 assert.deepEqual(errors,[]);console.log('INPUT_FOCUS_OK '+output);
}catch(e){await page.screenshot({path:join(output,'failure.png')});throw e;}
finally{await browser.close();await server.close();}
