// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Regenerate the Windows-only overlay from the verified upstream archive.
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const pin=JSON.parse(readFileSync(join(here,'upstream.json'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
if(!process.argv[2]) throw Error('Pass the pinned upstream tar.gz');
const archive=resolve(process.argv[2]);
if(hash(readFileSync(archive))!==pin.archive.sha256) throw Error('Archive hash mismatch');
const path='codex-rs/utils/home-dir/src/lib.rs';
const extracted=spawnSync('tar',['-xOf',archive,`codex-${pin.commit}/${path}`],{maxBuffer:1024*1024});
if(extracted.status!==0) throw Error('Pinned home-dir extraction failed');
const before=extracted.stdout.toString('utf8');
const anchor='let canonical = path.canonicalize().map_err(|err| {';
if(before.split(anchor).length!==2) throw Error('Pinned home-dir anchor mismatch');
const addition=`
#[cfg(windows)]
mod windows_home;

fn canonicalize_home(path: &std::path::Path) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    { windows_home::canonicalize(path) }
    #[cfg(not(windows))]
    { path.canonicalize() }
}
`;
const candidate=before.replace('use std::path::PathBuf;','use std::path::PathBuf;\n'+addition)
  .replace(anchor,'let canonical = canonicalize_home(&path).map_err(|err| {');
const formatted=spawnSync('rustfmt',['--edition','2024','--config','skip_children=true','--emit','stdout'],
  {input:candidate,encoding:'utf8',maxBuffer:1024*1024});
if(formatted.status!==0) throw Error(formatted.stderr);
const after=formatted.stdout.replace(/\r\n/g,'\n');
const helperPath='codex-rs/utils/home-dir/src/windows_home.rs';
const helper=readFileSync(join(here,'windows_home.rs'),'utf8').replace(/\r\n/g,'\n');
const lines=value=>value.replace(/\n$/,'').split('\n');
const oldLines=lines(before), newLines=lines(after), helperLines=lines(helper);
const patch=`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
  + oldLines.map(line=>'-'+line).join('\n')+'\n'+newLines.map(line=>'+'+line).join('\n')+'\n'
  + `diff --git a/${helperPath} b/${helperPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${helperPath}\n@@ -0,0 +1,${helperLines.length} @@\n`
  + helperLines.map(line=>'+'+line).join('\n')+'\n';
writeFileSync(join(here,'windows-home.patch'),patch);
writeFileSync(join(here,'windows-home-files.json'),JSON.stringify([
  {path,upstreamSha256:hash(extracted.stdout),patchedSha256:hash(after)},
  {path:helperPath,upstreamSha256:null,patchedSha256:hash(helper)},
],null,2)+'\n');
pin.windowsPatch={path:'windows-home.patch',sha256:hash(patch),scope:'Windows remote AppContainer CODEX_HOME canonicalization only'};
writeFileSync(join(here,'upstream.json'),JSON.stringify(pin,null,2)+'\n');
console.log(JSON.stringify(pin.windowsPatch));
