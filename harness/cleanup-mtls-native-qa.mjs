// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Restore exactly two local QA configuration files. No recursive removal.
import {existsSync,lstatSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import assert from 'node:assert/strict';
import {namespace,gateway,ca,directory,recordPath,names,hash,regular,native,assertStopped,vaultCount,writeRecord} from './prepare-mtls-native-qa.mjs';

assert.equal(process.platform,'win32','Windows QA only');assert(process.env.APPDATA,'APPDATA required');
assertStopped();regular(recordPath);const record=JSON.parse(readFileSync(recordPath,'utf8'));
assert.equal(record.version,1);assert.equal(record.namespace,namespace);assert.equal(record.gateway,gateway);assert.equal(record.ca,ca);assert.equal(record.initialVaultCount,0);
assert.equal(dirname(resolve(record.backup)),resolve('target'));
assert(basename(record.backup).startsWith('harness-mtls-native-backup-'));
assert(lstatSync(record.backup).isDirectory()&&!lstatSync(record.backup).isSymbolicLink());
assert.deepEqual(record.files.map(file=>file.name),names);
assert.equal(record.workspace,resolve('target/harness-mtls-qa-workspace'));
assert(record.stage!=='cleaned','This QA run has already been cleaned');
if(existsSync(directory))assert(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'QA config directory became a link');
// Verify every current and backup file before mutating credentials or config.
for(const file of record.files){
  const path=join(directory,file.name),original=join(record.backup,file.name);
  if(file.existed){regular(original);assert.equal(hash(readFileSync(original)),file.originalHash,'Original backup changed; preserve all state');}
  else assert(!existsSync(original),'Unexpected backup file');
  if(existsSync(path)){regular(path);const current=hash(readFileSync(path));assert(current===file.qaHash||(file.existed&&current===file.originalHash),'QA config changed since preparation; preserve it');}
  else assert(!file.existed,'Original QA config disappeared; preserve all state');
}
let remoteLogout={ok:false},localCleanup={ok:true,data:{alreadyAbsent:true}};
const count=vaultCount();
if(count>0){
  assert(['setup-started','paired','configured'].includes(record.stage),'Credentials appeared before QA setup; preserve them');
  remoteLogout=native({namespace,action:'logout'},{allowFailure:true});
  if(!remoteLogout.ok)localCleanup=native({namespace,action:'cleanup'});
}
assert.equal(vaultCount(),0,'QA namespace still contains credentials; do not claim cleanup');
for(const file of record.files){
  const path=join(directory,file.name);
  if(file.existed)writeFileSync(path,readFileSync(join(record.backup,file.name)));
  else if(existsSync(path))unlinkSync(path);
}
for(const file of record.files){const path=join(directory,file.name);if(file.existed)assert.equal(hash(readFileSync(path)),file.originalHash);else assert(!existsSync(path));}
record.stage='cleaned';record.cleanup={at:new Date().toISOString(),remoteLogoutConfirmed:remoteLogout.ok,localCredentialsRemoved:true,configurationRestored:true};writeRecord(record);
console.log(JSON.stringify({ok:true,...record.cleanup,bootstrapPreserved:true,backup:record.backup}));
