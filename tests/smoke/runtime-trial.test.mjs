// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {releasePath,releaseVersion,upstreamHeaders,candidatePatch,upstreamPatches} from '../../harness/check-upstream.mjs';
import {prepareWindowsModel,windowsModelTemplate} from '../../harness/prepare-windows-model.mjs';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zstdDecompressSync,zstdCompressSync} from 'node:zlib';
import {schemaReviewMatches,checkRuntimeSchema} from '../../harness/check-runtime-schema.mjs';
import {createHash} from 'node:crypto';

test('trial selects an exact stable release while scheduled discovery stays on latest',()=>{
  assert.equal(releasePath(),'latest');
  assert.equal(releasePath('0.159.2'),'tags/rust-v0.159.2');
  for(const value of ['',null,159,'latest','../latest','0.159.2-beta','0.159.2?x=1','0.159.2\n']){
    assert.throws(()=>releasePath(value),/UPSTREAM_VERSION_INVALID/);
  }
});
test('trial refuses a changed, draft or prerelease target',()=>{
  const release={tag_name:'rust-v0.159.2',draft:false,prerelease:false};
  assert.equal(releaseVersion(release,'0.159.2'),'0.159.2');
  assert.equal(releaseVersion(release),'0.159.2');
  for(const patch of [{tag_name:'rust-v0.159.3'},{draft:true},{prerelease:true},{tag_name:'rust-v0.159.2-beta'},{tag_name:'main'}]){
    assert.throws(()=>releaseVersion({...release,...patch},'0.159.2'),/UPSTREAM_NOT_STABLE/);
  }
});

test('candidate adaptation cannot carry over to another release or moved tag',()=>{
  const pin=JSON.parse(readFileSync(new URL('../../harness/upstream.json',import.meta.url)));
  const adaptation=pin.candidatePatches['0.159.2'];
  assert.equal(candidatePatch(pin,'0.159.2',adaptation.commit),adaptation);
  assert.equal(candidatePatch(pin,'0.156.1',adaptation.commit),undefined);
  assert.equal(candidatePatch(pin,'0.159.3',adaptation.commit),undefined);
  assert.throws(()=>candidatePatch(pin,'0.159.2','0'.repeat(40)),/UPSTREAM_ADAPTATION_COMMIT_MISMATCH/);
});
test('discovery token is limited to the official upstream API',()=>{
  const token='synthetic-trial-token';
  assert.equal(upstreamHeaders('https://api.github.com/repos/openai/codex/releases/latest',true,token).authorization,`Bearer ${token}`);
  for(const url of ['https://codeload.github.com/openai/codex/tar.gz/abc','https://api.github.com/repos/other/repo/releases/latest','https://api.github.com.evil.invalid/repos/openai/codex/releases/latest','http://api.github.com/repos/openai/codex/releases/latest']){
    assert.equal(upstreamHeaders(url,true,token).authorization,undefined);
  }
  assert.equal(upstreamHeaders('https://api.github.com/repos/openai/codex/releases/latest',true).authorization,undefined);
});

