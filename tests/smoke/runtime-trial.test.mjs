// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {releasePath,releaseVersion,upstreamHeaders} from '../../harness/check-upstream.mjs';
import {readFileSync} from 'node:fs';
import {schemaReviewMatches} from '../../harness/check-runtime-schema.mjs';

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
test('discovery token is limited to the official upstream API',()=>{
  const token='synthetic-trial-token';
  assert.equal(upstreamHeaders('https://api.github.com/repos/openai/codex/releases/latest',true,token).authorization,`Bearer ${token}`);
  for(const url of ['https://codeload.github.com/openai/codex/tar.gz/abc','https://api.github.com/repos/other/repo/releases/latest','https://api.github.com.evil.invalid/repos/openai/codex/releases/latest','http://api.github.com/repos/openai/codex/releases/latest']){
    assert.equal(upstreamHeaders(url,true,token).authorization,undefined);
  }
  assert.equal(upstreamHeaders('https://api.github.com/repos/openai/codex/releases/latest',true).authorization,undefined);
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
