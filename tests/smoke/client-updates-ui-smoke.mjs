// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import {build} from "esbuild";
import {createRequire} from "node:module";
import {mkdir} from "node:fs/promises";
import path from "node:path";
const require=createRequire(import.meta.url),{chromium}=require(process.argv[2]||"playwright");
const output=path.resolve("target/client-updates-ui");await mkdir(output,{recursive:true});
const built=await build({entryPoints:["tests/fixtures/client-updates-qa.tsx"],bundle:true,write:false,outdir:output,platform:"browser",format:"iife",jsx:"automatic"});
const browser=await chromium.launch({headless:true,channel:"msedge"});
try{
  const page=await browser.newPage({viewport:{width:1040,height:760}}),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent('<html lang="zh"><body><div id="root"></div></body></html>');
  await page.addStyleTag({content:built.outputFiles.find(f=>f.path.endsWith(".css")).text});
  await page.addScriptTag({content:built.outputFiles.find(f=>f.path.endsWith(".js")).text});
  await page.getByText("发现新版本",{exact:true}).waitFor();
  assert.equal(await page.getByRole("heading",{name:"版本更新",exact:true}).count(),1);
  assert.equal((await page.getByRole("button",{name:"检查更新",exact:true}).boundingBox()).height,28);
  await page.screenshot({path:path.join(output,"available.png")});
  await page.setViewportSize({width:400,height:700});
  await page.evaluate(()=>{window.updateFixture.downloadFail=true;window.updateFixture.downloadDelay=1000;window.updateFixture.verifyDelay=1000;});
  await page.getByRole("button",{name:"下载更新",exact:true}).click();
  await page.getByRole("progressbar").waitFor();await page.getByText("50%",{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,"downloading-narrow.png")});
  assert(await page.evaluate(()=>document.querySelector('.settings-page').scrollWidth<=innerWidth));
  await page.getByText("正在校验更新包…",{exact:true}).waitFor();
  assert(await page.getByRole("button",{name:"检查更新",exact:true}).isDisabled());
  await page.getByRole("alert").filter({hasText:"签名校验失败"}).waitFor();assert.equal(await page.getByRole("button",{name:"安装并重启",exact:true}).count(),0);
  await page.evaluate(()=>{window.updateFixture.downloadFail=false;window.updateFixture.unknownTotal=true;});await page.getByRole("button",{name:"重新下载"}).click();
  await page.getByText("2.0 MB",{exact:true}).waitFor();assert.equal(await page.getByRole("progressbar").getAttribute("value"),null);
  const install=page.getByRole("button",{name:"安装并重启",exact:true});await install.waitFor();
  assert.equal((await install.boundingBox()).height,32);
  await page.evaluate(()=>window.setUpdateBusy(true));await page.waitForFunction(()=>document.querySelector(".settings-actions button:last-child").disabled);assert(await install.isDisabled());
  await page.screenshot({path:path.join(output,"ready-busy.png")});
  await page.evaluate(()=>window.setUpdateBusy(false));await install.click();
  await page.screenshot({path:path.join(output,"confirm-narrow.png")});
  await page.getByRole("button",{name:"稍后",exact:true}).click();assert.equal((await page.evaluate(()=>window.updateFixture.calls)).filter(c=>c==="desktop_update_install").length,0);
  await install.click();await page.getByRole("button",{name:"确认安装并重启"}).click();await page.getByRole("alert").filter({hasText:"还有对话"}).waitFor();
  await page.evaluate(()=>window.updateFixture.current=true);await page.getByRole("button",{name:"检查更新",exact:true}).click();await page.getByText("已是最新版本",{exact:true}).waitFor();
  for(const theme of ["light","dark"]){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:760,height:600});await page.waitForTimeout(180);await page.screenshot({path:path.join(output,`current-${theme}.png`)});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.evaluate(()=>window.updateFixture.checkFail=true);await page.getByRole("button",{name:"检查更新",exact:true}).click();await page.getByRole("alert").filter({hasText:"检查更新超时"}).waitFor();
  await page.evaluate(()=>window.setUpdateEnabled(false));await page.getByText("连接后检查更新",{exact:true}).waitFor();assert(await page.getByRole("button",{name:"检查更新",exact:true}).isDisabled());
  assert.deepEqual(errors,[]);console.log("CLIENT_UPDATES_UI_OK: startup check, signature failure, retry, busy guard, confirmation, native refusal, current version, dark/light layouts");
}finally{await browser.close();}
