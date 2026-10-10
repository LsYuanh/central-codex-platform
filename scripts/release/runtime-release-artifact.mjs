// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {createHash} from 'node:crypto';

// Validate the exact builder revision and immutable download identity before
// giving a candidate to the signer. A successful older run is not interchangeable.
export function validateReleaseArtifact(report, descriptor, archive, expectedCommit) {
  if(report.status!=='validated')throw Error('RUNTIME_NOT_VALIDATED');
  if(!/^[a-f0-9]{40}$/.test(expectedCommit??'')||report.sourceCommit!==expectedCommit)throw Error('RUNTIME_SOURCE_MISMATCH');
  const version=report.latestVersion;
  if(!/^\d+\.\d+\.\d+$/.test(version??'')||!Number.isSafeInteger(descriptor.sequence)||descriptor.sequence<=0||
    report.releaseTag!==`runtime-${version}-${descriptor.sequence}`||descriptor.version!==version||descriptor.package?.version!==version||
    descriptor.archiveUrl!==`https://github.com/LsYuanh/central-codex-platform/releases/download/${report.releaseTag}/runtime.tar.gz`||
    archive.length!==descriptor.archiveBytes||createHash('sha256').update(archive).digest('hex')!==descriptor.archiveSha256||descriptor.archiveSha256!==report.archiveSha256) {
    throw Error('RUNTIME_ARTIFACT_MISMATCH');
  }
}
