// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale, message as uiMessage, errorMessage, useMessageState } from "./i18n";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "./native-invoke";
import { isTauri } from "@tauri-apps/api/core";
import { UiIcon } from "./UiIcon";
import { folderName, type ClientProject, type ProjectDraft } from "./projects";
import type { ThreadSummary } from "./gateway-ui-events";

type Preferences = Record<string,{collapsed?:boolean;pinned?:boolean}>;
export function ProjectSidebar({ scope, projects, threads, activeProjectId, disabled, loading, error, unavailable, refresh, save, remove, newThread, renderThread, groupFor, dropGroup, dragging }: {
  scope:string; projects:ClientProject[]; threads:ThreadSummary[]; activeProjectId?:string;
  disabled:boolean; loading:boolean; error:string; unavailable:string;
  refresh:()=>Promise<void>; save:(p:ProjectDraft)=>Promise<ClientProject>; remove:(p:ClientProject)=>Promise<void>;
  newThread:(p:ClientProject)=>void; renderThread:(t:ThreadSummary)=>ReactNode;
  groupFor:(t:ThreadSummary)=>string|null; dropGroup?:string|null; dragging:boolean;
}) {
  useLocale();
  const storageKey = `yuanzhou-project-view-v1:${scope}`;
  const [preferences,setPreferences] = useState<Preferences>(() => { try { const p=JSON.parse(localStorage.getItem(storageKey) || "{}");return p&&typeof p==="object"&&!Array.isArray(p)?p:{}; } catch { return {}; } });
  const [notice,setNotice] = useMessageState("");
  const [editing,setEditing] = useState<ClientProject | "new">();
  const [all,setAll] = useState<Set<string>>(new Set());
  useEffect(()=>{
    if(!dragging||!dropGroup)return;
    const timer=setTimeout(()=>setPreferences(s=>{
      if(!s[dropGroup]?.collapsed)return s;
      const next={...s,[dropGroup]:{...s[dropGroup],collapsed:false}};
      try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{setNotice(uiMessage("展开状态未保存"));}
      return next;
    }),600);
    return()=>clearTimeout(timer);
  },[dragging,dropGroup,storageKey]);
  const preference = (id:string, patch:Preferences[string]) => {
    const next = {...preferences,[id]:{...preferences[id],...patch}};
    setPreferences(next);
    try { localStorage.setItem(storageKey,JSON.stringify(next)); setNotice(""); } catch { setNotice(uiMessage("展开和置顶状态未保存，重启后将恢复默认")); }
  };
  const sorted = [...projects].sort((a,b) => Number(!!preferences[b.id]?.pinned) - Number(!!preferences[a.id]?.pinned) || a.name.localeCompare(b.name));
  return <section className="project-list-section" aria-label={t("项目")}>
    <div className="conversation-list-heading"><span>{t("项目")}</span><button className="text-icon-button" title={unavailable || t("添加项目")} aria-label={t("添加项目")} disabled={disabled || !!unavailable} onClick={() => setEditing("new")}><UiIcon name="plus" /></button></div>
    {unavailable ? <p className="project-list-notice">{unavailable}</p> : loading && !projects.length ? <p className="project-list-notice" role="status">{t("正在加载项目…")}</p> : !projects.length && !error ? <button className="project-empty" disabled={disabled} onClick={() => setEditing("new")}><UiIcon name="folderPlus" />{t("添加本机项目")}</button> : null}
    {(error || notice) && <div className="project-list-notice" role="alert">{error || notice}{error && <button className="button-quiet" onClick={() => void refresh()}>{t("重试")}</button>}</div>}
    {sorted.map(p => {
      const children = threads.filter(t => groupFor(t) === p.id);
      const expanded = !preferences[p.id]?.collapsed;
      return <div data-thread-group={p.id} className={`project-group${dropGroup === p.id ? " thread-drop-group" : ""}`} key={p.id}>
        <ProjectRow dragging={dragging} project={p} expanded={expanded} active={activeProjectId === p.id} count={children.length} pinned={!!preferences[p.id]?.pinned} disabled={disabled || !!unavailable}
          toggle={() => preference(p.id,{collapsed:expanded})} pin={() => preference(p.id,{pinned:!preferences[p.id]?.pinned})}
          edit={() => setEditing(p)} create={() => newThread(p)} />
        {expanded && <div className="project-threads" aria-label={t("{{p0}}的对话", { p0: p.name })}>
          {children.slice(0,all.has(p.id) ? undefined : 5).map(renderThread)}
          {!children.length && <button className="project-empty-thread" disabled={disabled || !!unavailable} onClick={() => newThread(p)}>{t("开始新对话")}</button>}
          {children.length > 5 && <button className="project-show-more" onClick={() => setAll(s => {const next=new Set(s);next.has(p.id)?next.delete(p.id):next.add(p.id);return next;})}>{all.has(p.id)?t("收起"):t("展开显示")}</button>}
        </div>}
      </div>;
    })}
    {editing && <ProjectDialog initial={editing === "new" ? undefined : editing} save={save} remove={remove} close={() => setEditing(undefined)} saved={p => {setEditing(undefined); if(editing === "new") newThread(p);}} />}
  </section>;
}

