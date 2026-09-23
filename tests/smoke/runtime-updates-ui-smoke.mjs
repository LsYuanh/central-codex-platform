// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Isolated native Windows UI only: no config, account, runtime download or service launch.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
assert(process.env.RUNTIME_UPDATE_QA_EXE,'Use a development binary with identifier com.centralcodex.harnessqa.runtimeupdates');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/runtime-updates-ui-'));
const server=await createServer({root:resolve('apps/central'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:1424,strictPort:true,fs:{allow:[resolve('.')]}}});
await server.listen();let child,browser;
try {
  child=spawn(process.env.RUNTIME_UPDATE_QA_EXE,[],{windowsHide:true,stdio:'ignore',env:{...process.env,APPDATA:output,LOCALAPPDATA:output,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9227'}});
  for(let i=0;i<40;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9227');break;}catch{await delay(500);}}
  assert(browser,'Expected isolated QA WebView');
  let page=browser.contexts().flatMap(context=>context.pages())[0];page.setDefaultTimeout(15000);
  await page.locator('.central-shell').waitFor();
  assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),'com.centralcodex.harnessqa.runtimeupdates');
  await page.getByRole('button',{name:'设置与诊断',exact:true}).click();
  await page.getByText('此平台暂不支持自动更新',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'检查更新',exact:true}).isDisabled(),true);
  await page.screenshot({path:join(output,'native-windows.png'),fullPage:true});
  await browser.close();browser=undefined;
  if(child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}child=undefined;
  // Tauri freezes its real IPC object. Use a separate browser for Mac-only status fixtures.
  browser=await chromium.launch({channel:'msedge',headless:true});
  page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(15000);
  await page.addInitScript(()=>{
    window.isTauri=true;
    window.runtimeFixture={state:'waiting-for-idle',code:null,checks:0,fail:false};
    window.__TAURI_INTERNALS__={invoke:async(command)=>{
      if(command==='central_runtime_update_status'){
        if(window.runtimeFixture.fail)throw Error('fixture read failure');
        return {...window.runtimeFixture,currentVersion:'0.153.4',latestVersion:'0.156.1',checkedAt:Date.now()};
      }
      if(command==='central_runtime_update_check'){window.runtimeFixture.checks++;return;}
      if(command==='central_config_read')return {initialized:false,config:null};
      if(command==='central_ui_context')return {dataDirectory:'/synthetic',platform:'darwin',runtimeAvailable:false};
      if(['central_runtime_catalog','central_tls_list','central_model_accounts_list'].includes(command))return [];
      if(command==='central_service_status')return {state:'stopped',generation:0,sequence:0,cleanupVerified:true};
      throw Error('synthetic unavailable');
    }};
  });
  await page.goto('http://127.0.0.1:1424');
  await page.getByRole('button',{name:'设置与诊断',exact:true}).click();
  await page.getByText('等待任务结束',{exact:true}).waitFor();
  await page.getByRole('button',{name:'检查更新',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.runtimeFixture.checks),1);
  await page.getByText('已安排检查，将在 30 秒内开始。',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'synthetic-waiting.png'),fullPage:true});
  await page.evaluate(()=>{window.runtimeFixture.state='rolled-back';window.runtimeFixture.code='SERVICE_UPDATE_VERIFY_FAILED';});
  await page.getByText('已恢复上一版',{exact:true}).waitFor();
  await page.screenshot({path:join(output,'synthetic-rolled-back.png'),fullPage:true});
  await page.evaluate(()=>{window.runtimeFixture.fail=true;});
  await page.getByRole('button',{name:'运行概览',exact:true}).click();
  await page.getByRole('button',{name:'设置与诊断',exact:true}).click();
  await page.getByText('更新状态暂不可用',{exact:true}).waitFor();
  assert.equal(await page.getByText('正在读取更新状态…',{exact:true}).count(),0);
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks:['native unsupported status IPC','synthetic waiting/manual check/rollback/read failure'],limits:['Mac activation and real runtime rollback not exercised']},null,2));
  console.log('RUNTIME_UPDATES_UI_OK '+output);
} finally {
  await browser?.close();
  if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
  await server.close();
}
