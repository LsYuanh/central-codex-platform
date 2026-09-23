// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Real pinned archive + real git apply inside the enclosing project repository.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, existsSync, unlinkSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {preparePatch, isolatedGitEnvironment} from './prepare-patch.mjs';
import {prepareWindowsHome} from './prepare-windows-home.mjs';
import {prepareWindowsModel} from './prepare-windows-model.mjs';
const here=dirname(fileURLToPath(import.meta.url));
if(!process.argv[2]) throw Error('Usage: prepare-patch-smoke.mjs PINNED_ARCHIVE');
const archive=resolve(process.argv[2]), pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(archive)),pin.archive.sha256);
const parent=join(here,'../target'); mkdirSync(parent,{recursive:true});
const root=mkdtempSync(join(parent,'prepare-patch-'));
const source=join(root,`codex-${pin.commit}`);
const license=`codex-${pin.commit}/codex-rs/vendor/bubblewrap/LICENSE`;
const extracted=spawnSync('tar',['-xzf',archive,'-C',root,...(process.platform==='win32'?['--exclude',license]:[])],{encoding:'utf8'});
assert.equal(extracted.status,0,extracted.stderr);
if(process.platform==='win32') copyFileSync(join(source,'codex-rs/vendor/bubblewrap/COPYING'),join(root,license));
const checks=[];
function check(name,fn) { fn(); checks.push({name,passed:true}); }
const basePatchBefore=hash(readFileSync(join(here,pin.patch.path)));
const baseManifestBefore=hash(readFileSync(join(here,'source-files.json')));
const windowsFiles=process.platform==='win32'?JSON.parse(readFileSync(join(here,'windows-home-files.json'),'utf8')):[];
const windowsOriginal=windowsFiles.map(item=>existsSync(join(source,item.path))?readFileSync(join(source,item.path)):null);
const modelFiles=process.platform==='win32'?JSON.parse(readFileSync(join(here,'windows-model-files.json'),'utf8')):[];
const modelOriginal=modelFiles.map(item=>existsSync(join(source,item.path))?readFileSync(join(source,item.path)):null);
if(process.platform==='win32')
  check('Windows model overlay missing from upstream source rejected',()=>assert.throws(()=>prepareWindowsModel(source,true),/WINDOWS_MODEL_SOURCE_CHANGED/));
if(process.platform==='win32')
  check('Windows overlay missing from upstream source rejected',()=>assert.throws(()=>prepareWindowsHome(source,true),/WINDOWS_HOME_SOURCE_CHANGED/));
