// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {publishRuntimeUpdate} from '../../scripts/release/runtime-publisher.mjs';
import {verifyRuntimeSignature} from '../../scripts/release/runtime-signature.mjs';

const root=mkdtempSync(join(tmpdir(),'runtime-publisher-'));
const signer=fileURLToPath(new URL('../../node_modules/@tauri-apps/cli/tauri.js',import.meta.url));
const commit='a'.repeat(40),channel='runtime-stable-macos-arm64';
const safeEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(TOKEN|SECRET|PASSWORD|SIGNING|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i.test(key)));
let key,publicKey,emptyPasswordKey,emptyPasswordPublicKey;
before(()=>{
  const generate=password=>{
    const path=join(root,password?'encrypted.key':'empty-password.key');
    const result=spawnSync(process.execPath,[signer,'signer','generate','--ci','--password',password,'--write-keys',path],
      {env:{...safeEnv,CI:'true'},encoding:'utf8',windowsHide:true,timeout:60000});
    assert.equal(result.status,0,'disposable key generation failed');
    // Never print the generated private keys; remove their files immediately.
    const pair=[readFileSync(path,'utf8'),readFileSync(path+'.pub','utf8')];
    unlinkSync(path);unlinkSync(path+'.pub');
    return pair;
  };
  [key,publicKey]=generate('fixture-password');
  [emptyPasswordKey,emptyPasswordPublicKey]=generate('');
});

function fixture(name,{lookup,failCreate,failChannelCreate,failUpload,signFailure,afterSign,emptyPassword=false}={}) {
  const directory=join(root,name);mkdirSync(directory);
  const archive=Buffer.from('synthetic runtime archive'),digest=createHash('sha256').update(archive).digest('hex');
  const report={status:'validated',sourceCommit:commit,latestVersion:'0.159.2',releaseTag:'runtime-0.159.2-123',archiveSha256:digest};
  const descriptor={version:'0.159.2',sequence:123,package:{version:'0.159.2'},archiveBytes:archive.length,archiveSha256:digest,
    archiveUrl:`https://github.com/LsYuanh/central-codex-platform/releases/download/${report.releaseTag}/runtime.tar.gz`};
  const save=(name,value)=>writeFileSync(join(directory,name),typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);
  save('report.json',report);save('latest.json',descriptor);save('runtime.tar.gz',archive);
  const env={...safeEnv,GITHUB_SHA:commit,GH_REPO:'LsYuanh/central-codex-platform',GH_TOKEN:'synthetic-github-token',
    GITHUB_TOKEN:'synthetic-workflow-token',OTHER_SECRET:'synthetic-secret',TAURI_SIGNING_PRIVATE_KEY:emptyPassword?emptyPasswordKey:key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:emptyPassword?'':'fixture-password'};
  const calls=[];
  const execute=(command,args,options)=>{
    calls.push({command,args});
    if(command===process.execPath){
      assert.equal(args[0],signer);
      assert.ok(!options.env.GH_TOKEN&&!options.env.GITHUB_TOKEN&&!options.env.OTHER_SECRET,'signer received unrelated credentials');
      if(signFailure)return {status:1,stderr:'synthetic-private-key-must-not-leak'};
      const result=spawnSync(command,args,options);
      afterSign?.({directory,save});
      return result;
    }
    // Any real GitHub process is forbidden, even in a successful publication test.
    assert.equal(command,'gh');assert.equal(args[0],'release');
    assert.ok(!options.env.TAURI_SIGNING_PRIVATE_KEY&&!options.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD&&!options.env.OTHER_SECRET&&!options.env.GITHUB_TOKEN,'GitHub received signing credentials');
    assert.equal(options.env.GH_TOKEN,'synthetic-github-token');
    assert.equal(options.env.GH_HOST,'github.com');
    if(args[1]==='view')return lookup??{status:0};
    if(args[1]==='create'&&failCreate)return {status:1};
    if(args[1]==='create'&&args[2]===channel&&failChannelCreate)return {status:1};
    if(args[1]==='upload'&&failUpload)return {status:1};
    return {status:0};
  };
  const publish=overrides=>publishRuntimeUpdate(directory,{env,execute,channelKey:emptyPassword?emptyPasswordPublicKey:publicKey,...overrides});
  return {directory,save,report,descriptor,env,calls,publish};
}