function ProjectRow({project:p,expanded,active,count,pinned,disabled,toggle,pin,edit,create,dragging}:{project:ClientProject;expanded:boolean;active:boolean;count:number;pinned:boolean;disabled:boolean;toggle:()=>void;pin:()=>void;edit:()=>void;create:()=>void;dragging:boolean}) {
  useLocale();
  const [open,setOpen] = useState(false);
  const [position,setPosition] = useState({left:0,top:0});
  const row = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusCard = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  const leave = () => {cancel();timer.current=setTimeout(()=>{if(!card.current?.contains(document.activeElement))setOpen(false);},180);};
  useEffect(() => () => cancel(),[]);
  useEffect(() => {if(dragging){cancel();setOpen(false);}},[dragging]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {const r=row.current?.getBoundingClientRect(),c=card.current;if(r&&c)setPosition({left:Math.max(8,Math.min(r.right+6,innerWidth-c.offsetWidth-8)),top:Math.max(8,Math.min(r.top,innerHeight-c.offsetHeight-8))});};
    place(); if(focusCard.current){card.current?.querySelector<HTMLButtonElement>("button")?.focus();focusCard.current=false;} window.addEventListener("resize",place);window.addEventListener("scroll",place,true);
    const outside=(e:PointerEvent)=>{if(e.target instanceof Node&&!row.current?.contains(e.target)&&!card.current?.contains(e.target))setOpen(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();setOpen(false);more.current?.focus();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape);
    return()=>{window.removeEventListener("resize",place);window.removeEventListener("scroll",place,true);document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape);};
  },[open]);
  return <div ref={row} className={`project-row${active?" active":""}`} onPointerEnter={e=>{if(!dragging&&e.pointerType==="mouse"){cancel();timer.current=setTimeout(()=>setOpen(true),400);}}} onPointerLeave={leave}>
    <button className="project-select" aria-expanded={expanded} onClick={toggle}><UiIcon name={expanded?"folderOpen":"folder"}/><span>{p.name}</span></button>
    <div className="project-row-actions"><button ref={more} className="text-icon-button" aria-label={t("项目详情：{{p0}}", { p0: p.name })} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{cancel();focusCard.current=!open;setOpen(v=>!v);}}><UiIcon name="more"/></button><button className="text-icon-button" disabled={disabled} title={t("新建对话")} aria-label={t("在{{p0}}中新建对话", { p0: p.name })} onClick={()=>{setOpen(false);create();}}><UiIcon name="edit"/></button></div>
    {open && createPortal(<div ref={card} className="project-popover" style={position} role="dialog" aria-label={t("{{p0}}项目详情", { p0: p.name })} onPointerEnter={cancel} onPointerLeave={leave} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget)&&!row.current?.contains(e.relatedTarget))setOpen(false);}}>
      <div className="project-popover-title"><UiIcon name="folder"/><strong>{p.name}</strong><button className={`text-icon-button${pinned?" pinned":""}`} aria-label={pinned?t("取消置顶项目"):t("置顶项目")} aria-pressed={pinned} onClick={pin}><UiIcon name="pin"/></button></div>
      <div className="project-count">{t("聊天数量", { count })}</div>
      <div className="project-popover-folders">{p.folders.map((folder,i)=><div key={folder}><UiIcon name="folder"/><span title={folder}>{folder}</span>{p.folders.length>1&&i===0&&<small>{t("主目录")}</small>}</div>)}</div>
      <button className="project-edit-link" disabled={disabled} onClick={()=>{setOpen(false);edit();}}><UiIcon name="settings"/>{t("编辑项目")}</button>
    </div>,document.body)}
  </div>;
}

