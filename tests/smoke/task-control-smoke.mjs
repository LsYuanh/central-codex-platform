// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerManager} from '../../services/central-gateway/dist/worker-manager.js';
import {collaborationMode,goalParams,planToolAllowed} from '../../services/central-gateway/dist/task-control.js';
const mode={mode:'plan',settings:{model:'fixture',reasoning_effort:null,developer_instructions:null}};
assert.equal(collaborationMode(mode),'plan');
assert.throws(()=>collaborationMode({...mode,settings:{...mode.settings,developer_instructions:'bypass'}}));
assert.throws(()=>collaborationMode({...mode,mode:'bypass'}));
for(const tool of ['device_exec','device_write_file','device_copy_file','device_publish_file','device_skill_draft','device_workspace_apply_patch'])assert(!planToolAllowed(tool),tool);
assert(planToolAllowed('device_workspace_read_text'));assert(planToolAllowed('conversation_read'));
for(const payload of [{threadId:'a',status:'complete'},{threadId:'a',objective:''},{threadId:'a',status:'active',tokenBudget:-1},{threadId:'a',status:'active',tokenBudget:1.1},{threadId:'a',objective:'ok',config:{}}])assert.throws(()=>goalParams(payload,'set'));
assert.equal(goalParams({threadId:'a',objective:'done',tokenBudget:null},'set').objective,'done');
let manager,bridge,modeFailure=false,delayed;
class Bridge {
  alive=true;enforcedRuntimeReady=true;pid=100;
  async request(method,p){
    if(method==='thread/goal/set'){
      if(modeFailure)throw Error('App Server request failed: rejected');
      if(p.status==='active')manager.notification('alice',this,{method:'thread/goal/cleared',params:{threadId:p.threadId}});
      manager.notification('alice',this,{method:'thread/goal/updated',params:{threadId:p.threadId,goal:{status:p.status}}});
      return {goal:{status:p.status}};
    }
    if(method==='turn/start')return await new Promise(resolve=>{delayed=()=>resolve({turn:{id:'manual'}});});
    return {};
  }
  close(){this.alive=false;}respond(){}
}
manager=new WorkerManager({root:mkdtempSync(join(tmpdir(),'goal-quota-')),perUser:true,maxWorkers:2,perUserTurns:1,totalTurns:1,maxRequests:4,idleMs:60000,cooldownMs:1,create:()=>bridge=new Bridge(),event:()=>{}});
const request=(method,p)=>manager.forUser('alice').request(method,p);
const notice=(method,params)=>manager.notification('alice',bridge,{method,params});
try{
  await request('thread/goal/set',{threadId:'a',status:'active'});
  assert(manager.hasGoal('alice','a'));assert.equal(manager.snapshot()[0].activeTurns,1);
  await assert.rejects(request('turn/start',{threadId:'b'}),/TURN_LIMIT/);
  notice('turn/started',{threadId:'a',turn:{id:'auto1'}});
  notice('turn/completed',{threadId:'a',turn:{id:'auto1',status:'completed'}});
  assert.equal(manager.snapshot()[0].activeTurns,1,'idle active goal keeps quota');
  notice('turn/started',{threadId:'a',turn:{id:'auto2'}});
  await request('thread/goal/set',{threadId:'a',status:'paused'});
  assert.equal(manager.snapshot()[0].activeTurns,1,'pausing cannot release a running turn');
  notice('turn/completed',{threadId:'a',turn:{id:'auto2',status:'interrupted'}});
  assert.equal(manager.snapshot()[0].activeTurns,0);
  modeFailure=true;await assert.rejects(request('thread/goal/set',{threadId:'a',status:'active'}),/rejected/);modeFailure=false;
  assert.equal(manager.snapshot()[0].activeTurns,0,'failed activation releases provisional quota');
  const start=request('turn/start',{threadId:'a'});await new Promise(r=>setImmediate(r));
  notice('thread/goal/updated',{threadId:'a',goal:{status:'active'}});
  notice('thread/goal/updated',{threadId:'a',goal:{status:'complete'}});
  assert.equal(manager.snapshot()[0].activeTurns,1,'goal completion before turn response retains pending admission');
  delayed();await start;
  notice('turn/completed',{threadId:'a',turn:{id:'manual',status:'completed'}});
  assert.equal(manager.snapshot()[0].activeTurns,0);
  notice('thread/goal/updated',{threadId:'foreign',goal:{status:'active'}});
  assert.equal(manager.snapshot()[0].stopping,true,'unadmitted native goal fails closed');
  console.log(JSON.stringify({ok:true,checks:['mode-validation','plan-tool-boundary','goal-validation','active-goal-quota','continuation-accounting','pause-vs-running-turn','activation-failure','early-completion-race','unadmitted-goal']}));
}finally{manager.close();}
