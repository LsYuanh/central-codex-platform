// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {qaRoot, qaAuthFile} from '../scripts/maintenance/operator-config.mjs';
// Offline bootstrap only in the previously authorized isolated central QA directory.
import {mkdirSync,existsSync,readFileSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const qa=qaRoot(),dir=qa+'/p5-workers-security';
const additional=process.argv.includes('--additional');
assert.equal(process.platform,'darwin');assert(additional?existsSync(dir+'/auth.json'):!existsSync(dir+'/auth.json'),'Preserve existing QA identities');
mkdirSync(dir,{recursive:true,mode:0o700});
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>8192)throw Error('Input too large');}
const {PlatformAuth}=await import(qa+'/gateway/services/central-gateway/dist/platform-auth.js');
const auth=new PlatformAuth(dir+'/auth.json'),input=JSON.parse(raw),users=[];
const authTarget=realpathSync(qaAuthFile());
// Existing QA config contains only reviewed model/runtime options; never copy model credentials.
const config=existsSync(qa+'/live-home/config.toml')?readFileSync(qa+'/live-home/config.toml','utf8'):'';
assert(!/api_key|token|password|secret/i.test(config),'Review secret-bearing config separately');
try{for(const username of additional?['finalalice','finalbob']:['alice','bob','nativeqa']){
  const user=await auth.createUser(username,input.password,['alice','finalalice'].includes(username)?'admin':'user');users.push(user);
  const base=qa+'/live-data/workers/'+createHash('sha256').update(user.id).digest('hex');
  mkdirSync(base+'/home',{recursive:true,mode:0o700});mkdirSync(base+'/runtime',{recursive:true,mode:0o700});
  writeFileSync(base+'/home/config.toml',config,{mode:0o600});
  symlinkSync(authTarget,base+'/home/auth.json');
}writeFileSync(dir+(additional?'/final-public-users.json':'/public-users.json'),JSON.stringify(users,null,2));console.log(JSON.stringify({ok:true,accounts:users.length,sharedCredential:'existing read-only QA link; refresh/revoke disabled',port:4529}));}finally{auth.close();}
