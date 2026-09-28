// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./platform-gateway-client";
import { UiIcon } from "./UiIcon";
import { t, useLocale, type MessageKey } from "./i18n";

const labels = {active:"目标进行中",paused:"目标已暂停",blocked:"目标遇到阻碍",usageLimited:"额度受限",budgetLimited:"目标已暂停",complete:"目标已完成"} as const satisfies Record<string,MessageKey>;
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
  const [drafts,setDrafts]=useState<Record<string,{text:string;base:string}>>({});
  const operation=useRef(false),cancelVersion=useRef(0),clientRef=useRef(client);
  clientRef.current=client;
  const cancelSave=useCallback(()=>{cancelVersion.current++;},[]);
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
    if(!client||!threadId||!online||operation.current)return false;
    operation.current=true;patch({busy:true,error:""});const version=++revision.current;
    try{
      const response=await client.request(`thread/goal/${action}`,{threadId,...params});
      if(version===revision.current)patch({goal:action==="clear"?null:readGoal((response.result as {goal:unknown}).goal),observedAt:Date.now()});
      if(action==="clear")setDrafts(old=>{const next={...old};delete next[key];return next;});
      return current.current===key;
    }catch(e){patch({error:String(e)});return false;}
    finally{operation.current=false;patch({busy:false});}
  };
  const draft=drafts[key];
  const objective=draft?.text??snapshot.goal?.objective??"";
  const dirty=objective!==(snapshot.goal?.objective??"");
  const discard=()=>setDrafts(old=>{const next={...old};delete next[key];return next;});
  const save=async()=>{
    if(!client||!threadId||!online||disabled||operation.current||snapshot.loading||!dirty||!objective.trim())return;
    if(Array.from(objective.trim()).length>4000){patch({error:t("目标不能超过 4000 个字符；草稿已保留。")});return;}
    operation.current=true;patch({busy:true,error:""});
    const cancellation=cancelVersion.current;
    const check=()=>{if(current.current!==key||clientRef.current!==client||cancelVersion.current!==cancellation)throw Error(t("目标保存已停止，草稿已保留。"));};
    const request=async(action:"get"|"set",params:Record<string,unknown>={})=>{
      check();const version=++revision.current;
      const response=await client.request(`thread/goal/${action}`,{threadId,...params});
      check();const goal=readGoal((response.result as {goal:unknown}).goal);
      if(version===revision.current)patch({goal,observedAt:Date.now()});
      return goal;
    };
    try{
      // Check the latest remote state before writing; preserve edits on conflicts.
      const latest=await request("get"),text=objective.trim();
      if(!latest)throw Error(t("目标已被清除，编辑内容已保留。"));
      if(latest.objective===text){discard();return;}
      if(latest.objective!==(draft?.base??snapshot.goal?.objective))throw Error(t("目标已在其他位置修改，请撤销修改以载入最新目标。"));
      const resume=latest.status==="active";
      if(resume){
        if(planMode)throw Error(t("请先开始实施计划，再启动目标。"));
        await request("set",{status:"paused"});
      }
      // Persist while paused; a failed save must not resume the old objective.
      await request("set",{objective:text,status:"paused",tokenBudget:null});
      if(resume)await request("set",{status:"active",tokenBudget:null});
      discard();
    }catch(e){patch({error:String(e)});}
    finally{operation.current=false;patch({busy:false});}
  };
  return {...snapshot,objective,dirty,locked:disabled||snapshot.busy||snapshot.loading||!online,planMode,online,threadId,refresh,mutate,save,cancelSave,discard,
    setObjective:(text:string)=>setDrafts(old=>({...old,[key]:{text,base:old[key]?.base??snapshot.goal?.objective??""}}))};
}

