// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Developer-only 4529 QA bootstrap; generated test credentials enter stdin only.
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const qa='/Users/operator/central-harness-qa-20260909',dir=qa+'/p5-security';
assert.equal(process.platform,'darwin');
assert(!existsSync(dir+'/auth.json'),'QA auth already exists; preserve it and use authenticated administration');
mkdirSync(dir,{recursive:true,mode:0o700});
writeFileSync(dir+'/openssl.cnf','[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Central Harness QA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:192.0.2.10,DNS:example-mac.local\n',{mode:0o600});
execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','3','-keyout',dir+'/key.pem','-out',dir+'/cert.pem','-config',dir+'/openssl.cnf'],{stdio:'ignore'});
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>8192)throw Error('QA input too large');}
const {PlatformAuth}=await import(qa+'/gateway/services/central-gateway/dist/platform-auth.js');
const input=JSON.parse(raw),auth=new PlatformAuth(dir+'/auth.json');
try{for(const username of ['alice','bob','nativeqa'])await auth.createUser(username,input.password,username==='alice'?'admin':'user');console.log(JSON.stringify({ok:true,accounts:3,cert:dir+'/cert.pem',port:4529}));}finally{auth.close();}
