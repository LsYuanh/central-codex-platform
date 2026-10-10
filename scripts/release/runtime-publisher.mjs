// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRuntimeSignature} from './runtime-signature.mjs';
import {validateReleaseArtifact} from './runtime-release-artifact.mjs';

const signer=fileURLToPath(new URL('../../node_modules/@tauri-apps/cli/tauri.js',import.meta.url));

// The CLI supplies the fixed channel key. Tests inject only a disposable key and
// an offline GitHub executor; there is no environment/CLI override for that trust root.
export async function publishRuntimeUpdate(directory,{channelKey,env=process.env,execute=spawnSync}) {
  const report=JSON.parse(await readFile(join(directory,'report.json')));
  if(report.status==='up-to-date')return {published:false};
  if(report.status!=='validated')throw Error('RUNTIME_NOT_VALIDATED');
  const descriptorPath=join(directory,'latest.json');
  const bytes=await readFile(descriptorPath),descriptor=JSON.parse(bytes);
  const archive=await readFile(join(directory,'runtime.tar.gz'));
  validateReleaseArtifact(report,descriptor,archive,env.GITHUB_SHA);
  if(!env.TAURI_SIGNING_PRIVATE_KEY)throw Error('RUNTIME_SIGNING_KEY_REQUIRED');
  if(env.GH_REPO!=='LsYuanh/central-codex-platform'||!env.GH_TOKEN||
    (env.GH_HOST&&env.GH_HOST!=='github.com'))throw Error('RUNTIME_RELEASE_DESTINATION_INVALID');

  // Keep the signing key out of gh, and the repository token out of the signer.
  const baseEnv=Object.fromEntries(Object.entries(env).filter(([key])=>!/(TOKEN|SECRET|PASSWORD|SIGNING|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i.test(key)));
  const signingEnv={...baseEnv,CI:'true',TAURI_SIGNING_PRIVATE_KEY:env.TAURI_SIGNING_PRIVATE_KEY,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD??''};
  const githubEnv={...baseEnv,GH_HOST:'github.com',GH_TOKEN:env.GH_TOKEN,GH_REPO:env.GH_REPO};
  const run=(command,args,childEnv,code,timeout)=>{
    const result=execute(command,args,{env:childEnv,encoding:'utf8',windowsHide:true,timeout});
    // Subprocess diagnostics can contain credentials. Return a bounded stage code.
    if(result.error||result.status!==0)throw Error(code);
    return result;
  };
  run(process.execPath,[signer,'signer','sign',descriptorPath],signingEnv,'RUNTIME_SIGNING_FAILED',120000);
  const signedBytes=await readFile(descriptorPath);
  if(!signedBytes.equals(bytes))throw Error('RUNTIME_ARTIFACT_MISMATCH');
  validateReleaseArtifact(report,descriptor,await readFile(join(directory,'runtime.tar.gz')),env.GITHUB_SHA);
  verifyRuntimeSignature(signedBytes,await readFile(descriptorPath+'.sig','utf8'),channelKey);
  const release=(args,code)=>run('gh',['release',...args],githubEnv,code,15*60*1000);
  release(['create',report.releaseTag,join(directory,'runtime.tar.gz'),'--target',report.sourceCommit,
    '--title',`App Server ${descriptor.version}`,'--notes','Validated Yuan Zhou central runtime.','--latest=false'],'RUNTIME_RELEASE_CREATE_FAILED');
  const channel='runtime-stable-macos-arm64';
  const lookup=execute('gh',['release','view',channel],{env:githubEnv,encoding:'utf8',windowsHide:true,timeout:120000});
  if(lookup.error||lookup.status===null)throw Error('RUNTIME_CHANNEL_LOOKUP_FAILED');
  // gh uses exit 1 both for missing releases and API failures. Only the explicit
  // missing-release response permits creation; network/auth failures stop here.
  if(lookup.status!==0){
    if(lookup.status!==1||!/^release not found\s*$/i.test((lookup.stderr??'').trim()))throw Error('RUNTIME_CHANNEL_LOOKUP_FAILED');
    release(['create',channel,'--target',report.sourceCommit,'--title','Central runtime stable channel',
      '--notes','Signed compatible runtime channel.','--latest=false'],'RUNTIME_CHANNEL_CREATE_FAILED');
  }
  // Readers reject a temporary mismatched pair and keep their installed runtime.
  release(['upload',channel,descriptorPath,descriptorPath+'.sig','--clobber'],'RUNTIME_CHANNEL_UPLOAD_FAILED');
  return {published:true,version:descriptor.version,releaseTag:report.releaseTag};
}
