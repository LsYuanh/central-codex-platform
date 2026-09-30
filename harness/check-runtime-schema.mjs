// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Conservative protocol gate: changes to existing public JSON contracts require adaptation.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
export function changedContracts(baseline,candidate) {
  return Object.entries(baseline.json_schema).filter(([key,value])=>!candidate.json_schema?.[key]||!isDeepStrictEqual(JSON.parse(value),JSON.parse(candidate.json_schema[key]))).map(([key])=>key);
}
export function schemaReviewMatches(review,candidate,mode,baseSha256,sha256) {
  return Boolean(review?.schemaVersion===1&&candidate?.version===review.version&&candidate?.commit===review.commit
    &&review.schema?.[mode]?.baseSha256===baseSha256&&review.schema?.[mode]?.sha256===sha256);
}
export function checkRuntimeSchema(source,output,candidate) {
  const pin=JSON.parse(readFileSync(new URL('./upstream.json',import.meta.url)));
  const changes={};
  let review,unreviewed=false,reviewMatched=true;
  if(candidate){
    if(!/^\d+\.\d+\.\d+$/.test(candidate.version)||! /^[a-f0-9]{40}$/.test(candidate.commit))throw Error('RUNTIME_SCHEMA_CANDIDATE_INVALID');
    const reviewFile=new URL(`./schema/reviews/${candidate.version}.json`,import.meta.url);
    if(existsSync(reviewFile))review=JSON.parse(readFileSync(reviewFile));
  }
  for(const mode of ['stable','experimental']) {
    const bytes=readFileSync(new URL(`./schema/app-server-exports-${mode}.json.zst`,import.meta.url));
    if(createHash('sha256').update(bytes).digest('hex')!==pin.schema[mode].sha256)throw Error('RUNTIME_SCHEMA_PIN_INVALID');
    const baseline=JSON.parse(zstdDecompressSync(bytes));
    const candidateBytes=readFileSync(join(source,`codex-rs/app-server-protocol/schema/precomputed/app-server-exports-${mode}.json.zst`));
    const next=JSON.parse(zstdDecompressSync(candidateBytes));
    changes[mode]=changedContracts(baseline,next);
    // Accept only an explicitly audited snapshot, never all schemas for a version.
    const reviewed=schemaReviewMatches(review,candidate,mode,pin.schema[mode].sha256,createHash('sha256').update(candidateBytes).digest('hex'));
    reviewMatched&&=reviewed;
    if(changes[mode].length&&!reviewed)unreviewed=true;
  }
  if(reviewMatched)changes.review={version:review.version,commit:review.commit};
  writeFileSync(output,JSON.stringify(changes,null,2)+'\n');
  if(unreviewed)throw Error('RUNTIME_SCHEMA_ADAPTATION_REQUIRED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))checkRuntimeSchema(resolve(process.argv[2]),resolve(process.argv[3]));
