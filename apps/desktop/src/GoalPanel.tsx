// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./platform-gateway-client";
import { UiIcon } from "./UiIcon";
import { t, useLocale, type MessageKey } from "./i18n";

const labels = {active:"目标进行中",paused:"目标已暂停",blocked:"目标遇到阻碍",usageLimited:"额度受限",budgetLimited:"目标预算已用尽",complete:"目标已完成"} as const satisfies Record<string,MessageKey>;
export type Goal = {threadId:string;objective:string;status:keyof typeof labels;tokenBudget:number|null;tokensUsed:number;timeUsedSeconds:number};
export function readGoal(value:unknown): Goal | null {
  if(value === null)return null;
  const g=value as Goal;
  if(!g||typeof g.threadId!=="string"||typeof g.objective!=="string"||!Object.hasOwn(labels,g.status)||!Number.isFinite(g.tokensUsed)||!Number.isFinite(g.timeUsedSeconds)||(g.tokenBudget!==null&&(!Number.isSafeInteger(g.tokenBudget)||g.tokenBudget<=0)))throw Error(t("目标状态格式不兼容"));
  return g;
}
type Snapshot = {key:string;goal:Goal|null;busy:boolean;loading:boolean;error:string;observedAt:number};
export function useGoalControl({client,threadId,scope,online,disabled,planMode,enabled}: {
  client:RpcClient|undefined;threadId?:string;scope:string;online:boolean;disabled:boolean;planMode:boolean;enabled:boolean;
}) {
  useLocale();
  const key=JSON.stringify([scope,threadId]),current=useRef(key),revision=useRef(0);
  current.current=key;
  const [state,setState]=useState<Snapshot>({key,goal:null,busy:false,loading:false,error:"",observedAt:Date.now()});
  const [budgets,setBudgets]=useState<Record<string,string>>({});
  const snapshot=state.key===key?state:{key,goal:null,busy:false,loading:Boolean(threadId&&enabled),error:"",observedAt:Date.now()};
  const patch=useCallback((change:Partial<Snapshot>)=>{if(current.current===key)setState(old=>({...old,...(old.key!==key?{goal:null,busy:false,loading:false,error:""}:{}),...change,key}));},[key]);
  const refresh=useCallback(async()=>{
    if(!enabled||!threadId||!client||!online)return;
    const version=++revision.current;patch({loading:true,error:""});
    try{const reply=await client.request("thread/goal/get",{threadId});if(version===revision.current)patch({goal:readGoal((reply.result as {goal:unknown}).goal),observedAt:Date.now()});}
    catch(e){if(version===revision.current)patch({error:String(e)});}
    finally{if(version===revision.current)patch({loading:false});}
  },[client,threadId,online,enabled,patch]);
  useEffect(()=>{patch({error:"",busy:false,loading:false});void refresh();return()=>{revision.current++;};},[refresh,patch]);
  useEffect(()=>client?.subscribe(message=>{
    const p=message.params as {threadId?:string;goal?:unknown}|undefined;
    if(!enabled||!p||!threadId||p.threadId!==threadId)return;
    if(message.method!=="thread/goal/updated"&&message.method!=="thread/goal/cleared")return;
    revision.current++;
    try{patch({goal:message.method.endsWith("cleared")?null:readGoal(p.goal),observedAt:Date.now(),error:"",loading:false});}catch(e){patch({error:String(e),loading:false});}
  }),[client,threadId,enabled,patch]);
  const mutate=async(action:"set"|"clear",params:Record<string,unknown>)=>{
    if(!client||!threadId||!online||snapshot.busy)return false;
    patch({busy:true,error:""});const version=++revision.current;
    try{
      const response=await client.request(`thread/goal/${action}`,{threadId,...params});
      if(version===revision.current)patch({goal:action==="clear"?null:readGoal((response.result as {goal:unknown}).goal),observedAt:Date.now()});
      if(action==="clear"||"tokenBudget" in params)setBudgets(old=>{const next={...old};delete next[key];return next;});
      return current.current===key;
    }catch(e){patch({error:String(e)});return false;}
    finally{patch({busy:false});}
  };
  const budget=budgets[key]??snapshot.goal?.tokenBudget?.toString()??"";
  return {...snapshot,budget,locked:disabled||snapshot.busy||snapshot.loading||!online,planMode,online,threadId,refresh,mutate,
    setBudget:(value:string)=>setBudgets(old=>({...old,[key]:value}))};
}
export function GoalStatusBar({control:c,expanded,showDetails,close}:{control:ReturnType<typeof useGoalControl>;expanded:boolean;showDetails:()=>void;close:()=>void}) {
  useLocale();
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const {goal,budget,busy,loading,error,locked,planMode,online}=c;
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(goal?.status!=="active")return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[goal]);
  useEffect(()=>{
    if(!expanded)return;
    root.current?.querySelector<HTMLInputElement>('input')?.focus();
    const outside=(event:Event)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();close();trigger.current?.focus();}};
    document.addEventListener("keydown",escape);
    document.addEventListener("pointerdown",outside);document.addEventListener("focusin",outside);
    return()=>{document.removeEventListener("keydown",escape);document.removeEventListener("pointerdown",outside);document.removeEventListener("focusin",outside);};
  },[expanded,close]);
  if(!goal&&!error)return null;
  const collapse=()=>{close();trigger.current?.focus();};
  const seconds=Math.floor((goal?.timeUsedSeconds??0)+(goal?.status==="active"?Math.max(0,now-c.observedAt)/1000:0));
  return <div className="goal-status" ref={root} onKeyDown={event=>{if(event.key==="Escape"&&expanded){event.preventDefault();event.stopPropagation();collapse();}if(event.key==="Enter"&&event.target instanceof HTMLInputElement)event.preventDefault();}}>
    <div className="goal-status-bar">
      <button ref={trigger} type="button" className="goal-status-summary" aria-expanded={expanded} title={error||goal?.objective} onClick={()=>expanded?collapse():showDetails()}><UiIcon name="goal"/><strong aria-live="polite">{error?t("目标·需核对"):t(labels[goal!.status])}</strong><span className="goal-objective">{goal?.objective}</span>{goal&&<small>{seconds}s</small>}</button>
      {goal&&<>
        <button type="button" className="goal-icon-button" aria-label={t("清除目标")} title={t("清除目标")} disabled={busy||!online} onClick={()=>void c.mutate("clear",{}).then(ok=>{if(ok)close();})}><UiIcon name="trash"/></button>
        {goal.status!=="complete"&&<button type="button" className="goal-icon-button" aria-label={t(goal.status==="active"?"暂停目标":"继续目标")} title={t(goal.status==="active"?"暂停目标":"继续目标")} disabled={goal.status==="active"?busy||!online:locked||planMode||goal.status==="budgetLimited"} onClick={()=>void c.mutate("set",{status:goal.status==="active"?"paused":"active"})}><UiIcon name={goal.status==="active"?"pause":"play"}/></button>}
      </>}
      <button type="button" className="goal-icon-button" aria-label={t(expanded?"收起目标":"展开目标")} title={t(expanded?"收起目标":"展开目标")} onClick={()=>expanded?collapse():showDetails()}><UiIcon name={expanded?"chevronDown":"expand"}/></button>
    </div>
    {expanded&&<section className="goal-panel" role="region" aria-label={t("对话目标")}>
      {error&&<p className="task-control-error" role="alert">{error}</p>}
      {goal&&<div className="goal-editor"><p className="goal-detail-objective">{goal.objective}</p><small>{goal.tokensUsed.toLocaleString()}{goal.tokenBudget!==null?` / ${goal.tokenBudget.toLocaleString()}`:""} tokens · {Math.floor(goal.timeUsedSeconds/60)} {t("分钟")}</small>
        <label>{t("Token 预算（可选）")}<input type="number" min={1} step={1} value={budget} onChange={e=>c.setBudget(e.target.value)} disabled={locked||goal.status==="complete"}/></label>
        <p>{t("预算用于限制自动续跑，当前轮收尾可能超出预算。")}</p>
        {planMode&&<p>{t("请先开始实施计划，再启动目标。")}</p>}
        <div className="button-row"><button type="button" disabled={locked||goal.status==="complete"||(budget!==""&&(!Number.isSafeInteger(Number(budget))||Number(budget)<=0))} onClick={()=>void c.mutate("set",{tokenBudget:budget?Number(budget):null,status:goal.status==="active"?"active":"paused"})}>{t("调整预算")}</button></div>
      </div>}
      <button type="button" className="button-quiet" disabled={loading||busy||!online} onClick={()=>void c.refresh()}>{loading?t("读取中…"):t("刷新")}</button>
    </section>}
  </div>;
}
