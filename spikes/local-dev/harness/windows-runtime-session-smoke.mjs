// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Protocol/lifecycle negatives using Node as an explicitly fake QA launcher.
// This never starts Codex, AppContainer, Cargo, a broker or a model request.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bounded, createWindowsRuntimeSession} from './windows-runtime-session.mjs';

assert.equal(process.platform, 'win32');
const here=dirname(fileURLToPath(import.meta.url));
const parent=join(here,'../target'); mkdirSync(parent,{recursive:true});
const output=mkdtempSync(join(parent,'windows-session-negative-'));
const checks=[];
for(const scenario of ['malformed-with-queued-tool','tool-queued-before-malformed','throwing-tool-callback','rpc-timeout']) {
  const root=join(output,scenario); mkdirSync(root);
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'commonjs',main:'index.cjs'}));
  writeFileSync(join(root,'index.cjs'),`
const fs=require('node:fs'), path=require('node:path');
// Synthetic protocol fixture only. These flags satisfy the helper's summary
// parser; the parent result explicitly disclaims actual isolation validation.
const summary={scope:'model-runtime-transport-verify-separately',profileCleaned:true,
 jobCloseVerified:true,modelPipeConnections:0,modelPipeTailDrains:0,modelPipeTailDrainCancels:0};
const tool=JSON.stringify({id:'synthetic-tool',method:'item/tool/call',params:{tool:'device_workspace_context',arguments:{}}})+'\\n';
let started=false;
process.stdin.on('data',()=>{
 if(started)return; started=true;
 if(${JSON.stringify(scenario)}==='malformed-with-queued-tool')process.stdout.write('invalid json\\n'+tool);
 if(${JSON.stringify(scenario)}==='tool-queued-before-malformed')process.stdout.write(tool+'invalid json\\n');
 if(${JSON.stringify(scenario)}==='throwing-tool-callback')process.stdout.write(tool);
});
process.stdin.on('end',()=>{
 fs.writeFileSync(path.join(__dirname,'summary.json'),JSON.stringify(summary));
 // Data already queued or produced during cleanup must not dispatch work.
 process.stdout.write(tool,()=>process.exit(0));
});
`);
  let calls=0;
  const lease={token:'synthetic-no-network-lease',certificatePem:'synthetic-no-certificate',forwardPort:1,closed:new Promise(()=>{})};
  const session=createWindowsRuntimeSession({launcher:process.execPath,runtime:process.execPath,root,lease,
    onToolCall(){calls++;throw Error('SYNTHETIC_CALLBACK_FAILURE');}});
  const expected=scenario.includes('malformed')?'QA_NON_JSON_STDOUT':scenario==='throwing-tool-callback'?'QA_TOOL_HANDLER_FAILED':'QA_RPC_TIMEOUT';
  const started=Date.now();
  // Never invoke stop(): the failure itself must settle closed and reap child.
  await assert.rejects(bounded(session.request('synthetic/pending'),35000,'QA_TEST_TIMEOUT'),error=>error.message===expected);
  await bounded(session.closed,5000,'QA_CLOSED_DID_NOT_SETTLE');
  assert.equal(calls,scenario==='throwing-tool-callback'?1:0);
  const evidence=session.safeEvidence();
  assert.equal(evidence.failureCode,expected); assert.equal(evidence.stopped,true);
  assert.equal(evidence.cleanup.modelPipeConnections,0);
  assert.throws(()=>process.kill(session.pid,0),error=>error.code==='ESRCH');
  await assert.rejects(session.request('synthetic/after-failure'),error=>error.message===expected);
  if(scenario==='rpc-timeout')assert(Date.now()-started>=29000,'Must exercise the actual 30-second RPC deadline');
  checks.push({scenario,passed:true,callbackCount:calls,closedSettled:true,childExited:true,elapsedMs:Date.now()-started});
  console.log('PASS '+scenario);
}
writeFileSync(join(output,'result.json'),JSON.stringify({scope:'session-protocol-lifecycle-with-fake-node-launcher',passed:true,
  realRuntime:false,realIsolation:false,realModel:false,credentialsUsed:false,cargoStarted:false,checks},null,2)+'\n');
console.log('WINDOWS_SESSION_NEGATIVE_OK '+join(output,'result.json'));
