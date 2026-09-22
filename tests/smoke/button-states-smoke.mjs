// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Exercise the real desktop stylesheet in the browser, including cascade order.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const css=await readFile('apps/desktop/src/styles.css','utf8');
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/button-states-'));
const cases=[
 {id:'suggestion',label:'技能候选操作',parent:'skill-suggestions',hover:'--hover',color:'--ink'},
 {id:'model',label:'模型菜单',parent:'model-picker-submenu-panel',hover:'--hover',color:'--ink'},
 {id:'thread',label:'对话菜单',parent:'thread-actions-menu',hover:'--hover',color:'--ink'},
 {id:'settings',label:'设置导航',parent:'settings-nav',hover:'--rail-hover',color:'--ink-muted'},
 {id:'icon',label:'图标按钮',button:'text-icon-button',hover:'--hover',color:'--ink'},
 {id:'secondary',label:'次要按钮',button:'button-secondary',hover:'--hover',color:'--ink'},
 {id:'primary',label:'默认主按钮',hover:'--primary-hover',color:'--on-primary'},
 {id:'send',label:'发送按钮',button:'send-button',hover:'--send-accent-hover',color:'--on-send-accent'},
 {id:'selected',label:'选中导航',parent:'settings-nav',button:'active',hover:'--selected',color:'--ink'},
 {id:'process',label:'处理过程',button:'turn-process-toggle',hover:null,color:'--ink',filter:'none'},
];
const browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1120,height:900}});
const results=[];
function contrast(a,b){const luminance=c=>c.match(/[\d.]+/g).slice(0,3).map(n=>{const x=Number(n)/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
try{
 await page.setContent(`<style>${css}</style><style>body{overflow:auto;padding:24px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}section{padding:16px;background:var(--surface-raised);border:1px solid var(--line);border-radius:12px}section>p{font-size:12px;color:var(--ink-muted)}.sample{position:static;width:auto;max-height:none;box-shadow:none;display:block}#process{display:block}#icon,#send{width:auto;min-width:100px}button{transition:none!important}</style><main>${cases.map(c=>`<section><p>${c.label}</p><div class="sample ${c.parent??''}"><button type="button" id="${c.id}" class="${c.button??''}">${c.html??c.label}</button></div></section>`).join('')}</main>`);
 const styles=async locator=>locator.evaluate(el=>{const s=getComputedStyle(el),root=getComputedStyle(document.documentElement);return {background:s.backgroundColor,color:s.color,filter:s.filter,cursor:s.cursor,hover:el.matches(':hover'),tokens:Object.fromEntries(['--hover','--rail-hover','--primary-hover','--on-primary','--ink','--ink-muted','--selected','--send-accent-hover','--on-send-accent','--surface-raised'].map(k=>{const probe=document.createElement('span');probe.style.color=root.getPropertyValue(k);document.body.append(probe);const rgb=getComputedStyle(probe).color;probe.remove();return [k,rgb];}))};});
 for(const theme of ['light','dark']){
  await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const c of cases){
   const button=page.locator('#'+c.id);await button.hover();const state=await styles(button);
   assert.equal(state.background,c.hover?state.tokens[c.hover]:'rgba(0, 0, 0, 0)',theme+' '+c.id+' hover background');
   assert.equal(state.color,state.tokens[c.color],theme+' '+c.id+' text');
   const background=c.hover?state.background:state.tokens['--surface-raised'];assert(contrast(state.color,background)>=4.5,theme+' '+c.id+' text contrast');
   if(c.id==='suggestion')await page.screenshot({path:join(output,theme+'-suggestion-hover.png')});
   await page.mouse.down();assert.equal((await styles(button)).filter,c.filter??'brightness(0.95)',theme+' '+c.id+' pressed');await page.mouse.up();
   await button.evaluate(el=>el.disabled=true);await page.mouse.move(0,0);const idle=await styles(button);await button.hover();const disabled=await styles(button);assert.equal(disabled.background,idle.background,theme+' '+c.id+' disabled hover');assert.equal(disabled.color,idle.color);assert.equal(disabled.filter,'none');assert.equal(disabled.cursor,c.id==='process'?'default':'not-allowed',theme+' '+c.id+' disabled cursor');
   await button.evaluate(el=>el.disabled=false);results.push({theme,component:c.id,passed:true});
  }
 }
 await writeFile(join(output,'result.json'),JSON.stringify({passed:true,results},null,2));console.log('BUTTON_STATES_OK '+output);
}catch(e){await page.screenshot({path:join(output,'failure.png')});throw e;}
finally{await browser.close();}
