// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Tauri IPC and UI, isolated application identity. Does not start a gateway.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join, extname, sep} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import http from 'node:http';
import {loadPlaywright} from '../support/playwright.mjs';
const executable=resolve(process.env.RELAY_CENTRAL_QA_EXE||'target/relay-central-qa.exe');
const identifier='com.yuanzhou.harnessqa.relaycentral';
assert((await readFile(executable)).includes(Buffer.from(identifier)), 'Refusing a production application identifier');
const output=resolve('target/relay-native-ui');await mkdir(output,{recursive:true});
const root=resolve('apps/central/dist');
const server=http.createServer(async(request,response)=>{
 try {
  const path=resolve(root,'.'+new URL(request.url,'http://localhost').pathname);
  assert(path===root||path.startsWith(root+sep));
  const file=path===root?join(root,'index.html'):path;
  response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');
  response.end(await readFile(file));
 }catch{response.statusCode=404;response.end();}
});
await new Promise((r,j)=>{server.once('error',j);server.listen(1422,'127.0.0.1',r);});
let child,browser,page,verified=false;
try{
 child=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9234'}});
 const {chromium}=await loadPlaywright();
 for(let i=0;i<40;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9234');break;}catch{await delay(500);}}
 assert(browser,'QA WebView did not start');page=browser.contexts().flatMap(c=>c.pages())[0];page.setDefaultTimeout(15000);
 await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
 assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),identifier);
 verified=true;
 const card=page.locator('.relay-settings');await card.getByRole('heading',{name:'公网中继',exact:true}).waitFor();
 await card.locator('summary').click();
 await card.getByRole('button',{name:'保存中继配置',exact:true}).click();
 await card.getByRole('alert').filter({hasText:'请填写有效的 HTTPS'}).waitFor();
 await card.getByLabel('中继地址',{exact:true}).fill('https://relay.example.com/');
 await card.getByLabel('中继接入密钥',{exact:true}).fill('synthetic-ui-admission-0123456789abcdef');
 await card.getByRole('button',{name:'保存中继配置',exact:true}).click();
 await card.getByRole('status').filter({hasText:'公网中继配置已保存'}).waitFor();
 assert.equal(await card.getByLabel('中继接入密钥',{exact:true}).inputValue(),'');
 const saved=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('central_relay_status'));
 assert.equal(saved.configured,true);assert.equal(saved.state,'waiting-service');assert(!JSON.stringify(saved).includes('synthetic-ui-admission'));
 // Cross several monitor ticks while replacing the private record. Old reads
 // must not overwrite the confirmed save with a transient storage failure.
 for(let attempt=0;attempt<8;attempt++){
  const status=await page.evaluate(async(attempt)=>{
   await window.__TAURI_INTERNALS__.invoke('central_relay_save',{access:{url:'https://relay.example.com/',token:'synthetic-ui-admission-0123456789abcdef-'+attempt,caPem:''}});
   return await window.__TAURI_INTERNALS__.invoke('central_relay_status');
  },attempt);
  assert.equal(status.state,'waiting-service');await delay(250);
 }
 await page.reload();await card.getByRole('status').filter({hasText:'等待中央服务启动'}).waitFor();
 await card.locator('summary').click();
 await card.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'central-relay.png')});
 await card.getByRole('button',{name:'关闭公网中继',exact:true}).click();
 await card.getByRole('status').filter({hasText:'公网中继已关闭'}).waitFor();
 assert.equal((await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('central_relay_status'))).configured,false);
 await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks:['real Tauri UI and IPC','invalid config feedback','encrypted native credential storage','secret absent from public status','reload persistence','disable'],gatewayStarted:false},null,2));
 console.log(JSON.stringify({ok:true,output}));
}catch(error){
 if(page){await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});console.error(await page.locator('.relay-settings').innerText().catch(()=>''));}
 throw error;
}finally{
 if(verified)await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('central_relay_save',{access:null})).catch(()=>{});
 if(child?.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
 await browser?.close().catch(()=>{});await new Promise(r=>server.close(r));
}
