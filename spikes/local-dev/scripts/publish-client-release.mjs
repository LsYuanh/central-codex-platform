// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Build a reviewable release directory. Copy it to the central data directory only after QA.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2), options = {};
for (let i=0;i<args.length;i+=2) {
  if (!["--version","--notes-file","--windows","--macos-arm64","--macos-x64","--out"].includes(args[i]) || !args[i+1] || options[args[i]]) throw Error("Usage: --version X.Y.Z --notes-file notes.txt --windows installer.exe --macos-arm64 app.tar.gz [--macos-x64 app.tar.gz] --out release-directory");
  options[args[i]]=args[i+1];
}
const version=options["--version"];
if(!/^\d+\.\d+\.\d+$/.test(version??"")||!options["--out"]||!options["--notes-file"])throw Error("Stable version, release notes and output directory are required");
const output=resolve(options["--out"]);
if(existsSync(join(output,"latest.json")))throw Error("Release directory already published; use a new staging directory");
const config=JSON.parse(readFileSync(join(root,"apps/desktop/src-tauri/tauri.conf.json"),"utf8"));
const keyLines=Buffer.from(config.plugins.updater.pubkey,"base64").toString("utf8").trim().split(/\r?\n/);
const key=Buffer.from(keyLines[1],"base64");
const publicKey=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),key.subarray(10)]),format:"der",type:"spki"});
const manifest={version,notes:readFileSync(resolve(options["--notes-file"]),"utf8"),pub_date:new Date().toISOString(),platforms:{}};
if(manifest.notes.length>16000)throw Error("Release notes exceed 16000 characters");
const artifacts=[];
for(const [flag,target,extension] of [["--windows","windows-x86_64","exe"],["--macos-arm64","darwin-aarch64","app.tar.gz"],["--macos-x64","darwin-x86_64","app.tar.gz"]]) {
  if(!options[flag])continue;
  const source=resolve(options[flag]);
  if(!source.endsWith(`.${extension}`))throw Error(`Wrong artifact format for ${target}`);
  const bytes=readFileSync(source), signature=readFileSync(`${source}.sig`,"utf8").trim();
  if(!bytes.length||bytes.length>512*1024*1024)throw Error("Invalid installer size");
  const lines=Buffer.from(signature,"base64").toString("utf8").trim().split(/\r?\n/), packet=Buffer.from(lines[1]??"","base64");
  if(packet.length!==74||!packet.subarray(2,10).equals(key.subarray(2,10))||!lines[2]?.startsWith("trusted comment: "))throw Error("Release signature/key mismatch");
  const algorithm=packet.subarray(0,2).toString(), data=algorithm==="ED"?createHash("blake2b512").update(bytes).digest():bytes;
  if(!["ED","Ed"].includes(algorithm)||!verify(null,data,publicKey,packet.subarray(10))||!verify(null,Buffer.concat([packet.subarray(10),Buffer.from(lines[2].slice(17))]),publicKey,Buffer.from(lines[3]??"","base64")))throw Error("Release signature verification failed");
  const file=`${version}-${target}.${extension}`;
  manifest.platforms[target]={file,signature};
  artifacts.push({source,file,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length});
}
if(!artifacts.length)throw Error("At least one signed platform artifact is required");
mkdirSync(output,{recursive:true});
for(const artifact of artifacts)copyFileSync(artifact.source,join(output,artifact.file));
writeFileSync(join(output,"sha256.json"),JSON.stringify(artifacts.map(({source,...a})=>a),null,2));
writeFileSync(join(output,"latest.json.tmp"),JSON.stringify(manifest,null,2));
renameSync(join(output,"latest.json.tmp"),join(output,"latest.json"));
console.log(JSON.stringify({result:"CLIENT_RELEASE_READY",directory:output,version,platforms:Object.keys(manifest.platforms)}));
