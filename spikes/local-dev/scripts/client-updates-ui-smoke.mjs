// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from "node:assert/strict";
import {build} from "esbuild";
import {createRequire} from "node:module";
import {mkdir} from "node:fs/promises";
import path from "node:path";
const require=createRequire(import.meta.url),{chromium}=require(process.argv[2]||"playwright");
const output=path.resolve("target/client-updates-ui");await mkdir(output,{recursive:true});
const built=await build({entryPoints:["scripts/fixtures/client-updates-qa.tsx"],bundle:true,write:false,outdir:output,platform:"browser",format:"iife",jsx:"automatic"});
const browser=await chromium.launch({headless:true,channel:"msedge"});
try{
  const page=await browser.newPage({viewport:{width:1040,height:760}}),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.setContent('<html lang="zh"><body><div id="root"></div></body></html>');
  await page.addStyleTag({content:built.outputFiles.find(f=>f.path.endsWith(".css")).text});
  await page.addScriptTag({content:built.outputFiles.find(f=>f.path.endsWith(".js")).text});
  await page.getByText("发现新版本 · 0.2.0").waitFor();
  await page.evaluate(()=>window.updateFixture.downloadFail=true);
  await page.getByRole("button",{name:"下载更新",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"签名校验失败"}).waitFor();assert.equal(await page.getByRole("button",{name:"安装并重启",exact:true}).count(),0);
  await page.evaluate(()=>window.updateFixture.downloadFail=false);await page.getByRole("button",{name:"重新下载"}).click();
  const install=page.getByRole("button",{name:"安装并重启",exact:true});await install.waitFor();
  await page.evaluate(()=>window.setUpdateBusy(true));await page.waitForFunction(()=>document.querySelector(".settings-actions button:last-child").disabled);assert(await install.isDisabled());
  await page.screenshot({path:path.join(output,"ready-busy.png")});
  await page.evaluate(()=>window.setUpdateBusy(false));await install.click();
  await page.getByRole("button",{name:"稍后",exact:true}).click();assert.equal((await page.evaluate(()=>window.updateFixture.calls)).filter(c=>c==="desktop_update_install").length,0);
  await install.click();await page.getByRole("button",{name:"确认安装并重启"}).click();await page.getByRole("alert").filter({hasText:"还有对话"}).waitFor();
  await page.evaluate(()=>window.updateFixture.current=true);await page.getByRole("button",{name:"检查更新",exact:true}).click();await page.getByText("已是最新版本",{exact:true}).waitFor();
  for(const theme of ["light","dark"]){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewportSize({width:760,height:600});await page.screenshot({path:path.join(output,`current-${theme}.png`)});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  assert.deepEqual(errors,[]);console.log("CLIENT_UPDATES_UI_OK: startup check, signature failure, retry, busy guard, confirmation, native refusal, current version, dark/light layouts");
}finally{await browser.close();}
