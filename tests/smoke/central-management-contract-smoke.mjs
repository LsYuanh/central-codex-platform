// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {validateCentralConfig, operationAt, acceptStatusEvent} from '../../services/central-gateway/dist/central-management-contract.js';
const config = {schemaVersion:1,revision:0,dataDirectory:'C:\\中央 数据\\service',listen:{host:'0.0.0.0',port:4510},
  clientUrl:'wss://192.168.3.10:4510/ws',tls:{certificateId:'local-ca-1'},runtimePackageId:'windows-x64-p0',
  limits:{maxWorkers:8,perUserTurns:2,totalTurns:8},shutdown:{graceMs:10000,forceMs:5000}};
let count = 0;
function check(name, fn) { fn(); count++; console.log(`PASS ${name}`); }
check('Windows Unicode/space path accepted',()=>assert.equal(validateCentralConfig(config,'win32').ok,true));
check('macOS absolute path accepted',()=>assert.equal(validateCentralConfig({...config,dataDirectory:'/Users/test/中央 数据'},'darwin').ok,true));
for (const clientUrl of ['ws://192.168.3.10:4510/ws','wss://localhost:4510/ws','wss://0.0.0.0:4510/ws','wss://127.1:4510/ws',
  'wss://[::1]:4510/ws','wss://name.localhost:4510/ws','wss://[::ffff:127.0.0.1]:4510/ws','wss://192.168.3.10:4511/ws',
  'wss://secret@192.168.3.10:4510/ws','wss://192.168.3.10:4510/ws?token=synthetic',
  ' wss://192.168.3.10:4510/ws','wss://192.168.3.10:4510/w\ns'])
  check(`reject invalid client URL ${clientUrl}`,()=>assert.equal(validateCentralConfig({...config,clientUrl},'win32').ok,false));
for (const dataDirectory of ['C:\\','relative','\\\\server\\share','C:\\data:stream','C:\\data\u0000oops','C:\\data\\..','C:\\data\\..\\other',
  'C:\\data.','C:\\data \\child','C:\\CON','C:\\data\\NUL.txt','C:\\COM¹\\child'])
  check('reject unsafe data path',()=>assert.equal(validateCentralConfig({...config,dataDirectory},'win32').ok,false));
for (const mutation of [{schemaVersion:2},{secret:'SYNTHETIC'}, {listen:{host:'0.0.0.0',port:4510,allowInsecure:true}},
  {limits:{maxWorkers:8,perUserTurns:9,totalTurns:8}},{shutdown:{graceMs:Infinity,forceMs:5000}},
  {runtimePackageId:'../../ordinary-codex.exe'}])
  check('reject incompatible or injected configuration',()=>assert.equal(validateCentralConfig({...config,...mutation},'win32').ok,false));
check('validation errors do not echo input values',()=>assert.ok(!JSON.stringify(validateCentralConfig({...config,password:'SYNTHETIC_PASSWORD'},'win32')).includes('SYNTHETIC_PASSWORD')));
check('valid DTO detached from renderer input',()=>{
  const input=structuredClone(config), result=validateCentralConfig(input,'win32');
  input.limits.maxWorkers=128; assert.equal(result.config.limits.maxWorkers,8);
});
check('inherited required fields rejected',()=>assert.equal(validateCentralConfig(Object.create(config),'win32').ok,false));
check('missing own field rejected',()=>{
  const input=structuredClone(config); delete input.limits.totalTurns;
  assert.equal(validateCentralConfig(input,'win32').ok,false);
});
check('accessor input rejected without invoking it',()=>{
  const input=structuredClone(config);
  Object.defineProperty(input.listen,'port',{enumerable:true,get(){throw Error('SYNTHETIC_PRIVATE_ERROR');}});
  assert.equal(validateCentralConfig(input,'win32').ok,false);
});
check('non-enumerable required field rejected',()=>{
  const input=structuredClone(config); Object.defineProperty(input,'revision',{value:0,enumerable:false});
  assert.equal(validateCentralConfig(input,'win32').ok,false);
});
check('symbol property rejected',()=>assert.equal(validateCentralConfig({...config,[Symbol('private')]:true},'win32').ok,false));
const operation={id:'test-operation',kind:'start',phase:'running',startedAt:0,deadlineAt:1000};
check('timeout becomes unknown, never success',()=>assert.equal(operationAt(operation,1000).phase,'unknown'));
check('completed operation stays completed',()=>assert.equal(operationAt({...operation,phase:'succeeded'},2000).phase,'succeeded'));
check('pending operation remains pending before deadline',()=>assert.equal(operationAt(operation,999).phase,'running'));
const snapshot={protocol:'central-management/v1',instanceId:'instance-a',sequence:10};
check('ignore stale status events',()=>assert.equal(acceptStatusEvent(snapshot,{...snapshot,sequence:9}),snapshot));
check('old instance cannot update restarted service',()=>assert.equal(acceptStatusEvent(snapshot,{...snapshot,instanceId:'old',sequence:99}),snapshot));
check('same-instance next event accepted',()=>assert.equal(acceptStatusEvent(snapshot,{...snapshot,sequence:11}).sequence,11));
check('invalid sequence cannot poison event ordering',()=>{
  for(const sequence of [NaN,Infinity,10.5,Number.MAX_SAFE_INTEGER+1])
    assert.equal(acceptStatusEvent(snapshot,{...snapshot,sequence}),snapshot);
});
console.log(`CENTRAL_MANAGEMENT_CONTRACT_OK ${count}`);
