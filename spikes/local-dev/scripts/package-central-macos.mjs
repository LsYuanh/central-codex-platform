// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Native Apple Silicon developer test package. Does not install or replace a service.
import {readFile,writeFile,mkdir,cp,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stageGateway,verifyCandidate,digestFile} from './stage-central-gateway.mjs';
import {inspectPinnedService} from './stage-central-service-resource.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('MACOS_ARM64_REQUIRED');
if(args.length!==6||args[0]!=='--node-exe'||args[2]!=='--node-license'||args[4]!=='--app-server')throw Error('Usage: node scripts/package-central-macos.mjs --node-exe <absolute Node24> --node-license <distribution LICENSE> --app-server <patched absolute binary>');
function run(command,parameters,cwd=root){
  const result=spawnSync(command,parameters,{cwd,env:process.env,stdio:'inherit'});
  if(result.error||result.status!==0)throw Error(`BUILD_FAILED:${path.basename(command)}:${result.status}`);
}
for(const project of ['packages/agentrpc-types','services/test-gateway']) {
  // Source sync may preserve incremental metadata from another platform.
  run(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-b',path.join(root,project,'tsconfig.json'),'--force']);
}
const staged=await stageGateway({sourceRoot:path.resolve(root,'../..'),nodeExe:args[1],nodeLicense:args[3],appServer:args[5],seatbeltProfile:path.join(root,'harness/worker-isolated.sb')});
const manifest=await verifyCandidate(staged.destination);
const pin={id:staged.packageId,label:'macOS 中央服务 · Apple Silicon 测试包',version:'0.153.4',platform:'darwin',architecture:'aarch64',marker:'yuan-zhou-remote-workspace/1',qualified:false,
  manifest:{path:'manifest.json',...await digestFile(path.join(staged.destination,'manifest.json'))},fileCount:manifest.files.length,
  node:'bin/node',entrypoint:manifest.entrypoint,appServer:'bin/codex-app-server',seatbeltProfile:'harness/worker-isolated.sb',
  blockers:['PRODUCTION_QUALIFICATION_PENDING','PROJECT_LICENSE_DISTRIBUTION_REVIEW_PENDING']};
const catalogPath=path.join(root,'harness/central-service-catalog.json');
const catalog=JSON.parse(await readFile(catalogPath,'utf8'));
const previous=catalog.packages.find(p=>p.id===pin.id);
if(previous&&JSON.stringify(previous)!==JSON.stringify(pin))throw Error('EXISTING_PIN_MISMATCH');
if(!previous){catalog.packages.push(pin);await writeFile(catalogPath,JSON.stringify(catalog,null,2)+'\n');}
await inspectPinnedService(staged.destination,pin);
const output=path.join(root,'target/central-macos',staged.packageId,String(Date.now()));
await mkdir(output,{recursive:true});
const resources=Object.fromEntries([{path:'manifest.json'},...manifest.files].map(f=>[path.join(staged.destination,f.path),`central-service/${staged.packageId}/${f.path}`]));
const config={bundle:{active:true,targets:['app'],resources,macOS:{minimumSystemVersion:'12.0',signingIdentity:'-'}},app:{windows:[{label:'main',title:'远舟中央管理 · Mac 测试版',width:1280,height:860,minWidth:960,minHeight:680}]}};
const configPath=path.join(output,'tauri.config.json');
await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
run(process.execPath,[path.join(root,'node_modules/@tauri-apps/cli/tauri.js'),'build','--ci','--debug','--bundles','app','--config',configPath,'--','--locked','--offline'],path.join(root,'apps/central'));
const app=path.join(root,'target/debug/bundle/macos/远舟中央管理.app');
await inspectPinnedService(path.join(app,'Contents/Resources/central-service',staged.packageId),pin);
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
// hdiutil does not require a logged-in display/Finder AppleScript session.
const imageRoot=path.join(output,'image');await mkdir(imageRoot);
await cp(app,path.join(imageRoot,'远舟中央管理.app'),{recursive:true,errorOnExist:true,force:false});
await symlink('/Applications',path.join(imageRoot,'Applications'));
const dmg=path.join(output,'远舟中央管理_0.1.0_aarch64.dmg');
run('/usr/bin/hdiutil',['create','-volname','远舟中央管理','-srcfolder',imageRoot,'-format','UDZO',dmg]);
run('/usr/bin/hdiutil',['verify',dmg]);
const report={packageId:pin.id,app,dmg,manifest:pin.manifest,dmgDigest:await digestFile(dmg),build:'debug',signature:'ad-hoc',notarized:false,qualified:false};
await writeFile(path.join(output,'build-report.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(path.join(root,'target/central-macos/latest-build.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