test('0.162.1 replaces only the three conflicting base sections and keeps older pins intact',()=>{
  const pin=JSON.parse(readFileSync(new URL('../../harness/upstream.json',import.meta.url)));
  const candidate=pin.candidatePatches['0.162.1'];
  assert.equal(candidatePatch(pin,'0.162.1',candidate.commit),candidate);
  assert.throws(()=>candidatePatch(pin,'0.162.1','0'.repeat(40)),/UPSTREAM_ADAPTATION_COMMIT_MISMATCH/);
  assert.equal(pin.candidatePatches['0.159.2'].basePatch,undefined);
  const read=spec=>{
    const bytes=readFileSync(new URL('../../harness/'+spec.path,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),spec.sha256);
    return bytes.toString().replaceAll('\r\n','\n');
  };
  const sections=patch=>new Map(patch.split(/(?=^diff --git )/m).filter(Boolean).map(s=>[s.split('\n')[0],s]));
  const base=sections(read(pin.patch)),next=sections(read(candidate.basePatch));
  read(candidate);
  assert.deepEqual([...next.keys()],[...base.keys()]);
  assert.deepEqual([...base].filter(([key,value])=>next.get(key)!==value).map(([key])=>key.split(' ')[2]),[
    'a/codex-rs/core/src/tools/handlers/dynamic.rs',
    'a/codex-rs/core/src/session/session.rs',
    'a/codex-rs/models-manager/src/manager.rs',
  ]);
});
test('0.163.0 preserves the older adaptation and changes only cancellation/shell contexts',()=>{
  const pin=JSON.parse(readFileSync(new URL('../../harness/upstream.json',import.meta.url)));
  const candidate=pin.candidatePatches['0.163.0'],previous=pin.candidatePatches['0.162.1'];
  assert.equal(candidate.commit,'83086188ae0614bd882818ff1aa23f3194962012');
  const patches=upstreamPatches(pin,'0.163.0',candidate.commit,'darwin');
  assert.deepEqual(patches,[candidate.basePatch,candidate]);
  assert.throws(()=>upstreamPatches(pin,'0.163.0','0'.repeat(40),'darwin'),/COMMIT_MISMATCH/);
  for(const platform of ['win32','linux']){
    assert.throws(()=>upstreamPatches(pin,'0.163.0',candidate.commit,platform),/PLATFORM_UNREVIEWED/);
  }
  assert.throws(()=>prepareWindowsModel('unused',true,{version:'0.163.0',commit:candidate.commit}),/CANDIDATE_UNREVIEWED/);
  const read=spec=>{
    const bytes=readFileSync(new URL('../../harness/'+spec.path,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),spec.sha256);
    return bytes.toString().replaceAll('\r\n','\n');
  };
  const sections=patch=>new Map(patch.split(/(?=^diff --git )/m).filter(Boolean).map(s=>[s.split('\n')[0],s]));
  const old=sections(read(previous.basePatch)),next=sections(read(candidate.basePatch));
  assert.equal(read(candidate),read(previous));
  assert.deepEqual([...next.keys()],[...old.keys()]);
  assert.deepEqual([...old].filter(([key,value])=>next.get(key)!==value).map(([key])=>key.split(' ')[2]),[
    'a/codex-rs/core/src/tools/registry.rs',
    'a/codex-rs/core/src/tools/handlers/dynamic.rs',
    'a/codex-rs/core/src/session/session.rs',
  ]);
});
for(const version of ['0.159.2','0.163.0'])test(`reviewed ${version} schema requires exact release, commit, baseline and candidate bytes`,()=>{
  const review=JSON.parse(readFileSync(new URL(`../../harness/schema/reviews/${version}.json`,import.meta.url)));
  const candidate={version:review.version,commit:review.commit};
  for(const mode of ['stable','experimental']){
    const {baseSha256,sha256}=review.schema[mode];
    assert.equal(schemaReviewMatches(review,candidate,mode,baseSha256,sha256),true);
    assert.equal(schemaReviewMatches(review,{...candidate,version:'0.159.3'},mode,baseSha256,sha256),false);
    assert.equal(schemaReviewMatches(review,{...candidate,commit:'0'.repeat(40)},mode,baseSha256,sha256),false);
    assert.equal(schemaReviewMatches(review,candidate,mode,'0'.repeat(64),sha256),false);
    assert.equal(schemaReviewMatches(review,candidate,mode,baseSha256,'0'.repeat(64)),false);
    assert.equal(schemaReviewMatches(undefined,candidate,mode,baseSha256,sha256),false);
  }
});

