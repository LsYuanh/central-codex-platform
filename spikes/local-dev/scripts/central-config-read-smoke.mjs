// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Run the actual read retry helper; no React mount, native IPC or write occurs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source,{mode:'strip'})).toString('base64')}`;
const contract=moduleUrl(readFileSync(new URL('../apps/central/src/central-management.ts',import.meta.url),'utf8'));
let source=readFileSync(new URL('../apps/central/src/use-central-management.ts',import.meta.url),'utf8');
source=source.replace(/^import .* from "react";\r?\n/m,'').replace(/^import .* from "\.\/native";\r?\n/m,'')
  .replace(/^import .* from "\.\/central-management";\r?\n/m,`import { publicFailure } from '${contract}';\n`);
const {readConfigWithBusyRetry}=await import(moduleUrl(source));
let count=0;
async function check(name,fn){await fn();count++;console.log(`PASS ${name}`);}
await check('transient exclusive read contention recovers',async()=>{
  let reads=0;const delays=[];
  const result=await readConfigWithBusyRetry(async()=>{if(++reads<3)throw {code:'OPERATION_BUSY'};return {revision:9};},()=>true,async ms=>delays.push(ms));
  assert.equal(result.revision,9);assert.equal(reads,3);assert.deepEqual(delays,[100,200]);
});
await check('persistent contention reaches a finite terminal error',async()=>{
  let reads=0;const delays=[],failure={code:'OPERATION_BUSY'};
  await assert.rejects(readConfigWithBusyRetry(async()=>{reads++;throw failure;},()=>true,async ms=>delays.push(ms)),error=>error===failure);
  assert.equal(reads,5);assert.deepEqual(delays,[100,200,400,800]);
});
await check('timeouts and storage failures are never retried',async()=>{
  for(const code of ['OPERATION_TIMEOUT','CONFIG_STORAGE_UNSAFE','INTERNAL_ERROR']){
    let reads=0,waits=0;
    await assert.rejects(readConfigWithBusyRetry(async()=>{reads++;throw {code};},()=>true,async()=>{waits++;}));
    assert.equal(reads,1);assert.equal(waits,0);
  }
});
await check('unmount cancels pending retry without another native request',async()=>{
  let active=true,reads=0;
  const value=await readConfigWithBusyRetry(async()=>{reads++;throw {code:'OPERATION_BUSY'};},()=>active,async()=>{active=false;});
  assert.equal(value,undefined);assert.equal(reads,1);
});
await check('already inactive owner performs no read',async()=>{
  let reads=0;assert.equal(await readConfigWithBusyRetry(async()=>{reads++;return {};},()=>false),undefined);assert.equal(reads,0);
});
console.log(`CENTRAL_CONFIG_READ_SMOKE_OK ${count}`);
