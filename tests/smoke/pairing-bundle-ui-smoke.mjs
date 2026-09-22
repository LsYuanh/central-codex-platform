// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Exercises the existing settings components with memory-only synthetic IPC.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2]??process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
await mkdir(path.join(root,'target'),{recursive:true});const output=await mkdtemp(path.join(root,'target/pairing-ui-'));
await writeFile(path.join(output,'index.html'),'<div id="root"></div><script type="module" src="/entry.tsx"></script>');
await writeFile(path.join(output,'entry.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import {RuntimeSettings} from '../../apps/desktop/src/runtime-settings';
import '../../apps/desktop/src/styles.css';
function Fixture(){const [draft,setDraft]=React.useState({gatewayUrl:'ws://192.0.2.20:4510/ws',userId:'old-user',deviceId:'old-device',workspaceRoot:'C:\\\\Synthetic workspace'});const [view,setView]=React.useState({saved:draft,effective:draft,uiGatewayUrl:draft.gatewayUrl,agentGatewayUrl:draft.gatewayUrl,overrides:[],hasSaved:true,needsSetup:true,running:false});const [busy,setBusy]=React.useState(false);window.setBusy=setBusy;
return <div style={{maxWidth:800,margin:'0 auto',padding:24,background:'var(--canvas)'}}><h2>连接配置</h2><RuntimeSettings draft={draft} setDraft={setDraft} view={view} busy={busy} applying={false} error="" notice="" reload={()=>{}} onAuthBoundary={()=>{window.boundaries=(window.boundaries??0)+1;}} apply={async config=>{const next=config??draft;window.applied=next;setView({...view,saved:next,effective:next,uiGatewayUrl:next.gatewayUrl,agentGatewayUrl:next.gatewayUrl,needsSetup:false,running:true});return true;}}/></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
const server=await createServer({configFile:false,root:output,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});await server.listen();
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1000,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.calls=[];window.account={authMode:'device-token-v1',paired:false,loggedIn:false};
    window.__TAURI_INTERNALS__={invoke:async(cmd,args)=>{
      window.calls.push({cmd,action:args?.action});
      if(cmd!=='platform_account')throw Error('Unexpected IPC');
      if(args.action==='pair-bundle'){
        if(args.input.code==='yzpair1.expired')throw 'PAIR_BUNDLE_EXPIRED';
        window.account={authMode:'device-token-v1',paired:true,loggedIn:true,user:{id:'paired-user',username:'示例用户'},deviceId:'paired-device',gatewayUrl:'wss://central.example:4510/ws',remoteAvailable:true};
        return window.account;
      }
      if(args.action==='status'){if(window.statusError)throw window.statusError;return window.account;}
      if(args.action==='disconnect'){window.account={authMode:'device-token-v1',paired:false,loggedIn:false};return {localRemoved:true,disconnected:true,remoteRevocationConfirmed:false};}
      throw Error('Unexpected manual configuration');
    }};
  });
  await page.goto(server.resolvedUrls.local[0]);
  const card=page.getByRole('region',{name:'设备配对',exact:true});
  const input=page.getByLabel('一体配对码',{exact:true});
  const refresh=page.getByRole('button',{name:'刷新状态',exact:true});
  const updateStatus=async patch=>{await page.evaluate(p=>Object.assign(window.account,p),patch);await refresh.click();await refresh.waitFor();};
  await input.fill('yzpair1.expired');await page.getByRole('button',{name:'配对并连接',exact:true}).click();
  await page.getByText('一体配对码已过期，请管理员重新生成。').waitFor();
  assert.equal(await page.evaluate(()=>window.applied),undefined);
  assert(!/旧版|手动设置中央地址|CA 证书路径/.test(await page.locator('body').innerText()));
  assert.equal(await page.getByRole('textbox',{name:'中央网关地址',exact:true}).count(),0);
  assert.equal(await page.getByRole('textbox',{name:'用户 ID',exact:true}).count(),0);
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.screenshot({path:path.join(output,'unpaired-light.png'),fullPage:true});
  await input.fill('yzpair1.synthetic');await page.getByRole('button',{name:'配对并连接',exact:true}).click();
  await page.waitForFunction(()=>Boolean(window.applied));
  await card.getByRole('status').filter({hasText:/^已配对$/}).waitFor();
  const applied=await page.evaluate(()=>window.applied);
  assert.equal(applied.gatewayUrl,'wss://central.example:4510/ws');assert.equal(applied.userId,'paired-user');assert.equal(applied.deviceId,'paired-device');assert.match(applied.workspaceRoot,/Synthetic workspace/);
  assert.equal(await input.count(),0,'A paired device must not expose a replacement form');
  assert(!/保存并应用.*开始连接/.test(await card.innerText()));
  await card.getByText('设备详情',{exact:true}).click();await card.getByText('paired-device',{exact:true}).waitFor();
  await card.getByText('设备详情',{exact:true}).click();
  for(const theme of ['light','dark']){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.screenshot({path:path.join(output,`paired-${theme}.png`),fullPage:true});
  }
  await page.setViewportSize({width:460,height:1000});
  await updateStatus({user:{id:'paired-user',username:'很长的关联用户名称用于检查换行'},deviceId:'very-long-device-installation-identity-without-spaces-0123456789abcdef'});
  await card.getByText('设备详情',{exact:true}).click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Narrow settings must not overflow horizontally');
  await page.screenshot({path:path.join(output,'paired-narrow-dark.png'),fullPage:true});
  await page.setViewportSize({width:1000,height:1000});
  await updateStatus({remoteAvailable:false,connectionError:'CENTRAL_CONNECTION_TIMEOUT'});
  await card.getByRole('status').filter({hasText:/^待确认$/}).waitFor();
  assert.equal(await input.count(),0,'Offline pairing must not invite replacement');
  await page.evaluate(()=>window.statusError='CENTRAL_CONNECTION_TIMEOUT');await refresh.click();
  await page.getByText(/暂时无法确认本机配对状态。/).waitFor();
  assert.equal(await card.getByRole('status').filter({hasText:/^已配对$/}).count(),0);
  await page.evaluate(()=>{window.statusError='';});await refresh.click();
  await updateStatus({remoteAvailable:true,authorizationError:'DEVICE_REVOKED'});
  await card.getByRole('status').filter({hasText:/^授权失效$/}).waitFor();await input.waitFor();
  await updateStatus({authorizationError:undefined,storageError:'DEVICE_TOKEN_STORAGE_CORRUPT'});
  await card.getByRole('status').filter({hasText:/^授权异常$/}).waitFor();assert.equal(await input.count(),0);
  await updateStatus({storageError:undefined});
  await page.evaluate(()=>window.setBusy(true));
  await page.waitForFunction(()=>document.querySelector('.pairing-card-footer button').disabled);
  assert(await refresh.isDisabled(),'Active work must lock pairing actions');
  await page.evaluate(()=>window.setBusy(false));
  await page.getByRole('button',{name:'取消本机配对',exact:true}).click();
  await page.getByText(/中央尚未确认撤销/).waitFor();await input.waitFor();
  assert.equal(await page.getByRole('button',{name:'取消本机配对',exact:true}).count(),0);
  assert.match(await page.getByRole('textbox',{name:'默认输出目录',exact:true}).inputValue(),/Synthetic workspace/);
  const calls=await page.evaluate(()=>window.calls);assert(!calls.some(c=>c.action==='set-ca'||c.action==='pair'));
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,syntheticIpc:true,scenarios:['expired','unpaired','paired','details','offline','status-error','revoked','storage-error','busy','disconnect-unconfirmed'],themes:['light','dark'],narrowWidth:460},null,2));
  console.log('PAIRING_BUNDLE_UI_SMOKE_OK '+output);
}catch(error){console.error(error);throw error;}
finally{await browser?.close();await server.close();}
