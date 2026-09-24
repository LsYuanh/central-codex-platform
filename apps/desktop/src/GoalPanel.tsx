// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./platform-gateway-client";
import { t, useLocale, type MessageKey } from "./i18n";

const labels = {active:"目标进行中",paused:"目标已暂停",blocked:"目标遇到阻碍",usageLimited:"额度受限",budgetLimited:"目标预算已用尽",complete:"目标已完成"} as const satisfies Record<string,MessageKey>;
type Goal = {threadId:string;objective:string;status:keyof typeof labels;tokenBudget:number|null;tokensUsed:number;timeUsedSeconds:number};
function readGoal(value:unknown): Goal | null {
  if(value === null)return null;
  const g=value as Goal;
  if(!g||typeof g.threadId!=="string"||typeof g.objective!=="string"||!Object.hasOwn(labels,g.status)||!Number.isFinite(g.tokensUsed)||!Number.isFinite(g.timeUsedSeconds)||(g.tokenBudget!==null&&(!Number.isSafeInteger(g.tokenBudget)||g.tokenBudget<=0)))throw Error(t("目标状态格式不兼容"));
  return g;
}
export function GoalPanel({client,threadId,online,disabled,planMode,createThread,initialOpen=false}: {
  client:RpcClient|undefined;threadId?:string;online:boolean;disabled:boolean;planMode:boolean;createThread:()=>Promise<string>;initialOpen?:boolean;
}) {
  useLocale();
  const [goal,setGoal]=useState<Goal|null>(null),[open,setOpen]=useState(initialOpen),[objective,setObjective]=useState(""),[budget,setBudget]=useState("");
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState("");
  const revision=useRef(0),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;revision.current++;};},[]);
  const refresh=useCallback(async()=>{
    if(!threadId||!client||!online)return;
    const version=++revision.current;setLoading(true);setError("");
    try{const reply=await client.request("thread/goal/get",{threadId});if(version===revision.current)setGoal(readGoal((reply.result as {goal:unknown}).goal));}
    catch(e){if(version===revision.current)setError(String(e));}
    finally{if(mounted.current)setLoading(false);}
  },[client,threadId,online]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>client?.subscribe(message=>{
    const p=message.params as {threadId?:string;goal?:unknown}|undefined;
    if(!p||!threadId||p.threadId!==threadId)return;
    if(message.method!=="thread/goal/updated"&&message.method!=="thread/goal/cleared")return;
    revision.current++;
    try{setGoal(message.method.endsWith("cleared")?null:readGoal(p.goal));setError("");setLoading(false);}catch(e){setError(String(e));}
  }),[client,threadId]);
  const mutate=async(action:"set"|"clear",params:Record<string,unknown>)=>{
    if(!client||!threadId||!online||busy)return;
    setBusy(true);setError("");
    const version=++revision.current;
    try{
      const response=await client.request(`thread/goal/${action}`,{threadId,...params});
      if(mounted.current){if(version===revision.current)setGoal(action==="clear"?null:readGoal((response.result as {goal:unknown}).goal));setOpen(false);}
    }catch(e){if(mounted.current)setError(String(e));}
    finally{if(mounted.current)setBusy(false);}
  };
  const locked=disabled||busy||!online;
  const openEditor=async()=>{
    if(threadId){setObjective(goal?.objective??"");setBudget(goal?.tokenBudget?.toString()??"");setOpen(!open);return;}
    if(locked)return;
    setBusy(true);setError("");
    try{await createThread();}catch(e){if(mounted.current)setError(String(e));}
    finally{if(mounted.current)setBusy(false);}
  };
  return <section className="goal-panel" aria-label={t("对话目标")}>
    <div className="goal-summary">
      <button type="button" className="button-quiet" aria-expanded={open} onClick={()=>void openEditor()} disabled={busy||(!threadId&&locked)}>{goal?t(labels[goal.status]):t("设置目标")}</button>
      {goal&&<><span className="goal-objective" title={goal.objective}>{goal.objective}</span><small>{goal.tokensUsed.toLocaleString()} {goal.tokenBudget!==null?`/ ${goal.tokenBudget.toLocaleString()}`:""} tokens · {Math.floor(goal.timeUsedSeconds/60)} {t("分钟")}</small>
        {goal.status==="active"?<button type="button" disabled={busy||!online} onClick={()=>void mutate("set",{status:"paused"})}>{t("暂停目标")}</button>
          :goal.status==="budgetLimited"?<button type="button" disabled={locked} onClick={()=>void openEditor()}>{t("调整预算")}</button>
          :goal.status!=="complete"&&<button type="button" disabled={locked||planMode} onClick={()=>void mutate("set",{status:"active"})}>{t("继续目标")}</button>}</>}
      {threadId&&<button type="button" className="button-quiet" disabled={loading||busy||!online} onClick={()=>void refresh()}>{loading?t("读取中…"):t("刷新")}</button>}
    </div>
    {error&&<p className="task-control-error" role="alert">{error}</p>}
    {open&&<div className="goal-editor">
      <label>{t("目标与验收条件")}<textarea maxLength={4000} required value={objective} onChange={e=>setObjective(e.target.value)} disabled={locked} rows={3}/></label>
      <label>{t("Token 预算（可选）")}<input type="number" min={1} step={1} value={budget} onChange={e=>setBudget(e.target.value)} disabled={locked}/></label>
      <p>{planMode?t("请先开始实施计划，再启动目标。"):t("目标会跨轮持续执行；完成、暂停、遇阻或达到预算后停止。")}</p>
      <p>{t("预算用于限制自动续跑，当前轮收尾可能超出预算。")}</p>
      <div className="button-row"><button type="button" disabled={locked||planMode||!objective.trim()||(budget!==""&&(!Number.isSafeInteger(Number(budget))||Number(budget)<=0))} onClick={()=>void mutate("set",{objective:objective.trim(),status:"active",tokenBudget:budget?Number(budget):null})}>{busy?t("处理中…"):t("启动目标")}</button>
        {goal&&<button type="button" className="button-secondary" disabled={busy||!online} onClick={()=>void mutate("clear",{})}>{t("清除目标")}</button>}
        <button type="button" className="button-quiet" onClick={()=>setOpen(false)} disabled={busy}>{t("取消")}</button></div>
    </div>}
  </section>;
}
