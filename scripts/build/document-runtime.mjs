// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setGlobalProxyFromEnv } from 'node:http';

setGlobalProxyFromEnv();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const builds = {
  'win32-x64': { archive:'pdfium-win-x64.tgz', library:'bin/pdfium.dll', name:'pdfium.dll', sha256:'73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08' },
  'darwin-arm64': { archive:'pdfium-mac-arm64.tgz', library:'lib/libpdfium.dylib', name:'libpdfium.dylib', sha256:'52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40' },
  'darwin-x64': { archive:'pdfium-mac-x64.tgz', library:'lib/libpdfium.dylib', name:'libpdfium.dylib', sha256:'6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b' },
};

/** Development/build-time dependency preparation only; the installed client never downloads a parser. */
export async function prepareDocumentRuntime(destination, platform=process.platform, arch=process.arch) {
  const spec = builds[`${platform}-${arch}`];
  if (!spec) throw Error(`DOCUMENT_RUNTIME_TARGET_UNSUPPORTED: ${platform}-${arch}`);
  const cache = join(root,'target','document-runtime',`${platform}-${arch}`);
  await mkdir(cache,{recursive:true});
  const archive = join(cache,spec.archive);
  let bytes;
  try { bytes = await readFile(archive); } catch { /* Fetch a pinned archive on a clean build host. */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex')!==spec.sha256) {
    const response = await fetch(`https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/7881/${spec.archive}`,{signal:AbortSignal.timeout(120_000)});
    if (!response.ok) throw Error(`DOCUMENT_RUNTIME_DOWNLOAD_FAILED: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex')!==spec.sha256) throw Error('DOCUMENT_RUNTIME_HASH_MISMATCH');
    await writeFile(archive,bytes);
  }
  const extracted = spawnSync('tar',['-xzf',archive,'-C',cache],{stdio:'pipe',windowsHide:true});
  if(extracted.status!==0)throw Error(`DOCUMENT_RUNTIME_EXTRACT_FAILED: ${extracted.error?.message??extracted.stderr}`);
  destination=resolve(destination); await mkdir(destination,{recursive:true});
  const library=join(destination,spec.name);
  await copyFile(join(cache,spec.library),library);
  // Pdfium redistributions include their third-party notices in LICENSE.
  const notices=join(destination,'PDFium-LICENSE');
  await copyFile(join(cache,'LICENSE'),notices);
  return {library,notices,name:spec.name,version:'chromium/7881',archiveSha256:spec.sha256};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await prepareDocumentRuntime(process.argv[2]??join(root,'target','debug'))));
}
