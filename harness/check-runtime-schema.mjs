// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Conservative protocol gate: changes to existing public JSON contracts require adaptation.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
export function changedContracts(baseline,candidate) {
  return Object.entries(baseline.json_schema).filter(([key,value])=>!candidate.json_schema?.[key]||!isDeepStrictEqual(JSON.parse(value),JSON.parse(candidate.json_schema[key]))).map(([key])=>key);
}
export function checkRuntimeSchema(source,output) {
  const pin=JSON.parse(readFileSync(new URL('./upstream.json',import.meta.url)));
  const changes={};
  for(const mode of ['stable','experimental']) {
    const bytes=readFileSync(new URL(`./schema/app-server-exports-${mode}.json.zst`,import.meta.url));
    if(createHash('sha256').update(bytes).digest('hex')!==pin.schema[mode].sha256)throw Error('RUNTIME_SCHEMA_PIN_INVALID');
    const baseline=JSON.parse(zstdDecompressSync(bytes));
    const candidate=JSON.parse(zstdDecompressSync(readFileSync(join(source,`codex-rs/app-server-protocol/schema/precomputed/app-server-exports-${mode}.json.zst`))));
    changes[mode]=changedContracts(baseline,candidate);
  }
  writeFileSync(output,JSON.stringify(changes,null,2)+'\n');
  if(Object.values(changes).some(list=>list.length))throw Error('RUNTIME_SCHEMA_ADAPTATION_REQUIRED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))checkRuntimeSchema(resolve(process.argv[2]),resolve(process.argv[3]));