test('Windows 0.162.1 selects only its reviewed model overlay; Mac and older releases retain their patches',()=>{
  const pin=JSON.parse(readFileSync(new URL('../../harness/upstream.json',import.meta.url)));
  const next=pin.candidatePatches['0.162.1'];
  const mac=upstreamPatches(pin,'0.162.1',next.commit,'darwin');
  assert.deepEqual(mac,[next.basePatch,next]);
  assert.equal(createHash('sha256').update(Buffer.concat(mac.map(p=>readFileSync(new URL('../../harness/'+p.path,import.meta.url))))).digest('hex'),
    // Capacity gates were removed from the reviewed base patch on 2026-10-19.
    '974a6e854a7e536b0df53b787d198bea6548700cb62ed186fb882f9f5bcea26c');
  assert.deepEqual(upstreamPatches(pin,'0.162.1',next.commit,'win32'),[next.basePatch,next,pin.windowsPatch,next.windowsModelPatch]);
  const old=pin.candidatePatches['0.159.2'];
  assert.deepEqual(upstreamPatches(pin,'0.159.2',old.commit,'win32'),[pin.patch,old,pin.windowsPatch,pin.windowsModelPatch]);
  assert.deepEqual(upstreamPatches(pin,pin.version,pin.commit,'win32'),[pin.patch,pin.windowsPatch,pin.windowsModelPatch]);
  assert.throws(()=>upstreamPatches(pin,'0.162.1','0'.repeat(40),'win32'),/COMMIT_MISMATCH/);
  assert.throws(()=>prepareWindowsModel('unused',true,{version:'0.162.2',commit:next.commit}),/CANDIDATE_UNREVIEWED/);
  assert.throws(()=>prepareWindowsModel('unused',true,{version:'0.162.1',commit:'0'.repeat(40)}),/COMMIT_MISMATCH/);
  for(const spec of [pin.windowsModelPatch,next.windowsModelPatch]){
    assert.equal(createHash('sha256').update(readFileSync(new URL('../../harness/'+spec.path,import.meta.url))).digest('hex'),spec.sha256);
  }
  const files=JSON.parse(readFileSync(new URL('../../harness/'+next.windowsModelPatch.files,import.meta.url)));
  const helper=files.find(f=>f.template==='windows_model_transport.rs');
  assert.equal(helper.patchedSha256,createHash('sha256').update(windowsModelTemplate('0.162.1')).digest('hex'));
  assert.equal(windowsModelTemplate('0.162.1').split('#[cfg(test)]')[0],windowsModelTemplate().split('#[cfg(test)]')[0]);
});

test('schema gate rejects an unreviewed contract even with a reviewed version identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'runtime-schema-gate-'));
  const schemas=join(root,'codex-rs/app-server-protocol/schema/precomputed');
  mkdirSync(schemas,{recursive:true});
  const review=JSON.parse(readFileSync(new URL('../../harness/schema/reviews/0.159.2.json',import.meta.url)));
  const candidate={version:review.version,commit:review.commit};
  for(const mode of ['stable','experimental']){
    writeFileSync(join(schemas,`app-server-exports-${mode}.json.zst`),readFileSync(new URL(`../../harness/schema/app-server-exports-${mode}.json.zst`,import.meta.url)));
  }
  const output=join(root,'result.json');
  checkRuntimeSchema(root,output,candidate);
  assert.equal(JSON.parse(readFileSync(output)).review,undefined,'unchanged baseline is not the reviewed candidate');
  const stable=join(schemas,'app-server-exports-stable.json.zst');
  const changed=JSON.parse(zstdDecompressSync(readFileSync(stable)));
  const key=Object.keys(changed.json_schema)[0];
  delete changed.json_schema[key];
  writeFileSync(stable,zstdCompressSync(Buffer.from(JSON.stringify(changed))));
  assert.throws(()=>checkRuntimeSchema(root,output,candidate),/RUNTIME_SCHEMA_ADAPTATION_REQUIRED/);
  assert.ok(JSON.parse(readFileSync(output)).stable.includes(key));
});
