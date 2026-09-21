// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real Wry layout acceptance, called after pairing an isolated QA client.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function verifyExecutionLayout(page, output, workspace) {
  await writeFile(path.join(workspace,'layout-fixture.ps1'),
    "1..60 | ForEach-Object { Write-Output ('Layout line ' + $_ + ': ' + ('visible log text ' * 8)) }\nStart-Sleep -Seconds 20\nWrite-Output 'YUANLAYOUTDONE'\n");
  const prompt='This is the isolated UI acceptance workspace. Run device_exec exactly once with program C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe, args ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File","layout-fixture.ps1"], cwd ".". The existing script only prints synthetic log lines and waits 20 seconds. Do not inspect other files or create/edit anything. After completion reply YUANLAYOUTDONE, followed by five short paragraphs describing that this was a UI layout test.';
  await page.getByRole('textbox',{name:'发送消息',exact:true}).fill(prompt);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.locator('.turn-process-toggle .spinner').waitFor({timeout:90000});
  const evidence=[];
  async function check(phase,width,height) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(200);
    const result=await page.evaluate(()=>{
      const list=document.querySelector('.message-list'), form=document.querySelector('.composer');
      const body=document.querySelector('.composer-body'), input=document.querySelector('.composer textarea'),footer=document.querySelector('.composer-footer');
      const dock=document.querySelector('.execution-dock'),group=[...document.querySelectorAll('.conversation-turn')].at(-1);
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
      return {viewport:{width:innerWidth,height:innerHeight},list:rect(list),form:rect(form),input:rect(input),footer:rect(footer),
        inputBodyScroll:body.scrollHeight-body.clientHeight,formOutsideScroll:form.scrollHeight-form.clientHeight,
        groupInHistory:list.contains(group),groupInComposer:form.contains(group),historyOpen:group.querySelector('.turn-process-toggle').getAttribute('aria-expanded')==='true',
        dockScroll:dock?.getClientRects().length?dock.scrollHeight-dock.clientHeight:0,
        pageScroll:document.documentElement.scrollHeight-innerHeight};
    });
    assert(result.groupInHistory&&!result.groupInComposer,'Execution history must belong to the message scroller');
    assert(result.list.bottom<=result.form.top+1,'Composer overlaps messages');
    assert(result.input.height>=48&&result.input.bottom<=result.footer.top+1,'Input is squeezed or obscured');
    assert(result.form.bottom<=height+1&&result.footer.bottom<=height+1,'Composer leaves viewport');
    assert(result.inputBodyScroll<=2&&result.formOutsideScroll<=2,'Short composer unexpectedly scrolls');
    assert(result.pageScroll<=2&&result.dockScroll<=2,'Extra page or execution-list scrollbar');
    if(phase==='running')assert(!result.historyOpen,'Running execution should remain collapsed');
    if(phase==='completed')assert(!result.historyOpen,'Completed execution should collapse');
    await page.screenshot({path:path.join(output,`${phase}-${width}x${height}.png`),fullPage:true});
    evidence.push({phase,...result});
  }
  for(const [width,height] of [[1040,760],[760,600],[1440,900]])await check('running',width,height);
  console.log('EXECUTION_LAYOUT_RUNNING_OK');
  await page.waitForFunction(()=>[...document.querySelectorAll('.bubble-assistant .bubble-content')].some(e=>e.textContent.includes('YUANLAYOUTDONE'))&&!document.querySelector('[aria-label="停止当前任务"]'),null,{timeout:120000});
  assert.equal(await page.locator('.execution-failed,.execution-timed_out').count(),0);
  for(const [width,height] of [[1040,760],[760,600],[1440,900]])await check('completed',width,height);
  await page.locator('.turn-process-toggle').last().click();
  await check('expanded',760,600);
  await page.locator('.turn-process-toggle').last().click();
  await page.setViewportSize({width:1040,height:760});
  console.log('EXECUTION_LAYOUT_COMPLETED_OK');
  return {realLocalAgent:true,modelCompleted:true,checks:evidence};
}
