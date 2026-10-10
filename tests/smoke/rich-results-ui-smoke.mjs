// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {loadPlaywright} from '../support/playwright.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { localAgentExecutable } from './client-smoke-platform.mjs';
const {chromium}=await loadPlaywright();
await mkdir('target',{recursive:true});
const output = await mkdtemp(resolve('target/rich-results-'));
const fixture = resolve('tests/fixtures/rich-results-qa.tsx').replaceAll('\\','/');
await writeFile(join(output,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></html>`);
const server=await createServer({configFile:false,root:output,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});
await server.listen();let browser,agent;
try {
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:1000,height:1100}});page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.json-tree').waitFor();
  await page.evaluate(()=>{window.copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}});});
  const set=async next=>{await page.evaluate(next=>window.setResults(next),next);};
  const json=page.locator('#json');
  await json.getByRole('button',{name:/items/}).click();
  assert((await json.innerText()).includes('0: 1'));
  await json.getByRole('button',{name:'查看源码'}).click();
  assert((await json.locator('pre').innerText()).includes('"items"'));
  await json.getByRole('button',{name:'复制原文'}).click();
  assert.equal(await page.evaluate(()=>window.copied),'{"name":"远舟","items":[1,true,null,{"nested":"内容"}]}');
  await json.getByRole('button',{name:'树形视图'}).click();
  const diff=page.locator('#diff');
  assert.equal(await diff.locator('details').count(),2);
  await diff.locator('summary').first().click();
  assert.equal(await diff.locator('details').first().locator('.diff-add .diff-number').last().innerText(),'1');
  assert.equal(await diff.locator('.diff-remove .diff-number').first().innerText(),'1');
  await diff.getByRole('button',{name:'查看原文'}).click();assert((await diff.locator('pre').innerText()).includes('diff --git'));
  await diff.getByRole('button',{name:'差异视图'}).click();
  const logs=page.locator('#logs');
  await logs.getByRole('button',{name:'错误输出',exact:true}).click();
  assert.equal(await logs.getByRole('log').innerText(),'错误示例\n');
  await logs.getByRole('button',{name:'复制当前输出'}).click();assert.equal(await page.evaluate(()=>window.copied),'错误示例\n');
  await logs.getByRole('button',{name:'全部',exact:true}).click();
  // Explicit syntax only: arbitrary prose remains prose, incomplete and large JSON retain source.
  for(const [content,streaming,expected] of [['```json\n{"x":\n```',false,'JSON 格式不完整'],['```json\n{"x":1}\n```',true,'生成中'],['```json\n{"id":9007199254740993}\n```',false,'安全精度'],['```json\n'+JSON.stringify('x'.repeat(100001))+'\n```',false,'JSON 较大']]) {
    await set({content,streaming});await page.waitForFunction(text=>document.querySelector('#json').textContent.includes(text),expected);assert.equal(await json.locator('.json-tree').count(),0);
  }
  await set({content:'这里举例 {"a": 1}',streaming:false});assert.equal(await json.locator('.json-tree').count(),0);
  await set({content:'```json\n'+JSON.stringify(Array.from({length:105},(_,i)=>i))+'\n```'});
  await json.getByRole('button',{name:'显示后续 5 项'}).click();assert.equal(await json.locator('.json-leaf').count(),105);
  // Log updates follow the bottom only while the user remains pinned.
  const longLogs=[{sequence:1,stream:'stdout',chunk:Array.from({length:100},(_,i)=>'line '+i).join('\n')}];
  await set({logs:longLogs});await page.waitForFunction(()=>{const e=document.querySelector('#logs .execution-log');return e.scrollTop>0;});
  await logs.getByRole('log').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll',{bubbles:true}));});
  await set({logs:[...longLogs,{sequence:2,stream:'stderr',chunk:'\nnew line'}]});
  await page.waitForTimeout(80);assert.equal(await logs.getByRole('log').evaluate(el=>el.scrollTop),0);
  await set({logs:[{sequence:1,stream:'stdout',chunk:'开始处理\n'},{sequence:2,stream:'stderr',chunk:'错误示例\n'}]});
  // Real local Agent verifies source device/version, reads previews/full bytes and closes transfers.
  const imagePath=join(output,'sample.png'),documentPath=join(output,'说明.pdf');
  const bytes=await readFile('apps/desktop/src-tauri/icons/icon.png');await writeFile(imagePath,bytes);await writeFile(documentPath,'%PDF-1.4\nfixture');
  agent=spawn(localAgentExecutable(),['--workspace-root',output,'--gateway-url','ws://127.0.0.1:9/ws/agent','--attachment-stdio'],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,LOCALAPPDATA:output}});
  let next=0;const pending=new Map(),calls=[];
  createInterface({input:agent.stdout}).on('line',line=>{const reply=JSON.parse(line),callback=pending.get(reply.id);if(callback){pending.delete(reply.id);reply.ok?callback.resolve(reply.result):callback.reject(new Error(reply.error));}});
  const ipc=(method,params={})=>new Promise((resolve,reject)=>{const id=String(++next),timer=setTimeout(()=>{pending.delete(id);reject(new Error('IPC timeout'));},5000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});calls.push(method);agent.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const identity=await ipc('attachment/identity'),stat=await ipc('file/stat',{path:imagePath}),doc=await ipc('file/stat',{path:documentPath});
  const attachment={...stat,id:'attachment',source:'localFile',deviceId:identity.deviceId,state:'read'};
  const saved={...stat,id:'saved',threadId:'qa',source:'deviceFile',deviceId:identity.deviceId,deviceKey:identity.deviceKey,status:'saved'};
  let badChunk=false;
  await page.exposeFunction('agentRequest',(command,args)=>{assert.equal(command,'attachment_request');if(args.method==='file/reveal'){calls.push('reveal-mock');return {opened:true};}if(badChunk&&args.method==='file/read_chunk')return {offset:999,data:'',done:true};return ipc(args.method,args.params);});
  await page.evaluate(()=>{window.isTauri=true;window.__TAURI_INTERNALS__={invoke:window.agentRequest};});
  await set({content:'```json\n{"name":"远舟","items":[1,true,null]}\n```',attachments:[attachment,{...doc,id:'doc',source:'localFile',deviceId:identity.deviceId,state:'referenced'}],outputs:[saved,{...doc,id:'doc-output',threadId:'qa',source:'deviceFile',deviceId:identity.deviceId,deviceKey:identity.deviceKey,status:'saved'}],image:`![正文图片](<${imagePath.replaceAll('\\','/')}>)`,images:[attachment]});
  await page.waitForFunction(()=>document.querySelector('#image img')?.naturalWidth>0);
  await page.locator('#files .output-image-button').waitFor();
  for(const name of ['放大图片 sample.png','查看图片 sample.png','放大图片 正文图片']) {
    const button=page.getByRole('button',{name,exact:true});await button.click();
    const viewer=page.getByRole('dialog');await viewer.waitFor();await page.waitForFunction(()=>document.querySelector('.image-viewer img')?.naturalWidth>0);
    await viewer.getByRole('button',{name:'放大图片',exact:true}).click();assert((await viewer.innerText()).includes('125%'));
    await viewer.getByRole('button',{name:'适应窗口',exact:true}).click();assert.equal(await viewer.locator('.image-fit').count(),1);
    for(let i=0;i<9;i++){await page.keyboard.press('Tab');assert(await viewer.evaluate(el=>el.contains(document.activeElement)),'focus stays inside modal');}
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert(await button.evaluate(el=>el===document.activeElement));
  }
  assert(calls.includes('file/read_image')&&calls.includes('file/read_chunk')&&calls.includes('file/close_transfer'));
  await page.locator('#files').getByRole('button',{name:'打开所在目录'}).first().click();await page.waitForFunction(()=>!document.querySelector('#files button[disabled]'));assert(calls.includes('reveal-mock'));
  // No stale identity, changed version or corrupt transfer may display a full image.
  const before=calls.filter(x=>x==='file/read_image').length;
  await set({attachments:[{...attachment,deviceId:'wrong'}],outputs:[],image:''});
  await page.locator('#files').getByRole('button',{name:'打开所在目录'}).click();await page.locator('#files').getByRole('alert').waitFor();assert.equal(calls.filter(x=>x==='file/read_image').length,before);
  await set({attachments:[attachment]});await page.getByRole('button',{name:'放大图片 sample.png',exact:true}).waitFor();
  badChunk=true;const closed=calls.filter(x=>x==='file/close_transfer').length;await page.getByRole('button',{name:'放大图片 sample.png',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#files').textContent.includes('图片内容校验失败'));assert(calls.filter(x=>x==='file/close_transfer').length>closed);assert.equal(await page.getByRole('dialog').count(),0);badChunk=false;
  await writeFile(imagePath,Buffer.concat([bytes,Buffer.from([0])]));
  await page.getByRole('button',{name:'放大图片 sample.png',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#files').textContent.includes('文件已变化'));assert.equal(await page.getByRole('dialog').count(),0);
  const fresh=await ipc('file/stat',{path:imagePath});
  await set({attachments:[{...attachment,...fresh},{...doc,id:'doc',source:'localFile',deviceId:identity.deviceId,state:'referenced'}],outputs:[{...saved,...fresh}]});
  await page.waitForFunction(()=>document.querySelector('#files .output-image-button img')?.naturalWidth>0 && !document.querySelector('#files button[disabled]'));
  await diff.locator('summary').first().click();
  for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:400,height:1100});await page.waitForTimeout(250);await page.screenshot({path:join(output,`${theme}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.getByRole('button',{name:'放大图片 sample.png',exact:true}).click();await page.getByRole('dialog').waitFor();await page.screenshot({path:join(output,'image-viewer.png')});await page.keyboard.press('Escape');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}}));await logs.getByRole('button',{name:'复制当前输出'}).click();assert((await logs.innerText()).includes('复制失败'));
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,realAgent:true,reveal:'mocked after real identity/version check',clipboard:'memory mock',scenarios:['JSON tree/source/streaming/invalid/large/precision/paging','diff files/line numbers/source','log filtering/copy failure','file metadata','three image entry points/zoom/fit/Escape/focus trap','device/version/corrupt chunk guards','light/dark/400px']},null,2));
  console.log(`RICH_RESULTS_OK ${output}`);
} finally {await browser?.close();agent?.kill();await server.close();}
