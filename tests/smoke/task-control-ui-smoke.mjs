// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real desktop App and RPC adapter, isolated protocol fixture (no model/real files).
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE??'C:/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
await mkdir('target',{recursive:true});const output=await mkdtemp(resolve('target/task-control-ui-'));
let sequence=0,goal=null,goalError=false,threadExists=false,selectedMode='default',turn=0,pendingQuestion;
const calls=[],unexpected=[],threads=[],sockets=[];
const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>gateway.once('listening',r));
const emit=(socket,name,data)=>socket.send(JSON.stringify({type:'event',name,eventType:'codex.notification',data,sequence:++sequence}));
const finish=(socket,id,plan)=>{
  const item={id:`answer-${id}`,type:plan?'plan':'agentMessage',text:plan?'## 实施计划\n\n1. 读取客户端文件\n2. 修改并验证':'Implementation complete.',phase:'final_answer'};
  emit(socket,'item/completed',{threadId:'qa-thread',turnId:id,item});
  const row={id,status:'completed',items:[item]};threads.push(row);
  emit(socket,'turn/completed',{threadId:'qa-thread',turn:row});
};
gateway.on('connection',socket=>{sockets.push(socket);socket.on('message',raw=>{
  const q=JSON.parse(String(raw));
  if(q.type==='approval.response'){assert.deepEqual(q.result??q.response,{answers:{scope:{answers:['仅当前项目']}}});finish(socket,pendingQuestion,true);return;}
  if(q.type!=='request')return;
  calls.push(q);let data={},error;
  switch(q.operation){
    case 'session.initialize':data={userAgent:'task-control-protocol-fixture',platformCapabilities:{planMode:true,goals:true}};break;
    case 'model.list':data={data:[{id:'fixture',model:'fixture',displayName:'Fixture',isDefault:true,supportedReasoningEfforts:[]}]};break;
    case 'conversation.list':data={data:threadExists?[{id:'qa-thread',name:'模式验收',preview:'QA'}]:[]};break;
    case 'conversation.create':threadExists=true;data={thread:{id:'qa-thread'}};break;
    case 'conversation.resume':case 'conversation.read':data={thread:{id:'qa-thread',turns:threads,status:{type:'idle'}},collaborationMode:selectedMode};break;
    case 'conversation.turn.create':{
      assert.equal(q.payload.collaborationMode.settings.developer_instructions,null);
      selectedMode=q.payload.collaborationMode.mode;const id=`turn-${++turn}`;data={turn:{id},submission:{status:'sent',turnId:id}};
      setTimeout(()=>{emit(socket,'turn/started',{threadId:'qa-thread',turn:{id,status:'inProgress'}});
        if(selectedMode==='plan'){pendingQuestion=id;socket.send(JSON.stringify({type:'approval.request',requestId:'question-1',method:'item/tool/requestUserInput',kind:'user-input',data:{threadId:'qa-thread',questions:[{id:'scope',question:'本次修改范围？',options:[{label:'仅当前项目',description:'保留其他项目'},{label:'全部项目',description:'范围更广'}]}]}}));}
        else finish(socket,id,false);
      },30);break;
    }
    case 'conversation.goal.get':data={goal};break;
    case 'conversation.goal.set':
      if(goalError){error='GOAL_TEST_RETRY';break;}
      goal={threadId:'qa-thread',objective:q.payload.objective??goal?.objective,status:q.payload.status??'active',tokenBudget:q.payload.tokenBudget??goal?.tokenBudget??null,tokensUsed:25,timeUsedSeconds:8};data={goal};emit(socket,'thread/goal/updated',{threadId:'qa-thread',goal});break;
    case 'conversation.goal.clear':goal=null;data={};emit(socket,'thread/goal/cleared',{threadId:'qa-thread'});break;
    default:unexpected.push(q.operation);error=`unsupported fixture ${q.operation}`;
  }
  socket.send(JSON.stringify({type:'response',requestId:q.requestId,ok:!error,...(error?{error}:{data})}));
});});
const server=await createServer({root:resolve('apps/desktop'),configFile:false,plugins:[react()],cacheDir:join(output,'.vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[resolve('.')]}}});await server.listen();
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
  const page=await browser.newPage({viewport:{width:1100,height:820}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'})),`ws://127.0.0.1:${gateway.address().port}/ws?userId=qa&deviceId=qa`);
  await page.goto(server.resolvedUrls.local[0]);await page.getByLabel('协作模式').waitFor();
  for(const socket of sockets)emit(socket,'device/status',{agent:'online',deviceId:'qa'});
  await page.getByLabel('协作模式').selectOption('plan');
  await page.locator('[contenteditable="true"]').fill('先规划改动');
  await page.locator('[contenteditable="true"]').press('Enter');
  await page.getByText('本次修改范围？',{exact:true}).waitFor();
  assert.equal(await page.getByText('发送 JSON 响应',{exact:true}).count(),0);
  await page.getByLabel('仅当前项目保留其他项目').check();
  await page.getByRole('button',{name:'提交回答',exact:true}).click();
  await page.getByRole('button',{name:'开始实施',exact:true}).waitFor();
  assert(await page.getByRole('heading',{name:'实施计划',exact:true}).isVisible());
  await page.screenshot({path:join(output,'plan-light.png')});
  await page.getByRole('button',{name:'开始实施',exact:true}).click();
  await page.getByText('Implementation complete.',{exact:true}).waitFor();
  assert.equal(calls.filter(q=>q.operation==='conversation.turn.create').at(-1).payload.collaborationMode.mode,'default');
  await page.getByRole('button',{name:'设置目标',exact:true}).click();
  await page.getByLabel('目标与验收条件').fill('修复问题并验证全部检查通过');
  await page.getByLabel('Token 预算（可选）').fill('5000');
  goalError=true;await page.getByRole('button',{name:'启动目标',exact:true}).click();await page.getByRole('alert').filter({hasText:'GOAL_TEST_RETRY'}).waitFor();
  assert.equal(await page.getByLabel('目标与验收条件').inputValue(),'修复问题并验证全部检查通过');
  goalError=false;await page.getByRole('button',{name:'启动目标',exact:true}).click();await page.getByRole('button',{name:'暂停目标',exact:true}).waitFor();
  assert.equal(goal.tokenBudget,5000);
  await page.getByRole('button',{name:'暂停目标',exact:true}).click();await page.getByRole('button',{name:'继续目标',exact:true}).waitFor();
  await page.getByRole('button',{name:'继续目标',exact:true}).click();await page.getByRole('button',{name:'暂停目标',exact:true}).waitFor();
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await page.screenshot({path:join(output,'goal-dark.png')});
  await page.setViewportSize({width:400,height:760});await page.screenshot({path:join(output,'goal-narrow.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  goal={...goal,status:'budgetLimited',tokensUsed:5001};for(const socket of sockets)emit(socket,'thread/goal/updated',{threadId:'qa-thread',goal});
  await page.getByRole('button',{name:'调整预算',exact:true}).click();await page.getByLabel('Token 预算（可选）').waitFor();
  await page.getByRole('button',{name:'清除目标',exact:true}).click();await page.getByRole('button',{name:'设置目标',exact:true}).waitFor();assert.equal(goal,null);
  // Fresh App without a selected thread: setup creates the conversation before editing.
  threadExists=false;
  const fresh=await browser.newPage({viewport:{width:1100,height:820}});
  await fresh.addInitScript(url=>localStorage.setItem('codexia.desktop.settings.v1',JSON.stringify({mode:'central-gateway',appUrl:url,theme:'light'})),`ws://127.0.0.1:${gateway.address().port}/ws?userId=qa&deviceId=qa`);
  await fresh.goto(server.resolvedUrls.local[0]);await fresh.getByLabel('协作模式').waitFor();for(const socket of sockets)emit(socket,'device/status',{agent:'online',deviceId:'qa'});
  const beforeCreate=calls.filter(q=>q.operation==='conversation.create').length;
  await fresh.getByRole('button',{name:'设置目标',exact:true}).click();await fresh.getByLabel('目标与验收条件').waitFor();
  assert.equal(calls.filter(q=>q.operation==='conversation.create').length,beforeCreate+1);
  await fresh.getByLabel('目标与验收条件').fill('新目标草稿');goalError=true;
  await fresh.getByRole('button',{name:'启动目标',exact:true}).click();await fresh.getByRole('alert').filter({hasText:'GOAL_TEST_RETRY'}).waitFor();
  assert.equal(await fresh.getByLabel('目标与验收条件').inputValue(),'新目标草稿');goalError=false;await fresh.close();
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks:['plan-mode-wire','structured-questions','plan-visible','implement-default-mode','goal-edit-retry','budget','pause-resume','budget-edit','clear','new-goal-draft-retry','themes','narrow'],calls:calls.map(q=>q.operation)},null,2));
  console.log(JSON.stringify({ok:true,output}));
}finally{await browser.close();await server.close();for(const s of sockets)s.close();await new Promise(r=>gateway.close(r));}
