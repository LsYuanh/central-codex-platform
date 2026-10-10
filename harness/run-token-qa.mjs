// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaGateway, qaRoot, sshTarget, remoteCommand, sshKey} from '../scripts/maintenance/operator-config.mjs';
// Windows developer orchestration only. Reuses the existing synthetic QA
// bootstrap entry; product pairing never reads this development-only entry.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.platform,'win32');
const action=process.argv[2];
assert(['central-prepare','windows-prepare','mac-prepare','windows-repair','mac-repair','windows-revoke'].includes(action));
const helper=join(root,'target/debug/examples/platform-acceptance.exe');
const fixture=spawnSync(helper,[],{input:JSON.stringify({action:'fixture-get',namespace:'com.centralcodex.harnessqa.p5.bootstrap',gateway:qaGateway(),ca:''}),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});
if(fixture.status!==0)throw Error('Existing synthetic QA bootstrap unavailable; output suppressed');
let password;
try{password=JSON.parse(fixture.stdout).data.password;}catch{throw Error('QA bootstrap response invalid; output suppressed');}
assert(typeof password==='string'&&password.length>=12);
const input=Buffer.from(JSON.stringify({password}));
try{
  let command,args;
  if(action.startsWith('windows-')){command=process.execPath;args=[join(root,'harness/token-client-qa.mjs'),action==='windows-revoke'?'revoke':action==='windows-repair'?'re-pair':'prepare'];}
  else{
    command='C:/Windows/System32/OpenSSH/ssh.exe';
    const remote=`${qaRoot()}/rc-client-source/harness/`;
    args=['-i',sshKey(),'-o','BatchMode=yes','-o','ConnectTimeout=5',sshTarget(),remoteCommand(remote+(action==='central-prepare'?'prepare-mtls-qa.mjs':'token-client-qa.mjs'),[action==='central-prepare'?'--token':action==='mac-repair'?'re-pair':'prepare'])];
  }
  const result=spawnSync(command,args,{cwd:root,input,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:65536});
  if(result.status!==0)throw Error(`TOKEN_QA_ORCHESTRATION_FAILED: ${action}; sensitive output suppressed`);
  const report=JSON.parse(result.stdout);assert(!JSON.stringify(report).includes(password));console.log(JSON.stringify(report));
}finally{input.fill(0);password=undefined;}
