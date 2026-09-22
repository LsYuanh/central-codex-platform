// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Isolated browser regression for the real editor; no central/model requests.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/skill-composer-'));
const source=resolve('apps/desktop/src').replaceAll('\\','/');
await writeFile(join(output,'index.html'),'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
await writeFile(join(output,'fixture.tsx'),`
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SkillComposer} from '/@fs/${source}/SkillComposer.tsx';
import '/@fs/${source}/styles.css';
function Fixture(){
 const [doc,setDoc]=useState({text:'',mentions:[]}),[state,setState]=useState('ready'),[slot,setSlot]=useState('a');
 const editor=useRef(null),drafts=useRef({}),sent=useRef([]);
 const rows=Array.from({length:16},(_,i)=>({id:'id-'+i,name:['disk-cleanup','document-report','skill-proof'][i]??'tool-'+i,revision:3,description:['扫描磁盘，评估风险并按确认清理','生成文档和报告模板','验证个人技能'][i]??'这是完整技能包的简短说明，较长时省略',enabled:true,automatic:false,platforms:[],programs:[]}));
 if(state==='builtin')rows.push({id:'builtin-creator',name:'yuan-zhou-skill-creator',displayName:'创建技能',source:'builtin',revision:1000000,description:'创建或修改远舟个人技能',enabled:true});
 const service={rows:state==='empty'?[]:rows,available:state!=='unavailable',loading:state==='loading',error:state==='error'?'test error':'',refresh:async()=>setState('ready')};
 window.qa={doc,sent:sent.current,setState,switch:()=>{drafts.current[slot]=doc;const next=slot==='a'?'b':'a';setSlot(next);setDoc(drafts.current[next]??{text:'',mentions:[]});}};
 return <main style={{padding:'32px',height:'100vh',display:'flex',alignItems:'flex-end',justifyContent:'center'}}><form className="composer" style={{width:'736px',margin:0}} onSubmit={e=>e.preventDefault()}><div className="composer-shell"><div className="composer-body"><div className="composer-input-wrap"><SkillComposer key={slot} scope={slot} value={doc} onChange={setDoc} editorRef={editor} service={service} disabled={false} skillsDisabled={state==='running'} placeholder="描述任务，按 Enter 发送" onSend={()=>{sent.current.push(doc);setDoc({text:'',mentions:[]});}} onPaste={e=>{if([...e.clipboardData.items].some(i=>i.type.startsWith('image/'))){e.preventDefault();window.qa.imagePasted=true;}}} manage={()=>setState('ready')} /></div></div><div className="composer-footer"><span>＋</span><span style={{marginLeft:'auto',fontSize:12}}>GPT-5.6-Sol low</span><button className="send-button" type="button">↑</button></div></div></form></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const server=await createServer({configFile:false,root:output,plugins:[react()],server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});
await server.listen();const browser=await chromium.launch({headless:true,channel:"msedge"});const page=await browser.newPage({viewport:{width:1100,height:760}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=async(fn)=>{await page.waitForFunction(fn,null,{timeout:5000});};
try {
 await page.goto(server.resolvedUrls.local[0]);const editor=page.getByRole('textbox',{name:'发送消息'});await editor.waitFor();
 await editor.fill('$');await page.getByRole('listbox').waitFor();assert.equal(await page.getByRole('option').count(),16);
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:join(output,'suggestions-'+theme+'.png')});}
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await check(()=>window.qa.doc.mentions[0]?.name==='document-report');assert.equal(await page.evaluate(()=>window.qa.sent.length),0);
 await page.keyboard.insertText('你好');await check(()=>window.qa.doc.text==='$document-report 你好');
 await page.keyboard.press('End');await page.keyboard.insertText(' $磁盘');await page.getByRole('option').waitFor();assert.equal(await page.getByRole('option').count(),1);await page.getByRole('option').click();await check(()=>window.qa.doc.mentions.length===2);
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:join(output,'selected-'+theme+'.png')});}
 await page.evaluate(()=>window.qa.switch());await check(()=>window.qa.doc.text==='');await page.evaluate(()=>window.qa.switch());await check(()=>window.qa.doc.mentions.length===2);assert.equal(await page.locator('.composer-skill-mention').count(),2);
 await editor.click();await page.keyboard.press('Control+End');await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');await check(()=>window.qa.doc.mentions.length===1);
 await page.keyboard.press('Control+z');await check(()=>window.qa.doc.mentions.length===2);await page.keyboard.press('Control+Shift+z');await check(()=>window.qa.doc.mentions.length===1);
 await editor.fill('$unmatched');await page.getByText('没有匹配的技能').waitFor();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.qa.sent.length),0);await page.keyboard.press('Escape');assert.equal(await page.locator('.skill-suggestions').count(),0);
 await editor.fill('');await page.keyboard.insertText('a');await page.keyboard.press('Backspace');await check(()=>window.qa.doc.text==='');await page.keyboard.insertText('空行');await page.keyboard.press('Shift+Enter');await check(()=>window.qa.doc.text==='空行\n');await page.keyboard.press('Shift+Enter');await check(()=>window.qa.doc.text==='空行\n\n');
 await editor.fill('第一行');await page.keyboard.press('Shift+Enter');await page.keyboard.insertText('$disk');await page.keyboard.press('Enter');await check(()=>window.qa.doc.text==='第一行\n$disk-cleanup ');await page.keyboard.press('Control+End');await page.keyboard.insertText('正文');await check(()=>window.qa.doc.text==='第一行\n$disk-cleanup 正文');
 await editor.fill('请用$disk');await page.keyboard.press('Enter');await check(()=>window.qa.doc.text==='请用$disk-cleanup ');await page.keyboard.insertText('你好');
 await editor.press('Control+a');const copied=await editor.evaluate(el=>{const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');});assert.equal(copied,'请用$disk-cleanup 你好');
 await editor.evaluate(el=>{el.dispatchEvent(new ClipboardEvent('cut',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true}));});await check(()=>window.qa.doc.text==='');
 await editor.fill('测试');await page.keyboard.press('Shift+Enter');await page.keyboard.insertText('第二行');await check(()=>window.qa.doc.text==='测试\n第二行');
 await editor.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});assert.equal(await page.evaluate(()=>window.qa.sent.length),0);
 await editor.evaluate(el=>{const data=new DataTransfer();data.setData('text/html','<b>formatted</b>');data.setData('text/plain','纯文本');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});await check(()=>window.qa.doc.text.endsWith('纯文本'));assert.equal(await editor.locator('b').count(),0);
 await editor.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['fixture'],'test.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});assert.equal(await page.evaluate(()=>window.qa.imagePasted),true);
 await editor.fill('$disk');await page.getByRole('option').click();await check(()=>window.qa.doc.mentions[0]?.id==='id-0');await editor.press('Enter');await check(()=>window.qa.sent.length===1);assert.equal((await page.evaluate(()=>window.qa.sent[0])).mentions[0].revision,3);
 for(const state of ['loading','error','empty','unavailable','running']){await page.evaluate(s=>window.qa.setState(s),state);await editor.fill('$');await page.locator('.skill-suggestions').waitFor();assert.equal(await page.getByRole('option').count(),0);await editor.press('Escape');}
 await page.evaluate(()=>window.qa.setState('builtin'));await editor.fill('$创建');await page.getByRole('option').click();await check(()=>window.qa.doc.mentions[0]?.displayName==='创建技能');assert.equal(await page.locator('.composer-skill-mention').innerText(),'创建技能');
 await page.keyboard.insertText(' 把流程做成技能');await check(()=>window.qa.doc.text.startsWith('$yuan-zhou-skill-creator '));await page.evaluate(()=>window.qa.switch());await page.evaluate(()=>window.qa.switch());assert.equal(await page.locator('.composer-skill-mention').innerText(),'创建技能');
 await editor.press('Control+a');const builtinCopy=await editor.evaluate(el=>{const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');});assert(builtinCopy.startsWith('$yuan-zhou-skill-creator '));
 assert.deepEqual(errors,[]);console.log('SKILL_COMPOSER_OK '+output);
}catch(e){await page.screenshot({path:join(output,'failure.png')});console.error({errors,html:await page.locator('.composer-editor').innerHTML(),doc:await page.evaluate(()=>window.qa?.doc)});throw e;}
finally{await browser.close();await server.close();}
