// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {createHash, createPublicKey, verify} from 'node:crypto';
// Same prehashed minisign format as the native updater; legacy Ed signatures are refused.
export function verifyRuntimeSignature(bytes, signature, publicKeyBase64) {
  const keyLines=Buffer.from(publicKeyBase64.trim(),'base64').toString('utf8').trim().split(/\r?\n/);
  const key=Buffer.from(keyLines[1]??'','base64');
  const lines=Buffer.from(signature.trim(),'base64').toString('utf8').trim().split(/\r?\n/);
  const packet=Buffer.from(lines[1]??'','base64');
  if(key.length!==42||packet.length!==74||packet.subarray(0,2).toString()!=='ED'||!packet.subarray(2,10).equals(key.subarray(2,10))||!lines[2]?.startsWith('trusted comment: '))throw Error('RUNTIME_SIGNATURE_INVALID');
  const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.subarray(10)]),format:'der',type:'spki'});
  if(!verify(null,createHash('blake2b512').update(bytes).digest(),publicKey,packet.subarray(10))||!verify(null,Buffer.concat([packet.subarray(10),Buffer.from(lines[2].slice(17))]),publicKey,Buffer.from(lines[3]??'','base64')))throw Error('RUNTIME_SIGNATURE_INVALID');
}
