// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual OutputCard in browser or isolated Tauri WebView; state fixtures only.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const native=process.env.IMAGE_NATIVE_EXE;
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/image-ui-')),source=resolve('apps/desktop/src').replaceAll('\\','/');
await writeFile(join(output,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>');
await writeFile(join(output,'fixture.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{OutputCard}from'${source}/outputs.tsx';import{i18n}from'${source}/i18n.ts';import '${source}/styles.css';window.setLanguage=l=>i18n.changeLanguage(l);document.documentElement.dataset.theme='light';document.body.style.overflow='auto';document.body.style.background='var(--canvas)';window.retries=0;const data={threadId:'t',deviceId:'d',source:'generatedImage',kind:'image',name:'generated-image.png'};createRoot(document.getElementById('root')).render(<main style={{maxWidth:700,padding:24,margin:'auto'}}>{['generating','generationFailed','saving','failed'].map((status,i)=><div key={status} style={{marginBottom:24}}><OutputCard output={{...data,id:String(i),status,error:status==='generationFailed'?'图片生成已中断，请在对话中重新提出生成请求':status==='failed'?'来源设备离线，请连接后重试保存':undefined}} retry={async()=>{window.retries++}}/></div>)}</main>);`);
const server=await createServer({configFile:false,root:output,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:native?1423:0,strictPort:true,fs:{allow:[resolve('.')]}}});await server.listen();
let browser,child;
try{
  if(native){
    child=spawn(resolve(native),[],{windowsHide:true,stdio:'ignore',env:{...process.env,APPDATA:output,LOCALAPPDATA:output,CODEXIA_WORKSPACE_ROOT:undefined,CODEXIA_GATEWAY_AGENT_URL:undefined,CODEXIA_LOCAL_AGENT_PATH:join(output,'no-agent.exe'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9231'}});
    for(let i=0;i<40;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9231');break;}catch{await new Promise(r=>setTimeout(r,500));}}assert(browser,'isolated Tauri WebView unavailable');
  }else browser=await chromium.launch({channel:'msedge',headless:true});
  const page=native?browser.contexts().flatMap(c=>c.pages())[0]:await browser.newPage({viewport:{width:900,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.resolvedUrls.local[0]);
  await page.getByText('正在生成图片…',{exact:true}).waitFor();
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).fontFamily.includes('Noto Sans SC'));
  assert.equal(await page.getByRole('button',{name:'重试保存',exact:true}).count(),1,'generation failure must not offer save retry');
  await page.getByRole('button',{name:'重试保存',exact:true}).click();assert.equal(await page.evaluate(()=>window.retries),1);
  for(const theme of ['light','dark']){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.waitForFunction(t=>getComputedStyle(document.querySelector('.output-generationFailed')).borderTopColor===(t==='dark'?'rgb(242, 160, 167)':'rgb(180, 52, 63)'),theme);
    assert((await page.locator('.output-card').first().evaluate(e=>getComputedStyle(e).fontFamily)).includes('Noto Sans SC'));
    await page.screenshot({path:join(output,theme+'.png'),fullPage:true});
  }
  await page.evaluate(()=>window.setLanguage('en'));await page.getByText('Generating image…',{exact:true}).waitFor();await page.getByText('Image generation failed or was interrupted',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:850});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,native:Boolean(native),output,checks:['generation-save-distinction','retry-save-only','both-themes','English','narrow-layout']}));
}finally{await browser?.close();child?.kill();await server.close();}
