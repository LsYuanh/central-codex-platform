// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Existing development executable, isolated profile, loopback protocol fixture only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {loadPlaywright} from '../support/playwright.mjs';
const executable=process.env.PERMISSION_NATIVE_EXE;assert(executable,'Set PERMISSION_NATIVE_EXE to the isolated com.centralcodex.harnessqa.permissions executable (target/permissions-qa.exe).');
assert((await readFile(executable)).includes(Buffer.from('com.centralcodex.harnessqa.permissions')),'Refusing to launch a non-QA application identifier');
const output=await mkdtemp(resolve('target/permission-native-ui-'));
// Windows Known Folders ignore APPDATA overrides: use a dedicated app identifier.
const directory=join(process.env.APPDATA,'com.centralcodex.harnessqa.permissions');await mkdir(directory,{recursive:true});
await writeFile(join(directory,'desktop-runtime-v1.json'),JSON.stringify({gatewayUrl:'ws://127.0.0.1:4510/ws',userId:'qa',deviceId:'qa',workspaceRoot:output}));
const sockets=[],gateway=new WebSocketServer({host:'127.0.0.1',port:4510});await new Promise(r=>gateway.once('listening',r));
gateway.on('connection',socket=>{sockets.push(socket);socket.on('message',bytes=>{
 const q=JSON.parse(String(bytes));if(q.type!=='request')return;
 const data=q.operation==='session.initialize'?{userAgent:'permission-native-ui-fixture',platformCapabilities:{deviceApproval:true}}:q.operation==='model.list'?{data:[{id:'fixture',model:'fixture',displayName:'Fixture',isDefault:true}]}:{data:[]};
 socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:true,data}));
 socket.send(JSON.stringify({type:'event',name:'device/status',eventType:'codex.notification',data:{agent:'online',deviceId:'qa'},sequence:1}));
 });});
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:1420,strictPort:true,fs:{allow:[resolve('.')]}}});await server.listen();
let child,browser,page;
try{
 child=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,APPDATA:output,LOCALAPPDATA:output,CODEXIA_WORKSPACE_ROOT:undefined,CODEXIA_GATEWAY_AGENT_URL:undefined,CODEXIA_LOCAL_AGENT_PATH:resolve('target/debug/local-agent.exe'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9226'}});
 const {chromium}=await loadPlaywright();
 for(let i=0;i<40;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9226');break;}catch{await delay(500);}}
 assert(browser,'Development WebView did not start');page=browser.contexts().flatMap(c=>c.pages())[0];page.setDefaultTimeout(15000);
 await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
 assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),'com.centralcodex.harnessqa.permissions');
 await page.locator('.permission-picker summary').waitFor();
 await page.waitForFunction(()=>document.querySelector('.permission-picker summary')?.textContent==='帮我批准');
 await page.locator('.permission-picker summary').click();
 await page.getByRole('button',{name:/^完全访问权限/}).waitFor();
 const bounds=await page.locator('.permission-popover').boundingBox();assert(bounds&&bounds.x>=0&&bounds.y>=0);
 await page.screenshot({path:join(output,'native-permission-light.png')});
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.permission-picker').getAttribute('open'),null);
 await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks:['actual Tauri IPC','new frontend in native WebView','default auto','three choices visible','popover bounds','Escape'],realModel:false,realDevice:false},null,2));
 console.log(JSON.stringify({ok:true,output}));
}catch(error){await page?.screenshot({path:join(output,'failure.png')});console.log(JSON.stringify({output,body:await page?.locator('body').innerText()}));throw error;}
finally{if(child?.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await browser?.close().catch(()=>{});await server.close();for(const socket of sockets)socket.close();await new Promise(r=>gateway.close(r));}
