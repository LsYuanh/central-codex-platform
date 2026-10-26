// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {DeviceReviewTickets,needsDeviceApproval,permissionMode} from '../../services/central-gateway/dist/device-approvals.js';
assert.throws(()=>permissionMode('never'),/INVALID/);
for(const mode of ['ask','auto','full'])assert.equal(permissionMode(mode),mode);
for(const args of [{program:'echo',args:['ok']},{program:'powershell',args:['-Command','Get-Content foo; Remove-Item foo']},{sessionId:'s',stdin:'rm file'}])assert(needsDeviceApproval('exec',args,'device_exec'));
assert(!needsDeviceApproval('exec',{sessionId:'s',offset:0},'device_exec'));
assert(!needsDeviceApproval('workspace/read_text',{},'device_workspace_read_text'));
for(const method of ['workspace/apply_patch','file/write_text','file/copy','file/publish',undefined])assert(needsDeviceApproval(method,{},'unknown'));
const tickets=new DeviceReviewTickets(),identity={bridge:{},clientId:'a',threadId:'t',turnId:'turn'};
const first=tickets.prepare(identity);
assert.throws(()=>tickets.complete({...identity,bridge:{}},first.token,{id:1,outcome:'approved',reason:''}),/STALE/);
assert.throws(()=>tickets.complete({...identity,turnId:'other'},first.token,{id:1,outcome:'approved',reason:''}),/STALE/);
tickets.complete(identity,first.token,{id:1,outcome:'approved',reason:''});assert.equal((await first.completion).id,1);
assert.throws(()=>tickets.complete(identity,first.token,{id:2,outcome:'approved',reason:''}),/STALE/);
const cancelled=tickets.prepare(identity);const rejected=assert.rejects(cancelled.completion,/DISCONNECTED/);
tickets.cancel(p=>p.clientId==='a','DISCONNECTED');await rejected;
const timeout=tickets.prepare(identity,10);await assert.rejects(timeout.completion,/TIMEOUT/);
console.log('PASS permission policy, concrete read allowlist, invocation identity, single use, cancellation and timeout');
