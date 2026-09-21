// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Exercises the existing settings components with memory-only synthetic IPC.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.argv[2]?pathToFileURL(path.resolve(process.argv[2])).href:'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const output=path.join(root,'target/pairing-ui');await mkdir(output,{recursive:true});
await writeFile(path.join(output,'index.html'),'<div id="root"></div><script type="module" src="/entry.tsx"></script>');
await writeFile(path.join(output,'entry.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import {RuntimeSettings} from '../../apps/desktop/src/runtime-settings';
import '../../apps/desktop/src/styles.css';
function Fixture(){const [draft,setDraft]=React.useState({gatewayUrl:'ws://192.0.2.20:4510/ws',userId:'old-user',deviceId:'old-device',workspaceRoot:'C:\\\\Synthetic workspace'});const [view,setView]=React.useState({saved:draft,effective:draft,uiGatewayUrl:draft.gatewayUrl,agentGatewayUrl:draft.gatewayUrl,overrides:[],hasSaved:true,needsSetup:true,running:false});
return <div style={{maxWidth:900,margin:'30px auto',padding:24,background:'#fff'}}><RuntimeSettings draft={draft} setDraft={setDraft} view={view} busy={false} applying={false} error="" notice="" reload={()=>{}} onAuthBoundary={()=>{}} apply={async config=>{window.applied=config;setView({...view,saved:config,effective:config,needsSetup:false,running:true});}}/></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
const server=await createServer({configFile:false,root:output,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}});await server.listen();
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1100,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.calls=[];window.__TAURI_INTERNALS__={invoke:async(cmd,args)=>{
    window.calls.push({cmd,action:args?.action});
    if(cmd!=='platform_account')throw Error('Unexpected IPC');
    if(args.action==='pair-bundle'){
      if(args.input.code==='yzpair1.expired')throw 'PAIR_BUNDLE_EXPIRED';
      return {authMode:'device-token-v1',paired:true,loggedIn:true,user:{id:'paired-user'},deviceId:'paired-device',gatewayUrl:'wss://central.example:4510/ws',remoteAvailable:true};
    }
    if(args.action==='status')return {authMode:'device-token-v1',paired:false,loggedIn:false};
    throw Error('Unexpected manual configuration');
  }};});
  await page.goto(server.resolvedUrls.local[0]);
  const input=page.getByRole('textbox',{name:'一体配对码'}).or(page.locator('input[aria-label="一体配对码"]'));
  await input.fill('yzpair1.expired');await page.getByRole('button',{name:'配对并连接',exact:true}).click();
  await page.getByText('一体配对码已过期，请管理员重新生成。').waitFor();
  assert.equal(await page.evaluate(()=>window.applied),undefined);
  await input.fill('yzpair1.synthetic');
  await page.screenshot({path:path.join(output,'one-code.png'),fullPage:true});
  await page.getByRole('button',{name:'配对并连接',exact:true}).click();
  await page.waitForFunction(()=>Boolean(window.applied));
  const applied=await page.evaluate(()=>window.applied);
  assert.equal(applied.gatewayUrl,'wss://central.example:4510/ws');assert.equal(applied.userId,'paired-user');assert.equal(applied.deviceId,'paired-device');assert.match(applied.workspaceRoot,/Synthetic workspace/);
  const calls=await page.evaluate(()=>window.calls);assert(!calls.some(c=>c.action==='set-ca'||c.action==='pair'));
  assert.deepEqual(errors,[]);
  console.log('PAIRING_BUNDLE_UI_SMOKE_OK expired code recovers; one paste applies gateway and identity automatically; workspace preserved; no manual CA/address calls. Synthetic IPC only.');
}finally{await browser?.close();await server.close();}
