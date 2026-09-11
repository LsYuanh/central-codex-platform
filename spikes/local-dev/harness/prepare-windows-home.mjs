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
export function prepareWindowsHome(source,verifyOnly=false) {
  const pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
  const files=JSON.parse(readFileSync(join(here,'windows-home-files.json'),'utf8'));
  const patch=join(here,pin.windowsPatch.path);
  if(hash(readFileSync(patch))!==pin.windowsPatch.sha256) throw Error('Windows home patch hash mismatch');
  const apply=args=> {
    const result=spawnSync('git',['-c','core.autocrlf=input','apply',...args,patch],
      {cwd:source,env:isolatedGitEnvironment(source),encoding:'utf8'});
    if(result.status!==0) throw Error(`Windows home patch failed: ${result.stderr}`);
  };
  if(!verifyOnly) {
    for(const file of files) {
      const path=join(source,file.path);
      if(file.upstreamSha256===null ? existsSync(path) : normalized(path)!==file.upstreamSha256)
        throw Error(`Windows home original source changed: ${file.path}`);
    }
    apply(['--check']); apply([]);
  }
  for(const file of files)
    if(!existsSync(join(source,file.path)) || normalized(join(source,file.path))!==file.patchedSha256)
      throw Error(`WINDOWS_HOME_SOURCE_CHANGED: ${file.path}`);
  if(normalized(join(source,files[1].path))!==normalized(join(here,'windows_home.rs')))
    throw Error('WINDOWS_HOME_TEMPLATE_CHANGED: regenerate pinned overlay');
  apply(['--reverse','--check']);
  return {windowsPatchSha256:pin.windowsPatch.sha256,verifiedWindowsFiles:files.length};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]) throw Error('Usage: prepare-windows-home.mjs SOURCE [--verify]');
  console.log(JSON.stringify(prepareWindowsHome(resolve(process.argv[2]),process.argv[3]==='--verify')));
}
