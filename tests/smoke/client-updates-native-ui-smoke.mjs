// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Actual Tauri WebView + real no-download IPC rejection; update outcomes are
// explicitly simulated. Never starts an installer or uses a production profile.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {loadPlaywright} from '../support/playwright.mjs';
const executable=process.env.CLIENT_UPDATE_QA_EXE;
assert(executable,'Set CLIENT_UPDATE_QA_EXE to an isolated development binary');
const identifier='com.centralcodex.harnessqa.clientupdates';
assert((await readFile(executable)).includes(Buffer.from(identifier)),'Refusing production application identifier');
const output=await mkdtemp(resolve('target/client-updates-native-ui-'));
const bundle=await build({entryPoints:['tests/fixtures/client-updates-qa.tsx'],bundle:true,write:false,outdir:output,platform:'browser',format:'iife',jsx:'automatic',plugins:[{
 name:'labelled-native-update-fixture',setup(build){
  build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'update-fixture',namespace:'qa'}));
  build.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'export const isTauri=()=>true; export class Channel {} export const invoke=(command,args)=>window.updateFixtureInvoke(command,args);',loader:'js'}));
 }
}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
const server=http.createServer((request,response)=>{
 response.setHeader('Content-Type',request.url==='/qa.js'?'text/javascript':request.url==='/qa.css'?'text/css':'text/html');
 response.end(request.url==='/qa.js'?js:request.url==='/qa.css'?css:'<!doctype html><html lang="zh"><head><link rel="stylesheet" href="/qa.css"></head><body><div id="root"></div><script src="/qa.js"></script></body></html>');
});
await new Promise((r,j)=>{server.once('error',j);server.listen(1420,'127.0.0.1',r);});
let child,browser,page;
try{
 child=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9226',CODEXIA_WORKSPACE_ROOT:undefined,CODEXIA_GATEWAY_AGENT_URL:undefined}});
 const {chromium}=await loadPlaywright();
 for(let i=0;i<40;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9226');break;}catch{await delay(500);}}
 assert(browser,'QA WebView did not start');page=browser.contexts().flatMap(c=>c.pages())[0];page.setDefaultTimeout(15000);
 await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
 assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),identifier);
 const rejection=await page.evaluate(async()=>{try{await window.__TAURI_INTERNALS__.invoke('desktop_update_install');return null;}catch(e){return e;}});
 assert.deepEqual(rejection,{message:'请先下载更新',ready:false},'new native error contract, no package or installer');
 await page.getByRole('button',{name:'下载更新',exact:true}).click();
 await page.getByRole('button',{name:'安装并重启',exact:true}).click();
 await page.getByRole('button',{name:'确认安装并重启'}).click();
 await page.getByRole('button',{name:'重试安装',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'重新下载',exact:true}).count(),0);
 assert.match(await page.getByRole('alert').innerText(),/本机命令仍在运行/);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await delay(200);
  await page.screenshot({path:join(output,`native-retry-${theme}.png`)});
 }
 await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks:['actual Tauri IPC error object','isolated profile','real WebView renders retained-download retry','light/dark'],simulatedUpdateOutcomes:true,installerStarted:false},null,2));
 console.log(JSON.stringify({ok:true,output}));
}finally{
 if(child?.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 await browser?.close().catch(()=>{});await new Promise(r=>server.close(r));
}
