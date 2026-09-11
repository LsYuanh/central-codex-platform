// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Public counts only: no identities, paths, model names or credentials.
export type ServiceMetrics = {onlineDevices:number;activeTurns:number;workers:number;readyWorkers:number;startingWorkers:number;stoppingWorkers:number};
type AgentSnapshot = {ready:boolean;socket:{readyState:number}};
type WorkerSnapshot = {pid?:number;alive:boolean;ready:boolean;starting:boolean;stopping:boolean;activeTurns:number};
const keys = ['onlineDevices','activeTurns','workers','readyWorkers','startingWorkers','stoppingWorkers'] as const;
const invalid = () => Error('SERVICE_METRICS_INVALID');
const count = (value:unknown):value is number => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

export function validateServiceMetrics(value:ServiceMetrics):ServiceMetrics {
  if(!value||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(key=>!count(value[key])))throw invalid();
  return value;
}
export function collectServiceMetrics(agents:Iterable<AgentSnapshot>,workers:Iterable<WorkerSnapshot>):ServiceMetrics {
  const result:ServiceMetrics={onlineDevices:0,activeTurns:0,workers:0,readyWorkers:0,startingWorkers:0,stoppingWorkers:0};
  for(const agent of agents){
    if(!agent||typeof agent.ready!=='boolean'||!agent.socket||!Number.isInteger(agent.socket.readyState)||agent.socket.readyState<0||agent.socket.readyState>3)throw invalid();
    // WebSocket.OPEN = 1; same ready + OPEN predicate as /healthz.
    if(agent.ready&&agent.socket.readyState===1)result.onlineDevices++;
  }
  for(const worker of workers){
    if(!worker||['alive','ready','starting','stopping'].some(key=>typeof worker[key as keyof WorkerSnapshot]!=='boolean')||!count(worker.activeTurns)||(worker.pid!==undefined&&(!count(worker.pid)||worker.pid===0)))throw invalid();
    // Transport.alive includes startup before a runtime PID is available.
    const running=worker.alive&&worker.pid!==undefined&&!worker.stopping;
    if(running)result.workers++;
    if(running&&worker.ready&&!worker.stopping)result.readyWorkers++;
    // States deliberately overlap: unresolved startup may be stopping, and a
    // cleanup-unverified stopping slot can have no live process anymore.
    if(worker.starting)result.startingWorkers++;
    if(worker.stopping)result.stoppingWorkers++;
    result.activeTurns+=worker.activeTurns;
  }
  return validateServiceMetrics(result);
}

type Clock={schedule:(callback:()=>void,delayMs:number)=>unknown;cancel:(handle:unknown)=>void};
const clock:Clock={schedule:(callback,delayMs)=>{const timer=setTimeout(callback,delayMs);timer.unref();return timer;},cancel:handle=>clearTimeout(handle as NodeJS.Timeout)};
export class ServiceMetricsEmitter {
  private sequence=0;
  private started=false;
  private stopped=false;
  private timer:unknown;
  constructor(
    private readonly read:()=>ServiceMetrics,
    private readonly write:(sequence:number,metrics:ServiceMetrics)=>Promise<void>,
    private readonly failed:(code:'SERVICE_METRICS_INVALID'|'SERVICE_CONTROLLER_CLOSED')=>Promise<void>,
    private readonly timing:Clock=clock,
  ){}
  start(){if(this.started||this.stopped)return;this.started=true;void this.tick();}
  stop(){this.stopped=true;if(this.timer!==undefined){this.timing.cancel(this.timer);this.timer=undefined;}}
  private async tick(){
    if(this.stopped)return;
    let sampled=false;
    try{
      if(this.sequence>=Number.MAX_SAFE_INTEGER)throw invalid();
      const metrics=validateServiceMetrics(this.read());sampled=true;
      await this.write(++this.sequence,metrics);
      // No queued samples while stdout is slow. A fresh 2s delay starts only
      // after the previous write callback has completed.
      if(!this.stopped)this.timer=this.timing.schedule(()=>{this.timer=undefined;void this.tick();},2000);
    }catch{
      if(this.stopped)return;
      this.stop();
      try{await this.failed(sampled?'SERVICE_CONTROLLER_CLOSED':'SERVICE_METRICS_INVALID');}catch{/* No unhandled rejection from shutdown. */}
    }
  }
}
