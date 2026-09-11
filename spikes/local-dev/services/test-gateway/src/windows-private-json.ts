// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync, type BigIntStats} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';

export type WindowsPrivateJsonOptions = {binary:string;sha256:string};
export class WindowsPrivateJsonError extends Error {
  constructor(readonly code:string){super(code);}
}
const fail=(code:string):never=>{throw new WindowsPrivateJsonError(code);};
const unsafe=()=>fail('WINDOWS_PRIVATE_JSON_UNSAFE');
const maximum=1024*1024;
const fingerprint=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.nlink].join(':');
function hashOpenedFile(fd:number):string {
  const hash=createHash('sha256'),chunk=Buffer.alloc(64*1024);
  let offset=0,count=0;
  while((count=readSync(fd,chunk,0,chunk.length,offset))>0){offset+=count;if(offset>256*1024*1024)return fail('WINDOWS_PRIVATE_JSON_HELPER_UNTRUSTED');hash.update(chunk.subarray(0,count));}
  return hash.digest('hex');
}
function canonical(path:string):boolean {
  return isAbsolute(path)&&/^[a-z]:\\/i.test(path)&&realpathSync(path)===path&&resolve(path)===path;
}
function checkedStat(path:string):BigIntStats {
  const stat=lstatSync(path,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size<1n||stat.size>256n*1024n*1024n)unsafe();
  return stat;
}

/**
 * Central-only IPC; never expose helper stdout/error objects to the renderer.
 * Provision the helper in a current-user/admin trusted artifact directory.
 * FD hash and before/after identity detect observable replacement. Node's Windows
 * sharing modes cannot pin ancestors against hostile same-user swap-and-restore;
 * no isolation from that trusted principal or administrators is claimed here.
 */
export function readWindowsPrivateJson(path:string,maxBytes=maximum,options:WindowsPrivateJsonOptions={
  binary:process.env.PLATFORM_NATIVE_HELPER_BINARY??'',sha256:process.env.PLATFORM_NATIVE_HELPER_SHA256??'',
}):unknown {
  if(process.platform!=='win32')return fail('WINDOWS_PRIVATE_JSON_PLATFORM_REQUIRED');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>maximum)return unsafe();
  let fd:number|undefined,stdout:Buffer|undefined,stderr:Buffer|undefined;
  try {
    if(!/^[a-f0-9]{64}$/i.test(options.sha256)||!canonical(options.binary))return fail('WINDOWS_PRIVATE_JSON_HELPER_UNTRUSTED');
    // Never silently canonicalize an alias. Native code checks every ancestor,
    // strict protected ACLs and the same opened file before returning bytes.
    if(!canonical(path))return unsafe();
    const before=checkedStat(options.binary);
    fd=openSync(options.binary,constants.O_RDONLY);
    if(fingerprint(fstatSync(fd,{bigint:true}))!==fingerprint(before))return fail('WINDOWS_PRIVATE_JSON_HELPER_CHANGED');
    if(hashOpenedFile(fd)!==options.sha256.toLowerCase())return fail('WINDOWS_PRIVATE_JSON_HELPER_UNTRUSTED');
    const unchanged=()=>{
      if(!canonical(options.binary)||fingerprint(fstatSync(fd!,{bigint:true}))!==fingerprint(before)
        ||fingerprint(checkedStat(options.binary))!==fingerprint(before))return fail('WINDOWS_PRIVATE_JSON_HELPER_CHANGED');
    };
    unchanged();
    const env:NodeJS.ProcessEnv={};
    for(const name of ['SystemRoot','WINDIR','SystemDrive'])if(process.env[name])env[name]=process.env[name];
    const result=spawnSync(options.binary,['read-private-json-v1'],{
      input:Buffer.from(JSON.stringify({version:1,path,maxBytes}),'utf8'),env,cwd:dirname(options.binary),
      windowsHide:true,shell:false,encoding:'buffer',timeout:5000,maxBuffer:maxBytes+4096,
    });
    stdout=result.stdout??undefined;stderr=result.stderr??undefined;
    const afterFd=fstatSync(fd,{bigint:true}),afterPath=checkedStat(options.binary);
    if(!canonical(options.binary)||identity(afterFd)!==identity(before)||identity(afterPath)!==identity(before))return fail('WINDOWS_PRIVATE_JSON_HELPER_CHANGED');
    if(fingerprint(afterFd)!==fingerprint(before)||fingerprint(afterPath)!==fingerprint(before)){
      // Three fresh Windows copies reproduced a first-execution ctime update
      // with unchanged file identity, mtime and content. Never accept that from
      // metadata alone: hash the original FD and a newly opened path FD, then
      // require all three views to remain stable through both complete reads.
      const verifyFd=openSync(options.binary,constants.O_RDONLY);
      try{
        const verifyBefore=fstatSync(verifyFd,{bigint:true});
        if(fingerprint(afterFd)!==fingerprint(afterPath)||fingerprint(verifyBefore)!==fingerprint(afterFd))return fail('WINDOWS_PRIVATE_JSON_HELPER_CHANGED');
        if(hashOpenedFile(fd)!==options.sha256.toLowerCase()||hashOpenedFile(verifyFd)!==options.sha256.toLowerCase())return fail('WINDOWS_PRIVATE_JSON_HELPER_CHANGED');
        if(!canonical(options.binary)||fingerprint(fstatSync(fd,{bigint:true}))!==fingerprint(afterFd)
          ||fingerprint(fstatSync(verifyFd,{bigint:true}))!==fingerprint(verifyBefore)
          ||fingerprint(checkedStat(options.binary))!==fingerprint(afterPath))return fail('WINDOWS_PRIVATE_JSON_HELPER_CHANGED');
      }finally{closeSync(verifyFd);}
    }
    if(result.error||result.signal||result.status!==0)return fail('WINDOWS_PRIVATE_JSON_READ_FAILED');
    if(!stdout||stdout.length>maxBytes+128||stderr?.length)return fail('WINDOWS_PRIVATE_JSON_PROTOCOL_INVALID');
    const message:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stdout));
    if(!message||typeof message!=='object'||Array.isArray(message))return fail('WINDOWS_PRIVATE_JSON_PROTOCOL_INVALID');
    const envelope=message as Record<string,unknown>;
    if(envelope.version!==1||envelope.ok!==true||!Object.hasOwn(envelope,'payload')||Object.keys(envelope).length!==3)return fail('WINDOWS_PRIVATE_JSON_PROTOCOL_INVALID');
    return envelope.payload;
  } catch(error) {
    if(error instanceof WindowsPrivateJsonError)throw error;
    try{lstatSync(path);}catch(missing){if((missing as NodeJS.ErrnoException).code==='ENOENT')return fail('WINDOWS_PRIVATE_JSON_NOT_FOUND');}
    return unsafe();
  } finally {
    stdout?.fill(0);stderr?.fill(0);
    if(fd!==undefined)closeSync(fd);
  }
}
