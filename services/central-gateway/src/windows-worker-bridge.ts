// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type {WorkerBridge,WorkerMessage} from './worker-manager.js';
import {WindowsWorkerTransport,type WindowsWorkerTransportOptions} from './windows-worker-transport.js';

/** Marker admission remains independent of native process readiness. */
export class WindowsWorkerBridge implements WorkerBridge {
  private readonly transport:WindowsWorkerTransport;
  private initialized=false;
  private initializedResult:unknown;
  private initializing:Promise<unknown>|undefined;
  readonly closed:Promise<void>;
  constructor(options:WindowsWorkerTransportOptions,private readonly checkModelAccess:()=>void){
    this.transport=new WindowsWorkerTransport(options);
    this.closed=this.transport.closed;
  }
  get alive(){return this.transport.alive;}
  get pid(){return this.transport.pid;}
  get enforcedRuntimeReady(){return this.initialized&&this.alive;}
  subscribe(listener:(message:WorkerMessage)=>void){return this.transport.subscribe(listener);}
  request(method:string,params:unknown):Promise<unknown>{
    if(['turn/start','turn/steer'].includes(method)){
      try{this.checkModelAccess();}catch(error){return Promise.reject(error);}
    }
    if(method==='initialize'){
      if(this.initialized)return Promise.resolve(this.initializedResult);
      if(this.initializing)return this.initializing;
      this.initializing=this.transport.request(method,params).then(result=>{
        if(!result||typeof result!=='object'||!('userAgent' in result)||typeof result.userAgent!=='string'||!result.userAgent.includes('yuan-zhou-remote-workspace/1')){
          this.transport.close();throw Error('REMOTE_HARNESS_REQUIRED: pinned remote-workspace runtime required');
        }
        this.initialized=true;this.initializedResult=result;return result;
      }).finally(()=>{this.initializing=undefined;});
      return this.initializing;
    }
    if(!this.initialized)return Promise.reject(Error('REMOTE_HARNESS_NOT_READY: initialize the enforced runtime first'));
    return this.transport.request(method,params);
  }
  respond(id:number|string,result:unknown){if(this.alive)this.transport.write({id,result});}
  close(idle=false){this.transport.close(idle);}
}
