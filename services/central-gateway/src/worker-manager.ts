// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type WorkerMessage = Record<string, unknown> & {id?: number|string; method?: string; params?: unknown};
export interface WorkerBridge {
  request(method:string, params:unknown):Promise<unknown>;
  respond(id:number|string, result:unknown):void;
  close(idle?:boolean):void;
  readonly enforcedRuntimeReady:boolean;
  readonly alive:boolean;
  readonly pid:number|undefined;
  /** Resolves only after owned process cleanup is verified; rejection means cleanup is unknown. */
  readonly closed?:Promise<void>;
}
type ActiveTurn = {id?:string; completedBeforeResponse:Set<string>};
type Worker = {userId:string; bridge?:WorkerBridge; starting?:Promise<WorkerBridge>; cancelStart?:()=>void; startTimer?:NodeJS.Timeout; stopping:boolean; exitConfirmed?:boolean; calls:number; touched:number; turns:Map<string,ActiveTurn>};
type Options = {
  root:string; perUser:boolean; maxWorkers:number; perUserTurns:number; totalTurns:number; maxRequests:number; idleMs:number; cooldownMs:number;
  create:(userId:string|undefined, paths:{home:string; directory:string}|undefined)=>WorkerBridge|Promise<WorkerBridge>;
  /** Maximum time a bridge factory may remain unresolved; timed out startup keeps its slot until exit. */
  startTimeoutMs?:number;
  /** Native host must create and validate per-user directories before launching. */
  nativeManagedPaths?:boolean;
  event:(action:string,userId:string,status:"started"|"succeeded"|"failed",code?:string)=>void;
};
const record = (v:unknown):v is Record<string,unknown> => !!v && typeof v==="object" && !Array.isArray(v);
/** Process/directory separation only: this is not an OS security boundary. */
export class WorkerManager {
  private readonly workers=new Map<string,Worker>();
  private readonly retryAfter=new Map<string,number>();
  private closed=false;
  private updateQuiesced=false;
  private readonly exitWaiters=new Set<()=>void>();
  private readonly timer:NodeJS.Timeout;
  private readonly startTimeout:number;
  constructor(private options:Options){
    this.startTimeout=options.startTimeoutMs??30_000;
    if(!Number.isSafeInteger(this.startTimeout)||this.startTimeout<100||this.startTimeout>300_000)throw Error("WORKER_START_TIMEOUT_INVALID");
    this.timer=setInterval(()=>this.reap(),Math.min(1000,options.idleMs));this.timer.unref();
    if(!options.perUser)this.get("legacy");
  }
  private key(userId:string){return this.options.perUser?userId:"legacy";}
  private get(userId:string):Worker{
    if(this.closed)throw Error("WORKER_MANAGER_UNAVAILABLE: execution stopped; repair and restart gateway");
    const key=this.key(userId),existing=this.workers.get(key);
    if(existing&&!existing.stopping&&(!this.options.perUser||existing.starting||existing.bridge?.alive)){existing.touched=Date.now();return existing;}
    // Do not overlap a terminated process with its replacement until exit is observed.
    if(existing)throw Error("WORKER_STOPPING: retry after the previous process exits");
    if((this.retryAfter.get(key)??0)>Date.now())throw Error("WORKER_RESTART_BACKOFF: retry shortly; previous operation was not replayed");
    if(this.workers.size>=this.options.maxWorkers){this.reap();if(this.workers.size>=this.options.maxWorkers)throw Error("WORKER_CAPACITY: all worker slots are occupied; retry later");}
    let paths:{home:string;directory:string}|undefined;
    if(this.options.perUser){
      const root=resolve(this.options.root),base=join(root,createHash("sha256").update(userId).digest("hex"));
      for(const directory of (this.options.nativeManagedPaths?[]:[root,base,join(base,"home"),join(base,"runtime")])){
        mkdirSync(directory,{recursive:true,mode:0o700});
        if(lstatSync(directory).isSymbolicLink()||realpathSync(directory)!==directory)throw Error("WORKER_PATH_UNSAFE");
      }
      paths={home:join(base,"home"),directory:join(base,"runtime")};
    }
    this.options.event("worker.start",key,"started");
    let resolveStart!:(bridge:WorkerBridge)=>void,rejectStart!:(error:unknown)=>void;
    const starting=new Promise<WorkerBridge>((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;});
    // Eager legacy construction or a cancelled startup may have no waiter yet.
    void starting.catch(()=>{});
    const worker:Worker={userId:key,starting,stopping:false,calls:0,touched:Date.now(),turns:new Map(),
      cancelStart:()=>rejectStart(Error("WORKER_STOPPING: startup cancelled; operation was not sent"))};
    // Reserve before invoking an async factory: both capacity and same-user
    // single-flight admission include workers whose bridge does not exist yet.
    this.workers.set(key,worker);
    worker.startTimer=setTimeout(()=>{
      if(!worker.starting||worker.stopping)return;
      worker.stopping=true;
      this.options.event("worker.start",key,"failed","WORKER_START_TIMEOUT");
      worker.cancelStart?.();
    },this.startTimeout);
    worker.startTimer.unref();
    const failed=(error:unknown)=>{
      // Factories may reject only after proving that no owned process remains.
      if(worker.startTimer)clearTimeout(worker.startTimer);
      worker.startTimer=undefined;
      rejectStart(error);worker.starting=undefined;worker.cancelStart=undefined;
      if(this.workers.get(key)===worker)this.workers.delete(key);
      this.changed();
    };
    const created=(bridge:WorkerBridge)=>{
      if(worker.startTimer)clearTimeout(worker.startTimer);
      worker.startTimer=undefined;
      worker.bridge=bridge;worker.starting=undefined;worker.cancelStart=undefined;
      // A promise replays an exit that happened before factory registration.
      if(bridge.closed)void bridge.closed.then(()=>this.exited(userId,bridge),()=>{
        if(this.workers.get(key)!==worker)return;
        worker.stopping=true;worker.cancelStart?.();
        try{this.options.event("worker.exit",key,"failed","WORKER_CLEANUP_UNVERIFIED");}catch{/* Do not lose the stopping slot if audit storage fails. */}
        this.changed();
      });
      if(this.closed||worker.stopping||this.workers.get(key)!==worker){
        worker.stopping=true;rejectStart(Error("WORKER_STOPPING: startup cancelled; operation was not sent"));
        // Retain the slot until the existing bridge-identity exited callback.
        // Factory resolution and close() alone do not prove process termination.
        bridge.close();return;
      }
      resolveStart(bridge);
    };
    try{
      const result=this.options.create(this.options.perUser?userId:undefined,paths);
      if(typeof (result as Promise<WorkerBridge>).then==="function"){
        void Promise.resolve(result).then(created,failed).catch(error=>{
          // A late bridge's close failure leaves a stopping slot, never a
          // replacement process. Creation failures have already released theirs.
          rejectStart(error);
        });
      }else created(result as WorkerBridge);
    }catch(error){
      if(worker.bridge){worker.stopping=true;rejectStart(error);}else failed(error);
      throw error;
    }
    return worker;
  }
  forUser(userId:string){return {request:(method:string,params:unknown)=>this.request(userId,method,params)};}
  private async request(userId:string,method:string,params:unknown):Promise<unknown>{
    if(this.updateQuiesced)throw Error('CENTRAL_UPDATING: reconnect after the central runtime update');
    const w=this.get(userId);
    if(w.calls>=this.options.maxRequests)throw Error("WORKER_REQUEST_LIMIT: too many pending requests");
    const tid=record(params)&&typeof params.threadId==="string"?params.threadId:undefined;
    let reserved:ActiveTurn|undefined;
    if(this.options.perUser&&method==="turn/start"&&tid){
      if(w.turns.has(tid))throw Error("THREAD_BUSY: an active or unknown turn must be reconciled before starting another");
      const total=[...this.workers.values()].reduce((n,w)=>n+w.turns.size,0);
      if(w.turns.size>=this.options.perUserTurns||total>=this.options.totalTurns){this.options.event("worker.quota",w.userId,"failed","TURN_LIMIT");throw Error("TURN_LIMIT: active turn quota reached; stop or wait for an existing turn");}
      reserved={completedBeforeResponse:new Set()};w.turns.set(tid,reserved);
    }
    w.calls++;
    try{
      const bridge=w.bridge??await w.starting!;
      const assertCurrent=()=>{if(this.closed||w.stopping||this.workers.get(this.key(userId))!==w)throw Error("WORKER_STOPPING: operation was not sent");};
      assertCurrent();
      // Fresh/restarted processes can initialize for read/recovery requests. Never replay the failed request.
      if(this.options.perUser&&method!=="initialize"&&!bridge.enforcedRuntimeReady)await bridge.request("initialize",{clientInfo:{name:"yuan-worker-manager",version:"1"},capabilities:{experimentalApi:true}});
      assertCurrent();
      const result=await bridge.request(method,params);
      if(reserved&&tid&&w.turns.get(tid)===reserved&&record(result)&&record(result.turn)&&typeof result.turn.id==="string"){
        reserved.id=result.turn.id;
        if(reserved.completedBeforeResponse.has(reserved.id))w.turns.delete(tid);
        reserved.completedBeforeResponse.clear();
      }
      const active=tid?w.turns.get(tid):undefined;
      if(tid&&["thread/read","thread/resume"].includes(method)&&active?.id&&record(result)&&record(result.thread)&&Array.isArray(result.thread.turns)){
        const turn=result.thread.turns.find(t=>record(t)&&t.id===active.id);
        if(record(turn)&&["completed","failed","interrupted"].includes(String(turn.status)))w.turns.delete(tid);
      }
      return result;
    }catch(error){
      // A timeout may have started work. Retain its slot until terminal event or worker exit.
      if(reserved&&tid&&w.turns.get(tid)===reserved&&!/timeout|unknown/i.test(String(error)))w.turns.delete(tid);
      throw error;
    }finally{w.calls--;w.touched=Date.now();}
  }
  notification(userId:string|undefined,bridge:WorkerBridge,message:WorkerMessage){
    const key=this.key(userId??"legacy"),w=this.workers.get(key);
    if(!w||w.bridge!==bridge)return;
    const p=record(message.params)?message.params:{};
    if(message.method==="turn/completed"&&typeof p.threadId==="string"&&record(p.turn)&&typeof p.turn.id==="string"){
      const active=w.turns.get(p.threadId);
      if(active?.id===p.turn.id)w.turns.delete(p.threadId);
      else if(active&&!active.id){
        // A previous Turn can finish late while a new start still awaits its ID.
        // Retain the reservation until the start response identifies a matching completion.
        active.completedBeforeResponse.add(p.turn.id);
        if(active.completedBeforeResponse.size>256)active.completedBeforeResponse.delete(active.completedBeforeResponse.values().next().value!);
      }
    }
    if(message.method==="gateway/runtimeUnavailable"){
      w.turns.clear();this.options.event("worker.exit",key,"failed","RUNTIME_UNAVAILABLE");
    }
    w.touched=Date.now();
  }
  exited(userId:string|undefined,bridge:WorkerBridge){
    const key=this.key(userId??"legacy");
    const worker=this.workers.get(key);
    if(worker?.bridge!==bridge)return;
    worker.exitConfirmed=true;
    if(this.options.perUser){this.workers.delete(key);this.retryAfter.set(key,Date.now()+this.options.cooldownMs);}
    this.changed();
  }
  private reap(){
    for(const [key,until] of this.retryAfter)if(until<=Date.now())this.retryAfter.delete(key);
    if(!this.options.perUser)return;
    for(const w of this.workers.values())if(!w.stopping&&w.bridge?.alive&&!w.calls&&!w.turns.size&&Date.now()-w.touched>=this.options.idleMs){this.options.event("worker.idle_stop",w.userId,"succeeded");this.stop(w,true);}
  }
  hasActiveThreads(matches:(threadId:string)=>boolean){return [...this.workers.values()].some(w=>[...w.turns.keys()].some(matches));}
  snapshot(){return [...this.workers.values()].map(w=>({userId:w.userId,pid:w.bridge?.pid,ready:!w.stopping&&(w.bridge?.enforcedRuntimeReady??false),alive:w.bridge?.alive??false,starting:!!w.starting,stopping:w.stopping,pendingRequests:w.calls,activeTurns:w.turns.size}));}
  /** Check and close admission in one event-loop turn; polling metrics is insufficient. */
  quiesceIfIdle(){
    if(this.closed||[...this.workers.values()].some(w=>w.starting||w.stopping||w.calls||w.turns.size))return false;
    this.updateQuiesced=true;return true;
  }
  get enforcedRuntimeReady(){const entries=[...this.workers.values()];return entries.length>0&&entries.every(w=>!w.stopping&&w.bridge?.enforcedRuntimeReady);}
  private stop(w:Worker,idle=false){if(w.stopping)return;w.stopping=true;if(w.startTimer)clearTimeout(w.startTimer);w.startTimer=undefined;w.cancelStart?.();w.bridge?.close(idle);}
  stopUser(userId:string){const w=this.workers.get(this.key(userId));if(w)this.stop(w);}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);for(const w of this.workers.values()){
    try{this.stop(w);}catch{/* Keep every failed stop reserved and continue stopping the others. */}
  }}
  private changed(){for(const notify of this.exitWaiters)notify();}
  /** Closing a bridge is not exit evidence. A deadline never frees a stopping slot. */
  drain(timeoutMs=20_000):Promise<void>{
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000)return Promise.reject(Error("WORKER_SHUTDOWN_TIMEOUT_INVALID"));
    this.close();
    return new Promise((resolve,reject)=>{
      const finish=()=>{if([...this.workers.values()].some(w=>!w.exitConfirmed))return;clearTimeout(timer);this.exitWaiters.delete(finish);resolve();};
      const timer=setTimeout(()=>{this.exitWaiters.delete(finish);reject(Error("WORKER_SHUTDOWN_TIMEOUT: process cleanup remains unverified"));},timeoutMs);
      this.exitWaiters.add(finish);finish();
    });
  }
}

export function workerLimit(name:string,fallback:number,min=1,max=1000){const raw=process.env[name];if(raw===undefined)return fallback;const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`Invalid ${name}`);return n;}
