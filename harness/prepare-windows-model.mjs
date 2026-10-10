// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isolatedGitEnvironment} from './patch-git-env.mjs';
import {candidatePatch} from './check-upstream.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalized=path=>hash(readFileSync(path,'utf8').replace(/\r\n/g,'\n'));
export function windowsModelTemplate(version) {
  const template=readFileSync(join(here,'windows_model_transport.rs'),'utf8').replace(/\r\n/g,'\n');
  if(version===undefined)return template;
  if(version!=='0.162.1')throw Error('WINDOWS_MODEL_CANDIDATE_UNREVIEWED');
  // Only the unit fixture changes: the new Request has additional defaulted fields.
  // Keep the older overlay bytes and the production helper implementation intact.
  const old='        let mut request = Request {\n            method: http::Method::POST,\n            url: MODEL_PIPE_URL.into(),\n            headers: HeaderMap::new(),\n            body: None,\n            compression: RequestCompression::None,\n            timeout: None,\n        };';
  if(template.split(old).length!==2)throw Error('WINDOWS_MODEL_TEMPLATE_CHANGED');
  return template.replace(old,'        let mut request = Request::new(http::Method::POST, MODEL_PIPE_URL.into());');
}
export function prepareWindowsModel(source,verifyOnly=false,candidate) {
  const pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
  const adaptation=candidate?candidatePatch(pin,candidate.version,candidate.commit):undefined;
  if(candidate&&!adaptation?.windowsModelPatch)throw Error('WINDOWS_MODEL_CANDIDATE_UNREVIEWED');
  const spec=adaptation?.windowsModelPatch??pin.windowsModelPatch;
  const files=JSON.parse(readFileSync(join(here,spec.files??'windows-model-files.json'),'utf8'));
  const patch=join(here,spec.path);
  if(hash(readFileSync(patch))!==spec.sha256) throw Error('Windows model patch hash mismatch');
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
    if(file.template && normalized(join(source,file.path))!==hash(windowsModelTemplate(candidate?.version)))
      throw Error('WINDOWS_MODEL_TEMPLATE_CHANGED: regenerate pinned overlay');
  }
  apply(['--reverse','--check']);
  return {windowsModelPatchSha256:spec.sha256,verifiedWindowsModelFiles:files.length};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(3),verifyOnly=args[0]==='--verify';
  if(verifyOnly)args.shift();
  if(!process.argv[2]||![0,2].includes(args.length))throw Error('Usage: prepare-windows-model.mjs SOURCE [--verify] [VERSION COMMIT]');
  const candidate=args.length?{version:args[0],commit:args[1]}:undefined;
  console.log(JSON.stringify(prepareWindowsModel(resolve(process.argv[2]),verifyOnly,candidate)));
}
