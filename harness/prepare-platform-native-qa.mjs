// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const gateway='wss://192.0.2.10:4529/ws',namespace='com.centralcodex.harnessqa20260909';
const binary=resolve('target/harness-agent/debug/examples/platform-acceptance.exe'),ca=resolve('target/harness-deploy/p5-central-ca.pem');
const native=input=>{const r=spawnSync(binary,[],{input:JSON.stringify({gateway,ca,...input}),encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).data;};
const password=native({namespace:'com.centralcodex.harnessqa.p5.bootstrap',action:'fixture-get'}).password;
const identity=native({namespace,action:'setup',username:'nativeqa',password,name:'P5 原生 QA 设备'});
const directory=join(process.env.APPDATA,namespace),backup=resolve('target/harness-p5-native-backup');mkdirSync(backup,{recursive:true});
for(const name of ['desktop-runtime-v1.json','platform-ca-v1.json']){if(existsSync(join(directory,name))&&!existsSync(join(backup,name)))copyFileSync(join(directory,name),join(backup,name));}
const workspace=resolve('target/harness-qa-workspace');mkdirSync(workspace,{recursive:true});mkdirSync(directory,{recursive:true});
writeFileSync(join(directory,'desktop-runtime-v1.json'),JSON.stringify({gatewayUrl:gateway,userId:identity.userId,deviceId:identity.deviceId,workspaceRoot:workspace},null,2));
writeFileSync(join(directory,'platform-ca-v1.json'),JSON.stringify({'https://192.0.2.10:4529':ca},null,2));
writeFileSync(resolve('target/harness-p5-native.json'),JSON.stringify({namespace,gateway,ca,...identity,workspace,backup},null,2));
console.log(JSON.stringify({ok:true,namespace,deviceId:identity.deviceId,configPrepared:true}));
