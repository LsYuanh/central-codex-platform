// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Execute the actual DTO/state helpers with native invocation disabled. This
// fixture never opens an endpoint, reads an account, or changes application data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../apps/central/src/people-client.ts',import.meta.url),'utf8');
const nativeImport="import { nativeCall } from './native';";
assert(source.includes(nativeImport),'fixture must replace exactly the native dependency');
const isolated=source.replace(nativeImport,"const nativeCall = async () => { throw Error('NATIVE_CALL_FORBIDDEN_IN_DTO_FIXTURE'); };");
const dto=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(isolated,{mode:'strip'})).toString('base64')}`);
const now=Date.now(), instance='0123456789abcdef0123456789abcdef';
const admin={id:'admin-qa',username:'admin-qa',role:'admin',disabled:false,loginMode:'password'};
const user={id:'user-qa',username:'user-qa',role:'user',disabled:false,loginMode:'pairing-only'};
const status={instanceId:instance,serviceState:'running',authenticated:true,admin,expiresAt:now+60000};
const device={id:'device-qa',userId:user.id,name:'Synthetic QA device',revoked:false,online:true,createdAt:now-1000,lastSeenAt:null,authMode:'device-token-v1'};
const inventory={instanceId:instance,users:[admin,user],devices:[device]};
let count=0;
function check(name,fn){fn();count++;console.log(`PASS ${name}`);}
check('public session retains only public identity',()=>{
  const value=dto.readPeopleStatus({...status,accessToken:'SYNTHETIC_SECRET',admin:{...admin,passwordHash:'SYNTHETIC_SECRET'}});
  assert.equal(value.admin.username,admin.username);assert(!JSON.stringify(value).includes('SYNTHETIC_SECRET'));
});
check('authenticated state requires running owned instance and enabled admin',()=>{
  for(const input of [{...status,instanceId:null},{...status,serviceState:'stopped'},{...status,admin:user},{...status,admin:{...admin,disabled:true}},{...status,expiresAt:NaN}])assert.throws(()=>dto.readPeopleStatus(input));
});
check('unknown login mode is rejected instead of called passwordless',()=>assert.throws(()=>dto.readPublicUser({...user,loginMode:'unknown'})));
check('device inventory preserves unknown activity time',()=>assert.equal(dto.readPeopleInventory(inventory,instance).devices[0].lastSeenAt,null));
check('old instance cannot replace current inventory',()=>assert.throws(()=>dto.readPeopleInventory({...inventory,instanceId:'old'},instance)));
check('duplicate user or device IDs cannot alias rows',()=>{
  assert.throws(()=>dto.readPeopleInventory({...inventory,users:[admin,user,user]},instance));
  assert.throws(()=>dto.readPeopleInventory({...inventory,devices:[device,device]},instance));
});
check('device from absent user is rejected',()=>assert.throws(()=>dto.readPeopleInventory({...inventory,devices:[{...device,userId:'foreign'}]},instance)));
check('device online must be an actual boolean',()=>assert.throws(()=>dto.readPeopleInventory({...inventory,devices:[{...device,online:'yes'}]},instance)));
check('inventory DTO detaches arrays and omits credential fields',()=>{
  const input=structuredClone(inventory);input.devices[0].token='SYNTHETIC_SECRET';
  const value=dto.readPeopleInventory(input,instance);input.devices[0].name='changed';
  assert.equal(value.devices[0].name,device.name);assert(!JSON.stringify(value).includes('SYNTHETIC_SECRET'));
});
const receipt={instanceId:instance,requestId:'request-qa',user:null,pairing:{authMode:'device-token-v1',code:'SYNTHETIC_PAIR_CODE',expiresAt:now+300000,expiresIn:300},disabled:false,revoked:false};
check('pairing receipt requires matching request and instance',()=>{
  assert.equal(dto.readMutationResult(receipt,instance,'request-qa').pairing.code,'SYNTHETIC_PAIR_CODE');
  assert.throws(()=>dto.readMutationResult(receipt,'other','request-qa'));
  assert.throws(()=>dto.readMutationResult(receipt,instance,'other'));
});
check('oversized or invalid pairing lifetime is rejected',()=>{
  for(const expiresIn of [0,301,NaN])assert.throws(()=>dto.readMutationResult({...receipt,pairing:{...receipt.pairing,expiresIn}},instance,'request-qa'));
  assert.throws(()=>dto.readMutationResult({...receipt,pairing:{...receipt.pairing,code:'x'.repeat(257)}},instance,'request-qa'));
});
check('session expiration is a hard permission boundary',()=>{
  assert(dto.peopleSessionValid(status,now));assert(!dto.peopleSessionValid(status,status.expiresAt));
  assert(!dto.peopleSessionValid({...status,authenticated:false},now));
});
check('stale inventory, service restart, and clock reversal disable mutations',()=>{
  assert(dto.peopleInventoryFresh(status,inventory,now,now+1000));
  assert(!dto.peopleInventoryFresh(status,inventory,now,now+15001));
  assert(!dto.peopleInventoryFresh({...status,instanceId:'new'},inventory,now,now));
  assert(!dto.peopleInventoryFresh(status,inventory,now,now-1));
});
check('unknown outcomes block automatic mutation retries',()=>{
  for(const code of ['OUTCOME_UNKNOWN','OPERATION_TIMEOUT','REQUEST_ID_CONFLICT','REQUEST_EXPIRED'])assert(dto.peopleOutcomeUnknown({code}));
  assert(!dto.peopleOutcomeUnknown({code:'INVALID_OR_EXISTING_ACCOUNT'}));
});
check('error messages never expose native secret-bearing text',()=>{
  assert(!dto.peopleMessage({code:'SYNTHETIC_SECRET',message:'SYNTHETIC_SECRET'}).includes('SYNTHETIC_SECRET'));
  assert.match(dto.peopleMessage({code:'PEOPLE_SERVICE_UNAVAILABLE'}),/受管服务/);
  assert.match(dto.peopleMessage({code:'PEOPLE_TLS_INVALID'}),/TLS/);
});
console.log(`CENTRAL_PEOPLE_UI_SMOKE_OK ${count}`);
