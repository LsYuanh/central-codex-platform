// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale, message as uiMessage, errorMessage, UiError, useMessageState } from "./i18n";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./platform-gateway-client";
import { MarkdownMessage } from "./MarkdownMessage";
import { SkillFilePicker } from "./SkillFilePicker";
import { UiIcon } from "./UiIcon";
export interface Skill { id:string; name:string; displayName?:string; source?:'builtin'|'personal'; nameConflict?:boolean; description:string; revision:number; enabled:boolean; automatic:boolean; platforms:string[]; programs:string[] }
// Keep the built-in name consistent with older gateways and persisted mentions.
export const skillLabel=(skill:Pick<Skill,'id'|'name'|'displayName'>)=>skill.id==='yuan-zhou-skill-creator'?skill.name:skill.displayName||skill.name;
interface Draft { id:string; path:string; skillId?:string; revision?:number }
interface Preview { previewId:string; name:string; displayName?:string; source?:'builtin'|'personal'; nameConflict?:boolean; description:string; platforms:string[]; programs:string[]; files:{path:string;bytes:number;content?:string}[] }
export function useSkills(scope:string,client:RpcClient|undefined,available:boolean){
  const [rows,setRows]=useState<Skill[]>([]),[drafts,setDrafts]=useState<Draft[]>([]),[error,setError]=useMessageState(''),[loading,setLoading]=useState(false);
  const current=useRef({scope,client,available});current.current={scope,client,available};const generation=useRef(0);
  const request=useCallback(async(method:string,params:Record<string,unknown>={})=>{
    if(!client||!available)throw new UiError("连接新版中央服务后使用个人技能");
    const response=await client.request(method,params);
    if(current.current.scope!==scope||current.current.client!==client)throw new UiError("连接已切换，请在原连接核对操作结果");
    return response.result as Record<string,unknown>;
  },[scope,client,available]);
  const refresh=useCallback(async()=>{
    const token=++generation.current;if(!available)return;setLoading(true);
    try{const data=await request('skill/list');if(!Array.isArray(data.skills)||!Array.isArray(data.drafts))throw new UiError("技能列表响应无效");if(token===generation.current){setRows(data.skills as Skill[]);setDrafts(data.drafts as Draft[]);setError('');}}
    catch(e){if(token===generation.current)setError(errorMessage(e));}finally{if(token===generation.current)setLoading(false);}
  },[request,available]);
  useEffect(()=>{setRows([]);setDrafts([]);setError('');setLoading(false);void refresh();const off=client?.subscribe(e=>{if(e.method==='skill/changed')void refresh();});return()=>{generation.current++;off?.();};},[refresh,client]);
  return {rows,drafts,error,loading,refresh,request,available};
}
export type SkillService=ReturnType<typeof useSkills>;
interface SkillDetail { id:string; files:{path:string;bytes:number}[]; content:string }
function SkillBadge(){
  useLocale();return <span className="skill-badge"><UiIcon name="skill" /></span>;}
