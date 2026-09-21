// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {randomBytes, createHash} from "node:crypto";
import {constants, openSync, closeSync, fstatSync, readFileSync, realpathSync} from "node:fs";
import {resolve, isAbsolute, dirname, basename, join, relative} from "node:path";
import http, {type IncomingMessage, type ServerResponse} from "node:http";
import https from "node:https";
import {Transform, type Duplex} from "node:stream";
import {createModelPipeTls, MODEL_PIPE_SERVER_NAME} from "./model-pipe-tls.js";
import {readWindowsPrivateJson, WindowsPrivateJsonError} from "./windows-private-json.js";

type Provider = {id:string;kind:"chatgpt"|"api-key";credentialFile:string;baseUrl?:string};
type Binding = {providerId:string;enabled:boolean};
type Config = {version:1;users:Record<string,Binding>;providers:Record<string,Provider>};
type Lease = {userId:string;fingerprint:string;controllers:Set<AbortController>;mode:"direct"|"pipe";workerInstanceId?:string;expiresAt?:number;stopEndpoint?:()=>void};
export type ModelCredentialLease = {token:string;release:()=>void};
export type ModelPipeLease = ModelCredentialLease & {forwardPort:number;serverName:typeof MODEL_PIPE_SERVER_NAME;certificatePem:string;expiresAt:number;closed:Promise<void>};
export type ModelCredentialBrokerOptions = {
  configFile:string;
  /** Native parent bootstrap only; decrypted secrets remain in central memory. */
  memorySource?:{readConfig:()=>unknown;readCredential:(reference:string)=>unknown};
  /** Every directory writable by a Worker; also enforced on config reloads and missing files. */
  forbiddenRoots?:string[];
  /** Protocol fixtures only: never enabled from process.env. */
  allowLoopbackTestProviders?:boolean;
  maxBodyBytes?:number;maxConcurrent?:number;maxConcurrentPerUser?:number;timeoutMs?:number;
  audit?:(event:{action:string;userId?:string;status:"succeeded"|"failed";errorCode?:string})=>void;
  /** Stop the user's Worker when an automatic binding reload invalidates its capability. */
  onRevoke?:(userId:string)=>void;
};
class SafeError extends Error {constructor(readonly code:string,readonly status=503){super(code);}}
const obj=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const bounded=(value:unknown,max=4096):value is string=>typeof value==="string"&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const fail=(code:string,status=503):never=>{throw new SafeError(code,status);};
const limit=(value:number|undefined,fallback:number,max:number)=>{const result=value??fallback;if(!Number.isSafeInteger(result)||result<1||result>max)throw Error("MODEL_BROKER_INVALID_LIMIT");return result;};
const responseFailed=(value:unknown):boolean=>obj(value)&&(value.type==="error"||value.type==="response.failed"||value.error!==undefined&&value.error!==null||obj(value.response)&&(value.response.status==="failed"||value.response.error!==undefined&&value.response.error!==null));
/** Only closed diagnostic categories leave the authority, never provider-supplied strings. */
function providerHttpError(status:number,bytes?:Buffer):SafeError{
  if(status===401||status===403)return new SafeError("MODEL_CREDENTIAL_REJECTED",401);
  if(status===429)return new SafeError("MODEL_PROVIDER_RATE_LIMITED",429);
  const code=`MODEL_PROVIDER_HTTP_${Number.isInteger(status)&&status>=100&&status<=599?status:502}`;
  if(status!==400||!bytes)return new SafeError(code,502);
  let value:unknown;try{value=JSON.parse(bytes.toString("utf8"));}catch{return new SafeError(code,502);}
  const error=obj(value)&&obj(value.error)?value.error:obj(value)?value:{};
  const detailMessages=(detail:unknown):string[]=>typeof detail==="string"?[detail]:Array.isArray(detail)?detail.slice(0,32).flatMap(item=>obj(item)&&typeof item.msg==="string"?[item.msg]:[]):obj(detail)&&typeof detail.message==="string"?[detail.message]:[];
  const message=[...(typeof error.message==="string"?[error.message]:[]),...detailMessages(error.detail),...(obj(value)?detailMessages(value.detail):[])].join(" ").slice(0,16384).toLowerCase();
  const param=typeof error.param==="string"?error.param.toLowerCase():"";
  const upstreamCode=typeof error.code==="string"?error.code.toLowerCase():"";
  let category=/instructions/.test(message)&&/required|missing|must be|expected/.test(message)?"INSTRUCTIONS_REQUIRED"
    :/store/.test(message)&&/false|disabled|not supported/.test(message)?"STORE_DISABLED_REQUIRED"
    :/session|conversation/.test(message)&&/uuid|invalid|format/.test(message)?"SESSION_FORMAT"
    :/stream/.test(message)&&/true|required|must/.test(message)?"STREAM_REQUIRED"
    :/unsupported|unknown|unrecognized/.test(message)&&/parameter|field|argument/.test(message)||upstreamCode==="unsupported_parameter"?"UNSUPPORTED_PARAMETER"
    :/model/.test(message)&&/not supported|unsupported|not found|does not exist|invalid/.test(message)||param==="model"?"MODEL_UNSUPPORTED"
    :/input/.test(message)&&/invalid|required|must|expected/.test(message)||param==="input"?"INPUT_INVALID":undefined;
  if(category==="UNSUPPORTED_PARAMETER"){
    const known=["max_output_tokens","max_tokens","client_metadata","stream_options","parallel_tool_calls","service_tier","prompt_cache_key","temperature","top_p","text","reasoning"];
    const name=known.find(name=>new RegExp(`\\b${name}\\b`).test(message)||param===name);
    if(name)category=`UNSUPPORTED_${name.toUpperCase()}`;
  }
  return new SafeError(category?`${code}_${category}`:code,502);
}
/** Preserve complete successful SSE frames verbatim; provider diagnostic events never leave the authority. */
class SafeSse extends Transform {
  private buffer:Buffer=Buffer.alloc(0);
  private sawData=false;
  private outputBytes=0;
  successfulTerminalEnd=0;
  private frame(bytes:Buffer){
    if(bytes.length>4*1024*1024)throw new SafeError("MODEL_PROVIDER_SSE_FRAME_TOO_LARGE",502);
    let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new SafeError("MODEL_PROVIDER_SSE_FORMAT_INVALID",502);}
    const lines=text.split(/\r?\n/);
    if(lines.some(line=>line!==""&&!line.startsWith(":")&&!/^(?:data|event|id|retry)(?::|$)/.test(line)))throw new SafeError("MODEL_PROVIDER_SSE_FORMAT_INVALID",502);
    if(lines.some(line=>/^event:\s*error\s*$/.test(line)))throw new SafeError("MODEL_PROVIDER_SSE_ERROR_EVENT",502);
    if(lines.some(line=>/^event:\s*response\.failed\s*$/.test(line)))throw new SafeError("MODEL_PROVIDER_SSE_RESPONSE_FAILED",502);
    const data=lines.filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
    let successfulTerminal=false;
    if(data&&data.trim()!=="[DONE]"){let value:unknown;try{value=JSON.parse(data);}catch{throw new SafeError("MODEL_PROVIDER_SSE_JSON_INVALID",502);}if(responseFailed(value)){
      const category=obj(value)&&value.type==="error"?"ERROR_EVENT":obj(value)&&(value.type==="response.failed"||obj(value.response)&&value.response.status==="failed")?"RESPONSE_FAILED":"RESPONSE_ERROR";
      throw new SafeError(`MODEL_PROVIDER_SSE_${category}`,502);}
      successfulTerminal=obj(value)&&value.type==="response.completed"&&obj(value.response)&&
        (value.response.status===undefined||value.response.status==="completed");}
    if(!data)return; // Keepalive/comment-only records carry no model content.
    this.sawData=true;
    this.outputBytes+=bytes.length;
    if(successfulTerminal)this.successfulTerminalEnd=this.outputBytes;
    this.push(bytes);
  }
  override _transform(chunk:Buffer,_encoding:BufferEncoding,callback:(error?:Error|null)=>void){
    try{this.buffer=Buffer.concat([this.buffer,chunk]);while(true){const lf=this.buffer.indexOf("\n\n"),crlf=this.buffer.indexOf("\r\n\r\n");const offset=lf<0?crlf:crlf<0?lf:Math.min(lf,crlf);if(offset<0)break;const end=offset+(offset===crlf?4:2);this.frame(this.buffer.subarray(0,end));this.buffer=this.buffer.subarray(end);}if(this.buffer.length>4*1024*1024)throw new SafeError("MODEL_PROVIDER_SSE_FRAME_TOO_LARGE",502);callback();}catch(error){callback(error instanceof Error?error:new SafeError("MODEL_PROVIDER_UNAVAILABLE"));}
  }
  override _flush(callback:(error?:Error|null)=>void){try{if(this.buffer.length)this.frame(this.buffer);if(!this.sawData)throw new SafeError("MODEL_PROVIDER_SSE_FORMAT_INVALID",502);callback();}catch(error){callback(error instanceof Error?error:new SafeError("MODEL_PROVIDER_UNAVAILABLE"));}}
}

