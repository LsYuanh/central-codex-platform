// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WorkerPaths = {home:string; directory:string};
const marker = '# Managed by Yuan Zhou credential broker v1\n';
function inside(root:string,path:string){const r=relative(root,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));}
function safePath(path:string,directory:boolean,privateMode=false){
  const stat=lstatSync(path);
  if(realpathSync(path)!==path||stat.isSymbolicLink()||!(directory?stat.isDirectory():stat.isFile())||(!directory&&stat.nlink!==1))throw Error('WORKER_PATH_UNSAFE');
  if(process.platform!=='win32'&&(stat.uid!==process.getuid!()||(stat.mode&(privateMode?0o077:0o022))))throw Error('WORKER_PATH_PERMISSIONS');
  return stat;
}
export class WorkerIsolation {
  readonly binary:string;
  readonly profile:string;
  private readonly fingerprint:string;
  constructor(private root:string, binary:string, expectedSha256:string,private model='gpt-6-astra',profile?:{path:string;sha256:string}){
    if(process.platform!=='darwin')throw Error('WORKER_ISOLATION_UNSUPPORTED: authenticated model workers require macOS Seatbelt');
    this.root=resolve(root);this.binary=resolve(binary);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model))throw Error('WORKER_MODEL_INVALID');
    this.profile=profile?resolve(profile.path):resolve(dirname(fileURLToPath(import.meta.url)),'../../../harness/worker-isolated.sb');
    if(!/^[a-f0-9]{64}$/i.test(expectedSha256))throw Error('WORKER_BINARY_HASH_REQUIRED');
    safePath(this.binary,false);safePath(this.profile,false);
    if(profile&&(!/^[a-f0-9]{64}$/.test(profile.sha256)||createHash('sha256').update(readFileSync(this.profile)).digest('hex')!==profile.sha256))throw Error('WORKER_PROFILE_HASH_MISMATCH');
    if(inside(this.root,this.binary)||inside(this.root,this.profile))throw Error('WORKER_LAUNCHER_WRITABLE');
    if(createHash('sha256').update(readFileSync(this.binary)).digest('hex')!==expectedSha256.toLowerCase())throw Error('WORKER_BINARY_HASH_MISMATCH');
    this.fingerprint=this.artifactFingerprint();
  }
  private artifactFingerprint(){return [this.binary,this.profile].map(path=>{const s=safePath(path,false);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}).join('|');}
  launch(paths:WorkerPaths,url:string,token:string,imageGeneration=false){
    if(this.artifactFingerprint()!==this.fingerprint)throw Error('WORKER_LAUNCHER_CHANGED');
    const endpoint=new URL(url);
    if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.pathname!=='/'||endpoint.username||endpoint.password)throw Error('WORKER_BROKER_URL_UNSAFE');
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw Error('WORKER_BROKER_TOKEN_INVALID');
    const base=dirname(paths.home);
    if(!inside(this.root,base)||base===this.root||dirname(paths.directory)!==base||paths.home!==join(base,'home')||paths.directory!==join(base,'runtime'))throw Error('WORKER_PATH_UNSAFE');
    for(const path of [this.root,base,paths.home,paths.directory])safePath(path,true,true);
    // Never silently adopt an old shared auth link or a locally logged-in Worker.
    try{lstatSync(join(paths.home,'auth.json'));throw Error('WORKER_CREDENTIAL_MIGRATION_REQUIRED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const config=join(paths.home,'config.toml');
    if(existsSync(config)){safePath(config,false,true);if(!readFileSync(config,'utf8').startsWith(marker))throw Error('WORKER_CONFIG_MIGRATION_REQUIRED');}
    const content=marker+'model = '+JSON.stringify(this.model)+'\nmodel_provider = "yuan_broker"\ncli_auth_credentials_store = "file"\n[model_providers.yuan_broker]\nname = "Central model access"\nbase_url = '+JSON.stringify(endpoint.href+'v1')+'\nenv_key = "YUAN_WORKER_MODEL_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n';
    const temp=join(paths.home,`.config-${randomUUID()}`);
    writeFileSync(temp,content,{flag:'wx',mode:0o600});renameSync(temp,config);
    const tmp=join(paths.directory,'tmp');if(!existsSync(tmp))mkdirSync(tmp,{mode:0o700});safePath(tmp,true,true);
    return {command:'/usr/bin/sandbox-exec',args:['-f',this.profile,'-D',`HARNESS_BINARY=${this.binary}`,'-D',`CODEX_HOME=${paths.home}`,'-D',`WORKER_DIR=${paths.directory}`,'-D',`BROKER_ADDRESS=localhost:${endpoint.port}`,this.binary],cwd:paths.directory,
      env:{PATH:'/usr/bin:/bin',HOME:paths.home,CODEX_HOME:paths.home,CODEX_REMOTE_WORKER_DIR:paths.directory,TMPDIR:tmp,LANG:'en_US.UTF-8',CODEX_REMOTE_WORKSPACE:'1',CODEX_EXEC_SERVER_URL:'none',CODEX_REMOTE_AUTH_MODE:'broker',CODEX_REMOTE_MODEL_CATALOG:'1',CODEX_REMOTE_IMAGE_GENERATION:imageGeneration?'1':'0',CODEX_REFRESH_TOKEN_URL_OVERRIDE:'disabled://broker-owned-auth',CODEX_REVOKE_TOKEN_URL_OVERRIDE:'disabled://broker-owned-auth',YUAN_WORKER_MODEL_TOKEN:token,RUST_LOG:'error'}};
  }
}