check('unpatched source rejected by verification',()=>assert.throws(()=>preparePatch(source,true),/PATCH_MISSING/));
const originalGitDir=process.env.GIT_DIR;
try {
  // Reproduce both ordinary ancestor discovery and explicit inherited Git context.
  process.env.GIT_DIR=resolve(here,'../../../.git');
  check('all pinned files actually patched inside parent repo',()=>assert.equal(preparePatch(source).verifiedFiles,JSON.parse(readFileSync(join(here,'source-files.json'),'utf8')).length+1));
} finally { if(originalGitDir===undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR=originalGitDir; }
check('prepared source verifies',()=>assert.equal(preparePatch(source,true).commit,pin.commit));
if(process.platform==='win32') {
  const windowsPrepared=windowsFiles.map(item=>readFileSync(join(source,item.path)));
  const basePaths=JSON.parse(readFileSync(join(here,'source-files.json'),'utf8')).map(item=>join(source,item.path));
  basePaths.push(join(source,'codex-rs/core/src/remote_workspace.rs'));
  const basePrepared=basePaths.map(path=>hash(readFileSync(path)));
  const restoreWindows=()=>windowsFiles.forEach((item,index)=>writeFileSync(join(source,item.path),windowsPrepared[index]));
  check('Windows overlay integrated and independently pinned',()=> {
    const actual=preparePatch(source,true);
    assert.equal(actual.verifiedFiles,26);
    assert.equal(actual.verifiedWindowsFiles,2);
    assert.equal(actual.windowsPatchSha256,pin.windowsPatch.sha256);
  });
  check('Windows overlay second application rejected',()=>assert.throws(()=>prepareWindowsHome(source),/Windows home original source changed/));
  for(let index=0;index<windowsFiles.length;index++) {
    const path=join(source,windowsFiles[index].path);
    try {
      if(windowsOriginal[index]===null) unlinkSync(path); else writeFileSync(path,windowsOriginal[index]);
      check(`Windows overlay incomplete file rejected: ${windowsFiles[index].path}`,()=>assert.throws(()=>preparePatch(source,true),/WINDOWS_HOME_SOURCE_CHANGED/));
    } finally {restoreWindows();}
    try {
      writeFileSync(path,Buffer.concat([windowsPrepared[index],Buffer.from('\n// unexpected overlay modification\n')]));
      check(`Windows overlay modified file rejected: ${windowsFiles[index].path}`,()=>assert.throws(()=>preparePatch(source,true),/WINDOWS_HOME_SOURCE_CHANGED/));
    } finally {restoreWindows();}
  }
  try {
    windowsFiles.forEach((item,index)=> {
      if(windowsOriginal[index]===null) unlinkSync(join(source,item.path)); else writeFileSync(join(source,item.path),windowsOriginal[index]);
    });
    const libPath=join(source,windowsFiles[0].path);
    writeFileSync(libPath,Buffer.concat([windowsOriginal[0],Buffer.from('\n// changed upstream source\n')]));
    check('Windows overlay changed original source rejected before application',()=>assert.throws(()=>prepareWindowsHome(source),/Windows home original source changed/));
    writeFileSync(libPath,windowsOriginal[0]);
    check('Windows overlay can upgrade exact base without changing base files',()=> {
      assert.equal(prepareWindowsHome(source).windowsPatchSha256,pin.windowsPatch.sha256);
      basePaths.forEach((path,index)=>assert.equal(hash(readFileSync(path)),basePrepared[index],path));
      assert.equal(hash(readFileSync(join(here,pin.patch.path))),basePatchBefore);
      assert.equal(hash(readFileSync(join(here,'source-files.json'))),baseManifestBefore);
      assert.equal(basePatchBefore,pin.patch.sha256);
    });
  } finally {restoreWindows();}
}
if(process.platform==='win32') {
  const prepared=modelFiles.map(item=>readFileSync(join(source,item.path)));
  const restore=()=>modelFiles.forEach((item,index)=>writeFileSync(join(source,item.path),prepared[index]));
  const unchangedPaths=[...JSON.parse(readFileSync(join(here,'source-files.json'),'utf8')).map(item=>join(source,item.path)),
    join(source,'codex-rs/core/src/remote_workspace.rs'),...windowsFiles.map(item=>join(source,item.path)),
    ...['remote-workspace.patch','source-files.json','windows-home.patch','windows-home-files.json'].map(path=>join(here,path))];
  const unchangedHashes=unchangedPaths.map(path=>hash(readFileSync(path)));
  check('Windows model overlay independently pinned and integrated',()=> {
    const actual=preparePatch(source,true);
    assert.equal(actual.verifiedWindowsModelFiles,5);
    assert.equal(actual.windowsModelPatchSha256,pin.windowsModelPatch.sha256);
  });
  check('Windows model overlay repeated application rejected',()=>assert.throws(()=>prepareWindowsModel(source),/Windows model original source changed/));
  for(let index=0;index<modelFiles.length;index++) {
    const path=join(source,modelFiles[index].path);
    try {
      if(modelOriginal[index]===null) unlinkSync(path); else writeFileSync(path,modelOriginal[index]);
      check(`Windows model incomplete file rejected: ${modelFiles[index].path}`,()=>assert.throws(()=>preparePatch(source,true),/WINDOWS_MODEL_SOURCE_CHANGED/));
    } finally {restore();}
    try {
      writeFileSync(path,Buffer.concat([prepared[index],Buffer.from('\n// modified outside patch context\n')]));
      check(`Windows model altered file rejected: ${modelFiles[index].path}`,()=>assert.throws(()=>preparePatch(source,true),/WINDOWS_MODEL_SOURCE_CHANGED/));
    } finally {restore();}
  }
  try {
    modelFiles.forEach((item,index)=> {
      if(modelOriginal[index]===null) unlinkSync(join(source,item.path)); else writeFileSync(join(source,item.path),modelOriginal[index]);
    });
    const path=join(source,modelFiles[0].path);
    writeFileSync(path,Buffer.concat([modelOriginal[0],Buffer.from('\n// changed upstream source\n')]));
    check('Windows model changed original rejected before application',()=>assert.throws(()=>prepareWindowsModel(source),/Windows model original source changed/));
    writeFileSync(path,modelOriginal[0]);
    check('Windows model upgrade preserves all base and home content and pins',()=> {
      assert.equal(prepareWindowsModel(source).windowsModelPatchSha256,pin.windowsModelPatch.sha256);
      unchangedPaths.forEach((path,index)=>assert.equal(hash(readFileSync(path)),unchangedHashes[index],path));
    });
  } finally {restore();}
}
check('Git command configuration and TLS overrides removed',()=> {
  const overrides={GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'apply.ignoreWhitespace',
    GIT_CONFIG_VALUE_0:'change',GIT_CONFIG_PARAMETERS:"'apply.ignoreWhitespace=change'",GIT_SSL_NO_VERIFY:'1'};
  const previous=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,overrides);
    const isolated=isolatedGitEnvironment(source);
    for(const key of Object.keys(overrides)) assert.equal(isolated[key],undefined,key);
    assert.equal(preparePatch(source,true).verifiedFiles,26);
  } finally {
    for(const [key,value] of Object.entries(previous))
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});
const lockPath=join(source,'codex-rs/Cargo.lock'), lockOriginal=readFileSync(lockPath);
try {
  // The first registry checksum belongs to a third-party package, outside the
  // local workspace version hunks. A reverse patch check alone accepts this.
  const changed=lockOriginal.toString('utf8').replace(/checksum = "([a-f0-9])/,(_,digit)=>`checksum = "${digit==='0'?'1':'0'}`);
  assert.notEqual(changed,lockOriginal.toString('utf8'));
  writeFileSync(lockPath,changed);
  const reverse=spawnSync('git',['apply','--reverse','--check',join(here,'remote-workspace.patch')],
    {cwd:source,env:isolatedGitEnvironment(source),encoding:'utf8'});
  check('lockfile change outside patch context passes reverse check',()=>assert.equal(reverse.status,0,reverse.stderr));
  check('third-party lockfile alteration rejected by full hash',()=>assert.throws(()=>preparePatch(source,true),/PATCHED_SOURCE_CHANGED: codex-rs\/Cargo.lock/));
} finally {writeFileSync(lockPath,lockOriginal);}
check('no silent second patch',()=>assert.throws(()=>preparePatch(source),/already has/));
const file=join(source,'codex-rs/core/src/remote_workspace.rs'), original=readFileSync(file);
try {
  writeFileSync(file,Buffer.concat([original,Buffer.from('\n// unexpected alteration\n')]));
  check('changed runtime boundary rejected',()=>assert.throws(()=>preparePatch(source,true),/PATCH_MISSING_OR_CHANGED/));
} finally {writeFileSync(file,original);}
const preparedPaths=[...JSON.parse(readFileSync(join(here,'source-files.json'),'utf8')).map(item=>join(source,item.path)),file,
  ...windowsFiles.map(item=>join(source,item.path)),...modelFiles.map(item=>join(source,item.path))];
const preparedBytes=preparedPaths.map(path=>readFileSync(path));
try {
  // Legacy Windows preparation inherited core.autocrlf=true. Verification must
  // accept the same content without rewriting files under an active compiler.
  const crlfBytes=preparedBytes.map(bytes=>Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n').replace(/\n/g,'\r\n')));
  preparedPaths.forEach((path,index)=>writeFileSync(path,crlfBytes[index]));
  check('all CRLF files verify without mutation',()=> {
    const actual=preparePatch(source,true);
    assert.equal(actual.verifiedFiles,26);
    if(process.platform==='win32') assert.equal(actual.verifiedWindowsFiles,2);
    if(process.platform==='win32') assert.equal(actual.verifiedWindowsModelFiles,5);
    preparedPaths.forEach((path,index)=>assert.equal(hash(readFileSync(path)),hash(crlfBytes[index]),path));
  });
} finally {preparedPaths.forEach((path,index)=>writeFileSync(path,preparedBytes[index]));}
check('license contents preserved',()=>assert.equal(hash(readFileSync(join(root,license))),hash(readFileSync(join(source,'codex-rs/vendor/bubblewrap/COPYING')))));
const result={scope:'source-preparation-not-runtime',platform:process.platform,passed:true,commit:pin.commit,
  patchSha256:pin.patch.sha256,baseManifestSha256:baseManifestBefore,
  ...(process.platform==='win32'?{windowsPatchSha256:pin.windowsPatch.sha256,windowsModelPatchSha256:pin.windowsModelPatch.sha256}:{}),
  nonWindowsExecutionTested:false,checks};
writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(`PREPARE_PATCH_SMOKE_OK ${checks.length} ${join(root,'result.json')}`);
