// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Run only with an isolated com.centralcodex.harnessqa.language development binary.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const exe=process.env.LANGUAGE_NATIVE_EXE;assert(exe,'Set LANGUAGE_NATIVE_EXE to the isolated QA executable');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
async function chooseLanguage(page, label) {
 await page.locator('#desktop-language').click();
 await page.getByRole('option',{name:label,exact:true}).click();
}
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/language-native-'));
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:1423,strictPort:true,fs:{allow:[resolve('.')]}}});await server.listen();
let child,browser;
async function start(){
 child=spawn(exe,[],{windowsHide:true,stdio:'ignore',env:{...process.env,APPDATA:output,LOCALAPPDATA:output,CODEXIA_WORKSPACE_ROOT:undefined,CODEXIA_GATEWAY_AGENT_URL:undefined,CODEXIA_LOCAL_AGENT_PATH:join(output,'no-agent.exe'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9226'}});
 for(let i=0;i<40;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9226');break;}catch{await delay(500);}}
 assert(browser,'Native QA WebView must expose its debugging endpoint');
 const page=browser.contexts().flatMap(c=>c.pages())[0];assert(page);page.setDefaultTimeout(15000);
 try {
  await page.locator('.desktop-shell').waitFor();
  if(!await page.locator('#desktop-language').isVisible())await page.locator('.sidebar-settings-row .sidebar-settings-button').click();
  await page.locator('#desktop-language').waitFor();
 } catch(error) {
  await page.screenshot({path:join(output,'native-failure.png')});
  console.log(JSON.stringify({url:page.url(),body:(await page.locator('body').innerText()).slice(0,4000),output}));throw error;
 }
 return page;
}
async function stop(){await browser?.close();browser=undefined;if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}child=undefined;}
try{
 let page=await start();
 assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),'com.centralcodex.harnessqa.language');
 await chooseLanguage(page,'简体中文');
 await page.getByRole('heading',{name:'常规与连接',exact:true}).waitFor();
 await chooseLanguage(page,'English');await page.getByRole('heading',{name:'General & connection',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('desktop_language')),'en');
 await page.screenshot({path:join(output,'native-en-light.png')});
 await page.locator('#desktop-language').click();await page.screenshot({path:join(output,'native-menu-light.png')});await page.keyboard.press('Escape');
 await page.getByRole('radio',{name:'Dark',exact:true}).check();await page.screenshot({path:join(output,'native-en-dark.png')});
 await page.locator('#desktop-language').click();await page.screenshot({path:join(output,'native-menu-dark.png')});await page.keyboard.press('Escape');
 await stop();page=await start();assert.equal(await page.locator('#desktop-language').innerText(),'English');
 await chooseLanguage(page,'简体中文');await page.getByRole('heading',{name:'常规与连接',exact:true}).waitFor();
 await page.getByRole('radio',{name:'浅色',exact:true}).check();await page.screenshot({path:join(output,'native-zh-light.png')});
 await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks:['actual Tauri IPC','Chinese/English UI','native preference survives process restart','light/dark screenshots'],limits:['system picker and tray menu require native visual inspection']},null,2));
 console.log(`LANGUAGE_NATIVE_OK ${output}`);
}finally{await stop();await server.close();}
