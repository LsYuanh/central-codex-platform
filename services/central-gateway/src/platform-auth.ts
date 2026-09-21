// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash, createPublicKey, randomBytes, randomUUID, scrypt, timingSafeEqual, verify, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import { writeGatewayState } from "./gateway-state.js";
import type { DeviceCertificates } from "./device-certificates.js";

type DeviceCertificate = {pem:string; fingerprint:string; expiresAt:number; renewAfter:number};

type UserIdentity = { id:string; username:string; role:"admin"|"user"; disabled:boolean };
type User = UserIdentity & ({authType?:"password";salt:string;passwordHash:string}|{authType:"pairing-only";salt?:never;passwordHash?:never});
type Session = { id:string; userId:string; refreshHash:string; spent:string[]; expiresAt:number; revoked:boolean; scope?:"central-admin" };
export type DeviceAuthMode = "device-token-v1"|"legacy-mtls-v1";
type Device = { id:string; userId:string; name:string; publicKey?:string; deviceKey:string; revoked:boolean; createdAt:number; tlsPublicKey?:string; certificates?:DeviceCertificate[]; authMode?:"device-token-v1"; tokenHash?:string };
type State = {version:1; users:User[]; sessions:Session[]; devices:Device[]};
export type Principal = {userId:string; sessionId:string; role:"admin"|"user"; expiresAt:number; deviceId?:string; deviceKey?:string; certificateFingerprint?:string; certificateExpiresAt?:number; authMode?:"device-token-v1"; tokenHash?:string};
type Ticket = {principal:Principal; purpose:"ui"|"agent"; expiresAt:number};
const hash = (s:string|Buffer) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const obj = (x:unknown): x is Record<string,unknown> => x!==null && typeof x==="object" && !Array.isArray(x);
const text = (x:unknown,max=256) => { if(typeof x!=="string"||!x||x.length>max||/[\x00-\x1f]/.test(x)) throw Error("INVALID_INPUT"); return x; };
const passwordKey = (password:string,salt:string) => new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,32,{N:131072,r:8,p:1,maxmem:256*1024*1024},(e,key)=>e?reject(e):resolve(key)));
const publicUser = (u:User) => ({id:u.id,username:u.username,role:u.role,disabled:u.disabled,loginMode:u.authType==="pairing-only"?"pairing-only" as const:"password" as const});
export type DevicePresence = {online:boolean;lastSeenAt:number|null};
type ManagementOperation = {fingerprint:string;expiresAt:number;result:Promise<unknown>;valid?:()=>boolean};

