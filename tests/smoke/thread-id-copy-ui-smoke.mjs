// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/thread-copy-ui-'));
const source=resolve('apps/desktop/src').replaceAll('\\','/');
await writeFile(join(output,'index.html'),'<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(join(output,'fixture.tsx'),`import React from 'react';import{createRoot}from'react-dom/client';import{ThreadActions}from'${source}/ThreadActions.tsx';import{useThreadIdCopy}from'${source}/useThreadIdCopy.tsx';import'${source}/styles.css';
window.writes=[];window.failCopy=false;window.hangCopy=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(window.hangCopy)return new Promise(()=>{});if(window.failCopy)throw Error('denied');window.writes.push(value);}}});
function Fixture(){const copy=useThreadIdCopy();return <main style={{padding:24}}>{copy.feedback}<div className="conversation-item running" style={{width:260}}><button className="conversation-select"><span className="conversation-copy"><strong>正在运行的很长的对话标题需要完整保留</strong></span></button><div className="conversation-actions"><span className="conversation-loading" role="status">进行中</span><ThreadActions title="运行中" disabled rename={()=>{throw Error('must stay disabled')}} archive={()=>{throw Error('must stay disabled')}} copyId={()=>copy.copy('thread-running-id')}/></div></div><ThreadActions title="普通" disabled={false} rename={()=>{}} archive={()=>{}} copyId={()=>copy.copy('thread-normal-id')}/><button aria-label="复制归档 ID" onClick={()=>copy.copy('thread-archived-id')}>复制归档 ID</button></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
const server=await createServer({configFile:false,root:output,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await server.listen();
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const page=await browser.newPage({viewport:{width:900,height:650}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.resolvedUrls.local[0]);
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  const trigger=page.getByRole('button',{name:'更多操作：运行中'});await trigger.focus();await page.keyboard.press('ArrowDown');
  assert(await page.getByRole('menuitem',{name:'复制对话 ID',exact:true}).evaluate(e=>e===document.activeElement));
  assert(await page.getByRole('menuitem',{name:'重命名',exact:true}).isDisabled());assert(await page.getByRole('menuitem',{name:'归档对话',exact:true}).isDisabled());
  await page.screenshot({path:join(output,theme+'-menu.png')});await page.keyboard.press('Enter');
  await page.getByText('已复制对话 ID',{exact:true}).waitFor();assert(await trigger.evaluate(e=>e===document.activeElement));
  assert.equal((await page.evaluate(()=>window.writes)).at(-1),'thread-running-id');
  await page.getByRole('button',{name:'关闭复制提示'}).click();
 }
 await page.getByRole('button',{name:'复制归档 ID',exact:true}).click();await page.getByText('已复制对话 ID',{exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.writes)).at(-1),'thread-archived-id');
 await page.getByRole('button',{name:'关闭复制提示'}).click();await page.evaluate(()=>window.failCopy=true);
 await page.setViewportSize({width:400,height:600});await page.getByRole('button',{name:'更多操作：普通'}).click();await page.getByRole('menuitem',{name:'复制对话 ID',exact:true}).click();
 await page.getByText('复制失败，可重试或手动复制：',{exact:true}).waitFor();assert.equal(await page.locator('.thread-copy-notice code').textContent(),'thread-normal-id');
 assert(await page.locator('.thread-copy-notice').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));await page.screenshot({path:join(output,'narrow-failure.png')});
 await page.evaluate(()=>window.failCopy=false);await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('已复制对话 ID',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭复制提示'}).click();await page.evaluate(()=>window.hangCopy=true);await page.getByRole('button',{name:'复制归档 ID',exact:true}).click();
 await page.getByText('复制失败，可重试或手动复制：',{exact:true}).waitFor({timeout:7000});
 await page.getByRole('button',{name:'关闭复制提示'}).click();
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{value:undefined});document.execCommand=()=>false;});
 await page.getByRole('button',{name:'复制归档 ID',exact:true}).click();await page.getByText('复制失败，可重试或手动复制：',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'复制归档 ID',exact:true}).evaluate(e=>e===document.activeElement));
 assert.deepEqual(errors,[]);console.log('THREAD_ID_COPY_UI_OK '+output);
}finally{await browser.close();await server.close();}
