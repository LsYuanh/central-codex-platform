// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Only an explicitly selected, owned stdio controller can bootstrap this mode.
// No network control endpoint and no credential files are created here.
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {validateCentralConfig,type CentralConfig} from './central-management-contract.js';
import type {PlatformAuth} from './platform-auth.js';
import type {ModelCredentialBrokerOptions} from './model-credential-broker.js';
import {ServiceMetricsEmitter,type ServiceMetrics} from './service-metrics.js';

const protocol='central-service-host/v1';
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fields=(v:Record<string,unknown>,names:string[])=>Object.keys(v).every(key=>names.includes(key));
export class NativeServiceHost {
  readonly config:CentralConfig;
  readonly tls:{cert:string;key:string};
  private account:Record<string,unknown>;
  private admin:{username:string;password:string}|undefined;
  private stopHandler:(()=>void)|undefined;
  private stopRequested=false;
  private metricsEmitter:ServiceMetricsEmitter|undefined;
  private metricsStopped=false;
  constructor(private instanceId:string,bootstrap:Record<string,unknown>){
    if(!fields(bootstrap,['config','tls','account','admin']))throw Error('SERVICE_BOOTSTRAP_INVALID');
    if(process.platform!=='win32'&&process.platform!=='darwin')throw Error('SERVICE_PLATFORM_UNSUPPORTED');
    const validated=validateCentralConfig(bootstrap.config,process.platform);
    if(!validated.ok)throw Error('SERVICE_CONFIG_INVALID');
    this.config=validated.config;
    if(!record(bootstrap.tls)||!fields(bootstrap.tls,['cert','key'])||typeof bootstrap.tls.cert!=='string'||typeof bootstrap.tls.key!=='string'
      ||bootstrap.tls.cert.length>1024*1024||bootstrap.tls.key.length>128*1024)throw Error('SERVICE_TLS_INVALID');
    this.tls={cert:bootstrap.tls.cert,key:bootstrap.tls.key};
    if(!record(bootstrap.account)||!record(bootstrap.account.tokens)||typeof bootstrap.account.tokens.access_token!=='string'||typeof bootstrap.account.tokens.account_id!=='string')throw Error('SERVICE_ACCOUNT_INVALID');
    this.account=bootstrap.account;
    if(bootstrap.admin!==undefined){
      if(!record(bootstrap.admin)||!fields(bootstrap.admin,['username','password'])||typeof bootstrap.admin.username!=='string'||!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(bootstrap.admin.username)
        ||typeof bootstrap.admin.password!=='string'||bootstrap.admin.password.length<12||bootstrap.admin.password.length>256)throw Error('SERVICE_ADMIN_INVALID');
      this.admin={username:bootstrap.admin.username,password:bootstrap.admin.password};
    }
    // Remove all inherited mode overrides. The parent's DTO cannot inject env.
    for(const key of Object.keys(process.env))if(/^(PLATFORM_|TEST_GATEWAY_|CODEX_|NODE_OPTIONS|NODE_PATH)/.test(key))delete process.env[key];
    const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
    const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
    const mac=process.platform==='darwin';
    if(manifest.kind!=='central-gateway-candidate'||manifest.nativeWorker?.protocol!==(mac?'macos-seatbelt/v1':'windows-worker-host/v1'))throw Error('SERVICE_PACKAGE_INVALID');
    const binary=(name:string)=>join(root,'bin',name);
    Object.assign(process.env,{
      TEST_GATEWAY_HOST:this.config.listen.host,TEST_GATEWAY_PORT:String(this.config.listen.port),
      TEST_GATEWAY_STATE_FILE:join(this.config.dataDirectory,'gateway-state.json'),
      PLATFORM_AUTH_FILE:join(this.config.dataDirectory,'platform-auth.json'),
      PLATFORM_AUDIT_DIR:join(this.config.dataDirectory,'audit'),
      PLATFORM_WORKER_ROOT:join(this.config.dataDirectory,'workers'),
      PLATFORM_MODEL_BINDINGS:join(this.config.dataDirectory,'model-bindings.memory'),
      PLATFORM_DEVICE_AUTH_MODE:'device-token-v1',PLATFORM_WORKER_ISOLATION:mac?'macos-seatbelt-v1':'windows-appcontainer-v1',
      PLATFORM_WORKER_BINARY:binary(mac?'codex-app-server':'codex-app-server.exe'),PLATFORM_WORKER_BINARY_SHA256:manifest.nativeWorker.appServer.sha256,
      ...(mac?{
        PLATFORM_WORKER_PROFILE:join(root,'harness','worker-isolated.sb'),PLATFORM_WORKER_PROFILE_SHA256:manifest.nativeWorker.seatbeltProfile.sha256,
      }:{
        PLATFORM_WORKER_HOST_BINARY:binary('windows-worker-host.exe'),PLATFORM_WORKER_HOST_SHA256:manifest.nativeWorker.host.sha256,
        PLATFORM_NATIVE_HELPER_BINARY:binary('central-native-helper.exe'),PLATFORM_NATIVE_HELPER_SHA256:manifest.nativeWorker.privateFileHelper.sha256,
      }),
      PLATFORM_MAX_WORKERS:String(this.config.limits.maxWorkers),PLATFORM_USER_TURNS:String(this.config.limits.perUserTurns),PLATFORM_TOTAL_TURNS:String(this.config.limits.totalTurns),
    });
  }
  emit(event:'ready'|'stopped'|'failed',code?:string){
    return new Promise<void>((done,reject)=>process.stdout.write(JSON.stringify({method:'central/service',protocol,instanceId:this.instanceId,event,...(event==='ready'?{listening:true}:{}),...(code?{code}:{})})+'\n',error=>error?reject(Error('SERVICE_CONTROLLER_CLOSED')):done()));
  }
  startMetrics(read:()=>ServiceMetrics){
    if(this.stopRequested||this.metricsStopped||this.metricsEmitter)return;
    this.metricsEmitter=new ServiceMetricsEmitter(read,(sequence,metrics)=>new Promise<void>((done,reject)=>{
      process.stdout.write(JSON.stringify({method:'central/service',protocol,instanceId:this.instanceId,event:'metrics',sequence,metrics})+'\n',error=>error?reject(Error('SERVICE_CONTROLLER_CLOSED')):done());
    }),async code=>{
      // Invalid counts never become a false zero sample.
      try{if(code==='SERVICE_METRICS_INVALID')await this.emit('failed',code);}finally{this.stop();}
    });
    this.metricsEmitter.start();
  }
  stopMetrics(){this.metricsStopped=true;this.metricsEmitter?.stop();}
  async provision(auth:PlatformAuth){
    try{
      const users=auth.serviceUsers();
      if(!users.length){if(!this.admin)throw Error('SERVICE_ADMIN_REQUIRED');await auth.createUser(this.admin.username,this.admin.password,'admin');}
      else if(!users.some(user=>user.role==='admin'&&!user.disabled))throw Error('SERVICE_ADMIN_UNAVAILABLE');
    }finally{if(this.admin)this.admin.password='';this.admin=undefined;}
  }
  modelSource(auth:PlatformAuth):NonNullable<ModelCredentialBrokerOptions['memorySource']>{
    const reference=join(this.config.dataDirectory,'model-account.memory');
    return {
      readConfig:()=>({version:1,users:Object.fromEntries(auth.serviceUsers().map(user=>[user.id,{providerId:'native-default',enabled:!user.disabled}])),
        providers:{'native-default':{id:'native-default',kind:'chatgpt',credentialFile:reference}}}),
      readCredential:path=>{if(path!==reference)throw Error('SERVICE_ACCOUNT_REFERENCE_INVALID');return this.account;},
    };
  }
  bindStop(handler:()=>void){this.stopHandler=handler;if(this.stopRequested)handler();}
  get isStopping(){return this.stopRequested;}
  get serviceInstanceId(){return this.instanceId;}
  stop(){this.stopRequested=true;this.stopMetrics();this.stopHandler?.();}
  accept(value:unknown){if(!record(value)||!fields(value,['method','protocol','instanceId','command'])||value.method!=='central/service'||value.protocol!==protocol||value.instanceId!==this.instanceId||value.command!=='stop')throw Error('SERVICE_CONTROL_INVALID');this.stop();}
  clear(){this.stopMetrics();this.tls.key='';this.account={};}
}

