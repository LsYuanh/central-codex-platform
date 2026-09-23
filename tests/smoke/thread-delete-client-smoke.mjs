// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['apps/desktop/src/codexia-gateway-adapter.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {CodexiaGatewayAdapter}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const calls=[];let failure;
const reply={id:1,result:{}};
const adapter=new CodexiaGatewayAdapter({request:async(method,params)=>{calls.push({method,params});if(failure)throw failure;return reply;}});
assert.equal(await adapter.threadDelete('owned-thread'),reply);
assert.deepEqual(calls,[{method:'thread/delete',params:{threadId:'owned-thread'}}]);
for(const error of [new Error('App Server request failed: {"code":-32602,"message":"REMOTE_WORKSPACE_UNSUPPORTED: thread/delete"}'),'REMOTE_WORKSPACE_UNSUPPORTED: thread/delete']) {
  failure=error;await assert.rejects(adapter.threadDelete('owned-thread'),error=>/升级中央服务/.test(error.message)&&/本次未删除/.test(error.message)&&error.cause===failure);
}
for(const message of ['REMOTE_WORKSPACE_UNSUPPORTED: thread/deleteAll','Request timed out','permission denied','failed to delete thread: storage failure']) {
  failure=new Error(message);await assert.rejects(adapter.threadDelete('owned-thread'),error=>error===failure);
}
assert.equal(calls.length,7,'Deletion must never be retried automatically');
console.log('THREAD_DELETE_CLIENT_OK: exact legacy denial translated; failures preserved; no automatic retry');
