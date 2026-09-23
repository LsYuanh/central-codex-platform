// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['apps/desktop/src/archived-chats.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {loadArchivedChats}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const parse=result=>result.data.filter(row=>typeof row?.id==='string');
let calls=0;
const client={threadList:async params=>{calls++;assert.equal(params.archived,true);return {result:params.cursor?{data:[{id:'one'},{id:'two'}],nextCursor:null}:{data:[{id:'one'}],nextCursor:'next'}};}};
assert.deepEqual((await loadArchivedChats(client,()=>true,parse)).map(r=>r.id),['one','two']);assert.equal(calls,2);
for(const result of [{}, {data:[{}]}, {data:[],nextCursor:3}, {data:[],nextCursor:''}]){
 await assert.rejects(loadArchivedChats({threadList:async()=>({result})},()=>true,parse),/格式异常|无效记录|分页异常/);
}
calls=0;await assert.rejects(loadArchivedChats({threadList:async()=>{calls++;return {result:{data:[],nextCursor:'same'}};}},()=>true,parse),/分页异常/);assert.equal(calls,2);
let current=true;calls=0;
await assert.rejects(loadArchivedChats({threadList:async()=>{calls++;current=false;return {result:{data:[{id:'old'}],nextCursor:'next'}};}},()=>current,parse),/连接已变化/);assert.equal(calls,1);
console.log('ARCHIVED_CHATS_LOAD_OK: deduplicated pagination, malformed rows/cursors rejected, old connection discarded');