export function ProjectDialog({initial,save,remove,close,saved}:{initial?:ClientProject;save:(p:ProjectDraft)=>Promise<ClientProject>;remove:(p:ClientProject)=>Promise<void>;close:()=>void;saved:(p:ClientProject)=>void}) {
  useLocale();
  const [draft,setDraft]=useState<ProjectDraft>(()=>initial?{...initial,folders:[...initial.folders]}:{name:"",folders:[],creationKey:crypto.randomUUID()});
  const [busy,setBusy]=useState(false),[picking,setPicking]=useState(false),[error,setError]=useMessageState(""),[removing,setRemoving]=useState(false);
  const [manual,setManual]=useState("");
  const dialog=useRef<HTMLDialogElement>(null);
  const live=useRef(true);
  useEffect(()=>{live.current=true;const focus=document.activeElement;dialog.current?.showModal();return()=>{live.current=false;dialog.current?.close();if(focus instanceof HTMLElement&&focus.isConnected)focus.focus();};},[]);
  const add=(path:string)=>setDraft(d=>({...d,name:d.name||folderName(path),folders:d.folders.includes(path)?d.folders:[...d.folders,path]}));
  const pick=async()=>{setPicking(true);setError("");try{const path=await invoke<string|null>("select_workspace_directory");if(live.current&&path)add(path);}catch(e){if(live.current)setError(errorMessage(e));}finally{if(live.current)setPicking(false);}};
  const submit=async()=>{if(busy)return;setBusy(true);setError("");try{const p=await save(draft);if(live.current)saved(p);}catch(e){if(live.current)setError(uiMessage("{{p0}}。未确认的结果请先刷新列表核对。", { p0: String(e) }));}finally{if(live.current)setBusy(false);}};
  const confirmRemove=async()=>{if(!initial||busy)return;setBusy(true);setError("");try{await remove(initial);if(live.current)close();}catch(e){if(live.current)setError(errorMessage(e));}finally{if(live.current)setBusy(false);}};
  return createPortal(<dialog ref={dialog} className="project-dialog" aria-labelledby="project-dialog-title" onCancel={e=>{e.preventDefault();if(!busy&&!picking)close();}}>
    <form onSubmit={e=>{e.preventDefault();e.stopPropagation();void submit();}}>
      <header><h2 id="project-dialog-title">{removing?t("移除本地项目"):initial?t("编辑项目"):t("添加项目")}</h2><button type="button" className="text-icon-button" aria-label={t("关闭项目编辑")} disabled={busy||picking} onClick={close}><UiIcon name="close"/></button></header>
      {removing?<p>{t("将“")}{initial?.name}{t("”从项目列表移除。对话会保留在“最近”，原工作目录和本机文件不会删除。")}</p>:<>
        <label className="project-name"><UiIcon name="folder"/><input autoFocus aria-label={t("项目名称")} placeholder={t("项目名称")} value={draft.name} disabled={busy} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <h3>{t("源文件夹")}</h3><div className="project-folder-list">{draft.folders.map((path,i)=><div className="project-folder-entry" key={path}><UiIcon name="folder"/><div className="project-folder-copy"><span>{folderName(path)}{i===0&&<small>{t("主目录")}</small>}</span><span title={path}>{path}</span></div>{i!==0&&<button type="button" className="button-quiet project-primary" disabled={busy} onClick={()=>setDraft(d=>({...d,folders:[path,...d.folders.filter(f=>f!==path)]}))}>{t("设为主目录")}</button>}<button type="button" className="text-icon-button" aria-label={t("移除文件夹：{{p0}}", { p0: path })} disabled={busy} onClick={()=>setDraft(d=>({...d,folders:d.folders.filter(f=>f!==path)}))}><UiIcon name="close"/></button></div>)}
        <button type="button" className="project-add-folder" disabled={busy||picking} onClick={()=>{if(isTauri())void pick();else setError(uiMessage("浏览器预览请在下方填写本机目录，正式客户端使用系统目录选择器。"));}}><UiIcon name="folderPlus"/>{picking?t("选择文件夹中…"):t("添加文件夹")}</button></div>
        {!isTauri()&&<div className="project-manual-path"><input aria-label={t("本机目录路径")} value={manual} onChange={e=>setManual(e.target.value)} placeholder={t("本机目录绝对路径")}/><button type="button" className="button-secondary" disabled={!manual.trim()||busy} onClick={()=>{add(manual.trim());setManual("");setError("");}}>{t("添加")}</button></div>}
        {initial&&draft.folders[0]!==initial.folders[0]&&<p className="project-dialog-hint">{t("主目录调整仅用于新对话，已有对话保留原工作目录。")}</p>}
      </>}
      {error&&<p className="project-error" role="alert">{error}</p>}
      <footer>{initial&&!removing&&<button type="button" className="project-remove" disabled={busy||picking} onClick={()=>setRemoving(true)}>{t("移除本地项目")}</button>}<span/><button type="button" className="button-quiet" disabled={busy||picking} onClick={()=>removing?setRemoving(false):close()}>{t("取消")}</button>{removing?<button type="button" className="button-danger" disabled={busy} onClick={()=>void confirmRemove()}>{busy?t("移除中…"):t("确认移除")}</button>:<button type="submit" disabled={busy||picking||!draft.name.trim()||!draft.folders.length}>{busy?t("保存中…"):initial?t("保存"):t("创建")}</button>}</footer>
    </form>
  </dialog>,document.body);
}