/** Platform credentials are independent of model credentials. Only token hashes are durable. */
export class PlatformAuth {
  private state:State;
  private failed=false;
  private hashing=0;
  private readonly access = new Map<string,Principal>();
  private readonly pairs = new Map<string,{userId:string;sessionId:string;expiresAt:number}>();
  private readonly devicePairs = new Map<string,{userId:string;issuerUserId:string;sessionId:string;expiresAt:number}>();
  private readonly challenges = new Map<string,{sessionId:string;deviceId:string;expiresAt:number}>();
  private readonly tickets = new Map<string,Ticket>();
  private readonly sockets = new Map<WebSocket,Principal>();
  private readonly rates = new Map<string,{count:number;until:number}>();
  private readonly operations = new Map<string,ManagementOperation>();
  private presence:(deviceId:string,userId:string)=>DevicePresence=()=>({online:false,lastSeenAt:null});
  public setDevicePresence(reader:typeof this.presence){this.presence=reader;}
  private readonly timer:NodeJS.Timeout;
  private audit:(action:string,status:"started"|"succeeded"|"failed",userId?:string,errorCode?:string)=>void=()=>{};
  public setAudit(callback:typeof this.audit){this.audit=callback;}
  private certificates?:DeviceCertificates;
  private readonly renewing = new Set<string>();
  public setCertificates(certificates:DeviceCertificates){this.certificates=certificates;}
  public constructor(private path:string, private accessMs=5*60_000, private sessionMs=30*86400_000, public readonly deviceAuthMode:DeviceAuthMode="device-token-v1") {
    if(!["device-token-v1","legacy-mtls-v1"].includes(deviceAuthMode))throw Error("AUTH_MODE_UNSUPPORTED");
    let raw:unknown;
    try { raw=JSON.parse(readFileSync(path,"utf8")); }
    catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT") throw Error("AUTH_STATE_CORRUPT_OR_UNREADABLE"); raw={version:1,users:[],sessions:[],devices:[]}; }
    if(!obj(raw)||raw.version!==1||!Array.isArray(raw.users)||!Array.isArray(raw.sessions)||!Array.isArray(raw.devices)) throw Error("AUTH_STATE_CORRUPT");
    this.state=raw as State;
    const ids=new Set<string>(),names=new Set<string>();
    for(const u of this.state.users){
      if(!obj(u)||typeof u.id!=="string"||ids.has(u.id)||typeof u.username!=="string"||names.has(u.username)||!["admin","user"].includes(u.role)||typeof u.disabled!=="boolean")throw Error("AUTH_STATE_CORRUPT");
      if(u.authType==="pairing-only"){
        if(u.role!=="user"||Object.hasOwn(u,"salt")||Object.hasOwn(u,"passwordHash"))throw Error("AUTH_STATE_CORRUPT");
      }else if((u.authType!==undefined&&u.authType!=="password")||typeof u.passwordHash!=="string"||!(/^[a-f0-9]{64}$/.test(u.passwordHash))||typeof u.salt!=="string"||!(/^[a-f0-9]{32}$/.test(u.salt)))throw Error("AUTH_STATE_CORRUPT");
      ids.add(u.id);names.add(u.username);
    }
    const sessions=new Set<string>();
    for(const s of this.state.sessions){if(!obj(s)||typeof s.id!=="string"||sessions.has(s.id)||!ids.has(s.userId)||!Array.isArray(s.spent)||s.spent.some(h=>typeof h!=="string"||!/^[a-f0-9]{64}$/.test(h))||!/^[a-f0-9]{64}$/.test(s.refreshHash)||!Number.isFinite(s.expiresAt)||typeof s.revoked!=="boolean"||(s.scope!==undefined&&(s.scope!=="central-admin"||!this.state.users.some(u=>u.id===s.userId&&u.role==="admin"&&u.authType!=="pairing-only"))))throw Error("AUTH_STATE_CORRUPT");sessions.add(s.id);}
    const devices=new Set<string>();
    for(const d of this.state.devices){
      if(!obj(d)||typeof d.id!=="string"||devices.has(d.id)||!ids.has(d.userId)||typeof d.revoked!=="boolean")throw Error("AUTH_STATE_CORRUPT");
      if(d.authMode==="device-token-v1"){
        if(!/^[a-f0-9-]{36}$/.test(d.id)||typeof d.name!=="string"||!Number.isFinite(d.createdAt)||!/^[a-f0-9]{64}$/.test(d.deviceKey)||typeof d.tokenHash!=="string"||!/^[a-f0-9]{64}$/.test(d.tokenHash)||d.publicKey!==undefined||d.certificates!==undefined||d.tlsPublicKey!==undefined)throw Error("AUTH_STATE_CORRUPT");
      }else if(d.authMode!==undefined||d.tokenHash!==undefined||typeof d.publicKey!=="string"||Buffer.from(d.publicKey,"base64").length!==32||d.deviceKey!==hash(Buffer.from(d.publicKey,"base64")))throw Error("AUTH_STATE_CORRUPT");
      devices.add(d.id);
    }
    for(const d of this.state.devices){
      if(d.tlsPublicKey===undefined&&d.certificates===undefined)continue; // Legacy identity requires explicit re-pairing.
      try{
        if(typeof d.tlsPublicKey!=="string"||!Array.isArray(d.certificates)||d.certificates.length<1||d.certificates.length>2)throw Error();
        for(const c of d.certificates){
          const x=new X509Certificate(c.pem);
          if(c.fingerprint!==hash(x.raw)||c.expiresAt!==Date.parse(x.validTo)||!Number.isFinite(c.renewAfter)||c.renewAfter>=c.expiresAt||x.publicKey.export({type:"spki",format:"der"}).toString("base64")!==d.tlsPublicKey)throw Error();
        }
      }catch{throw Error("AUTH_STATE_CORRUPT");}
    }
    this.timer=setInterval(()=>this.sweep(),500); this.timer.unref();
  }
  public close(){clearInterval(this.timer);this.operations.clear();this.devicePairs.clear();for(const socket of this.sockets.keys())socket.close(1001,"server stopping");}
  /** In-process native service provisioning only, never an unauthenticated route. */
  public serviceUsers(){this.ensure();return this.state.users.map(publicUser);}
  public failClosed(){this.failed=true;this.invalidate();}
  private save(){this.ensure();try{writeGatewayState(this.path,this.state);}catch{this.failed=true;this.invalidate();throw Error("AUTH_STORAGE_UNAVAILABLE");}}
  private ensure(){if(this.failed)throw Error("AUTH_STORAGE_UNAVAILABLE");}
  private liveSession(id:string){this.ensure();const s=this.state.sessions.find(s=>s.id===id);if(!s||s.revoked||s.expiresAt<=Date.now()||!this.state.users.some(u=>u.id===s.userId&&!u.disabled))throw Error("AUTH_REQUIRED");return s;}
  public valid(p:Principal){try{
    this.ensure();
    if(p.authMode==="device-token-v1")return this.deviceAuthMode==="device-token-v1"&&p.role==="user"&&this.state.users.some(u=>u.id===p.userId&&!u.disabled)&&this.state.devices.some(d=>d.authMode==="device-token-v1"&&d.id===p.deviceId&&d.userId===p.userId&&d.deviceKey===p.deviceKey&&d.tokenHash===p.tokenHash&&!d.revoked);
    const s=this.liveSession(p.sessionId);return s.userId===p.userId&&p.expiresAt>Date.now()&&(!p.deviceId||this.deviceAuthMode==="legacy-mtls-v1"&&this.state.devices.some(d=>d.id===p.deviceId&&d.userId===p.userId&&!d.authMode&&!d.revoked&&(!p.certificateFingerprint||d.certificates?.some(c=>c.fingerprint===p.certificateFingerprint&&c.expiresAt>Date.now()&&(p.certificateExpiresAt??0)>Date.now()))));
  }catch{return false;}}
  public failureReason(p:Principal|undefined){
    if(!p)return "AUTH_REQUIRED";
    const d=p.deviceId?this.state.devices.find(d=>d.id===p.deviceId):undefined;
    return d?.revoked?"DEVICE_REVOKED":p.certificateExpiresAt!==undefined&&p.certificateExpiresAt<=Date.now()?"DEVICE_CERTIFICATE_EXPIRED":"AUTH_REQUIRED";
  }
  private invalidate(){for(const [socket,p] of this.sockets)if(!this.valid(p)){
    socket.close(4001,this.failureReason(p));setTimeout(()=>socket.terminate(),500).unref();
  }}
  private sweep(){this.invalidate();const now=Date.now();for(const map of [this.access,this.pairs,this.devicePairs,this.challenges,this.tickets,this.operations])for(const [key,value] of map)if(value.expiresAt<=now)map.delete(key);for(const [key,value] of this.rates)if(value.until<=now)this.rates.delete(key);}
  private admin(p:Principal){this.assert(p);if(p.role!=="admin"||p.authMode||p.deviceId)throw Error("NOT_FOUND");}
  private management(p:Principal,requestId:unknown,route:string,payload:unknown,action:()=>unknown,valid?:()=>boolean):Promise<unknown>{
    this.assert(p);
    if(requestId===undefined)return Promise.resolve().then(action);
    const id=text(requestId,128);if(!/^[A-Za-z0-9._-]+$/.test(id))throw Error("INVALID_INPUT");
    const key=`${p.sessionId}:${id}`,fingerprint=hash(JSON.stringify([route,payload]));
    this.sweep();const previous=this.operations.get(key);
    if(previous){if(previous.fingerprint!==fingerprint)throw Error("REQUEST_ID_CONFLICT");if(previous.valid&&!previous.valid())throw Error("REQUEST_EXPIRED");return previous.result;}
    if(this.operations.size>=1000)throw Error("RATE_LIMITED");
    // Reserve before invoking an async action, including concurrent identical requests.
    const result=Promise.resolve().then(()=>{this.assert(p);return action();});
    this.operations.set(key,{fingerprint,expiresAt:Date.now()+300_000,result,valid});return result;
  }
  private devicePresence(d:Device):DevicePresence{
    const seen=this.presence(d.id,d.userId);
    return {online:seen.online===true&&!d.revoked&&this.state.users.some(u=>u.id===d.userId&&!u.disabled),lastSeenAt:typeof seen.lastSeenAt==="number"&&Number.isFinite(seen.lastSeenAt)&&seen.lastSeenAt>=0?seen.lastSeenAt:null};
  }
  private deviceSummary(d:Device){return {id:d.id,userId:d.userId,name:d.name,deviceKey:d.deviceKey,revoked:d.revoked,createdAt:d.createdAt,authMode:d.authMode??"legacy-mtls-v1",...this.devicePresence(d)};}
  private userSummary(u:User){const presence=this.state.devices.filter(d=>d.userId===u.id).map(d=>this.devicePresence(d)),seen=presence.flatMap(p=>p.lastSeenAt===null?[]:[p.lastSeenAt]);return {...publicUser(u),online:presence.some(p=>p.online),lastSeenAt:seen.length?Math.max(...seen):null};}
  private rate(key:string,limit:number){const now=Date.now();if(this.rates.size>10000)this.sweep();if(this.rates.size>10000)throw Error("RATE_LIMITED");const r=this.rates.get(key);if(r&&r.until>now){if(++r.count>limit)throw Error("RATE_LIMITED");}else this.rates.set(key,{count:1,until:now+60_000});}
  public async createUser(username:string,password:string,role:"admin"|"user"="user"){
    this.ensure();username=text(username,64).trim().toLowerCase();if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)||password.length<12||password.length>256||this.state.users.some(u=>u.username===username))throw Error("INVALID_OR_EXISTING_ACCOUNT");
    if(this.hashing>=2)throw Error("RATE_LIMITED");this.hashing++;
    try{const salt=randomBytes(16).toString("hex"),passwordHash=(await passwordKey(password,salt)).toString("hex");if(this.state.users.some(u=>u.username===username))throw Error("INVALID_OR_EXISTING_ACCOUNT");const user:User={id:randomUUID(),username,salt,passwordHash,role,disabled:false};this.state.users.push(user);this.save();return publicUser(user);}finally{this.hashing--;}
  }
  public async createPairingUser(p:Principal,username:string){
    this.admin(p);username=text(username,64).trim().toLowerCase();
    if(!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)||this.state.users.some(u=>u.username===username))throw Error("INVALID_OR_EXISTING_ACCOUNT");
    // No await between duplicate check and insertion; a concurrent password create
    // also rechecks its username after scrypt before committing.
    const user:User={id:randomUUID(),username,role:"user",disabled:false,authType:"pairing-only"};
    this.state.users.push(user);this.save();return publicUser(user);
  }
  private issue(s:Session){const value=token(),user=this.state.users.find(u=>u.id===s.userId)!;const expiresAt=Math.min(Date.now()+this.accessMs,s.expiresAt);this.access.set(hash(value),{userId:s.userId,sessionId:s.id,role:user.role,expiresAt});return {accessToken:value,accessExpiresAt:expiresAt,sessionId:s.id,user:publicUser(user)};}
  public async login(username:string,password:string,ip:string,management=false){
    this.ensure();username=text(username,64).trim().toLowerCase();password=text(password,256);this.rate(`login-ip:${ip}`,20);this.rate(`login-user:${hash(username)}`,8);if(this.hashing>=2)throw Error("RATE_LIMITED");this.hashing++;
    try{const u=this.state.users.find(u=>u.username===username);const passwordUser=u?.authType!=="pairing-only"?u:undefined;const derived=await passwordKey(password,passwordUser?.salt??"00000000000000000000000000000000");const matches=timingSafeEqual(derived,Buffer.from(passwordUser?.passwordHash??"0".repeat(64),"hex"));if(!u||u.disabled||!passwordUser||!matches)throw Error("INVALID_LOGIN");
      if(management&&u.role!=="admin")throw Error("INVALID_LOGIN");
      const now=Date.now();
      // Successful password verification is required before retiring old native
      // management sessions. Ordinary client sessions are never reclaimed here.
      this.state.sessions=this.state.sessions.filter(s=>s.expiresAt>now&&!(management&&s.userId===u.id&&s.scope==="central-admin"));
      const live=this.state.sessions.filter(s=>s.userId===u.id&&!s.revoked&&(!management||s.scope==="central-admin"));if(live.length>=10)throw Error("SESSION_LIMIT");
      const secret=token(),s:Session={id:randomUUID(),userId:u.id,refreshHash:hash(secret),spent:[],expiresAt:now+this.sessionMs,revoked:false,...(management?{scope:"central-admin" as const}:{})};this.state.sessions.push(s);this.save();if(management)this.invalidate();return {...this.issue(s),refreshToken:`${s.id}.${secret}`};
    }finally{this.hashing--;}
  }
  public refresh(raw:string){const [id,secret,...extra]=text(raw).split(".");if(!id||!secret||extra.length)throw Error("AUTH_REQUIRED");const s=this.liveSession(id);const incoming=hash(secret);if(s.spent.includes(incoming)){s.revoked=true;this.save();this.invalidate();throw Error("REFRESH_REUSED");}if(incoming!==s.refreshHash)throw Error("AUTH_REQUIRED");const next=token();s.spent.push(s.refreshHash);s.refreshHash=hash(next);this.save();return {...this.issue(s),refreshToken:`${s.id}.${next}`};}
  public bearer(raw:unknown){
    if(typeof raw!=="string"||!raw.startsWith("Bearer "))throw Error("AUTH_REQUIRED");
    const value=raw.slice(7);
    if(value.startsWith("ydt1.")){
      if(this.deviceAuthMode!=="device-token-v1")throw Error("AUTH_MODE_UNSUPPORTED");
      const match=/^ydt1\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);if(!match)throw Error("AUTH_REQUIRED");
      const d=this.state.devices.find(d=>d.id===match[1]&&d.authMode==="device-token-v1");
      if(!d?.tokenHash||!timingSafeEqual(Buffer.from(d.tokenHash,"hex"),Buffer.from(hash(value),"hex")))throw Error("AUTH_REQUIRED");
      const p:Principal={userId:d.userId,sessionId:`device:${d.id}`,role:"user",expiresAt:Number.MAX_SAFE_INTEGER,deviceId:d.id,deviceKey:d.deviceKey,authMode:"device-token-v1",tokenHash:d.tokenHash};
      if(!this.valid(p))throw Error(this.failureReason(p));return p;
    }
    const p=this.access.get(hash(value));if(!p||!this.valid(p))throw Error("AUTH_REQUIRED");return p;
  }
  public device(p:Principal,id:string){const d=this.state.devices.find(d=>d.id===id&&d.userId===p.userId&&!d.revoked);if(!this.valid(p)||!d||(p.authMode==="device-token-v1"&&p.deviceId!==id))throw Error("NOT_FOUND");return d;}
  private requireLegacy(){if(this.deviceAuthMode!=="legacy-mtls-v1")throw Error("AUTH_MODE_UNSUPPORTED");}
  public adminPairCode(p:Principal,userId:string){
    this.admin(p);
    if(!this.state.users.some(u=>u.id===userId&&!u.disabled))throw Error("NOT_FOUND");
    if(this.deviceAuthMode!=="device-token-v1")throw Error("AUTH_MODE_UNSUPPORTED");
    this.sweep();for(const [key,entry] of this.devicePairs)if(entry.sessionId===p.sessionId&&entry.userId===userId)this.devicePairs.delete(key);
    if(this.devicePairs.size>=1000)throw Error("RATE_LIMITED");
    const code=token(),expiresAt=Date.now()+300_000;
    this.devicePairs.set(hash(code),{userId,issuerUserId:p.userId,sessionId:p.sessionId,expiresAt});
    return {authMode:"device-token-v1",code,expiresAt,expiresIn:300};
  }
  public pairDeviceToken(code:string,name:string){
    if(this.deviceAuthMode!=="device-token-v1")throw Error("AUTH_MODE_UNSUPPORTED");
    this.ensure();const key=hash(code),entry=this.devicePairs.get(key);this.devicePairs.delete(key);
    if(!entry||entry.expiresAt<=Date.now())throw Error("INVALID_PAIR_CODE");
    try{const s=this.liveSession(entry.sessionId);if(s.userId!==entry.issuerUserId||!this.state.users.some(u=>u.id===s.userId&&u.role==="admin"&&!u.disabled))throw Error();}catch{throw Error("INVALID_PAIR_CODE");}
    const user=this.state.users.find(u=>u.id===entry.userId&&!u.disabled);if(!user)throw Error("INVALID_PAIR_CODE");
    const id=randomUUID(),deviceToken=`ydt1.${id}.${token()}`;
    const d:Device={id,userId:user.id,name:text(name,128),deviceKey:randomBytes(32).toString("hex"),createdAt:Date.now(),revoked:false,authMode:"device-token-v1",tokenHash:hash(deviceToken)};
    this.state.devices.push(d);this.save();return {...this.publicDevice(d),deviceToken};
  }
  private publicDevice(d:Device){const u=this.state.users.find(u=>u.id===d.userId)!;return {authMode:"device-token-v1",deviceId:d.id,deviceKey:d.deviceKey,name:d.name,user:{id:u.id,username:u.username},status:d.revoked?"revoked":"active"};}
  public deviceStatus(p:Principal){this.assert(p);if(p.authMode!=="device-token-v1"||!p.deviceId)throw Error("AUTH_MODE_UNSUPPORTED");return this.publicDevice(this.device(p,p.deviceId));}
  public disconnectDevice(p:Principal){this.deviceStatus(p);this.revokeDevice(p,p.deviceId!);return {disconnected:true};}
  public pairCode(p:Principal){this.requireLegacy();if(!this.valid(p))throw Error("AUTH_REQUIRED");const code=token();this.pairs.set(hash(code),{userId:p.userId,sessionId:p.sessionId,expiresAt:Date.now()+120_000});return {code,expiresIn:120};}
  private prepareDevice(p:Principal,code:string,publicKey:string,name:string):Device {
    this.requireLegacy();
    const entry=this.pairs.get(hash(code));this.pairs.delete(hash(code));
    if(!entry||entry.userId!==p.userId||entry.sessionId!==p.sessionId||entry.expiresAt<=Date.now()||!this.valid(p))throw Error("INVALID_PAIR_CODE");
    const raw=Buffer.from(text(publicKey),"base64");
    if(raw.length!==32||raw.toString("base64")!==publicKey)throw Error("INVALID_DEVICE_KEY");
    if(this.state.devices.some(d=>d.publicKey===publicKey))throw Error("DEVICE_KEY_ALREADY_REGISTERED");
    return {id:randomUUID(),userId:p.userId,name:text(name,128),publicKey,deviceKey:hash(raw),revoked:false,createdAt:Date.now()};
  }
  public pair(p:Principal,code:string,publicKey:string,name:string){
    if(this.certificates)throw Error("DEVICE_CERTIFICATE_REQUIRED");
    const d=this.prepareDevice(p,code,publicKey,name);this.state.devices.push(d);this.save();
    return {deviceId:d.id,deviceKey:d.deviceKey,name:d.name};
  }
  public async pairWithCertificate(p:Principal,code:string,publicKey:string,name:string,tlsPublicKey:unknown){
    if(!this.certificates)return this.pair(p,code,publicKey,name);
    const d=this.prepareDevice(p,code,publicKey,name);d.tlsPublicKey=text(tlsPublicKey,2048);
    const certificate=await this.certificates.issue({deviceId:d.id,userId:d.userId,tlsPublicKey:d.tlsPublicKey});
    this.assert(p);
    if(this.state.devices.some(other=>other.publicKey===publicKey))throw Error("DEVICE_KEY_ALREADY_REGISTERED");
    d.certificates=[certificate];this.state.devices.push(d);this.save();
    return {deviceId:d.id,deviceKey:d.deviceKey,name:d.name,certificate};
  }
  private certificateDevice(request:IncomingMessage,sessionId:string,deviceId:string){
    if(!this.certificates)throw Error("DEVICE_CERTIFICATE_REQUIRED");
    const peer=this.certificates.validateTLS(request),s=this.liveSession(sessionId);
    const d=this.state.devices.find(d=>d.id===deviceId&&d.userId===s.userId);
    if(!d||d.revoked)throw Error("DEVICE_REVOKED");
    const certificate=d.certificates?.find(c=>c.fingerprint===peer.fingerprint);
    if(!certificate)throw Error("DEVICE_CERTIFICATE_INVALID");
    if(certificate.expiresAt<=Date.now()||peer.expiresAt<=Date.now())throw Error("DEVICE_CERTIFICATE_EXPIRED");
    return {d,s,certificate};
  }
  public async renewCertificate(request:IncomingMessage,sessionId:string,deviceId:string){
    this.requireLegacy();
    const {d,s,certificate}=this.certificateDevice(request,sessionId,deviceId);
    if(!d.tlsPublicKey)throw Error("DEVICE_CERTIFICATE_REQUIRED");
    if(this.renewing.has(d.id))throw Error("RATE_LIMITED");
    this.renewing.add(d.id);
    try{
      let next=d.certificates!.at(-1)!;
      if(next.renewAfter<=Date.now()){
        next=await this.certificates!.issue({deviceId:d.id,userId:d.userId,tlsPublicKey:d.tlsPublicKey});
        // A logout/revoke or expiry during signing must not resurrect this identity.
        this.certificateDevice(request,sessionId,deviceId);
        d.certificates=[...d.certificates!.filter(c=>c.expiresAt>Date.now()),next].slice(-2);
        this.save();
      }
      // Explicit mTLS reauthorization of this session's existing channel. This does not
      // replace its TLS handshake; it extends the device authorization lease without
      // canceling a running client command. Old certificates retain their original expiry.
      for(const p of this.sockets.values())if(p.sessionId===s.id&&p.deviceId===d.id&&p.certificateFingerprint===certificate.fingerprint){
        p.certificateFingerprint=next.fingerprint;p.certificateExpiresAt=next.expiresAt;
      }
      return {certificate:next};
    }finally{this.renewing.delete(d.id);}
  }
  public challenge(sessionId:string,deviceId:string){this.requireLegacy();const s=this.liveSession(sessionId);const d=this.state.devices.find(d=>d.id===deviceId&&d.userId===s.userId&&!d.authMode);if(!d)throw Error("AUTH_REQUIRED");if(d.revoked)throw Error("DEVICE_REVOKED");if(this.challenges.size>=1000)throw Error("RATE_LIMITED");const nonce=token();this.challenges.set(nonce,{sessionId,deviceId,expiresAt:Date.now()+30_000});return {nonce,message:`yuan-zhou-device-v1\n${sessionId}\n${deviceId}\n${nonce}`};}
  public prove(nonce:string,signature:string){this.requireLegacy();const c=this.challenges.get(nonce);this.challenges.delete(nonce);if(!c||c.expiresAt<=Date.now())throw Error("AUTH_REQUIRED");const s=this.liveSession(c.sessionId),d=this.state.devices.find(d=>d.id===c.deviceId&&d.userId===s.userId&&!d.authMode);if(!d?.publicKey)throw Error("AUTH_REQUIRED");if(d.revoked)throw Error("DEVICE_REVOKED");const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(d.publicKey,"base64")]),type:"spki",format:"der"});if(!verify(null,Buffer.from(`yuan-zhou-device-v1\n${s.id}\n${d.id}\n${nonce}`),key,Buffer.from(signature,"base64")))throw Error("AUTH_REQUIRED");const value=token();this.tickets.set(hash(value),{principal:{userId:s.userId,sessionId:s.id,role:this.state.users.find(u=>u.id===s.userId)!.role,deviceId:d.id,deviceKey:d.deviceKey,expiresAt:s.expiresAt},purpose:"agent",expiresAt:Date.now()+15_000});return {ticket:value};}
  public upgrade(request:IncomingMessage,purpose:"ui"|"agent"):Principal {
    const query=new URL(request.url??"/","https://gateway.invalid").searchParams;
    if(query.has("userId")||[...query.keys()].some(k=>k!=="deviceId")||query.getAll("deviceId").length>1)throw Error("CLIENT_IDENTITY_OVERRIDE_DENIED");
    if(this.deviceAuthMode==="device-token-v1"){
      const p=this.bearer(request.headers.authorization);if(p.authMode!=="device-token-v1")throw Error("AUTH_MODE_UNSUPPORTED");
      if(query.has("deviceId")&&query.get("deviceId")!==p.deviceId)throw Error("CLIENT_IDENTITY_OVERRIDE_DENIED");return p;
    }
    if(purpose==="ui"){const p=this.bearer(request.headers.authorization);const deviceId=text(query.get("deviceId"));const d=this.device(p,deviceId);return {...p,deviceId,deviceKey:d.deviceKey};}
    const raw=request.headers.authorization;if(typeof raw!=="string"||!raw.startsWith("Bearer "))throw Error("AUTH_REQUIRED");const key=hash(raw.slice(7)),ticket=this.tickets.get(key);this.tickets.delete(key);if(!ticket||ticket.purpose!=="agent"||ticket.expiresAt<=Date.now()||!this.valid(ticket.principal)||query.get("deviceId")!==ticket.principal.deviceId)throw Error("AUTH_REQUIRED");
    if(this.certificates){const {certificate}=this.certificateDevice(request,ticket.principal.sessionId,ticket.principal.deviceId!);return {...ticket.principal,certificateFingerprint:certificate.fingerprint,certificateExpiresAt:certificate.expiresAt};}
    return ticket.principal;
  }
  public track(socket:WebSocket,p:Principal){this.sockets.set(socket,p);socket.once("close",()=>this.sockets.delete(socket));}
  public assert(p:Principal|undefined){if(!p||!this.valid(p))throw Error("AUTH_REQUIRED");}
  public logout(p:Principal){this.assert(p);if(p.authMode){this.disconnectDevice(p);return;}this.liveSession(p.sessionId).revoked=true;for(const [key,entry] of this.devicePairs)if(entry.sessionId===p.sessionId)this.devicePairs.delete(key);this.save();this.invalidate();}
  public revokeDevice(p:Principal,id:string){
    this.assert(p);
    const d=this.state.devices.find(d=>d.id===id&&(p.role==="admin"||(p.authMode==="device-token-v1"?d.id===p.deviceId:d.userId===p.userId)));
    if(!d)throw Error("NOT_FOUND");d.revoked=true;this.save();this.invalidate();
  }
  public disableUser(p:Principal,id:string){this.admin(p);if(p.userId===id)throw Error("NOT_FOUND");const u=this.state.users.find(u=>u.id===id);if(!u)throw Error("NOT_FOUND");u.disabled=true;for(const [key,entry] of this.devicePairs)if(entry.userId===id||entry.issuerUserId===id)this.devicePairs.delete(key);this.save();this.invalidate();}
  public async http(request:IncomingMessage,response:ServerResponse):Promise<void>{
    response.setHeader("Cache-Control","no-store");response.setHeader("X-Content-Type-Options","nosniff");
    const route=new URL(request.url??"/","https://gateway.invalid").pathname;
    const known=["login","admin/login","refresh","device/challenge","device/prove","device/renew","device/pair","device/status","device/disconnect","me","logout","pair-code","pair","devices","device/revoke","admin/users","admin/user/create","admin/user/create-pairing","admin/user/disable","admin/pair-code","admin/devices"];
    const action=known.includes(route.slice(6))?`auth.${route.slice(6).replaceAll("/",".")}`:"auth.unknown";
    let auditUser:string|undefined;
    try{
      this.ensure();this.audit(action,"started");
      // Native clients need no cross-origin cookies. Do not accept browser credential posts.
      if(request.headers.origin)throw Error("ORIGIN_DENIED");
      this.rate(`http:${request.socket.remoteAddress}`,120);
      if(request.method!=="POST"||!request.headers["content-type"]?.startsWith("application/json"))throw Error("INVALID_INPUT");
      let bytes=0,body="";for await(const chunk of request){bytes+=chunk.length;if(bytes>16*1024)throw Error("INVALID_INPUT");body+=chunk.toString();}
      const input:unknown=JSON.parse(body);if(!obj(input))throw Error("INVALID_INPUT");let result:unknown;
      const only=(keys:string[])=>{if(Object.keys(input).some(k=>!keys.includes(k))||new URL(request.url??"/","https://gateway.invalid").search)throw Error("INVALID_INPUT");};
      if(route==="/auth/login"||route==="/auth/admin/login"){only(["username","password"]);result=await this.login(text(input.username,64),text(input.password,256),request.socket.remoteAddress??"unknown",route==="/auth/admin/login");}
      else if(route==="/auth/refresh"){only(["refreshToken"]);result=this.refresh(text(input.refreshToken));}
      else if(route==="/auth/device/pair"){only(["code","name"]);if(request.headers.authorization)throw Error("INVALID_INPUT");result=this.pairDeviceToken(text(input.code),text(input.name,128));}
      else if(route==="/auth/device/challenge"){this.requireLegacy();only(["sessionId","deviceId"]);result=this.challenge(text(input.sessionId),text(input.deviceId));}
      else if(route==="/auth/device/prove"){this.requireLegacy();only(["nonce","signature"]);result=this.prove(text(input.nonce),text(input.signature));}
      else if(route==="/auth/device/renew"){this.requireLegacy();only(["sessionId","deviceId"]);result=await this.renewCertificate(request,text(input.sessionId),text(input.deviceId));auditUser=this.liveSession(text(input.sessionId)).userId;}
      else {
        const p=this.bearer(request.headers.authorization);
        auditUser=p.userId;
        if(route==="/auth/device/status"){only([]);result=this.deviceStatus(p);}
        else if(route==="/auth/device/disconnect"){only([]);result=this.disconnectDevice(p);}
        else if(route==="/auth/admin/pair-code"){
          only(["userId","requestId"]);this.admin(p);const userId=text(input.userId);let codeHash:string|undefined;
          result=await this.management(p,input.requestId,route,{userId},()=>{const issued=this.adminPairCode(p,userId);codeHash=hash(issued.code);return issued;},()=>codeHash===undefined||this.devicePairs.has(codeHash));
        }
        else if(route==="/auth/admin/devices"){only(["userId"]);this.admin(p);const userId=input.userId===undefined?undefined:text(input.userId);result={devices:this.state.devices.filter(d=>!userId||d.userId===userId).map(d=>this.deviceSummary(d))};}
        else if(route==="/auth/me"){only([]);result={user:{...publicUser(this.state.users.find(u=>u.id===p.userId)!),role:p.role}};}
        else if(route==="/auth/logout"){only([]);this.logout(p);result={loggedOut:true};}
        else if(route==="/auth/pair-code"){this.requireLegacy();only([]);result=this.pairCode(p);}
        else if(route==="/auth/pair"){only(["code","publicKey","name","tlsPublicKey"]);result=await this.pairWithCertificate(p,text(input.code),text(input.publicKey),text(input.name,128),input.tlsPublicKey);}
        else if(route==="/auth/devices"){only([]);result={devices:this.state.devices.filter(d=>d.userId===p.userId&&(!p.authMode||d.id===p.deviceId)).map(d=>({...this.deviceSummary(d),...(!d.authMode?{certificateExpiresAt:d.certificates?.at(-1)?.expiresAt,certificateStatus:d.revoked?"revoked":!d.certificates?.length?"missing":d.certificates.at(-1)!.expiresAt<=Date.now()?"expired":"valid"}:{})}))};}
        else if(route==="/auth/device/revoke"){only(["deviceId","requestId"]);const deviceId=text(input.deviceId);result=await this.management(p,input.requestId,route,{deviceId},()=>{this.revokeDevice(p,deviceId);return {revoked:true};});}
        else if(route==="/auth/admin/users"){only([]);this.admin(p);result={users:this.state.users.map(u=>this.userSummary(u))};}
        else if(route==="/auth/admin/user/create"){only(["username","password"]);this.admin(p);result=await this.createUser(text(input.username,64),text(input.password,256));}
        else if(route==="/auth/admin/user/create-pairing"){only(["requestId","username"]);this.admin(p);const requestId=text(input.requestId,128),username=text(input.username,64).trim().toLowerCase();result=await this.management(p,requestId,route,{username},()=>this.createPairingUser(p,username));}
        else if(route==="/auth/admin/user/disable"){only(["userId","requestId"]);this.admin(p);const userId=text(input.userId);result=await this.management(p,input.requestId,route,{userId},()=>{this.disableUser(p,userId);return {disabled:true};});}
        else throw Error("NOT_FOUND");
      }
      if(!auditUser&&obj(result)&&obj(result.user)&&typeof result.user.id==="string")auditUser=result.user.id;
      this.audit(action,"succeeded",auditUser);
      response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify({ok:true,data:result}));
    }catch(e){const code=e instanceof Error?e.message:"INVALID_INPUT";const allowed=["AUTH_REQUIRED","INVALID_LOGIN","REFRESH_REUSED","NOT_FOUND","RATE_LIMITED","AUTH_STORAGE_UNAVAILABLE","INVALID_INPUT","INVALID_PAIR_CODE","INVALID_DEVICE_KEY","DEVICE_KEY_ALREADY_REGISTERED","ORIGIN_DENIED","INVALID_OR_EXISTING_ACCOUNT","SESSION_LIMIT","REQUEST_ID_CONFLICT","REQUEST_EXPIRED"];
      let error=allowed.includes(code)||["AUTH_MODE_UNSUPPORTED","DEVICE_CERTIFICATE_REQUIRED","DEVICE_CERTIFICATE_INVALID","DEVICE_CERTIFICATE_EXPIRED","DEVICE_REVOKED","DEVICE_CERTIFICATE_ISSUE_FAILED","DEVICE_CERTIFICATE_KEY_INVALID","DEVICE_CA_EXPIRED"].includes(code)?code:code==="AUDIT_STORAGE_UNAVAILABLE"?code:"INVALID_INPUT";
      try{this.audit(action,"failed",auditUser,error);}catch{error="AUDIT_STORAGE_UNAVAILABLE";}
      response.writeHead(error==="NOT_FOUND"?404:error==="RATE_LIMITED"?429:error.endsWith("STORAGE_UNAVAILABLE")?503:400,{"Content-Type":"application/json"});response.end(JSON.stringify({ok:false,error}));
    }
  }
}
