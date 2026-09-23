// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {readConversation} from '../../services/central-gateway/dist/conversation-reader.js';
const owners=new Map([['source','alice'],['target','alice'],['foreign','bob']]);
const long='中🙂'.repeat(14000);
let calls=0,checks=0;
let history={thread:{id:'target',cwd:'PRIVATE_CENTRAL_PATH',turns:[{id:'t',status:'inProgress',items:[
 {id:'u',type:'userMessage',content:[{type:'text',text:'[platform-message:attachment-1] INTERNAL_ATTACHMENT_INJECTION'}]},
 {id:'a',type:'agentMessage',text:long,phase:'final_answer'},
 {id:'r',type:'reasoning',text:'PRIVATE_REASONING',summary:['PRIVATE_SUMMARY']},
 {id:'s',type:'message',role:'system',content:'PRIVATE_SYSTEM'},
 {id:'tool',type:'dynamicToolCall',tool:'device_exec',contentItems:[{type:'inputText',text:'saved result'},{type:'image',url:'PRIVATE_IMAGE'}]},
]}]}};
const summary={name:'跨设备历史',deviceId:'offline-other-device',isArchived:true,attachmentSubmissions:[{clientMessageId:'attachment-1',turnId:'t',status:'sent',content:'原始提问',attachments:[{name:'说明.pdf',path:'PRIVATE_PATH',data:'PRIVATE_BINARY'}]}]};
const context={userId:'alice',sourceThreadId:'source',owner:id=>owners.get(id),summary:()=>summary,request:async(method,p)=>{calls++;assert.equal(method,'thread/read');assert.deepEqual(p,{threadId:'target',includeTurns:true});return history;},check:()=>{checks++;}};
const first=await readConversation({threadId:'target'},context);
assert.equal(first.archived,true);assert.equal(first.inProgress,true);assert(first.nextCursor);
let page=first,parts=[];
do{parts.push(...page.fragments);if(!page.nextCursor)break;page=await readConversation({threadId:'target',cursor:page.nextCursor},context);}while(true);
assert.equal(parts.filter(p=>p.itemId==='a').map(p=>p.text).join(''),long,'oversize text has no missing or duplicate characters');
assert.equal(parts.find(p=>p.itemId==='a').phase,'final_answer');
assert.match(parts[0].text,/原始提问.*\n.*说明.pdf/);
assert(!JSON.stringify(parts).includes('PRIVATE_'));assert(!JSON.stringify(parts).includes('INTERNAL_ATTACHMENT_INJECTION'));
assert(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p.text)));assert.equal(first.omittedItems,3);
const toolPage=await readConversation({threadId:'target',includeTools:true},context);
page=toolPage;while(page.nextCursor)page=await readConversation({threadId:'target',includeTools:true,cursor:page.nextCursor},context);
assert.match(JSON.stringify(page.fragments),/saved result/);assert(!JSON.stringify(page).includes('PRIVATE_IMAGE'));
const before=calls;
for(const id of ['foreign','absent'])await assert.rejects(readConversation({threadId:id},context),/CONVERSATION_UNAVAILABLE/);
assert.equal(calls,before,'unauthorized ID never reaches Worker');
await assert.rejects(readConversation({threadId:'target',userId:'bob'},context),/ARGUMENTS_INVALID/);
await assert.rejects(readConversation({threadId:'target',cursor:'bad'},context),/CURSOR_INVALID/);
await assert.rejects(readConversation({threadId:'target',includeTools:true,cursor:first.nextCursor},context),/CONVERSATION_CHANGED/);
history.thread.turns[0].items[1].text+='changed';
await assert.rejects(readConversation({threadId:'target',cursor:first.nextCursor},context),/CONVERSATION_CHANGED/);
await assert.rejects(readConversation({threadId:'target'},{...context,request:async()=>{owners.delete('target');return history;}}),/CONVERSATION_UNAVAILABLE/);
owners.set('target','alice');
await assert.rejects(readConversation({threadId:'target'},{...context,request:async()=>({thread:{id:'foreign',turns:[]}})}),/HISTORY_UNAVAILABLE/);
await assert.rejects(readConversation({threadId:'target'},{...context,request:async()=>{throw Error('PRIVATE_CENTRAL_PATH');}}),e=>!String(e).includes('PRIVATE_')&&String(e).includes('HISTORY_UNAVAILABLE'));
await assert.rejects(readConversation({threadId:'target'},{...context,check:()=>{throw Error('CANCELLED');}}),/CANCELLED/);
const empty=await readConversation({threadId:'target'},{...context,summary:()=>({}),request:async()=>({thread:{id:'target',turns:[]}})});
assert.equal(empty.nextCursor,null);assert.deepEqual(empty.fragments,[]);
const legacy=await readConversation({threadId:'target'},{...context,summary:()=>({}),request:async()=>({thread:{id:'target',turns:[{items:[{item:{type:'assistant',message:{content:[{type:'outputText',text:'旧版回答'}]}}}]}]}})});
assert.equal(legacy.fragments[0].text,'旧版回答');
mock.timers.enable({apis:['setTimeout']});
try {
 const timeout=assert.rejects(readConversation({threadId:'target'},{...context,request:()=>new Promise(()=>{})}),/CONVERSATION_READ_TIMEOUT/);
 mock.timers.tick(15001);await timeout;
} finally {mock.timers.reset();}
assert(checks>=calls*2);
console.log('CONVERSATION_READER_OK: pagination, attachment normalization, privacy, ownership, stale cursors, deletion race, cancellation and empty history');
