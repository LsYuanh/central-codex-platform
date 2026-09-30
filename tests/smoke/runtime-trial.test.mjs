// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {releasePath,releaseVersion} from '../../harness/check-upstream.mjs';

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