test('real signer verifies before publishing archive and moving an existing channel',async()=>{
  const f=fixture('success');assert.equal((await f.publish()).published,true);
  verifyRuntimeSignature(readFileSync(join(f.directory,'latest.json')),readFileSync(join(f.directory,'latest.json.sig'),'utf8'),publicKey);
  assert.deepEqual(f.calls.slice(1).map(c=>c.args.slice(0,3)),[
    ['release','create',f.report.releaseTag],['release','view',channel],['release','upload',channel]]);
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--target')+1],commit);
});
test('empty-password signing is noninteractive and missing channel is created before upload',async()=>{
  const f=fixture('empty-password',{emptyPassword:true,lookup:{status:1,stderr:'release not found\n'}});
  assert.equal((await f.publish()).published,true);
  assert.deepEqual(f.calls.slice(1).map(c=>c.args[1]),['create','view','create','upload']);
});
test('tampered bytes, stale source and failed validation stop before signing',async()=>{
  for(const mode of ['archive','source','failed']){
    const f=fixture('reject-'+mode);
    if(mode==='archive')f.save('runtime.tar.gz','changed');
    if(mode==='source')f.env.GITHUB_SHA='b'.repeat(40);
    if(mode==='failed')f.save('report.json',{...f.report,status:'needs-adaptation'});
    await assert.rejects(f.publish(),/RUNTIME_(ARTIFACT_MISMATCH|SOURCE_MISMATCH|NOT_VALIDATED)/);
    assert.equal(f.calls.length,0);
  }
});
test('missing or failed signing never invokes GitHub or exposes signer diagnostics',async()=>{
  const missing=fixture('missing-key');delete missing.env.TAURI_SIGNING_PRIVATE_KEY;
  await assert.rejects(missing.publish(),/^Error: RUNTIME_SIGNING_KEY_REQUIRED$/);assert.equal(missing.calls.length,0);
  const failed=fixture('sign-failure',{signFailure:true});
  await assert.rejects(failed.publish(),/^Error: RUNTIME_SIGNING_FAILED$/);assert.equal(failed.calls.length,1);
});
test('unexpected repository, host or missing release token stops before signing',async()=>{
  for(const [name,patch] of [['repo',{GH_REPO:'other/repository'}],['host',{GH_HOST:'github.example.invalid'}],['token',{GH_TOKEN:''}]]){
    const f=fixture('destination-'+name);Object.assign(f.env,patch);
    await assert.rejects(f.publish(),/RUNTIME_RELEASE_DESTINATION_INVALID/);assert.equal(f.calls.length,0);
  }
});
test('real signature with the wrong trust root never invokes GitHub',async()=>{
  const f=fixture('wrong-key');
  const productionKey=JSON.parse(readFileSync(new URL('../../harness/runtime-update-channel.json',import.meta.url))).publicKey;
  await assert.rejects(f.publish({channelKey:productionKey}),/RUNTIME_SIGNATURE_INVALID/);assert.equal(f.calls.length,1);
});
test('descriptor, archive or signature changed during signing is rejected before GitHub',async()=>{
  for(const mode of ['descriptor','archive','signature']){
    const f=fixture('sign-tamper-'+mode,{afterSign:({directory,save})=>{
      if(mode==='descriptor')writeFileSync(join(directory,'latest.json'),readFileSync(join(directory,'latest.json'),'utf8')+' ');
      if(mode==='archive')save('runtime.tar.gz','changed');
      if(mode==='signature')save('latest.json.sig',Buffer.from('invalid').toString('base64'));
    }});
    await assert.rejects(f.publish(),/RUNTIME_(ARTIFACT_MISMATCH|SIGNATURE_INVALID)/);assert.equal(f.calls.length,1);
  }
});
test('release creation and channel lookup failures cannot move the channel',async()=>{
  const failed=fixture('create-failed',{failCreate:true});
  await assert.rejects(failed.publish(),/RUNTIME_RELEASE_CREATE_FAILED/);assert.equal(failed.calls.length,2);
  for(const [name,lookup] of [['network',{status:1,stderr:'HTTP 503'}],['auth',{status:1,stderr:'HTTP 401'}],['timeout',{status:null,error:new Error('timeout')}]] ){
    const f=fixture('lookup-'+name,{lookup});await assert.rejects(f.publish(),/RUNTIME_CHANNEL_LOOKUP_FAILED/);
    assert.equal(f.calls.length,3);
  }
});
test('channel upload failure is reported and never declared a successful publication',async()=>{
  const missing=fixture('channel-create-failed',{lookup:{status:1,stderr:'release not found'},failChannelCreate:true});
  await assert.rejects(missing.publish(),/RUNTIME_CHANNEL_CREATE_FAILED/);
  assert.ok(!missing.calls.some(c=>c.command==='gh'&&c.args[1]==='upload'));
  const f=fixture('upload-failed',{failUpload:true});await assert.rejects(f.publish(),/RUNTIME_CHANNEL_UPLOAD_FAILED/);
});
test('up-to-date reports skip all signing and GitHub calls',async()=>{
  const f=fixture('up-to-date');f.save('report.json',{status:'up-to-date'});delete f.env.TAURI_SIGNING_PRIVATE_KEY;
  assert.deepEqual(await f.publish(),{published:false});assert.equal(f.calls.length,0);
});
