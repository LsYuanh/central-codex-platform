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
import {ConnectionModePicker} from '../../apps/desktop/src/ConnectionModePicker';
import {ThemePicker} from '../../apps/desktop/src/ThemePicker';
import {initializeInputFocus} from '../../apps/desktop/src/input-focus';
import '../../apps/desktop/src/styles.css';
initializeInputFocus();
function Fixture(){const [draft,setDraft]=React.useState({gatewayUrl:'ws://192.0.2.20:4510/ws',userId:'old-user',deviceId:'old-device',workspaceRoot:'C:\\\\Synthetic workspace'});const [view,setView]=React.useState({saved:draft,effective:draft,uiGatewayUrl:draft.gatewayUrl,agentGatewayUrl:draft.gatewayUrl,overrides:[],hasSaved:true,needsSetup:true,running:false});const [busy,setBusy]=React.useState(false);window.setBusy=setBusy;const [theme,setTheme]=React.useState('light');const [error,setError]=React.useState('');const [mode,setMode]=React.useState('central-gateway');
return <main className="settings-page connection-settings-page"><header className="settings-header"><div><h1>常规与连接</h1><p>外观、设备连接与文件保存位置。</p></div></header><div className="settings-content connection-settings"><section className="settings-section"><div className="settings-section-heading"><h2>外观</h2></div><div className="theme-settings-card"><div className="settings-field"><span><strong>主题</strong><small>立即应用，下次启动时保留。</small></span><ThemePicker value={theme} onChange={value=>{setTheme(value);document.documentElement.dataset.theme=value;}}/></div></div></section><RuntimeSettings connectionStatus={<div className="connection-status-grid"><div className="connection-status-item"><strong>中央网关</strong><span className="status-pill pill-online"><span/>已连接</span></div><div className="connection-status-item"><strong>本机设备</strong><span className="status-pill pill-online"><span/>在线</span></div></div>} draft={draft} setDraft={setDraft} view={view} busy={busy} applying={false} error={error} notice="" reload={()=>{setDraft(view.saved);setError('');}} onAuthBoundary={()=>{window.boundaries=(window.boundaries??0)+1;}} apply={async config=>{const next=config??draft;if(window.failApply){setError('测试：保存失败，请重试。');return false;}setError('');window.applied=next;setView({...view,saved:next,effective:next,uiGatewayUrl:next.gatewayUrl,agentGatewayUrl:next.gatewayUrl,needsSetup:false,running:true});return true;}}/><details className="connection-dev-options" open><summary>开发选项<span>开发版</span></summary><ConnectionModePicker value={mode} disabled={busy} onChange={setMode}/></details></div></main>}
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
      if(cmd==='select_workspace_directory'){if(window.pickerError)throw '测试：选择目录失败';return 'C:\\Synthetic selected';}
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
  const details=card.getByRole('button',{name:'连接详情',exact:true});
  assert.equal(await details.getAttribute('aria-expanded'),'false');assert(!await card.getByText('paired-device',{exact:true}).isVisible());
  await details.click();await card.getByText('paired-device',{exact:true}).waitFor();
  assert(await card.getByRole('button',{name:'取消本机配对',exact:true}).isVisible());await details.click();
  const directory=page.getByRole('textbox',{name:'默认输出目录',exact:true});
  await page.evaluate(()=>window.pickerError=true);await page.getByRole('button',{name:'选择目录',exact:true}).click();await page.getByRole('alert').filter({hasText:'选择目录失败'}).waitFor();
  await page.evaluate(()=>window.pickerError=false);await page.getByRole('button',{name:'选择目录',exact:true}).click();assert.equal(await directory.inputValue(),'C:\\Synthetic selected');
  await page.evaluate(()=>window.failApply=true);await page.getByRole('button',{name:'保存并应用',exact:true}).click();await page.getByText('测试：保存失败，请重试。').waitFor();assert.equal(await directory.inputValue(),'C:\\Synthetic selected');
  await page.getByRole('button',{name:'重新读取配置',exact:true}).click();assert.match(await directory.inputValue(),/Synthetic workspace/);
  await page.evaluate(()=>window.failApply=false);
  await page.setViewportSize({width:1200,height:760});
  const modePicker=page.getByRole('group',{name:'连接模式',exact:true});
  await modePicker.getByRole('radio',{name:'中央网关',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert(await modePicker.getByRole('radio',{name:'本机调试',exact:true}).isChecked());
  await page.getByText('仅用于本机 App Server 开发与协议调试，正式客户端不可用。',{exact:true}).waitFor();
  await modePicker.getByRole('radio',{name:'模拟测试',exact:true}).check();
  await page.getByText('Fake Central / AgentRPC：仅验证设备工具与协议，不运行真实推理。',{exact:true}).waitFor();
  await modePicker.getByRole('radio',{name:'中央网关',exact:true}).check();
  assert.equal((await modePicker.boundingBox()).height,28);
  assert((await page.locator('.connection-group').boundingBox()).height<=80);
  await page.locator('.settings-page').evaluate(el=>el.scrollTop=0);
  for(const theme of ['light','dark']){
    await page.getByRole('radio',{name:theme==='dark'?'深色':'浅色',exact:true}).check();
    await page.waitForTimeout(200);
    const save=await page.getByRole('button',{name:'保存并应用',exact:true}).boundingBox();
    assert(save.y+save.height<=760,'Default settings should keep save in the first screen');
    assert.equal(save.height,32);
    assert.equal((await refresh.boundingBox()).height,28);
    await page.screenshot({path:path.join(output,`paired-${theme}.png`),fullPage:true});
  }
  await page.setViewportSize({width:460,height:1000});
  await updateStatus({user:{id:'paired-user',username:'很长的关联用户名称用于检查换行'},deviceId:'very-long-device-installation-identity-without-spaces-0123456789abcdef'});
  await details.click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Narrow settings must not overflow horizontally');
  await page.screenshot({path:path.join(output,'paired-narrow-dark.png'),fullPage:true});
  const narrowSave=page.getByRole('button',{name:'保存并应用',exact:true});
  await narrowSave.scrollIntoViewIfNeeded();
  const narrowSaveBox=await narrowSave.boundingBox();
  assert(narrowSaveBox.x>=0&&narrowSaveBox.x+narrowSaveBox.width<=460&&narrowSaveBox.y+narrowSaveBox.height<=1000,'Narrow settings must keep save reachable');
  await page.screenshot({path:path.join(output,'paired-narrow-actions-dark.png'),fullPage:true});
  await modePicker.scrollIntoViewIfNeeded();
  const narrowMode=await modePicker.boundingBox();
  assert(narrowMode.x>=0&&narrowMode.x+narrowMode.width<=460,'Mode segments must fit the narrow viewport');
  await page.screenshot({path:path.join(output,'paired-narrow-mode-dark.png'),fullPage:true});
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
  assert(await modePicker.getByRole('radio',{name:'本机调试',exact:true}).isDisabled(),'Active work must lock mode switching');
  await page.evaluate(()=>window.setBusy(false));
  await page.getByRole('button',{name:'取消本机配对',exact:true}).click();
  await page.getByText(/中央尚未确认撤销/).waitFor();await input.waitFor();
  assert.equal(await page.getByRole('button',{name:'取消本机配对',exact:true}).count(),0);
  assert.match(await page.getByRole('textbox',{name:'默认输出目录',exact:true}).inputValue(),/Synthetic workspace/);
  const calls=await page.evaluate(()=>window.calls);assert(!calls.some(c=>c.action==='set-ca'||c.action==='pair'));
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,syntheticIpc:true,scenarios:['expired','unpaired','paired','details','directory-picker-error','save-error-retains-draft','reload','offline','status-error','revoked','storage-error','busy','disconnect-unconfirmed'],themes:['light','dark'],narrowWidth:460},null,2));
  console.log('PAIRING_BUNDLE_UI_SMOKE_OK '+output);
}catch(error){console.error(error);throw error;}
finally{await browser?.close();await server.close();}
