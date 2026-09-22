// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real skills UI with an in-memory service; no central changes or script execution.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/skills-panel-'));
const source=resolve('apps/desktop/src').replaceAll('\\','/');
const description='扫描 Windows 系统盘常见垃圾，评估清理风险，生成待确认计划，并在明确授权后执行。';
const content='---\nname: disk-cleanup\ndescription: "example"\n---\n# 磁盘清理\n\n先扫描，再确认。\n\n## 使用步骤\n\n- 检查空间\n- 评估清理风险\n- 等待用户确认\n\n```powershell\nGet-PSDrive -PSProvider FileSystem\n```\n\n<script>window.unsafe=true</script>\n';
await writeFile(join(output,'index.html'),'<html><meta charset="utf-8"><style>.settings-page{background:var(--canvas)}</style><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>');
await writeFile(join(output,'fixture.tsx'),`
import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
import {SkillsPanel} from '/@fs/${source}/skills.tsx';import '/@fs/${source}/styles.css';
const body=${JSON.stringify(content)};
const files=[{path:'SKILL.md',bytes:350,content:body},{path:'scripts/proof.ps1',bytes:21,content:'Write-Output "proof"'},{path:'assets/template.bin',bytes:8}];
function Fixture(){
 const [rows,setRows]=useState(Array.from({length:6},(_,i)=>({id:'id-'+i,name:['disk-cleanup','document-report','code-review','meeting-notes','spreadsheet-helper','weekly-report'][i],description:i===0?${JSON.stringify(description)}:'整理参考资料与模板，帮助完成日常工作。',enabled:i!==5,automatic:true,revision:3,platforms:['windows'],programs:['powershell']})));
 const [drafts,setDrafts]=useState([{id:'draft-1',path:'C:/example/skills/draft'}]);
 const [disabled,setDisabled]=useState(false),[available,setAvailable]=useState(true),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const state=useRef({calls:[],used:[],created:[],fail:false});
 const service={rows,drafts,loading,error,available,refresh:async()=>{},request:async(method,params)=>{
  state.current.calls.push({method,params});if(state.current.fail)throw Error('测试：读取失败，请重试');
  if(method==='skill/read')return {files,content:files.find(f=>f.path===(params.file??'SKILL.md')).content??'二进制文件'};
  if(method==='skill/update'){setRows(rs=>rs.map(s=>s.id===params.id?{...s,...params,revision:s.revision+1}:s));return {};}
  if(method==='skill/remove'){setRows(rs=>rs.filter(s=>s.id!==params.id));return {};}
  if(method==='skill/draft')return {prompt:'创建草稿 '+(params.skillId??'new')};
  if(method==='skill/preview')return {previewId:'preview-1',name:'draft-skill',description:'草稿预览说明',platforms:[],programs:[],files};
  if(method==='skill/save'||method==='skill/discard'){setDrafts([]);return {};}
  throw Error('Unexpected '+method);
 }};
 window.qa={state:state.current,rows,setDisabled,setAvailable,setLoading,setError,setRows};
 return <main className="settings-page"><SkillsPanel service={service} disabled={disabled} startDraft={p=>state.current.created.push(p)} useSkill={s=>state.current.used.push(s)}/></main>;
}createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const server=await createServer({configFile:false,root:output,cacheDir:join(output,'.vite'),plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});
await server.listen();const browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1120,height:820}});page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=fn=>page.waitForFunction(fn);
const open=async(name='disk-cleanup')=>{await page.getByRole('button',{name:'查看 '+name,exact:true}).click();await page.locator('.skill-dialog[open]').waitFor();await page.waitForFunction(()=>!document.querySelector('.skill-dialog .text-icon-button').disabled);};
const close=()=>page.getByRole('button',{name:'关闭技能详情',exact:true}).click();
try{
 await page.goto(server.resolvedUrls.local[0]);await page.locator('.skill-card').first().waitFor();
 assert.equal(await page.getByRole('heading',{name:'我的技能',exact:true}).count(),1);
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.locator('.skill-card').first().hover();
  await page.screenshot({path:join(output,'list-'+theme+'.png')});await open();
  assert.equal(await page.getByRole('heading',{name:'磁盘清理',exact:true}).count(),1);assert.equal(await page.locator('.skill-file-content script').count(),0);
  assert.equal(await page.evaluate(()=>window.unsafe),undefined);assert(!await page.locator('.skill-file-content').innerText().then(s=>s.includes('description:')));
  // Capture after the shared 140ms button transition has settled.
  await page.waitForTimeout(180);await page.screenshot({path:join(output,'detail-'+theme+'.png')});
  // Native dialog keeps keyboard focus in the modal and Escape restores card focus.
  await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.querySelector('.skill-dialog').contains(document.activeElement)));
  await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('.skill-card').first().evaluate(e=>e===document.activeElement),true);
 }
 const search=page.getByRole('searchbox',{name:'搜索技能'});await search.fill('清理风险');assert.equal(await page.locator('.skill-card').count(),1);await search.fill('not-found');await page.getByText('没有匹配的技能，试试其他名称或关键词。').waitFor();await search.fill('');
 await open();await page.getByRole('button',{name:'查看源码',exact:true}).click();assert.match(await page.locator('.skill-file-content').innerText(),/description:/);await page.getByRole('button',{name:'阅读视图',exact:true}).click();await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}},configurable:true}));await page.locator('.skill-file-content').getByRole('button',{name:'复制',exact:true}).click();await page.getByRole('button',{name:'已复制',exact:true}).waitFor();assert.match(await page.evaluate(()=>window.copied),/Get-PSDrive/);
 await page.getByRole('combobox',{name:'技能文件'}).selectOption('scripts/proof.ps1');assert.equal((await page.locator('.skill-file-content').innerText()).trim(),'Write-Output "proof"');
 await page.evaluate(()=>window.qa.state.fail=true);await page.getByRole('combobox',{name:'技能文件'}).selectOption('SKILL.md');await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('combobox',{name:'技能文件'}).inputValue(),'scripts/proof.ps1');await page.evaluate(()=>window.qa.state.fail=false);
 await page.getByRole('combobox',{name:'技能文件'}).selectOption('SKILL.md');await page.getByRole('heading',{name:'磁盘清理',exact:true}).waitFor();
 await page.getByRole('switch',{name:'启用技能'}).click();await check(()=>!window.qa.rows[0].enabled);assert(await page.getByRole('button',{name:'立即使用',exact:true}).isDisabled());
 await page.getByRole('switch',{name:'启用技能'}).click();await check(()=>window.qa.rows[0].enabled);
 await page.locator('.skill-more summary').click();await page.getByRole('button',{name:/自动匹配/}).click();await check(()=>!window.qa.rows[0].automatic);await page.keyboard.press('Escape');assert.equal(await page.locator('.skill-dialog[open]').count(),1);
 await page.getByRole('button',{name:'立即使用',exact:true}).click();await check(()=>window.qa.state.used.length===1);assert.equal((await page.evaluate(()=>window.qa.state.used[0])).revision,6);assert.equal(await page.locator('dialog[open]').count(),0);
 await open();await page.getByRole('button',{name:'删除技能',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('.skill-delete-dialog[open]').count(),0);assert.equal(await page.locator('.skill-dialog[open]').count(),1);
 await page.getByRole('button',{name:'删除技能',exact:true}).click();await page.locator('.skill-delete-dialog').getByRole('button',{name:'删除技能',exact:true}).click();await check(()=>window.qa.rows.length===5);assert.equal(await page.locator('dialog[open]').count(),0);
 await page.getByRole('button',{name:'预览并保存',exact:true}).click();await page.locator('.skill-dialog[open]').waitFor();await page.getByRole('combobox',{name:'技能文件'}).selectOption('assets/template.bin');await page.getByText('二进制资源，已列入技能包。',{exact:true}).waitFor();await page.getByRole('button',{name:'确认保存',exact:true}).click();await page.getByText('技能已保存，同一用户的其他设备可刷新后调用。').waitFor();
 await page.getByRole('button',{name:'创建技能',exact:true}).click();await check(()=>window.qa.state.created.length===1);
 await open('document-report');await page.locator('.skill-more summary').click();await page.getByRole('button',{name:'对话修改',exact:true}).click();await check(()=>window.qa.state.created.length===2);await close();
 await page.evaluate(()=>window.qa.setDisabled(true));await open('document-report');assert(await page.getByRole('button',{name:'立即使用',exact:true}).isDisabled());await close();await page.evaluate(()=>window.qa.setDisabled(false));
 await page.setViewportSize({width:760,height:600});await page.emulateMedia({reducedMotion:'reduce'});await open('document-report');const box=await page.locator('.skill-dialog').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=760&&box.y+box.height<=600);await page.screenshot({path:join(output,'narrow-detail.png')});await close();await page.evaluate(()=>window.qa.setRows(rs=>rs.map(s=>({...s,description:'长说明'.repeat(300),programs:Array.from({length:30},(_,i)=>'program-'+i)}))));await open('document-report');const footer=await page.locator('.skill-dialog-actions').first().boundingBox();assert(footer.y+footer.height<=600);await close();
 await page.evaluate(()=>window.qa.setAvailable(false));await page.getByText('连接支持个人技能的中央服务后可用。').waitFor();assert(await page.getByRole('button',{name:'创建技能',exact:true}).isDisabled());
 await page.evaluate(()=>{window.qa.setAvailable(true);window.qa.setRows([]);});await page.getByRole('heading',{name:'把常用流程变成技能'}).waitFor();
 assert.deepEqual(errors,[]);console.log('SKILLS_PANEL_OK '+output);
}catch(e){await page.screenshot({path:join(output,'failure.png')});console.error(errors);throw e;}
finally{await browser.close();await server.close();}