/** Read only owned, private, single-link regular files; no secret contents in errors. */
function privateJson(path:string,missingCode:string):unknown {
  if(process.platform==='win32'){
    try{return readWindowsPrivateJson(path);}
    catch(error){return fail(error instanceof WindowsPrivateJsonError&&error.code==='WINDOWS_PRIVATE_JSON_NOT_FOUND'?missingCode:'MODEL_CREDENTIAL_FILE_UNSAFE');}
  }
  let fd:number|undefined;
  try {
    if(!isAbsolute(path)||realpathSync(path)!==resolve(path))return fail("MODEL_CREDENTIAL_FILE_UNSAFE");
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const before=fstatSync(fd);
    if(!before.isFile()||before.nlink!==1||before.size<2||before.size>1024*1024)return fail("MODEL_CREDENTIAL_FILE_UNSAFE");
    if(before.uid!==process.getuid?.()||(before.mode&0o077)!==0)return fail("MODEL_CREDENTIAL_FILE_UNSAFE");
    const bytes=readFileSync(fd);const after=fstatSync(fd);
    if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)return fail("MODEL_CREDENTIAL_FILE_UNSAFE");
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  }catch(error){if(error instanceof SafeError)throw error;if(obj(error)&&error.code==="ENOENT")return fail(missingCode);return fail("MODEL_CREDENTIAL_FILE_UNSAFE");}
  finally{if(fd!==undefined)closeSync(fd);}
}

