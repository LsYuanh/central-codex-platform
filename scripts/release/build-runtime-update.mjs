// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Dedicated Mac build runner only. Does not install, stop, or mutate a service.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {mkdtempSync,statfsSync,writeFileSync} from 'node:fs';
import {totalmem,freemem} from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {checkUpstream} from '../../harness/check-upstream.mjs';
import {checkRuntimeSchema} from '../../harness/check-runtime-schema.mjs';
import {stageGateway,verifyCandidate,digestFile} from '../build/stage-central-gateway.mjs';
const [outputArg,licenseArg,requestedVersion]=process.argv.slice(2);
if(!outputArg||!licenseArg||process.platform!=='darwin'||process.arch!=='arm64')throw Error('Usage on isolated Mac arm64: node scripts/release/build-runtime-update.mjs NEW_OUTPUT NODE_LICENSE [STABLE_VERSION]');
const root=resolve('.'),output=resolve(outputArg);
await mkdir(output,{recursive:false});
const started=Date.now();
function resources(){const disk=statfsSync(output);return {elapsedSeconds:Math.round((Date.now()-started)/1000),totalMemoryBytes:totalmem(),freeMemoryBytes:freemem(),availableDiskBytes:disk.bavail*disk.bsize};}
const initialResources=resources();
const report=await checkUpstream(join(output,'upstream'),requestedVersion);
Object.assign(report,{requestedVersion,resources:{start:initialResources,afterDiscovery:resources()},steps:[]});
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
if(report.status!=='ready-for-validation'){console.log(JSON.stringify(report));process.exit(report.status==='up-to-date'?0:1);}
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(TOKEN|SECRET|PASSWORD|SIGNING|API_KEY|CODEX_HOME)/i.test(key)));
// Honor the reviewed candidate's rust-toolchain.toml, not a runner's stable override.
delete env.RUSTUP_TOOLCHAIN;
// GitHub's temporary path can exceed macOS's Unix socket path limit in isolation probes.
const qaRoot=mkdtempSync('/private/tmp/yz-');
// Node's macOS default /var/folders path aliases /private/var; Worker roots reject
// aliases deliberately. Keep every fixture on the same canonical, short QA root.
Object.assign(env,{CARGO_TARGET_DIR:join(output,'cargo-target'),HARNESS_QA_ROOT:qaRoot,TMPDIR:qaRoot});
// Respect the runner's selected Xcode; a standalone CLT directory need not exist.
function run(command,args,cwd=root){
  const step={command,args,startedAt:new Date().toISOString(),before:resources()};
  report.steps.push(step);
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  const r=spawnSync('/usr/bin/time',['-l',command,...args],{cwd,env,stdio:'inherit',timeout:90*60*1000});
  Object.assign(step,{exitCode:r.status,signal:r.signal,after:resources()});
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  if(r.status!==0)throw Error('RUNTIME_VALIDATION_FAILED');
}
try{
  checkRuntimeSchema(report.source,join(output,'schema-changes.json'),{version:report.latestVersion,commit:report.commit});
  run('cargo',['build','-p','codex-app-server','--bin','codex-app-server','--locked'],join(report.source,'codex-rs'));
  const binary=join(env.CARGO_TARGET_DIR,'debug/codex-app-server');
  // Run independent probes even after one fails; packaging still requires all of them.
  let probeFailed=false;
  const probe=(command,args)=>{try{run(command,args);}catch{probeFailed=true;}};
  probe(process.execPath,['harness/runtime-smoke.mjs',binary]);
  probe(process.execPath,['harness/plan-goal-smoke.mjs',binary]);
  probe(process.execPath,['harness/image-generation-smoke.mjs',binary]);
  probe(process.execPath,['harness/model-catalog-smoke.mjs',binary,join(report.source,'codex-rs/models-manager/models.json'),report.latestVersion]);
  probe(process.execPath,['harness/thread-delete-smoke.mjs',binary]);
  probe(process.execPath,['harness/worker-isolation-smoke.mjs']);
  probe(process.execPath,['tests/smoke/model-credential-broker-smoke.mjs']);
  probe(process.execPath,['tests/smoke/worker-routing-smoke.mjs']);
  probe(process.execPath,['tests/smoke/task-control-smoke.mjs']);
  probe(process.execPath,['tests/smoke/task-control-gateway-smoke.mjs']);
  probe(process.execPath,['tests/smoke/runtime-updates-smoke.mjs']);
  probe(process.execPath,['tests/smoke/native-account-update-smoke.mjs']);
  probe('cargo',['test','-p','central-app','runtime_updates','--locked']);
  if(probeFailed)throw Error('RUNTIME_VALIDATION_FAILED');
  const upstream={version:report.latestVersion,commit:report.commit,archiveSha256:report.archiveSha256,patchSha256:report.patchSha256};
  const staged=await stageGateway({sourceRoot:root,nodeExe:process.execPath,nodeLicense:resolve(licenseArg),appServer:binary,seatbeltProfile:join(root,'harness/worker-isolated.sb'),upstream});
  const manifest=await verifyCandidate(staged.destination);
  const archive=join(output,'runtime.tar.gz');run('tar',['-czf',archive,'-C',staged.destination,...['manifest.json',...manifest.files.map(f=>f.path)]]);
  const packagePin={id:staged.packageId,label:'macOS 中央自动更新运行包',version:report.latestVersion,platform:'darwin',architecture:'aarch64',marker:'yuan-zhou-remote-workspace/1',qualified:false,
    manifest:{path:'manifest.json',...await digestFile(join(staged.destination,'manifest.json'))},fileCount:manifest.files.length,node:'bin/node',entrypoint:manifest.entrypoint,appServer:'bin/codex-app-server',seatbeltProfile:'harness/worker-isolated.sb',blockers:['PRODUCTION_QUALIFICATION_PENDING']};
  const digest=await digestFile(archive);
  // Archive URLs are immutable per version/build; only the signed channel pointer moves.
  const sequence=Date.now();const releaseTag=`runtime-${report.latestVersion}-${sequence}`;
  const descriptor={schemaVersion:1,version:report.latestVersion,sequence,hostProtocol:'central-runtime-update/v1',archiveUrl:`https://github.com/LsYuanh/central-codex-platform/releases/download/${releaseTag}/runtime.tar.gz`,archiveBytes:digest.bytes,archiveSha256:digest.sha256,package:packagePin};
  await writeFile(join(output,'latest.json'),JSON.stringify(descriptor,null,2)+'\n');
  Object.assign(report,{status:'validated',releaseTag,archiveSha256:digest.sha256});
}catch(error){Object.assign(report,{status:'needs-adaptation',code:error.message==='RUNTIME_SCHEMA_ADAPTATION_REQUIRED'?error.message:'RUNTIME_VALIDATION_FAILED'});}
report.resources.finish=resources();
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(report.status!=='validated')process.exitCode=1;