function SkillContent({file,content,source}:{file:string;content:string;source:boolean}){
  useLocale();
  const markdown=/\.md$/i.test(file);
  const body=file==='SKILL.md'?content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,''):content;
  return <div className="skill-file-content" tabIndex={0} aria-label={t("文件内容")}>{markdown&&!source?<MarkdownMessage content={body}/>:<pre>{content}</pre>}</div>;
}
export function SkillsPanel({service,disabled,startDraft,useSkill}:{service:SkillService;disabled:boolean;startDraft:(prompt:string)=>void;useSkill:(skill:Skill,prompt?:string)=>void}){
  useLocale();
  const [busy,setBusy]=useState(''),[error,setError]=useMessageState(''),[notice,setNotice]=useMessageState(''),[query,setQuery]=useState('');
  const [preview,setPreview]=useState<Preview>(),[detail,setDetail]=useState<SkillDetail>();
  const [selectedFile,setSelectedFile]=useState('SKILL.md'),[source,setSource]=useState(false),[confirmation,setConfirmation]=useState<Skill>();
  const dialog=useRef<HTMLDialogElement>(null),deleteDialog=useRef<HTMLDialogElement>(null),more=useRef<HTMLDetailsElement>(null);
  const mounted=useRef(true),pending=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(preview||detail){if(!dialog.current?.open)dialog.current?.showModal();}else dialog.current?.close();},[preview,detail]);
  useEffect(()=>{if(confirmation){if(!deleteDialog.current?.open)deleteDialog.current?.showModal();}else deleteDialog.current?.close();},[confirmation]);
  useEffect(()=>{
    const dismiss=(event:Event)=>{if(more.current?.open&&event.target instanceof Node&&!more.current.contains(event.target))more.current.open=false;};
    document.addEventListener('pointerdown',dismiss);document.addEventListener('focusin',dismiss);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('focusin',dismiss);};
  },[]);
  const action=async(key:string,run:()=>Promise<void>)=>{
    if(pending.current)return;pending.current=true;setBusy(key);setError('');setNotice('');
    try{await run();}catch(e){if(mounted.current)setError(errorMessage(e));}
    finally{pending.current=false;if(mounted.current)setBusy('');}
  };
  const create=async(skillId?:string)=>{
    const creator=service.rows.find(s=>s.source==='builtin'&&s.name==='yuan-zhou-skill-creator');
    if(creator){const original=service.rows.find(s=>s.id===skillId);close();useSkill(creator,original?t("请修改个人技能 {{p0}}（skillId: {{p1}}），先了解我的修改需求。", { p0: original.name, p1: original.id }):'');return;}
    const data=await service.request('skill/draft',{creationKey:crypto.randomUUID(),...(skillId?{skillId}:{})});
    await service.refresh();if(!mounted.current)return;
    if(typeof data.prompt!=='string')throw new UiError("未收到创建对话");startDraft(data.prompt);
  };
  const close=()=>{setPreview(undefined);setDetail(undefined);setSelectedFile('SKILL.md');setSource(false);setError('');};
  const inactive=!!busy||disabled||!service.available;
  const skill=detail?service.rows.find(s=>s.id===detail.id):undefined;
  const rows=service.rows.filter(s=>`${s.name} ${s.displayName??''} ${s.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const files=preview?.files??detail?.files??[];
  const content=preview?preview.files.find(f=>f.path===selectedFile)?.content??t("二进制资源，已列入技能包。"):detail?.content??'';
  const read=async(s:Skill)=>{const d=await service.request('skill/read',{id:s.id});if(mounted.current){setSelectedFile('SKILL.md');setSource(false);setDetail({id:s.id,files:d.files as SkillDetail['files'],content:String(d.content)});}};
  const update=async(s:Skill,change:{enabled?:boolean;automatic?:boolean})=>{await service.request('skill/update',{id:s.id,revision:s.revision,enabled:s.enabled,...change});await service.refresh();};
  return <div className="settings-content skills-settings">
    <header className="skills-page-header"><div><h1>{t("我的技能")}</h1><p>{t("把常用工作方法变成技能，在不同设备上使用。")}</p></div><div className="skills-header-actions">
      <button type="button" className="text-icon-button" aria-label={t("刷新技能")} title={t("刷新技能")} disabled={!!busy||service.loading||!service.available} onClick={()=>void service.refresh()}><UiIcon name="refresh" /></button>
      <button type="button" className="skill-create-button" disabled={inactive} onClick={()=>void action('create',()=>create())}><UiIcon name="plus" />{t("创建技能")}</button>
    </div></header>
    <label className="skills-search"><UiIcon name="search"/><input type="search" aria-label={t("搜索技能")} placeholder={t("搜索技能")} value={query} onChange={e=>setQuery(e.target.value)}/></label>
    {!service.available&&<p className="notice">{t("连接支持个人技能的中央服务后可用。")}</p>}
    {(error||service.error)&&!detail&&!preview&&!confirmation&&<div className="error-banner" role="alert">{error||service.error}<button type="button" className="button-secondary" onClick={()=>void service.refresh()} disabled={!!busy}>{t("刷新核对")}</button></div>}
    <div className="skills-feedback" role="status">{busy?t("正在处理，请稍候…"):service.loading?t("正在刷新技能…"):notice}</div>
    <section aria-labelledby="skills-installed-title"><div className="skills-section-heading"><h2 id="skills-installed-title">{t("可用技能")}</h2><span>{query?`${rows.length} / `:''}{service.rows.length}</span></div>
      {!service.loading&&!service.rows.length&&service.available?<div className="skills-empty"><SkillBadge/><h3>{t("把常用流程变成技能")}</h3><p>{t("描述需求，让远舟生成技能包，预览后保存。")}</p></div>:query&&!rows.length?<p className="skills-empty">{t("没有匹配的技能，试试其他名称或关键词。")}</p>:<div className="skills-grid">{rows.map(s=><button type="button" className="skill-card" key={s.id} disabled={!!busy||!service.available} onClick={()=>void action('read',()=>read(s))} aria-label={t("查看 {{p0}}", { p0: skillLabel(s) })}>
        <SkillBadge/><span className="skill-card-copy"><strong>{skillLabel(s)}{s.source==='builtin'&&<small className="skill-source-label">{t("远舟内置")}</small>}</strong><span title={s.description}>{s.description}</span></span><span className="skill-card-state" title={s.enabled?t("已启用"):t("已停用")} aria-label={s.enabled?t("已启用"):t("已停用")}>{s.enabled?<UiIcon name="check"/>:<span>{t("已停用")}</span>}</span>
      </button>)}</div>}
    </section>
    <section className="skills-drafts" aria-labelledby="skills-drafts-title"><div className="skills-section-heading"><h2 id="skills-drafts-title">{t("本机草稿")}</h2><span>{service.drafts.length}</span></div><p className="skills-section-note">{t("对话生成的技能包会保留在本机，预览确认后保存。")}</p>
      {!service.drafts.length&&<p className="skills-drafts-empty">{t("暂无草稿")}</p>}
      {service.drafts.map(d=><div className="skill-draft" key={d.id}><UiIcon name="file"/><div className="skill-draft-copy"><strong>{d.skillId?t("修改草稿"):t("新技能草稿")}</strong><details><summary>{t("文件位置")}</summary><code>{d.path}</code></details></div><div className="skill-row-actions"><button type="button" className="button-secondary" disabled={inactive} onClick={()=>void action('preview',async()=>{const p=await service.request('skill/preview',{id:d.id});if(mounted.current){setSelectedFile('SKILL.md');setSource(false);setPreview(p as unknown as Preview);}})}>{t("预览并保存")}</button><button type="button" className="text-icon-button" title={t("移除登记，保留本机文件")} aria-label={t("移除草稿登记")} disabled={inactive} onClick={()=>void action('discard',async()=>{await service.request('skill/discard',{id:d.id});await service.refresh();setNotice(uiMessage("草稿登记已移除，本机文件保留。"));})}><UiIcon name="close"/></button></div></div>)}
    </section>
    <dialog ref={dialog} className="skill-dialog" onCancel={e=>{if(pending.current)e.preventDefault();else close();}} aria-labelledby="skill-preview-title">
      <div className="skill-dialog-top"><SkillBadge/><div className="skill-dialog-tools">
        {skill&&<>{skill.source!=='builtin'&&<button type="button" className="skill-toggle" role="switch" aria-label={t("启用技能")} aria-checked={skill.enabled} title={skill.enabled?t("停用技能"):t("启用技能")} disabled={!!busy||!service.available} onClick={()=>void action('toggle',()=>update(skill,{enabled:!skill.enabled}))}><span/></button>}
        <details ref={more} className="skill-more" onKeyDown={e=>{if(e.key==='Escape'&&e.currentTarget.open){e.preventDefault();e.stopPropagation();e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}><summary aria-label={t("更多技能操作")}><UiIcon name="more"/></summary><div className="skill-more-menu">{skill.source!=='builtin'&&<button type="button" disabled={inactive} onClick={()=>{if(more.current)more.current.open=false;void action('edit',()=>create(skill.id));}}><UiIcon name="edit"/>{t("对话修改")}</button>}<button type="button" disabled={!!busy||!service.available} onClick={()=>void action('automatic',()=>update(skill,{automatic:!skill.automatic}))}>{t("自动匹配")}<span>{skill.automatic?t("已开启"):t("已关闭")}</span></button></div></details></>}
        <button type="button" autoFocus className="text-icon-button" aria-label={t("关闭技能详情")} disabled={!!busy} onClick={close}><UiIcon name="close"/></button>
      </div></div>
      <div className="skill-dialog-heading"><h2 id="skill-preview-title">{preview?t("预览 · {{p0}}", { p0: preview.name }):skill?skillLabel(skill):t("技能已移除")}<span>{t("技能")}</span></h2><p>{preview?.description??skill?.description}</p><div className="skill-metadata">{skill&&<span>{skill.source==='builtin'?t("远舟内置 · 只读"):`v${skill.revision} · ${skill.enabled?t("已启用"):t("已停用")}`}</span>}<span>{(preview?.platforms??skill?.platforms??[]).join(' / ')||t("不限系统")}</span>{(preview?.programs??skill?.programs??[]).length>0&&<span>{t("需要 ")}{(preview?.programs??skill?.programs)?.join('、')}</span>}</div></div>
      <div className="skill-file-toolbar"><SkillFilePicker key={preview?.previewId??detail?.id??'closed'} files={files} value={selectedFile} disabled={!!busy} onChange={file=>{if(preview){setSelectedFile(file);return;}if(detail)void action('file',async()=>{const data=await service.request('skill/read',{id:detail.id,file});if(mounted.current){setSelectedFile(file);setDetail({...detail,content:String(data.content)});}});}}/>{/\.md$/i.test(selectedFile)&&<button type="button" className="button-quiet" aria-pressed={source} onClick={()=>setSource(!source)}>{source?t("阅读视图"):t("查看源码")}</button>}</div>
      {skill?.nameConflict&&<p role="alert" className="error-text">{t("名称与远舟内置技能冲突，请通过「对话修改」更换个人技能名称。原技能文件已保留。")}</p>}
      <SkillContent file={selectedFile} content={content} source={source}/>
      <p className="skill-preview-note">{preview?t("预览不会运行脚本；保存包含完整技能包。"):t("在对话中输入 $ 选择技能，也可以立即使用。")}{t(" 文件最多预览 64 KiB。")}</p>
      {(error||service.error)&&<p role="alert" className="error-text">{error||service.error}</p>}{busy&&<p role="status" className="skill-dialog-status">{t("正在处理，请稍候…")}</p>}
      <footer className="skill-dialog-actions">{preview?<><button type="button" className="button-secondary" disabled={!!busy} onClick={close}>{t("返回")}</button><button type="button" disabled={!!busy} onClick={()=>void action('save',async()=>{await service.request('skill/save',{previewId:preview.previewId});close();await service.refresh();setNotice(uiMessage("技能已保存，同一用户的其他设备可刷新后调用。"));})}>{busy==='save'?t("正在保存…"):t("确认保存")}</button></>:<>{skill?.source==='builtin'?<span className="skill-use-hint">{t("由远舟维护，支持关闭自动匹配")}</span>:<button type="button" className="skill-delete-button" disabled={!!busy||!skill||!service.available} onClick={()=>setConfirmation(skill)}>{t("删除技能")}</button>}<span className="skill-use-hint">{skill&&!skill.enabled?t("先启用技能，即可使用"):disabled?t("连接设备并等待当前操作完成"):''}</span><button type="button" disabled={inactive||!skill?.enabled} onClick={()=>{if(skill?.enabled){close();useSkill(skill);}}}><UiIcon name="chat"/>{t("立即使用")}</button></>}</footer>
    </dialog>
    <dialog ref={deleteDialog} className="skill-delete-dialog" aria-labelledby="skill-delete-title" onCancel={e=>{if(pending.current)e.preventDefault();else setConfirmation(undefined);}}><h2 id="skill-delete-title">{t("删除 ")}{confirmation?.name}？</h2><p>{t("删除后无法再次加载此技能。正在执行的脚本不会因此中止。")}</p>{error&&<p role="alert">{error}</p>}<div className="skill-dialog-actions"><button type="button" autoFocus className="button-secondary" disabled={!!busy} onClick={()=>setConfirmation(undefined)}>{t("取消")}</button><button type="button" className="button-danger" disabled={!!busy} onClick={()=>void action('remove',async()=>{await service.request('skill/remove',{id:confirmation!.id,revision:confirmation!.revision});setConfirmation(undefined);close();await service.refresh();})}>{t("删除技能")}</button></div></dialog>
  </div>;
}