export async function readNativeServiceHost():Promise<NativeServiceHost|undefined>{
  if(process.env.CENTRAL_SERVICE_HOST!=='1')return undefined;
  if(process.platform!=='win32'&&process.platform!=='darwin')throw Error('SERVICE_PLATFORM_UNSUPPORTED');
  return new Promise((done,reject)=>{
    let buffer:Buffer=Buffer.alloc(0),host:NativeServiceHost|undefined,failed=false;
    const deadline=setTimeout(()=>abort('SERVICE_BOOTSTRAP_TIMEOUT'),10000);
    const abort=(code:string)=>{if(failed)return;failed=true;clearTimeout(deadline);buffer.fill(0);buffer=Buffer.alloc(0);if(host){void host.emit('failed',code).catch(()=>{});host.stop();}else reject(Error(code));};
    process.stdin.on('data',(chunk:Buffer)=>{
      if(failed)return;
      if(buffer.length+chunk.length>2*1024*1024){abort('SERVICE_CONTROL_TOO_LARGE');return;}
      const previous=buffer;buffer=Buffer.concat([previous,chunk]);previous.fill(0);chunk.fill(0);
      let end:number;
      while((end=buffer.indexOf(10))>=0){
        const line=buffer.subarray(0,end);const remaining=Buffer.from(buffer.subarray(end+1));
        try{
          const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));
          if(!host){
            if(!record(value)||!fields(value,['method','protocol','instanceId','command','config'])||value.method!=='central/service'||value.protocol!==protocol||typeof value.instanceId!=='string'||!/^[a-f0-9]{32}$/.test(value.instanceId)||value.command!=='bootstrap'||!record(value.config))throw Error();
            host=new NativeServiceHost(value.instanceId,value.config);clearTimeout(deadline);done(host);
          }else host.accept(value);
        }catch{abort('SERVICE_CONTROL_INVALID');return;}
        finally{buffer.fill(0);buffer=remaining;}
      }
    });
    process.stdin.on('end',()=>{if(buffer.length)abort('SERVICE_CONTROL_TRUNCATED');if(host)host.stop();else abort('SERVICE_CONTROLLER_CLOSED');});
    process.stdin.on('error',()=>abort('SERVICE_CONTROLLER_CLOSED'));
  });
}