/** Central credential authority. Workers receive only revocable, user-scoped loopback capabilities. */
export class ModelCredentialBroker {
  private readonly server:http.Server;
  private readonly scopeSecret=randomBytes(32);
  private readonly leases=new Map<string,Lease>();
  private readonly endpointClosures=new Set<Promise<void>>();
  private readonly sweep:NodeJS.Timeout;
  private closed=false;
  private requests=0;
  private readonly perUser=new Map<string,number>();
  private address="";
  private readonly bodyLimit:number;
  private readonly concurrent:number;
  private readonly userConcurrent:number;
  private readonly timeout:number;
  private constructor(private readonly options:ModelCredentialBrokerOptions){
    this.bodyLimit=limit(options.maxBodyBytes,32*1024*1024,32*1024*1024);
    this.concurrent=limit(options.maxConcurrent,32,1024);
    this.userConcurrent=limit(options.maxConcurrentPerUser,4,128);
    this.timeout=limit(options.timeoutMs,30*60_000,2*60*60_000);
    this.readConfig();
    this.server=http.createServer({maxHeaderSize:16*1024,requestTimeout:Math.min(this.timeout,60_000),headersTimeout:Math.min(this.timeout,15_000)},(request,response)=>{void this.handle(request,response);});
    this.server.maxConnections=256;
    this.server.on("clientError",(_error,socket)=>socket.destroy());
    // Disabling/rebinding a user also terminates an existing stream without waiting for another request.
    this.sweep=setInterval(()=>this.reload(),500);this.sweep.unref();
  }
  static async start(options:ModelCredentialBrokerOptions):Promise<ModelCredentialBroker>{
    const broker=new ModelCredentialBroker(options);
    try{await new Promise<void>((done,reject)=>{broker.server.once("error",reject);broker.server.listen(0,"127.0.0.1",()=>{broker.server.removeListener("error",reject);done();});});}
    catch{await broker.close();throw Error("MODEL_BROKER_LISTEN_FAILED");}
    const address=broker.server.address();if(!address||typeof address==="string"){await broker.close();throw Error("MODEL_BROKER_LISTEN_FAILED");}
    broker.address=`http://127.0.0.1:${address.port}`;return broker;
  }
  get url(){return this.address;}
  status(userId:string):{status:"ready"|"missing"|"disabled"|"expired"|"unavailable";code?:string}{
    try{if(this.closed)return {status:"unavailable",code:"MODEL_BROKER_CLOSED"};const {provider}=this.binding(this.readConfig(),userId);this.credential(provider);return {status:"ready"};}
    catch(error){const code=error instanceof SafeError?error.code:"MODEL_PROVIDER_UNAVAILABLE";return {status:code==="MODEL_CREDENTIAL_DISABLED"?"disabled":code==="MODEL_CREDENTIAL_EXPIRED"?"expired":["MODEL_CREDENTIAL_MISSING","MODEL_CREDENTIAL_UNCONFIGURED"].includes(code)?"missing":"unavailable",code};}
  }
  private emit(action:string,userId:string|undefined,status:"succeeded"|"failed",errorCode?:string){
    // An audit failure must prevent admission, but cleanup must remain possible.
    try{this.options.audit?.({action,...(userId?{userId}:{}),status,...(errorCode?{errorCode}:{})});}
    catch{return fail("MODEL_BROKER_AUDIT_UNAVAILABLE");}
  }
  private readConfig():Config{
    this.assertOutsideWorkers(this.options.configFile);
    const value=this.options.memorySource?this.options.memorySource.readConfig():privateJson(this.options.configFile,"MODEL_CREDENTIAL_CONFIG_MISSING");
    if(!obj(value)||value.version!==1||!obj(value.users)||!obj(value.providers))return fail("MODEL_CREDENTIAL_CONFIG_INVALID");
    if(Object.keys(value.users).length>10000||Object.keys(value.providers).length>1000)return fail("MODEL_CREDENTIAL_CONFIG_INVALID");
    for(const [id,binding] of Object.entries(value.users))if(!bounded(id,256)||!obj(binding)||!bounded(binding.providerId,256)||typeof binding.enabled!=="boolean")return fail("MODEL_CREDENTIAL_CONFIG_INVALID");
    for(const [id,p] of Object.entries(value.providers)){
      if(!bounded(id,256)||!obj(p)||p.id!==id||!["chatgpt","api-key"].includes(String(p.kind))||!bounded(p.credentialFile)||!isAbsolute(p.credentialFile)||(p.baseUrl!==undefined&&!bounded(p.baseUrl)))return fail("MODEL_CREDENTIAL_CONFIG_INVALID");
      this.assertOutsideWorkers(p.credentialFile);
      this.endpoint(p as Provider);
    }
    return value as Config;
  }
  private assertOutsideWorkers(path:string){
    const canonicalCandidate=(path:string):string=>{
      let current=resolve(path);const suffix:string[]=[];
      while(true){try{return join(realpathSync(current),...suffix);}catch(error){
        if(!obj(error)||error.code!=="ENOENT")return fail("MODEL_CREDENTIAL_FILE_UNSAFE");
        const parent=dirname(current);if(parent===current)return fail("MODEL_CREDENTIAL_FILE_UNSAFE");suffix.unshift(basename(current));current=parent;
      }}
    };
    const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===""||rel!==".."&&!rel.startsWith("..\\")&&!rel.startsWith("../")&&!isAbsolute(rel);};
    const candidate=resolve(path),canonical=canonicalCandidate(path);
    for(const root of this.options.forbiddenRoots??[]){
      if(!bounded(root)||!isAbsolute(root))return fail("MODEL_CREDENTIAL_CONFIG_INVALID");
      if(inside(resolve(root),candidate)||inside(canonicalCandidate(root),canonical))return fail("MODEL_CREDENTIAL_WORKER_PATH_DENIED");
    }
  }
  private endpoint(provider:Provider):URL{
    const defaultUrl=provider.kind==="chatgpt"?"https://chatgpt.com/backend-api/codex":"https://api.openai.com/v1";
    let url:URL;try{url=new URL(provider.baseUrl??defaultUrl);}catch{return fail("MODEL_PROVIDER_URL_INVALID");}
    if(url.username||url.password||url.search||url.hash)return fail("MODEL_PROVIDER_URL_INVALID");
    if(url.href.replace(/\/$/,"")!==defaultUrl){
      if(!this.options.allowLoopbackTestProviders||url.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(url.hostname)||!/^\/(?:v1|backend-api\/codex)\/?$/.test(url.pathname))return fail("MODEL_PROVIDER_URL_INVALID");
    }
    return new URL(url.href.replace(/\/$/,"")+"/responses");
  }
  private binding(config:Config,userId:string):{provider:Provider;fingerprint:string}{
    const binding=Object.hasOwn(config.users,userId)?config.users[userId]:undefined;
    if(!binding)return fail("MODEL_CREDENTIAL_UNCONFIGURED");
    if(!binding.enabled)return fail("MODEL_CREDENTIAL_DISABLED",403);
    const provider=Object.hasOwn(config.providers,binding.providerId)?config.providers[binding.providerId]:undefined;
    if(!provider)return fail("MODEL_CREDENTIAL_UNCONFIGURED");
    return {provider,fingerprint:JSON.stringify([provider.id,provider.kind,provider.credentialFile,this.endpoint(provider).href])};
  }
  private credential(provider:Provider):{authorization:string;accountId?:string}{
    this.assertOutsideWorkers(provider.credentialFile);
    const value=this.options.memorySource?this.options.memorySource.readCredential(provider.credentialFile):privateJson(provider.credentialFile,"MODEL_CREDENTIAL_MISSING");
    if(!obj(value))return fail("MODEL_CREDENTIAL_INVALID");
    if(provider.kind==="api-key"){
      if(!bounded(value.apiKey,16384))return fail("MODEL_CREDENTIAL_INVALID");
      return {authorization:`Bearer ${value.apiKey}`};
    }
    if(!obj(value.tokens)||!bounded(value.tokens.access_token,32768)||!bounded(value.tokens.account_id,256))return fail("MODEL_CREDENTIAL_INVALID");
    // Access JWT exp is checked locally. This broker never calls refresh, login or revoke.
    const jwt=value.tokens.access_token.split(".");
    if(jwt.length===3){try{const payload=JSON.parse(Buffer.from(jwt[1]!,"base64url").toString("utf8"));if(obj(payload)&&typeof payload.exp==="number"&&payload.exp*1000<=Date.now())return fail("MODEL_CREDENTIAL_EXPIRED",401);}catch(error){if(error instanceof SafeError)throw error;return fail("MODEL_CREDENTIAL_INVALID");}}
    return {authorization:`Bearer ${value.tokens.access_token}`,accountId:value.tokens.account_id};
  }
  createLease(userId:string):ModelCredentialLease{
    if(this.closed)return fail("MODEL_BROKER_CLOSED");
    if(!bounded(userId,256))return fail("MODEL_CREDENTIAL_UNCONFIGURED");
    const config=this.readConfig();this.reconcile(config);
    const {provider,fingerprint}=this.binding(config,userId);this.credential(provider);
    if(this.leases.size>=4096)return fail("MODEL_BROKER_CAPACITY",429);
    this.emit("model.lease",userId,"succeeded");
    const token=randomBytes(32).toString("base64url"),key=this.tokenKey(token);
    this.leases.set(key,{userId,fingerprint,controllers:new Set(),mode:"direct"});
    return {token,release:()=>this.release(key)};
  }
  /** Trusted native pipe bridges receive a fixed port; only the bound Worker receives its token and public CA. */
  async createPipeLease(userId:string,workerInstanceId:string):Promise<ModelPipeLease>{
    if(!bounded(workerInstanceId,128)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workerInstanceId))return fail("MODEL_WORKER_INSTANCE_INVALID",400);
    if([...this.leases.values()].some(lease=>lease.mode==="pipe"&&lease.workerInstanceId===workerInstanceId))return fail("MODEL_WORKER_INSTANCE_IN_USE",409);
    const capability=this.createLease(userId),key=this.tokenKey(capability.token),lease=this.leases.get(key)!;
    lease.mode="pipe";lease.workerInstanceId=workerInstanceId;
    const expiresAt=Date.now()+Math.max(60_000,this.timeout+60_000);lease.expiresAt=expiresAt;
    let server:https.Server|undefined,expiry:NodeJS.Timeout|undefined,stopped=false;
    const sockets=new Set<Duplex>();
    let complete!:()=>void;
    const closed=new Promise<void>(done=>{complete=done;});
    const stop=()=>{
      if(stopped)return;stopped=true;if(expiry)clearTimeout(expiry);
      for(const socket of sockets)socket.destroy();
      if(server){server.closeAllConnections();server.close(()=>complete());}else complete();
    };
    lease.stopEndpoint=stop;this.endpointClosures.add(closed);void closed.then(()=>this.endpointClosures.delete(closed));
    try{
      const tls=await createModelPipeTls(expiresAt);
      if(this.closed||this.leases.get(key)!==lease||stopped)return fail("MODEL_LEASE_INVALID",401);
      try{server=https.createServer({...tls.options,maxHeaderSize:16*1024,requestTimeout:Math.min(this.timeout,60_000),headersTimeout:Math.min(this.timeout,15_000)},
        (request,response)=>{
          // Model clients deliberately open a fresh authenticated pipe per request.
          // Close TLS after delivering the response rather than retaining an idle session.
          response.setHeader("connection","close");
          try{this.emit("model.pipe_http_request",userId,"succeeded");}
          catch(error){this.error(response,error);return;}
          void this.handle(request,response,key);
        });}
      finally{if(Buffer.isBuffer(tls.options.key))tls.options.key.fill(0);}
      server.maxConnections=32;
      server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
      server.on("secureConnection",socket=>{
        try{this.emit("model.pipe_tls_handshake",userId,"succeeded");}catch{socket.destroy();}
      });
      server.on("clientError",(_error,socket)=>socket.destroy());
      server.on("tlsClientError",(error,socket)=>{
        const code=(error as NodeJS.ErrnoException).code;
        const category=code==="ERR_SSL_TLSV1_ALERT_UNKNOWN_CA"?"MODEL_PIPE_TLS_UNTRUSTED_ISSUER"
          :code==="ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE"||code==="ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN"?"MODEL_PIPE_TLS_CERTIFICATE_REJECTED"
          :"MODEL_PIPE_TLS_HANDSHAKE_FAILED";
        try{this.emit("model.pipe_tls_handshake",userId,"failed",category);}catch{}
        socket.destroy();
      });
      // Invalid protocol upgrades never escape to a generic management or TCP route.
      server.on("upgrade",(_request,socket)=>socket.destroy());
      server.on("connect",(_request,socket)=>socket.destroy());
      await new Promise<void>((done,reject)=>{
        const timer=setTimeout(()=>finish(new SafeError("MODEL_BROKER_LISTEN_FAILED")),5000);timer.unref();
        const finish=(error?:Error)=>{clearTimeout(timer);server!.removeListener("error",failed);server!.removeListener("close",cancelled);error?reject(error):done();};
        const failed=(error:Error)=>finish(error),cancelled=()=>finish(new SafeError("MODEL_LEASE_INVALID",401));
        server!.once("error",failed);server!.once("close",cancelled);server!.listen(0,"127.0.0.1",()=>finish());
      });
      server.on("error",()=>this.release(key));
      if(this.closed||this.leases.get(key)!==lease||stopped)return fail("MODEL_LEASE_INVALID",401);
      const address=server.address();if(!address||typeof address==="string")return fail("MODEL_BROKER_LISTEN_FAILED");
      expiry=setTimeout(()=>this.release(key),Math.max(1,expiresAt-Date.now()));expiry.unref();
      return {...capability,forwardPort:address.port,serverName:MODEL_PIPE_SERVER_NAME,certificatePem:tls.certificatePem,expiresAt,closed};
    }catch(error){this.release(key);stop();if(error instanceof SafeError)throw error;return fail("MODEL_PIPE_ENDPOINT_FAILED");}
  }
  private tokenKey(token:string){return createHash("sha256").update(token).digest("hex");}
  private scope(userId:string,value:string){return createHash("sha256").update(this.scopeSecret).update(JSON.stringify([userId,value])).digest("hex");}
  private sessionScope(userId:string,value:string){const hash=this.scope(userId,value);return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-${((parseInt(hash[16]!,16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;}
  private release(key:string){const lease=this.leases.get(key);if(!lease)return;this.leases.delete(key);for(const controller of lease.controllers)controller.abort();lease.stopEndpoint?.();}
  revokeUser(userId:string){for(const [key,lease] of this.leases)if(lease.userId===userId)this.release(key);}
  private notifyRevoked(users:Set<string>){for(const userId of users){
    try{this.emit("model.revoked",userId,"succeeded");}catch{}
    try{this.options.onRevoke?.(userId);}catch{try{this.emit("model.revoked",userId,"failed","MODEL_WORKER_STOP_FAILED");}catch{}}
  }}
  private reconcile(config:Config){const revoked=new Set<string>();for(const [key,lease] of this.leases){let invalid=false;try{invalid=this.binding(config,lease.userId).fingerprint!==lease.fingerprint;}catch{invalid=true;}if(invalid){revoked.add(lease.userId);this.release(key);}}this.notifyRevoked(revoked);}
  reload(){if(this.closed)return;try{this.reconcile(this.readConfig());}catch{const revoked=new Set<string>();for(const [key,lease] of this.leases){revoked.add(lease.userId);this.release(key);}this.notifyRevoked(revoked);}}
  private error(response:ServerResponse,error:unknown){
    const safe=error instanceof SafeError?error:new SafeError("MODEL_PROVIDER_UNAVAILABLE");
    if(response.destroyed)return;
    if(response.headersSent){response.destroy();return;}
    response.writeHead(safe.status,{"content-type":"application/json","cache-control":"no-store","connection":"close"});
    response.end(JSON.stringify({error:{code:safe.code,message:safe.code}}));
  }
  private async handle(request:IncomingMessage,response:ServerResponse,expectedLeaseKey?:string){
    let lease:Lease|undefined,controller:AbortController|undefined,timer:NodeJS.Timeout|undefined,admitted=false;
    try{
      if(this.closed)return fail("MODEL_BROKER_CLOSED");
      if(request.method!=="POST"||!["/v1/responses","/responses"].includes(request.url??""))return fail("MODEL_BROKER_ROUTE_DENIED",404);
      const auth=request.headers.authorization;
      if(request.rawHeaders.filter((_,index)=>index%2===0&&request.rawHeaders[index]!.toLowerCase()==="authorization").length!==1)return fail("MODEL_LEASE_INVALID",401);
      if(typeof auth!=="string"||!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))return fail("MODEL_LEASE_INVALID",401);
      const config=this.readConfig();this.reconcile(config);
      const leaseKey=this.tokenKey(auth.slice(7));
      if(expectedLeaseKey!==undefined&&leaseKey!==expectedLeaseKey)return fail("MODEL_LEASE_INVALID",401);
      lease=this.leases.get(leaseKey);
      if(!lease)return fail("MODEL_LEASE_INVALID",401);
      if((lease.mode==="pipe")!==(expectedLeaseKey!==undefined))return fail("MODEL_LEASE_INVALID",401);
      if(lease.expiresAt!==undefined&&Date.now()>=lease.expiresAt){this.release(leaseKey);return fail("MODEL_LEASE_INVALID",401);}
      const {provider}=this.binding(config,lease.userId),credential=this.credential(provider),url=this.endpoint(provider);
      if(request.headers["content-encoding"]||!String(request.headers["content-type"]??"").toLowerCase().startsWith("application/json"))return fail("MODEL_REQUEST_INVALID",400);
      if(this.requests>=this.concurrent||(this.perUser.get(lease.userId)??0)>=this.userConcurrent)return fail("MODEL_BROKER_BUSY",429);
      const length=request.headers["content-length"];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>this.bodyLimit))return fail("MODEL_REQUEST_TOO_LARGE",413);
      controller=new AbortController();lease.controllers.add(controller);this.requests++;this.perUser.set(lease.userId,(this.perUser.get(lease.userId)??0)+1);admitted=true;
      timer=setTimeout(()=>controller?.abort(),this.timeout);timer.unref();
      const abort=()=>controller?.abort();request.once("aborted",abort);response.once("close",abort);
      const chunks:Buffer[]=[];let size=0;
      // The abort listener also terminates a stalled upload, not just an upstream request.
      const stopUpload=()=>request.destroy();controller.signal.addEventListener("abort",stopUpload,{once:true});
      try{for await(const chunk of request){size+=chunk.length;if(size>this.bodyLimit)return fail("MODEL_REQUEST_TOO_LARGE",413);chunks.push(Buffer.from(chunk));}}
      finally{controller.signal.removeEventListener("abort",stopUpload);}
      if(controller.signal.aborted)return fail("MODEL_REQUEST_CANCELLED",503);
      let payload:Record<string,unknown>;
      try{const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!obj(parsed))return fail("MODEL_REQUEST_INVALID",400);payload=parsed;}catch{return fail("MODEL_REQUEST_INVALID",400);}
      // A shared provider account is not a shared conversation namespace. Never
      // retrieve provider-side state on behalf of a worker capability.
      if(payload.previous_response_id!=null||payload.conversation!=null||payload.prompt!=null)return fail("MODEL_REMOTE_REFERENCE_DENIED",400);
      const checkInput=(value:unknown):void=>{
        if(Array.isArray(value)){for(const item of value)checkInput(item);return;}
        if(!obj(value))return;
        if(value.type==="item_reference"||value.file_id!=null||value.file_url!=null||value.image_url!==undefined&&(typeof value.image_url!=="string"||!value.image_url.startsWith("data:image/")))return fail("MODEL_REMOTE_REFERENCE_DENIED",400);
        for(const item of Object.values(value))checkInput(item);
      };
      checkInput(payload.input);
      payload.store=false;
      payload.prompt_cache_key=this.scope(lease.userId,typeof payload.prompt_cache_key==="string"?payload.prompt_cache_key.slice(0,2048):"default");
      const body=Buffer.from(JSON.stringify(payload));
      if(body.length>this.bodyLimit)return fail("MODEL_REQUEST_TOO_LARGE",413);
      this.emit("model.request",lease.userId,"succeeded");
      const headers:Record<string,string>={"authorization":credential.authorization,"content-type":"application/json","accept":payload.stream===true?"text/event-stream":"application/json","accept-encoding":"identity","content-length":String(body.length)};
      for(const name of ["openai-beta","version"]){const value=request.headers[name];if(bounded(value,2048))headers[name]=value;}
      // Stateful provider request headers are namespaced; opaque turn-state or
      // provider-owned routing cookies are not accepted from workers.
      for(const name of ["session_id","conversation_id"]){const value=request.headers[name];headers[name]=this.sessionScope(lease.userId,bounded(value,2048)?value:"default");}
      if(provider.kind==="chatgpt"){headers["chatgpt-account-id"]=credential.accountId!;headers.originator="codex_cli_rs";}
      await new Promise<void>((resolvePromise,rejectPromise)=>{
        const signal=controller!.signal;
        let settled=false,terminalDelivered=false,upstream:http.ClientRequest|undefined,incomingResponse:IncomingMessage|undefined,sseFilter:SafeSse|undefined;
        const finish=(error?:unknown)=>{
          if(settled)return;settled=true;
          signal.removeEventListener("abort",cancel);response.removeListener("close",cancel);
          if(error!==undefined){sseFilter?.destroy();incomingResponse?.destroy();upstream?.destroy();rejectPromise(error);}
          else resolvePromise();
        };
        const done=()=>finish(),reject=(error:unknown)=>finish(error);
        const cancel=()=>{
          // A consumer may finish on response.completed while the provider keeps
          // its SSE socket open. Only acknowledge a terminal frame after its
          // downstream write callback; queued/partial frames are not success.
          if(response.destroyed&&terminalDelivered){finish();sseFilter?.destroy();incomingResponse?.destroy();upstream?.destroy();}
          else reject(new SafeError("MODEL_REQUEST_CANCELLED",503));
        };
        signal.addEventListener("abort",cancel,{once:true});response.once("close",cancel);
        if(signal.aborted||response.destroyed){cancel();return;}
        upstream=(url.protocol==="https:"?https:http).request(url,{method:"POST",headers,signal,agent:false},incoming=>{
          incomingResponse=incoming;
          const status=incoming.statusCode??502;
          const encoding=String(incoming.headers["content-encoding"]??"identity").trim().toLowerCase();
          if(encoding!=="identity"){
            const category=encoding==="gzip"?"GZIP":encoding==="br"?"BR":encoding==="deflate"?"DEFLATE":encoding==="zstd"?"ZSTD":"UNKNOWN";
            incoming.destroy();reject(new SafeError(`MODEL_PROVIDER_ENCODING_${category}_UNSUPPORTED`,502));return;
          }
          if(status<200||status>=300){
            if(status!==400){incoming.destroy();reject(providerHttpError(status));return;}
            const diagnostics:Buffer[]=[];let size=0;
            incoming.on("data",chunk=>{size+=chunk.length;if(size>32768){incoming.destroy();reject(providerHttpError(status));}else diagnostics.push(Buffer.from(chunk));});
            incoming.once("end",()=>reject(providerHttpError(status,Buffer.concat(diagnostics))));
            incoming.once("error",()=>reject(providerHttpError(status)));incoming.once("aborted",()=>reject(providerHttpError(status)));return;
          }
          const rawType=String(incoming.headers["content-type"]??"");
          let contentType=rawType.split(";")[0]!.trim().toLowerCase();
          // Pinned Rust feeds response bytes directly to eventsource_stream and
          // does not require a Content-Type header. Match that only for requested
          // SSE and validate every frame before releasing bytes to the Worker.
          if(!contentType&&payload.stream===true)contentType="text/event-stream";
          if(!["text/event-stream","application/json"].includes(contentType)||rawType.includes(",")){
            const category=rawType.includes(",")?"DUPLICATE":!contentType?"MISSING":contentType==="text/plain"?"PLAIN":contentType==="text/html"?"HTML":contentType==="application/octet-stream"?"OCTET_STREAM":contentType==="application/x-ndjson"?"NDJSON":contentType==="application/jsonl"?"JSONL":contentType==="application/x-event-stream"?"X_EVENT_STREAM":contentType.startsWith("multipart/")?"MULTIPART":"UNKNOWN";
            incoming.destroy();reject(new SafeError(`MODEL_PROVIDER_CONTENT_TYPE_INVALID_${category}`,502));return;
          }
          incoming.once("error",()=>reject(new SafeError("MODEL_PROVIDER_STREAM_TRANSPORT_FAILED",502)));
          incoming.once("aborted",()=>reject(new SafeError("MODEL_PROVIDER_STREAM_ABORTED",502)));
          if(contentType==="text/event-stream"){
            response.statusCode=status;response.setHeader("content-type",contentType);response.setHeader("cache-control","no-store");response.setHeader("x-accel-buffering","no");
            const filter=new SafeSse();sseFilter=filter;
            filter.once("error",error=>reject(error));
            let forwarded=0;
            filter.on("data",(chunk:Buffer)=>{
              const end=forwarded+=chunk.length;
              const accepted=response.write(chunk,error=>{
                if(error){reject(new SafeError("MODEL_DOWNSTREAM_WRITE_FAILED",502));return;}
                if(!settled&&filter.successfulTerminalEnd>0&&end>=filter.successfulTerminalEnd)terminalDelivered=true;
              });
              if(!accepted)filter.pause();
            });
            response.on("drain",()=>filter.resume());
            filter.once("end",()=>response.end());
            incoming.pipe(filter);response.once("finish",done);
          }else{
            const result:Buffer[]=[];let bytes=0;
            incoming.on("data",chunk=>{bytes+=chunk.length;if(bytes>32*1024*1024){incoming.destroy();reject(new SafeError("MODEL_PROVIDER_JSON_TOO_LARGE",502));}else result.push(Buffer.from(chunk));});
            incoming.once("end",()=>{try{const body=Buffer.concat(result);const value=JSON.parse(body.toString("utf8"));if(responseFailed(value))throw new SafeError("MODEL_PROVIDER_UNAVAILABLE",502);response.writeHead(status,{"content-type":contentType,"cache-control":"no-store"});response.end(body);done();}catch(error){reject(error instanceof SafeError?error:new SafeError("MODEL_PROVIDER_JSON_INVALID",502));}});
          }
        });
        upstream.once("error",()=>reject(new SafeError("MODEL_PROVIDER_REQUEST_TRANSPORT_FAILED",502)));upstream.end(body);
      });
    }catch(error){
      const safe=error instanceof SafeError?error:new SafeError("MODEL_PROVIDER_UNAVAILABLE");
      try{this.emit("model.request",lease?.userId,"failed",safe.code);}catch{}
      this.error(response,safe);
    }finally{
      if(timer)clearTimeout(timer);
      if(controller&&lease)lease.controllers.delete(controller);
      if(admitted&&lease){this.requests--;const n=(this.perUser.get(lease.userId)??1)-1;if(n)this.perUser.set(lease.userId,n);else this.perUser.delete(lease.userId);}
    }
  }
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.sweep);for(const key of this.leases.keys())this.release(key);this.server.closeAllConnections();await Promise.all([new Promise<void>(done=>this.server.close(()=>done())),...this.endpointClosures]);}
}
