// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {releasePath,releaseVersion,upstreamHeaders,candidatePatch} from '../../harness/check-upstream.mjs';
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
test('reviewed schema requires exact release, commit, baseline and candidate bytes',()=>{
  const review=JSON.parse(readFileSync(new URL('../../harness/schema/reviews/0.159.2.json',import.meta.url)));
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
