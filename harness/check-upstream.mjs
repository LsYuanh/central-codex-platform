// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Read-only upstream discovery + isolated patch compatibility check; never installs.
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isolatedGitEnvironment} from './patch-git-env.mjs';
export const stableVersion = tag => /^rust-v(\d+\.\d+\.\d+)$/.exec(tag ?? '')?.[1];
// A trial pins its release so a newly published version cannot change the experiment.
export function releasePath(version) {
  if(version===undefined)return 'latest';
  if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version))throw Error('UPSTREAM_VERSION_INVALID');
  return `tags/rust-v${version}`;
}
export function releaseVersion(release,requestedVersion) {
  const version=stableVersion(release.tag_name);
  if(!version||release.draft||release.prerelease||(requestedVersion!==undefined&&version!==requestedVersion))throw Error('UPSTREAM_NOT_STABLE');
  return version;
}
export function compareVersions(a,b) {
  for(let i=0;i<3;i++){const delta=Number(a.split('.')[i])-Number(b.split('.')[i]);if(delta)return Math.sign(delta);}return 0;
}
export function candidatePatch(pin,version,commit) {
  const patch=pin.candidatePatches?.[version];
  if(patch&&patch.commit!==commit)throw Error('UPSTREAM_ADAPTATION_COMMIT_MISMATCH');
  return patch;
}
export function upstreamPatches(pin,version,commit,platform=process.platform) {
  const adaptation=candidatePatch(pin,version,commit);
  // A Mac-reviewed adaptation must not silently reuse an older Windows overlay.
  if(adaptation?.platforms&&!adaptation.platforms.includes(platform))throw Error('UPSTREAM_ADAPTATION_PLATFORM_UNREVIEWED');
  return [adaptation?.basePatch??pin.patch,...(adaptation?[adaptation]:[]),
    ...(adaptation?.deviceApprovalPatch?[adaptation.deviceApprovalPatch]:[]),
    ...(platform==='win32'?[pin.windowsPatch,adaptation?.windowsModelPatch??pin.windowsModelPatch]:[])];
}
export function upstreamHeaders(url,json,token) {
  const headers={'User-Agent':'Yuan-Zhou-runtime-updates',accept:json?'application/vnd.github+json':'application/octet-stream'};
  const target=new URL(url);
  // The ephemeral read-only job token avoids the shared runner's anonymous API limit.
  // Never forward it to archives, redirects or another origin.
  if(token&&target.origin==='https://api.github.com'&&target.pathname.startsWith('/repos/openai/codex/'))headers.authorization=`Bearer ${token}`;
  return headers;
}
async function download(url, limit, json=false) {
  const response=await fetch(url,{headers:upstreamHeaders(url,json,process.env.GITHUB_TOKEN),redirect:'error',signal:AbortSignal.timeout(60000)});
  if(response.status===403&&response.headers.get('x-ratelimit-remaining')==='0')throw Error('UPSTREAM_RATE_LIMITED');
  if(!response.ok)throw Error(`UPSTREAM_HTTP_${response.status}`);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('UPSTREAM_TOO_LARGE');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);return json?JSON.parse(bytes):bytes;
}
export async function checkUpstream(destination,requestedVersion) {
  const releaseEndpoint=releasePath(requestedVersion);
  const here=dirname(fileURLToPath(import.meta.url));
  const pin=JSON.parse(await readFile(join(here,'upstream.json')));
  await mkdir(destination,{recursive:false});
  const report={schemaVersion:1,checkedAt:new Date().toISOString(),currentVersion:pin.version,status:'checking'};
  const save=()=>writeFile(join(destination,'upstream-report.json'),JSON.stringify(report,null,2)+'\n');
  try{
    const release=await download(`https://api.github.com/repos/openai/codex/releases/${releaseEndpoint}`,1024*1024,true);
    const version=releaseVersion(release,requestedVersion);
    Object.assign(report,{latestVersion:version,tag:release.tag_name});
    if(compareVersions(version,pin.version)<=0){report.status='up-to-date';await save();return report;}
    // Resolve the release tag once; pin the immutable commit and downloaded bytes.
    const ref=await download(`https://api.github.com/repos/openai/codex/git/ref/tags/${release.tag_name}`,1024*1024,true);
    let object=ref.object;
    if(object?.type==='tag')object=(await download(`https://api.github.com/repos/openai/codex/git/tags/${object.sha}`,1024*1024,true)).object;
    if(object?.type!=='commit'||! /^[a-f0-9]{40}$/.test(object.sha))throw Error('UPSTREAM_COMMIT_INVALID');
    report.commit=object.sha;
    const adaptation=candidatePatch(pin,version,report.commit);
    const archive=await download(`https://codeload.github.com/openai/codex/tar.gz/${object.sha}`,128*1024*1024);
    report.archiveSha256=createHash('sha256').update(archive).digest('hex');
    if(adaptation?.archiveSha256&&adaptation.archiveSha256!==report.archiveSha256)throw Error('UPSTREAM_ARCHIVE_HASH_MISMATCH');
    const archivePath=join(destination,'upstream.tar.gz');await writeFile(archivePath,archive,{flag:'wx'});
    const source=join(destination,`codex-${object.sha}`);
    // The known redundant LICENSE symlink is excluded; new links require review.
    const exclude=['--exclude',`codex-${object.sha}/codex-rs/vendor/bubblewrap/LICENSE`];
    const listing=spawnSync('tar',['-tzf',archivePath,...exclude],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
    const types=spawnSync('tar',['-tzvf',archivePath,...exclude],{encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
    const names=listing.stdout?.trim().split(/\r?\n/)??[];
    if(listing.status!==0||types.status!==0||names.length>100000||names.some(name=>!name.startsWith(`codex-${object.sha}/`)||name.includes('\\')||name.includes(':')||name.split('/').includes('..'))||types.stdout.trim().split(/\r?\n/).some(line=>!/^[-d]/.test(line)))throw Error('UPSTREAM_ARCHIVE_UNSAFE');
    const extraction=spawnSync('tar',['-xzf',archivePath,'-C',destination,...exclude],{encoding:'utf8',timeout:60000});
    if(extraction.status!==0)throw Error('UPSTREAM_EXTRACT_FAILED');
    // A source refactor can require a reviewed replacement of the base patch.
    // It is bound to the exact candidate commit and hash, never used by other releases.
    const basePatch=adaptation?.basePatch??pin.patch;
    const patches=upstreamPatches(pin,version,report.commit);
    const appliedBytes=[];
    report.patches=[];
    for(const spec of patches){
      const patch=join(here,spec.path);
      const bytes=await readFile(patch);
      if(createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw Error('UPSTREAM_PATCH_HASH_MISMATCH');
      // Upstream source-less workspace package versions follow the candidate version.
      // Never carry the old release's Cargo.lock hunk or touch third-party pins.
      const exclusions=spec===basePatch?['--exclude=codex-rs/Cargo.lock']:[];
      const result=spawnSync('git',['-c','core.autocrlf=input','apply','--check',...exclusions,patch],{cwd:source,env:isolatedGitEnvironment(source),encoding:'utf8',timeout:60000});
      if(result.status!==0){report.status='needs-adaptation';report.code='UPSTREAM_PATCH_CONFLICT';await writeFile(join(destination,'patch-conflicts.txt'),result.stderr);await save();return report;}
      const applied=spawnSync('git',['-c','core.autocrlf=input','apply',...exclusions,patch],{cwd:source,env:isolatedGitEnvironment(source),encoding:'utf8',timeout:60000});
      if(applied.status!==0)throw Error('UPSTREAM_PATCH_APPLY_FAILED');
      appliedBytes.push(bytes);
      report.patches.push({path:spec.path,sha256:spec.sha256});
    }
    // Bind staged provenance to all applied patches, including version-scoped adaptations.
    report.patchSha256=createHash('sha256').update(Buffer.concat(appliedBytes)).digest('hex');
    const lockPath=join(source,'codex-rs/Cargo.lock');
    const lock=await readFile(lockPath,'utf8');
    await writeFile(lockPath,lock.replace(/(\[\[package\]\]\nname = "[^"]+"\nversion = ")0\.0\.0("\n)(?!source =)/g,(_match,prefix,suffix)=>prefix+version+suffix));
    report.status='ready-for-validation';report.source=source;
    await save();return report;
  }catch(error){report.status='failed';report.code=/^[A-Z_0-9]+$/.test(error.message)?error.message:'UPSTREAM_CHECK_FAILED';await save();return report;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]||process.argv.length>4)throw Error('Usage: node harness/check-upstream.mjs NEW_OUTPUT_DIRECTORY [STABLE_VERSION]');
  console.log(JSON.stringify(await checkUpstream(resolve(process.argv[2]),process.argv[3]),null,2));
}
