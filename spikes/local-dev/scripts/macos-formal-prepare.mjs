// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Operator-side migration preparation. No running service changes.
import {mkdir,writeFile,readFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin')throw Error('MACOS_REQUIRED');
const dir=path.resolve(root,'../../artifacts/central-macos/formal-migration-20260911');
await mkdir(dir,{mode:0o700});
await writeFile(path.join(dir,'server.cnf'),`[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=192.0.2.10\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:192.0.2.10,IP:127.0.0.1,DNS:localhost\n`,{mode:0o600,flag:'wx'});
function run(cmd,args,options={}){const result=spawnSync(cmd,args,{cwd:dir,encoding:'utf8',...options});if(result.status!==0)throw Error(`PREPARE_FAILED:${path.basename(cmd)}:${result.status}`);return result;}
run('/usr/bin/openssl',['req','-x509','-newkey','rsa:3072','-nodes','-keyout','ca-key.pem','-out','ca.pem','-days','365','-subj','/CN=Yuan Zhou Central LAN CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
run('/usr/bin/openssl',['req','-newkey','rsa:3072','-nodes','-keyout','server-key.pem','-out','server.csr','-config','server.cnf']);
run('/usr/bin/openssl',['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca-key.pem','-CAcreateserial','-out','server.pem','-days','365','-extfile','server.cnf','-extensions','ext']);
for(const name of ['ca-key.pem','ca.pem','server-key.pem','server.pem','server.csr','server.cnf','ca.srl'])await chmod(path.join(dir,name),0o600);
const info=JSON.parse(await readFile(path.join(root,'target/central-macos/latest-build.json'),'utf8'));
const appData=path.join(homedir(),'Library/Application Support/com.yuanzhou.central');
run('cargo',['test','-p','central-app','--offline','prepare_formal_macos_profile','--','--ignored','--nocapture'],{cwd:root,stdio:'inherit',env:{...process.env,CENTRAL_MACOS_PROVISION_OPT_IN:'1',CENTRAL_MACOS_APP_DATA:appData,CENTRAL_MACOS_TLS_DIRECTORY:dir,CENTRAL_MACOS_PACKAGE_ID:info.packageId}});
const report=JSON.parse(await readFile(path.join(dir,'native-profile-report.json'),'utf8'));
const admin={username:'admin',password:randomBytes(24).toString('base64url')};
const bootstrap=run(process.execPath,[path.join(root,'scripts/platform-auth-bootstrap.mjs')],{cwd:root,input:JSON.stringify(admin),env:{...process.env,PLATFORM_AUTH_FILE:path.join(report.dataDirectory,'platform-auth.json')}});
await writeFile(path.join(dir,'admin-login.json'),JSON.stringify(admin,null,2)+'\n',{mode:0o600,flag:'wx'});
if(!JSON.parse(bootstrap.stdout).ok)throw Error('ADMIN_PREPARE_FAILED');
await writeFile(path.join(dir,'deployment.json'),JSON.stringify({...report,appData,caPath:path.join(dir,'ca.pem'),gateway:'wss://192.0.2.10:4510/ws'},null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({prepared:true,directory:dir,credentialContentsPrinted:false}));
