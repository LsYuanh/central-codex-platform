// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Local developer wrapper. Bootstrap password is only passed over child stdin.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [platform,phase]=process.argv.slice(2);
assert(['win32','darwin'].includes(platform)&&['create','resume','repaired'].includes(phase));
const record=JSON.parse(readFileSync(platform==='win32'?'target/rc-native-windows/record.json':'target/harness-deploy/rc-native-macos-record.json','utf8'));
const bootstrap=spawnSync('target/harness-agent/debug/examples/platform-acceptance.exe',[],{input:JSON.stringify({namespace:'com.centralcodex.harnessqa.p5.bootstrap',gateway:'wss://192.0.2.10:4529/ws',action:'fixture-get'}),encoding:'utf8',windowsHide:true,timeout:30_000});
assert.equal(bootstrap.status,0,'QA bootstrap unavailable');
const secret=JSON.parse(bootstrap.stdout),identity=record.identity;
const request=Buffer.from(JSON.stringify({password:secret.data.password,username:platform==='win32'?'rcwindows':'rcmac',platform,phase,deviceId:identity.deviceId,workspace:record.workspace}));
secret.data.password=undefined;bootstrap.stdout=undefined;
let result;try{result=spawnSync(process.execPath,['harness/rc-device-acceptance.mjs'],{input:request,windowsHide:true,stdio:['pipe','inherit','inherit'],timeout:420_000});}finally{request.fill(0);}
process.exitCode=result.status??1;
