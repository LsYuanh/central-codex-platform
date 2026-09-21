// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Local native token-file QA against a real TLS module fixture. No central/model/Keychain.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir,stat,lstat,realpath} from 'node:fs/promises';
import {basename,isAbsolute,join,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import https from 'node:https';
import {WebSocket,WebSocketServer} from 'ws';
import {PlatformAuth} from '../../services/central-gateway/dist/platform-auth.js';

assert.equal(process.argv.length,4,'Usage: node tests/smoke/device-token-native-smoke.mjs --helper /absolute/platform-acceptance[.exe]');
assert.equal(process.argv[2],'--helper');assert(isAbsolute(process.argv[3]));
const helper=resolve(process.argv[3]);assert(['platform-acceptance.exe','platform-acceptance'].includes(basename(helper)));
const helperStat=await lstat(helper);assert(helperStat.isFile()&&!helperStat.isSymbolicLink(),'Expected regular native QA helper');
await mkdir(resolve('target'),{recursive:true});const root=await realpath(await mkdtemp(resolve('target/device-token-native-')));
const tokenRoot=join(root,'private-app-data'),namespace='com.centralcodex.harnessqa.device-token-native';
const caPath=join(root,'server-ca.pem'),caKey=join(root,'server-ca-key.pem'),certPath=join(root,'server.pem'),keyPath=join(root,'server-key.pem');
const caConfig=join(root,'ca.cnf'),leafConfig=join(root,'leaf.cnf');
await writeFile(caConfig,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Synthetic Native Token QA CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
await writeFile(leafConfig,'[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
const openssl=args=>{const r=spawnSync(process.env.OPENSSL_BIN??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl'),args,{windowsHide:true});assert.equal(r.status,0,'Synthetic TLS generation failed');};
openssl(['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','2','-sha256','-keyout',caKey,'-out',caPath,'-config',caConfig]);
openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',join(root,'server.csr'),'-subj','/CN=localhost']);
openssl(['x509','-req','-in',join(root,'server.csr'),'-CA',caPath,'-CAkey',caKey,'-set_serial','1','-days','2','-sha256','-out',certPath,'-extfile',leafConfig,'-extensions','server']);
const ca=await readFile(caPath),checks=[],issued=new Map(),children=new Set(),sockets=[];
const password=randomBytes(32).toString('base64url'),authPath=join(root,'auth.json');
const auth=new PlatformAuth(authPath,undefined,undefined,'device-token-v1');
// Keep only synthetic issuance secrets in fixture memory to check the public native contract.
const actualPair=auth.pairDeviceToken.bind(auth);auth.pairDeviceToken=(...args)=>{const value=actualPair(...args);issued.set(value.deviceId,value.deviceToken);return value;};
const server=https.createServer({cert:await readFile(certPath),key:await readFile(keyPath),minVersion:'TLSv1.2',maxVersion:'TLSv1.2'},(req,res)=>void auth.http(req,res));
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{try{const p=auth.upgrade(req,'ui');wss.handleUpgrade(req,socket,head,ws=>{auth.track(ws,p);ws.on('error',()=>{});});}catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`https://localhost:${server.address().port}`,gateway=origin.replace('https:','wss:')+'/ws';
const secretFile=join(tokenRoot,'device-auth-v1',createHash('sha256').update(namespace+'\n'+origin).digest('hex')+'.bin');
const pass=name=>{checks.push(name);console.log('PASS '+name);};
function post(route,body={},token){return new Promise((resolve,reject)=>{const req=https.request(origin+route,{method:'POST',ca,agent:false,timeout:5000,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',d=>raw+=d);res.on('end',()=>{try{const value=JSON.parse(raw);value.ok?resolve(value.data):reject(Error(value.error));}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTPS timeout')));req.end(JSON.stringify(body));});}
function native(action,extra={}){return new Promise((resolve,reject)=>{
  const request=Buffer.from(JSON.stringify({namespace,gateway,ca:caPath,'token-root':tokenRoot,action,...extra}));
  const child=spawn(helper,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});children.add(child);let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill();reject(Error('Native token helper timed out'));},30_000);
  child.on('error',()=>{clearTimeout(timer);children.delete(child);reject(Error('Native token helper failed to spawn'));});
  child.stdout.on('data',data=>{stdout+=data;if(stdout.length>64*1024)child.kill();});child.stderr.on('data',data=>{stderr+=data;if(stderr.length>64*1024)child.kill();});
  child.stdin.on('error',()=>{});child.stdin.end(request,()=>request.fill(0));
  child.on('close',status=>{clearTimeout(timer);children.delete(child);request.fill(0);
    if(status!==0){const code=stderr.match(/CENTRAL_[A-Z_]+|DEVICE_[A-Z_]+|AUTH_[A-Z_]+|PAIR_[A-Z_]+/)?.[0]??'NATIVE_HELPER_FAILED';reject(Error(`Native ${action}: ${code}; output suppressed`));return;}
    try{const value=JSON.parse(stdout);assert(value.ok===true,'Native request rejected');for(const token of issued.values())assert(!stdout.includes(token),'Native response leaked the synthetic token');resolve(value.data);}catch{reject(Error('Invalid or secret-bearing native helper output; suppressed'));}
  });
});}
async function fileProtection(){
  const bytes=await readFile(secretFile),file=await stat(secretFile),folder=await stat(join(tokenRoot,'device-auth-v1'));assert.equal(file.nlink,1);
  if(process.platform==='win32'){
    for(const token of issued.values())assert(!bytes.includes(Buffer.from(token)),'Windows token file must not contain plaintext');
    const quote=value=>"'"+value.replaceAll("'","''")+"'";
    const code=`$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $results=@(); foreach($path in @(${quote(secretFile)},${quote(join(tokenRoot,'device-auth-v1'))})) { $acl=Get-Acl -LiteralPath $path; $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); $results+=@{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=@($rules|ForEach-Object{@{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');inherited=$_.IsInherited;rights=[int]$_.FileSystemRights}})} }; @{sid=$sid;entries=$results}|ConvertTo-Json -Depth 5 -Compress`;
    // PowerShell 7's inherited module path is incompatible with Windows PowerShell 5.1.
    const metadataEnv={...process.env};for(const key of Object.keys(metadataEnv))if(key.toUpperCase()==='PSMODULEPATH')delete metadataEnv[key];
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "+code],{env:metadataEnv,encoding:'utf8',windowsHide:true,timeout:10_000});if(r.status!==0)throw Error('ACL_METADATA_PROBE_FAILED: '+String(r.stderr).slice(0,3000));const acl=JSON.parse(r.stdout);
    for(const entry of acl.entries){assert(entry.protected);assert.equal(entry.owner,acl.sid);assert.equal(entry.rules.length,1);assert.equal(entry.rules[0].sid,acl.sid);assert(entry.rules[0].allow&&!entry.rules[0].inherited);assert((entry.rules[0].rights&0x1f01ff)===0x1f01ff);}
    pass('Windows token file contains no plaintext and file/directory ACL grants only the current user');
  }else{assert.equal(file.mode&0o777,0o600);assert.equal(folder.mode&0o777,0o700);assert.equal(file.uid,process.getuid());assert.equal(folder.uid,process.getuid());pass('Unix token file and directory enforce owner-only 0600/0700 permissions');}
}
let adminPrincipal,result;
try{
  await auth.createUser('nativeadmin',password,'admin');const user=await auth.createUser('nativeuser',password);const login=await post('/auth/login',{username:'nativeadmin',password});adminPrincipal=auth.bearer('Bearer '+login.accessToken);
  const issue=async()=> (await post('/auth/admin/pair-code',{userId:user.id},login.accessToken)).code;
  assert.equal((await native('token-status')).status,'missing');pass('fresh native token store reports missing without creating credentials');
  const first=await native('token-pair',{code:await issue(),name:'Synthetic native token A'});assert.equal(first.authMode,'device-token-v1');assert.equal(first.user.id,user.id);assert(first.paired&&first.loggedIn);pass('native helper pairs with a one-time code and returns only public identity');
  const active=await native('token-status');assert.equal(active.status,'active');assert.equal(active.deviceId,first.deviceId);assert(active.remoteAvailable);const restarted=await native('token-status');assert.equal(restarted.deviceId,first.deviceId);assert.equal(restarted.status,'active');pass('new helper processes reload the protected file and verify active status over HTTPS');
  await fileProtection();
  await assert.rejects(post('/auth/admin/users',{},issued.get(first.deviceId)),/NOT_FOUND/);await assert.rejects(post('/auth/admin/pair-code',{userId:user.id},issued.get(first.deviceId)),/NOT_FOUND/);pass('native-paired ordinary user cannot access administrator APIs');
  const ws=new WebSocket(gateway,{ca,headers:{Authorization:'Bearer '+issued.get(first.deviceId)}});sockets.push(ws);ws.on('error',()=>{});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
  const second=await native('token-pair',{code:await issue(),name:'Synthetic native token replacement'});assert.notEqual(second.deviceId,first.deviceId);assert.equal((await native('token-status')).deviceId,second.deviceId);await assert.rejects(post('/auth/device/status',{},issued.get(first.deviceId)),/DEVICE_REVOKED/);
  await new Promise((r,j)=>{if(ws.readyState===WebSocket.CLOSED){r();return;}const t=setTimeout(()=>j(Error('Replaced token channel remained open')),3000);ws.once('close',()=>{clearTimeout(t);r();});});pass('replacement pairing stores the new identity and revokes the old token and WSS channel');
  assert.equal((await readdir(join(tokenRoot,'device-auth-v1'))).length,1,'Only committed token file should remain');
  await post('/auth/device/revoke',{deviceId:second.deviceId},login.accessToken);const revoked=await native('token-status');assert.equal(revoked.status,'revoked');assert.equal(revoked.authorizationError,'DEVICE_REVOKED');pass('administrator revocation appears as terminal revoked native status');
  const disconnected=await native('token-disconnect');assert(disconnected.disconnected&&disconnected.localRemoved&&disconnected.remoteRevocationConfirmed);assert.deepEqual(await readdir(join(tokenRoot,'device-auth-v1')),[]);assert.equal((await native('token-status')).status,'missing');pass('disconnect removes the revoked local token file and confirms remote revocation');
  const third=await native('token-pair',{code:await issue(),name:'Synthetic native disconnect'});const out=await native('token-disconnect');assert(out.remoteRevocationConfirmed&&out.localRemoved);await assert.rejects(post('/auth/device/status',{},issued.get(third.deviceId)),/DEVICE_REVOKED/);pass('disconnect of an active native token revokes the server record and removes the file');
  const bundleToken=await issue();
  const encoded=(await native('bundle-encode',{code:bundleToken,caPem:ca.toString(),expiresAt:Date.now()+290000})).code;
  const decode=code=>JSON.parse(Buffer.from(code.slice('yzpair1.'.length),'base64url'));
  const alter=changes=>'yzpair1.'+Buffer.from(JSON.stringify({...decode(encoded),...changes})).toString('base64url');
  for(const code of [alter({version:2}),alter({expiresAt:1}),alter({extra:'unsupported'}),'yzpair1.broken','yzpair1.'+'a'.repeat(98304)]) {
    await assert.rejects(native('token-pair-bundle',{ca:'',code,name:'Synthetic bundle'}),/PAIR_BUNDLE_/);
  }
  await assert.rejects(native('token-pair-bundle',{ca:'',code:alter({caPem:await readFile(caKey,'utf8')}),name:'Synthetic bundle'}),/PAIR_BUNDLE_CA_INVALID/);
  pass('incomplete, oversized, expired, unknown-version/fields and private-key-bearing codes fail before pairing');
  const paired=await native('token-pair-bundle',{ca:'',code:encoded,name:'Synthetic bundle'});
  assert(paired.paired);assert.equal((await native('token-status',{ca:''})).deviceId,paired.deviceId);
  assert.equal((await native('token-status',{ca:''})).status,'active');
  pass('one code pairs without a CA path and fresh native processes recover bundled trust');
  const nativeSocket=await native('token-socket',{ca:''});assert(nativeSocket.connected&&nativeSocket.rustls);
  pass('persisted pairing opens an actual Rustls WSS socket against a TLS 1.2-only server');
  await assert.rejects(native('token-pair-bundle',{ca:'',code:encoded,name:'Synthetic duplicate'}),/PAIR_CODE|INVALID_PAIR/);
  assert.equal((await native('token-status',{ca:''})).deviceId,paired.deviceId);
  const otherCa=join(root,'unrelated-ca.pem');
  openssl(['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','2','-sha256','-keyout',join(root,'unrelated-key.pem'),'-out',otherCa,'-config',caConfig,'-subj','/CN=Unrelated QA CA']);
  const freshToken=await issue();
  const wrong=(await native('bundle-encode',{code:freshToken,caPem:await readFile(otherCa,'utf8'),expiresAt:Date.now()+290000})).code;
  await assert.rejects(native('token-pair-bundle',{ca:'',code:wrong,name:'Synthetic wrong trust'}),/CENTRAL_CERT_UNTRUSTED/);
  for(const transport of ['https','wss'])assert.equal((await native('tls-probe',{ca:otherCa,transport})).errorCode,'CENTRAL_CERT_UNTRUSTED');
  pass('HTTP and WSS reject unrelated CA with the same safe error code');
  const nameConfig=join(root,'wrong-name.cnf'),nameCert=join(root,'wrong-name.pem');
  await writeFile(nameConfig,'[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:other.invalid\n');
  openssl(['x509','-req','-in',join(root,'server.csr'),'-CA',caPath,'-CAkey',caKey,'-set_serial','2','-days','2','-sha256','-out',nameCert,'-extfile',nameConfig,'-extensions','server']);
  const nameServer=https.createServer({cert:await readFile(nameCert),key:await readFile(keyPath)},(_req,res)=>res.end());
  await new Promise(r=>nameServer.listen(0,'127.0.0.1',r));
  try{for(const transport of ['https','wss'])assert.equal((await native('tls-probe',{gateway:`wss://localhost:${nameServer.address().port}/ws`,transport})).errorCode,'CENTRAL_CERT_NAME_MISMATCH');}
  finally{nameServer.closeAllConnections();await new Promise(r=>nameServer.close(r));}
  pass('HTTP and WSS both reject a trusted certificate with the wrong hostname');
  assert.equal((await native('token-status',{ca:''})).deviceId,paired.deviceId);
  const correct=(await native('bundle-encode',{code:freshToken,caPem:ca.toString(),expiresAt:Date.now()+290000})).code;
  const repaired=await native('token-pair-bundle',{ca:'',code:correct,name:'Synthetic bundle replacement'});
  assert.notEqual(repaired.deviceId,paired.deviceId);
  await assert.rejects(post('/auth/device/status',{},issued.get(paired.deviceId)),/DEVICE_REVOKED/);
  pass('reused code and wrong CA preserve prior identity; TLS failure does not consume code; successful replacement revokes old identity');
  const bundleDisconnect=await native('token-disconnect',{ca:''});assert(bundleDisconnect.remoteRevocationConfirmed&&bundleDisconnect.localRemoved);
  assert.equal((await native('token-status',{ca:''})).status,'missing');
  pass('bundled trust supports verified revocation and local unpairing without manual certificate setup');
  const disk=await readFile(authPath,'utf8');for(const token of issued.values())assert(!disk.includes(token),'Server must persist only hashes');
  result={ok:true,platform:process.platform,checks,root,helper,helperSha256:createHash('sha256').update(await readFile(helper)).digest('hex'),namespace,nativeStorageRemoved:true,server:'isolated in-process HTTPS/WSS PlatformAuth module',centralValidated:false,agentExecutionValidated:false,keychainUsed:false};
}catch(error){
  let detail=String(error.message);for(const token of issued.values())detail=detail.replaceAll(token,'[redacted]');detail=detail.replaceAll(password,'[redacted]');
  result={ok:false,platform:process.platform,checks,root,helper,namespace,error:detail.match(/DEVICE_[A-Z_]+|AUTH_[A-Z_]+|NATIVE_[A-Z_]+/)?.[0]??'NATIVE_ACCEPTANCE_FAILED',detail};process.exitCode=1;
}finally{
  for(const child of children)child.kill();for(const ws of sockets)ws.terminate();
  if(adminPrincipal)for(const id of issued.keys()){try{auth.revokeDevice(adminPrincipal,id);}catch{}}
  let cleanupConfirmed=false;
  try{await native('token-cleanup');cleanupConfirmed=true;}catch{console.error('Native synthetic token cleanup not confirmed; preserve the reported QA root for inspection.');}
  auth.close();wss.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  result??={ok:false,root,checks};result.cleanupConfirmed=cleanupConfirmed;
  if(!cleanupConfirmed){process.exitCode=1;result.ok=false;result.cleanupError='NATIVE_TOKEN_CLEANUP_NOT_CONFIRMED';}
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,checks:checks.length,result:join(root,'result.json'),...(result.error?{error:result.error}:{})}));
}
