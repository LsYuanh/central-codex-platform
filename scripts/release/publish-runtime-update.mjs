// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Invoked only in the protected signing/release job after builder validation.
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {verifyRuntimeSignature} from './runtime-signature.mjs';
import {validateReleaseArtifact} from './runtime-release-artifact.mjs';
const dir=resolve(process.argv[2]??'');
const report=JSON.parse(await readFile(join(dir,'report.json')));
if(report.status!=='validated'){console.log(`No runtime published: ${report.code??report.status}`);process.exit(0);}
if(!process.env.TAURI_SIGNING_PRIVATE_KEY)throw Error('RUNTIME_SIGNING_KEY_REQUIRED');
const descriptor=JSON.parse(await readFile(join(dir,'latest.json'))),archive=await readFile(join(dir,'runtime.tar.gz'));
validateReleaseArtifact(report,descriptor,archive,process.env.GITHUB_SHA);
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error('RUNTIME_PUBLISH_FAILED');};
run(process.execPath,['node_modules/@tauri-apps/cli/tauri.js','signer','sign',join(dir,'latest.json')]);
const channelKey=JSON.parse(await readFile(new URL('../../harness/runtime-update-channel.json',import.meta.url))).publicKey;
verifyRuntimeSignature(await readFile(join(dir,'latest.json')),await readFile(join(dir,'latest.json.sig'),'utf8'),channelKey);
run('gh',['release','create',report.releaseTag,join(dir,'runtime.tar.gz'),'--target',report.sourceCommit,'--title',`App Server ${descriptor.version}`,'--notes','Validated Yuan Zhou central runtime.','--latest=false']);
const channel='runtime-stable-macos-arm64';
const exists=spawnSync('gh',['release','view',channel],{stdio:'ignore'}).status===0;
if(!exists)run('gh',['release','create',channel,'--target',report.sourceCommit,'--title','Central runtime stable channel','--notes','Signed compatible runtime channel.','--latest=false']);
// Readers reject a temporary mismatched payload/signature pair and retain their current runtime.
run('gh',['release','upload',channel,join(dir,'latest.json'),join(dir,'latest.json.sig'),'--clobber']);
