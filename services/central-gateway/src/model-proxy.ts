// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import http from 'node:http';
import https from 'node:https';
import {BlockList, isIP} from 'node:net';
import type {Duplex} from 'node:stream';

export type ModelProxy = {httpProxy?:string;httpsProxy?:string;noProxy?:string};
/** This DTO comes only from the native parent's private bootstrap, never a Worker or renderer. */
export function validateModelProxy(value:unknown):ModelProxy {
  const fail=():never=>{throw Error('MODEL_PROXY_CONFIG_INVALID');};
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['httpProxy','httpsProxy','noProxy'].includes(k)))return fail();
  for(const key of ['httpProxy','httpsProxy'])if(v[key]!==undefined){
    if(typeof v[key]!=='string'||v[key].length>4096||/[\x00-\x1f\x7f]/.test(v[key]))return fail();
    let url:URL;try{url=new URL(v[key]);}catch{return fail();}
    if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.pathname!=='/'||url.search||url.hash)return fail();
  }
  if(v.noProxy!==undefined&&(typeof v.noProxy!=='string'||v.noProxy.length>16384||/[\x00-\x1f\x7f<>]/.test(v.noProxy)))return fail();
  return {...v} as ModelProxy;
}

/** Match reqwest's host/domain/IP/CIDR exclusions; Node's NO_PROXY lacks CIDR support. */
export function bypassModelProxy(url:URL, noProxy:string|undefined):boolean {
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  return (noProxy??'').split(',').some(raw=>{
    const rule=raw.trim().toLowerCase();
    if(!rule)return false;
    if(rule==='*')return true;
    const [address,prefix]=rule.split('/');
    if(prefix!==undefined){
      const family=isIP(address!);if(!family||family!==isIP(host)||!/^\d+$/.test(prefix))return false;
      try{const list=new BlockList();list.addSubnet(address!,Number(prefix),family===6?'ipv6':'ipv4');return list.check(host,family===6?'ipv6':'ipv4');}catch{return false;}
    }
    const domain=rule.replace(/^\[|\]$/g,'').replace(/^\./,'');
    return host===domain||host.endsWith('.'+domain);
  });
}

/** Dedicated agents keep proxy settings out of global networking and Worker environments. */
export class ModelTransport {
  private readonly proxy:ModelProxy;
  private readonly active=new Set<()=>void>();
  constructor(proxy:ModelProxy={}){
    this.proxy=validateModelProxy(proxy);
  }
  agent(url:URL,signal?:AbortSignal):http.Agent{
    const direct=bypassModelProxy(url,this.proxy.noProxy);
    const proxyEnv=direct?{}:{HTTP_PROXY:this.proxy.httpProxy,HTTPS_PROXY:this.proxy.httpsProxy,NO_PROXY:''};
    const options={keepAlive:false,proxyEnv,timeout:15_000};
    const agent=url.protocol==='https:'?new https.Agent(options):new http.Agent(options);
    // Node 24 does not register a CONNECT socket in agent.sockets until the
    // tunnel succeeds. Track the returned socket too, or cancellation leaks it.
    let socket:Duplex|undefined;
    const dispose=()=>{signal?.removeEventListener('abort',abort);this.active.delete(dispose);socket?.destroy();agent.destroy();};
    const abort=()=>{socket?.destroy(Object.assign(new Error('Model request cancelled'),{code:'ABORT_ERR'}));dispose();};
    const create=agent.createConnection;
    agent.createConnection=(connectionOptions,callback)=>{
      try{
        const result=create.call(agent,connectionOptions,callback);
        if(result){socket=result;socket.once('close',dispose);if(signal?.aborted)abort();}
        return result;
      }catch(error){dispose();throw error;}
    };
    this.active.add(dispose);signal?.addEventListener('abort',abort,{once:true});
    return agent;
  }
  close(){for(const dispose of this.active)dispose();}
}
