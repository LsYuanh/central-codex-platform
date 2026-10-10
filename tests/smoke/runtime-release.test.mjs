// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {validateReleaseArtifact} from '../../scripts/release/runtime-release-artifact.mjs';

const archive=Buffer.from('synthetic runtime archive');
const sha=createHash('sha256').update(archive).digest('hex'),commit='a'.repeat(40);
const report={status:'validated',sourceCommit:commit,latestVersion:'0.159.2',releaseTag:'runtime-0.159.2-123',archiveSha256:sha};
const descriptor={version:'0.159.2',sequence:123,package:{version:'0.159.2'},archiveBytes:archive.length,archiveSha256:sha,
  archiveUrl:'https://github.com/LsYuanh/central-codex-platform/releases/download/runtime-0.159.2-123/runtime.tar.gz'};

test('release accepts the validated archive from this exact source revision',()=>{
  assert.doesNotThrow(()=>validateReleaseArtifact(report,descriptor,archive,commit));
});
test('release refuses failed, missing or stale build provenance',()=>{
  assert.throws(()=>validateReleaseArtifact({...report,status:'needs-adaptation'},descriptor,archive,commit),/NOT_VALIDATED/);
  for(const expected of [undefined,'',commit+'\n','b'.repeat(40)]) {
    assert.throws(()=>validateReleaseArtifact(report,descriptor,archive,expected),/SOURCE_MISMATCH/);
  }
  assert.throws(()=>validateReleaseArtifact({...report,sourceCommit:undefined},descriptor,archive,commit),/SOURCE_MISMATCH/);
});
test('release refuses modified bytes, sizes, URLs and inconsistent version identities',()=>{
  assert.throws(()=>validateReleaseArtifact(report,descriptor,Buffer.from('changed'),commit),/ARTIFACT_MISMATCH/);
  for(const change of [{archiveBytes:0},{archiveSha256:'0'.repeat(64)},{version:'0.159.3'},{package:{version:'0.156.1'}},
    {sequence:124},{sequence:-1},{archiveUrl:descriptor.archiveUrl.replace('github.com','example.invalid')}]) {
    assert.throws(()=>validateReleaseArtifact(report,{...descriptor,...change},archive,commit),/ARTIFACT_MISMATCH/);
  }
  assert.throws(()=>validateReleaseArtifact({...report,releaseTag:'runtime-0.159.3-123'},descriptor,archive,commit),/ARTIFACT_MISMATCH/);
  assert.throws(()=>validateReleaseArtifact({...report,archiveSha256:'0'.repeat(64)},descriptor,archive,commit),/ARTIFACT_MISMATCH/);
});
