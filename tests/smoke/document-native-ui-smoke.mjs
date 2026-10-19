// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Requires a debug desktop built with identifier com.centralcodex.capacityqa.
// Real Tauri IPC/Agent preview; sends no model requests or production settings.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {loadPlaywright} from '../support/playwright.mjs';
const image=resolve(process.argv[2]??'');assert(process.argv[2],'Pass a local image path');
const root=await mkdtemp(resolve('target/document-ui-'));const wss=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>wss.once('listening',r));
wss.on('connection',socket=>socket.on('message',raw=>{const q=JSON.parse(raw);if(q.type==='agent.hello')socket.send(JSON.stringify({protocol:'agentrpc',version:1,type:'agent.hello_ack',timestamp:new Date().toISOString(),nonce:'fixture',payload:{}}));}));
let vite,app,browser;
try{
 let serving=false;try{serving=(await fetch('http://127.0.0.1:1420')).ok;}catch{}
 if(!serving){vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/desktop/vite.config.ts','apps/desktop'],{windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1420')).ok){serving=true;break;}}catch{}await delay(100);}}
 assert(serving,'Vite entry not available');
 let occupied=false;try{occupied=(await fetch('http://127.0.0.1:19337/json/version',{signal:AbortSignal.timeout(500)})).ok;}catch{}assert(!occupied,'QA debugger port already in use');
 app=spawn(resolve('target/debug/desktop-spike.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:join(root,'webview'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19337',CODEXIA_GATEWAY_AGENT_URL:`ws://127.0.0.1:${wss.address().port}/ws/agent?deviceId=capacity-ui`,CODEXIA_WORKSPACE_ROOT:root,CODEXIA_LOCAL_AGENT_PATH:resolve('target/debug/local-agent.exe')}});
 let endpoint;for(let i=0;i<100;i++){try{endpoint=(await(await fetch('http://127.0.0.1:19337/json/version')).json()).webSocketDebuggerUrl;if(endpoint)break;}catch{}await delay(100);}assert(endpoint,'No debug WebView');
 const {chromium}=await loadPlaywright();browser=await chromium.connectOverCDP(endpoint);let page;for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await delay(100);}assert(page);await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
 const identifier=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'));assert.equal(identifier,'com.centralcodex.capacityqa','Never use the installed app for this fixture');
 await page.evaluate(config=>window.__TAURI_INTERNALS__.invoke('apply_desktop_config',{config}),{gatewayUrl:`ws://127.0.0.1:${wss.address().port}/ws`,userId:'capacity-fixture',deviceId:'capacity-ui',workspaceRoot:root});
 await page.reload();
 await page.waitForFunction(()=>!!document.querySelector('.composer-container,.composer,.composer-shell'));
 const preview=await page.evaluate(async path=>{const call=(method,params)=>window.__TAURI_INTERNALS__.invoke('attachment_request',{method,params});const stat=await call('file/stat',{path});const preview=await call('attachment/preview',{path,version:stat.version});return {stat,width:preview.width,height:preview.height,previewBytes:preview.url.length};},image);assert(preview.previewBytes>0);
 await page.evaluate(path=>window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to',{target:{kind:'AnyLabel',label:'main'},event:'tauri://drag-drop',payload:{paths:[path],position:{x:600,y:500}}}),image);
 await page.locator('.attachment-card').waitFor();assert.equal(await page.locator('.attachment-card img').count(),1);assert(!(await page.locator('.attachment-card').innerText()).includes('IMAGE_DECODE_FAILED'));
 await page.screenshot({path:join(root,'tall-image-preview.png')});console.log(JSON.stringify({ok:true,root,preview,scope:'isolated real Tauri + local IPC; no model request'}));
}finally{
 await browser?.close().catch(()=>{});
 // Killing only Tauri skips its normal exit hook and leaks its managed Agent.
 if(app?.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 vite?.kill();for(const socket of wss.clients)socket.terminate();await new Promise(r=>wss.close(r));
}
