// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isolatedGitEnvironment} from './patch-git-env.mjs';
import {prepareWindowsHome} from './prepare-windows-home.mjs';
import {prepareWindowsModel} from './prepare-windows-model.mjs';
export {isolatedGitEnvironment} from './patch-git-env.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
const files=JSON.parse(readFileSync(join(here,'source-files.json'),'utf8'));

function apply(source,args) {
  // Keep fresh output as LF and permit legacy CRLF worktrees in reverse checks.
  // This is explicit command configuration, never inherited user configuration;
  // full-file LF hashes below remain the authoritative content verification.
  const result=spawnSync('git',['-c','core.autocrlf=input','apply',...args,join(here,'remote-workspace.patch')],{
    cwd:source,env:isolatedGitEnvironment(source),encoding:'utf8'});
  if(result.status!==0) throw Error(`Pinned patch ${args.join(' ')} failed: ${result.stderr}`);
}
export function preparePatch(source, verifyOnly=false) {
  source=resolve(source);
  if(digest(readFileSync(join(here,'remote-workspace.patch')))!==pin.patch.sha256) throw Error('Fork patch hash mismatch');
  const modulePath=join(source,'codex-rs/core/src/remote_workspace.rs');
  if(!verifyOnly) {
    if(existsSync(modulePath)) throw Error('Source already has a remote-workspace module; use verification, not reapplication');
    for(const item of files)
      if(digest(readFileSync(join(source,item.path)))!==item.upstreamSha256) throw Error(`Upstream file changed: ${item.path}`);
    apply(source,['--check']);
    apply(source,[]);
  }
  // Explicit postcondition: a successful git exit is not evidence of application.
  const sourceDigest=path=>digest(readFileSync(path,'utf8').replace(/\r\n/g,'\n'));
  if(!existsSync(modulePath)||sourceDigest(modulePath)!==sourceDigest(join(here,'remote_workspace.rs')))
    throw Error('REMOTE_WORKSPACE_PATCH_MISSING_OR_CHANGED');
  // Reverse applicability only covers patch hunks. Hash each complete file,
  // including dependency entries outside the changed Cargo.lock contexts.
  for(const item of files)
    if(!item.patchedSha256 || sourceDigest(join(source,item.path))!==item.patchedSha256)
      throw Error(`PATCHED_SOURCE_CHANGED: ${item.path}`);
  apply(source,['--reverse','--check']);
  const windows=process.platform==='win32'?prepareWindowsHome(source,verifyOnly):{};
  const model=process.platform==='win32'?prepareWindowsModel(source,verifyOnly):{};
  return {commit:pin.commit,patchSha256:pin.patch.sha256,verifiedFiles:files.length+1,...windows,...model};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]) throw Error('Usage: prepare-patch.mjs EXTRACTED_SOURCE [--verify]');
  console.log(JSON.stringify(preparePatch(process.argv[2],process.argv[3]==='--verify')));
}
