// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isolatedGitEnvironment} from './patch-git-env.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalized=path=>hash(readFileSync(path,'utf8').replace(/\r\n/g,'\n'));
export function prepareWindowsModel(source,verifyOnly=false) {
  const pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
  const files=JSON.parse(readFileSync(join(here,'windows-model-files.json'),'utf8'));
  const patch=join(here,pin.windowsModelPatch.path);
  if(hash(readFileSync(patch))!==pin.windowsModelPatch.sha256) throw Error('Windows model patch hash mismatch');
  const apply=args=> {
    const result=spawnSync('git',['-c','core.autocrlf=input','apply',...args,patch],
      {cwd:source,env:isolatedGitEnvironment(source),encoding:'utf8'});
    if(result.status!==0) throw Error(`Windows model patch failed: ${result.stderr}`);
  };
  if(!verifyOnly) {
    for(const file of files) {
      const path=join(source,file.path);
      if(file.upstreamSha256===null ? existsSync(path) : !existsSync(path)||normalized(path)!==file.upstreamSha256)
        throw Error(`Windows model original source changed: ${file.path}`);
    }
    apply(['--check']); apply([]);
  }
  for(const file of files) {
    if(!existsSync(join(source,file.path)) || normalized(join(source,file.path))!==file.patchedSha256)
      throw Error(`WINDOWS_MODEL_SOURCE_CHANGED: ${file.path}`);
    if(file.template && normalized(join(source,file.path))!==normalized(join(here,file.template)))
      throw Error('WINDOWS_MODEL_TEMPLATE_CHANGED: regenerate pinned overlay');
  }
  apply(['--reverse','--check']);
  return {windowsModelPatchSha256:pin.windowsModelPatch.sha256,verifiedWindowsModelFiles:files.length};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]) throw Error('Usage: prepare-windows-model.mjs SOURCE [--verify]');
  console.log(JSON.stringify(prepareWindowsModel(resolve(process.argv[2]),process.argv[3]==='--verify')));
}