export function GoalStatusBar({control:c,expanded,showDetails,close}:{control:ReturnType<typeof useGoalControl>;expanded:boolean;showDetails:()=>void;close:()=>void}) {
  useLocale();
  const trigger=useRef<HTMLButtonElement>(null);
  const {goal,busy,error,locked,planMode,online}=c;
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(goal?.status!=="active")return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[goal]);
  if(!goal&&!error)return null;
  const collapse=()=>{close();trigger.current?.focus();};
  const seconds=Math.floor((goal?.timeUsedSeconds??0)+(goal?.status==="active"?Math.max(0,now-c.observedAt)/1000:0));
  return <div className="goal-status">
    <div className="goal-status-bar">
      <button ref={trigger} type="button" className="goal-status-summary" aria-expanded={expanded} title={error||goal?.objective} onClick={()=>expanded?collapse():showDetails()}><UiIcon name="goal"/><strong aria-live="polite">{error?t("目标·需核对"):t(labels[goal!.status])}</strong><span className="goal-objective">{goal?.objective}</span>{goal&&<small>{seconds}s</small>}</button>
      {goal&&<>
        <button type="button" className="goal-icon-button" aria-label={t("清除目标")} title={t("清除目标")} disabled={busy||!online} onClick={()=>void c.mutate("clear",{}).then(ok=>{if(ok)close();})}><UiIcon name="trash"/></button>
        {goal.status!=="complete"&&<button type="button" className="goal-icon-button" aria-label={t(goal.status==="active"?"暂停目标":"继续目标")} title={t(goal.status==="active"?"暂停目标":"继续目标")} disabled={goal.status==="active"?busy||!online:locked||planMode} onClick={()=>void c.mutate("set",{status:goal.status==="active"?"paused":"active",...(goal.status!=="active"?{tokenBudget:null}:{})})}><UiIcon name={goal.status==="active"?"pause":"play"}/></button>}
      </>}
      <button type="button" className="goal-icon-button" aria-label={t(expanded?"收起目标":"展开目标")} title={t(expanded?"收起目标":"展开目标")} onClick={()=>expanded?collapse():showDetails()}><UiIcon name={expanded?"chevronDown":"expand"}/></button>
    </div>
  </div>;
}

export function GoalEditorPanel({control:c,compact,close}:{control:ReturnType<typeof useGoalControl>;compact:boolean;close:()=>void}) {
  useLocale();
  const root=useRef<HTMLElement>(null),editor=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null,panel=root.current;
    (editor.current?.disabled?root.current?.querySelector<HTMLButtonElement>("button"):editor.current)?.focus();
    return()=>{if(previous?.isConnected&&(panel?.contains(document.activeElement)||document.activeElement===document.body))previous.focus();};
  },[]);
  useEffect(()=>{if(compact&&!root.current?.contains(document.activeElement))editor.current?.focus();},[compact]);
  const {goal,error,objective,dirty,busy,locked}=c;
  return <aside ref={root} className="goal-editor-panel" role={compact?"dialog":"region"} aria-modal={compact?true:undefined} aria-label={t("编辑目标")} onKeyDown={event=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();close();}
    if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){event.preventDefault();void c.save();}
    if(event.key==="Tab"&&compact){
      const items=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled)')??[]),first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}>
    <header className="goal-editor-heading"><span><UiIcon name="goal"/>{t("编辑目标")}</span><button type="button" className="text-icon-button" aria-label={t("关闭目标编辑器")} title={t("关闭目标编辑器")} onClick={close}><UiIcon name="close"/></button></header>
    <div className="goal-editor-toolbar"><small role="status">{busy?t("保存中…"):dirty?t("未保存的修改"):t("已同步目标")}</small><button type="button" className="text-icon-button" aria-label={t("撤销修改")} title={t("撤销修改")} disabled={busy||!dirty} onClick={()=>{c.discard();editor.current?.focus();}}><UiIcon name="undo"/></button><button type="button" className="goal-save-button" disabled={locked||!goal||!dirty||!objective.trim()||Array.from(objective.trim()).length>4000} onClick={()=>void c.save()}>{t("保存")}</button></div>
    {error&&<p className="task-control-error" role="alert">{error}</p>}
    {!goal&&!c.loading&&<p className="goal-editor-notice">{t("目标已被清除，编辑内容已保留。")}</p>}
    <textarea ref={editor} aria-label={t("目标与验收条件")} value={objective} onChange={event=>c.setObjective(event.target.value)} disabled={busy} spellCheck={false}/>
    <footer><small>{goal?`${goal.tokensUsed.toLocaleString()} tokens · ${Math.floor(goal.timeUsedSeconds/60)} ${t("分钟")}`:""}</small><button type="button" className="button-quiet" disabled={busy||c.loading||!c.online} onClick={()=>void c.refresh()}>{c.loading?t("读取中…"):t("刷新")}</button></footer>
  </aside>;
}
