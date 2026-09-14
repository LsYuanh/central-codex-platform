// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Explicit operator acceptance against the authorized central LAN endpoint.
// SSH manages test pairing only; inference/client runtime still uses WSS+Local Agent.
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32')throw Error('WINDOWS_REQUIRED');
const remote='/Users/operator/central-codex-platform';
const sshArgs=['-i',path.join(process.env.USERPROFILE,'.ssh/id_ed25519'),'-o','BatchMode=yes','operator@192.0.2.10'];
function management(action,id){
  if(id&&!/^[a-f0-9-]{36}$/.test(id))throw Error('INVALID_DEVICE_ID');
  const command=`${remote}/artifacts/macos-tools/node/bin/node ${remote}/spikes/local-dev/scripts/macos-formal-management.mjs ${action}${id?' '+id:''}`;
  const bytes=execFileSync('ssh.exe',[...sshArgs,command],{windowsHide:true,timeout:30000,maxBuffer:65536});
  try{return JSON.parse(bytes);}finally{bytes.fill(0);}
}
const output=path.join(root,'target/central-macos/formal-client',String(Date.now()));
mkdirSync(path.join(output,'workspace'),{recursive:true});
const bundled=process.argv.includes('--bundle');
const installed=process.argv.includes('--installed');
const legacyWorkspace=process.argv.includes('--legacy');
if(legacyWorkspace&&installed)throw Error('CHOOSE_LEGACY_OR_INSTALLED');
const pair=management(bundled?'pair-bundle':'pair');
const child=spawn(process.execPath,[path.join(root,'scripts/central-live-client-qa.mjs'),'--formal-4510'],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
const config={gateway:'wss://192.0.2.10:4510/ws',caPath:bundled?'':path.join(root,'target/central-macos/formal-ca.pem'),code:pair.code,agentBinary:legacyWorkspace?path.resolve(root,'../../artifacts/client-paths-20260914/windows-installed-before/local-agent.exe'):installed?path.join(process.env.LOCALAPPDATA,'远舟/local-agent.exe'):path.join(root,'target/debug/local-agent.exe'),helperBinary:path.join(root,'target/debug/examples/central-live-client.exe'),workspace:path.join(output,'workspace'),output:path.join(output,'client-result.json'),model:'gpt-6-astra',legacyWorkspace};
const bytes=Buffer.from(JSON.stringify(config)+'\n');child.stdin.write(bytes,()=>bytes.fill(0));pair.code='';config.code='';
let buffer='',deviceId,failed=false;const phases=[];
child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{
  const value=JSON.parse(line);phases.push(value);if(value.deviceId)deviceId=value.deviceId;
  if(value.phase==='completed')management('revoke',deviceId);
  if(value.phase==='failed')failed=true;
  console.log(JSON.stringify(value));
}catch{failed=true;console.log(JSON.stringify({phase:'failed',code:'FORMAL_CONTROLLER_FAILED'}));child.stdin.end();}}});
child.stderr.on('data',()=>{});
const timer=setTimeout(()=>child.stdin.end(),290000);
child.on('close',code=>{clearTimeout(timer);if(failed&&deviceId){try{management('revoke',deviceId);}catch{}}
  writeFileSync(path.join(output,'controller-result.json'),JSON.stringify({code,phases},null,2));
  process.exitCode=code===0&&!failed?0:1;console.log(JSON.stringify({output,passed:process.exitCode===0}));
});
