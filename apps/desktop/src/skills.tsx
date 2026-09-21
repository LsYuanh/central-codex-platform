// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "./platform-gateway-client";
import { UiIcon } from "./UiIcon";
interface Skill { id:string; name:string; description:string; revision:number; enabled:boolean; automatic:boolean; platforms:string[]; programs:string[] }
interface Draft { id:string; path:string; skillId?:string; revision?:number }
interface Preview { previewId:string; name:string; description:string; platforms:string[]; programs:string[]; files:{path:string;bytes:number;content?:string}[] }
export function useSkills(scope:string,client:RpcClient|undefined,available:boolean){
  const [rows,setRows]=useState<Skill[]>([]),[drafts,setDrafts]=useState<Draft[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const current=useRef({scope,client,available});current.current={scope,client,available};const generation=useRef(0);
  const request=useCallback(async(method:string,params:Record<string,unknown>={})=>{
    if(!client||!available)throw Error('连接新版中央服务后使用个人技能');
    const response=await client.request(method,params);
    if(current.current.scope!==scope||current.current.client!==client)throw Error('连接已切换，请在原连接核对操作结果');
    return response.result as Record<string,unknown>;
  },[scope,client,available]);
  const refresh=useCallback(async()=>{
    const token=++generation.current;if(!available)return;setLoading(true);
    try{const data=await request('skill/list');if(!Array.isArray(data.skills)||!Array.isArray(data.drafts))throw Error('技能列表响应无效');if(token===generation.current){setRows(data.skills as Skill[]);setDrafts(data.drafts as Draft[]);setError('');}}
    catch(e){if(token===generation.current)setError(String(e));}finally{if(token===generation.current)setLoading(false);}
  },[request,available]);
  useEffect(()=>{setRows([]);setDrafts([]);setError('');setLoading(false);void refresh();const off=client?.subscribe(e=>{if(e.method==='skill/changed')void refresh();});return()=>{generation.current++;off?.();};},[refresh,client]);
  return {rows,drafts,error,loading,refresh,request,available};
}
type Service=ReturnType<typeof useSkills>;
export function SkillPicker({service,disabled,insert,manage}:{service:Service;disabled:boolean;insert:(text:string)=>void;manage:()=>void}){
  const ref=useRef<HTMLDetailsElement>(null);
  return <details ref={ref} className="skill-picker" onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}>
    <summary aria-label="选择技能"><UiIcon name="review" /><span>技能</span></summary>
    <div className="skill-picker-menu"><strong>个人技能</strong>{!service.available?<p>中央服务更新后可用</p>:service.loading?<p role="status">正在加载…</p>:service.error?<><p role="alert">{service.error}</p><button type="button" onClick={()=>void service.refresh()}>重试</button></>:service.rows.filter(s=>s.enabled).length===0?<p>还没有启用的技能</p>:service.rows.filter(s=>s.enabled).map(s=><button type="button" key={s.id} disabled={disabled} onClick={()=>{insert(`$${s.name} `);if(ref.current)ref.current.open=false;}}><span>{s.name}</span><small>{s.description}</small></button>)}<button type="button" onClick={()=>{manage();if(ref.current)ref.current.open=false;}}>管理我的技能</button></div>
  </details>;
}
export function SkillsPanel({service,disabled,startDraft}:{service:Service;disabled:boolean;startDraft:(prompt:string)=>void}){
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [preview,setPreview]=useState<Preview>(),[detail,setDetail]=useState<{id:string;name:string;files:{path:string;bytes:number}[];content:string}>();
  const [selectedFile,setSelectedFile]=useState('SKILL.md'),[confirmation,setConfirmation]=useState<Skill>();
  const dialog=useRef<HTMLDialogElement>(null),deleteDialog=useRef<HTMLDialogElement>(null);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if((preview||detail)&&dialog.current&&!dialog.current.open)dialog.current.showModal();else if(!preview&&!detail)dialog.current?.close();},[preview,detail]);
  useEffect(()=>{if(confirmation)deleteDialog.current?.showModal();else deleteDialog.current?.close();},[confirmation]);
  const action=async(key:string,run:()=>Promise<void>)=>{if(busy)return;setBusy(key);setError('');setNotice('');try{await run();}catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy('');}};
  const create=async(skillId?:string)=>{
    const data=await service.request('skill/draft',{creationKey:crypto.randomUUID(),...(skillId?{skillId}:{})});
    await service.refresh();if(typeof data.prompt!=='string')throw Error('未收到创建对话');startDraft(data.prompt);
  };
  const close=()=>{setPreview(undefined);setDetail(undefined);setSelectedFile('SKILL.md');};
  const inactive=!!busy||disabled||!service.available;
  return <div className="settings-content skills-settings">
    <section className="settings-card"><div className="skills-toolbar"><div><h2>我的技能</h2><p>保存常用工作方法，在你的不同设备上调用。</p></div><button disabled={inactive} onClick={()=>void action('create',()=>create())}><UiIcon name="plus" /> 创建技能</button></div>
      {!service.available&&<p className="notice">连接支持个人技能的中央服务后可用。</p>}
      {(error||service.error)&&<div className="error-banner" role="alert">{error||service.error}<button onClick={()=>void service.refresh()} disabled={!!busy}>刷新核对</button></div>}
      {notice&&<p role="status">{notice}</p>}{busy&&<p role="status">正在处理，请稍候…</p>}
      <div className="skills-list-heading"><span>{service.rows.length} 个技能</span><button className="secondary" disabled={!!busy||service.loading||!service.available} onClick={()=>void service.refresh()}>{service.loading?'正在刷新…':'刷新'}</button></div>
      {!service.loading&&!service.rows.length&&service.available&&<div className="skills-empty"><UiIcon name="review" /><h3>把常用流程变成技能</h3><p>描述你想完成的工作，让远舟生成说明、参考资料、模板与脚本。预览确认后保存。</p></div>}
      {service.rows.map(s=><article className="skill-row" key={s.id}><div><strong>{s.name}</strong><span className="skill-state">{s.enabled?'已启用':'已停用'} · v{s.revision}</span><p>{s.description}</p><small>{s.platforms.length?s.platforms.join(' / '):'未限定操作系统'}{s.programs.length?` · 需要 ${s.programs.join('、')}`:''}</small></div><div className="skill-row-actions">
        <button className="secondary" disabled={!!busy} onClick={()=>void action('read',async()=>{const d=await service.request('skill/read',{id:s.id});setSelectedFile('SKILL.md');setDetail({id:s.id,name:s.name,files:d.files as {path:string;bytes:number}[],content:String(d.content)});})}>查看</button>
        <button className="secondary" disabled={inactive} onClick={()=>void action('edit',()=>create(s.id))}>对话修改</button>
        <button className="secondary" disabled={!!busy||!service.available} onClick={()=>void action('toggle',async()=>{await service.request('skill/update',{id:s.id,revision:s.revision,enabled:!s.enabled});await service.refresh();})}>{s.enabled?'停用':'启用'}</button>
        <button className="secondary" disabled={!!busy||!service.available} onClick={()=>void action("automatic",async()=>{await service.request("skill/update",{id:s.id,revision:s.revision,enabled:s.enabled,automatic:!s.automatic});await service.refresh();})}>{s.automatic?"自动匹配：开":"自动匹配：关"}</button>
        <button className="secondary" disabled={!!busy||!service.available} onClick={()=>setConfirmation(s)}>删除</button>
      </div></article>)}
    </section>
    <section className="settings-card"><h2>本机草稿</h2><p>创建对话生成文件后，在这里预览并保存到个人技能库。</p>
      {!service.drafts.length&&<p className="muted">暂无草稿。</p>}
      {service.drafts.map(d=><div className="skill-draft" key={d.id}><div><strong>{d.skillId?'修改草稿':'新技能草稿'}</strong><details><summary>文件位置</summary><code>{d.path}</code></details></div><div className="skill-row-actions"><button disabled={inactive} onClick={()=>void action('preview',async()=>{const p=await service.request('skill/preview',{id:d.id});setSelectedFile('SKILL.md');setPreview(p as unknown as Preview);})}>预览并保存</button><button className="secondary" disabled={inactive} onClick={()=>void action('discard',async()=>{await service.request('skill/discard',{id:d.id});await service.refresh();setNotice('草稿登记已移除，本机文件保留。');})}>移除登记</button></div></div>)}
    </section>
    <dialog ref={dialog} className="skill-dialog" onCancel={e=>{if(busy)e.preventDefault();else close();}} aria-labelledby="skill-preview-title"><div className="skills-toolbar"><h2 id="skill-preview-title">{preview?`预览 · ${preview.name}`:detail?.name}</h2><button className="text-icon-button" aria-label="关闭预览" disabled={!!busy} onClick={close}><UiIcon name="close" /></button></div>
      {preview&&<><p>{preview.description}</p><p>系统：{preview.platforms.join(' / ')||'未限定'} · 依赖：{preview.programs.join('、')||'未声明'}</p></>}
      <label className="skill-file-select">文件<select value={selectedFile} disabled={!!busy} onChange={e=>{const file=e.target.value;setSelectedFile(file);if(detail)void action('file',async()=>{const data=await service.request('skill/read',{id:detail.id,file});setDetail({...detail,content:String(data.content)});});}}>{(preview?.files??detail?.files??[]).map(f=><option key={f.path} value={f.path}>{f.path} · {f.bytes} B</option>)}</select></label>
      <pre className="skill-file-content">{preview?preview.files.find(f=>f.path===selectedFile)?.content??'二进制资源，已列入技能包。':detail?.content}</pre>
      <p className="muted">文件内容最多预览 64 KiB；保存包含完整技能包。预览不会运行脚本。</p>
      {error&&<p role="alert" className="error-text">{error}</p>}
      <div className="skill-dialog-actions"><button className="secondary" disabled={!!busy} onClick={close}>返回</button>{preview&&<button disabled={!!busy} onClick={()=>void action('save',async()=>{await service.request('skill/save',{previewId:preview.previewId});close();await service.refresh();setNotice('技能已保存，同一用户的其他设备可刷新后调用。');})}>{busy==='save'?'正在保存…':'确认保存'}</button>}</div>
    </dialog>
    <dialog ref={deleteDialog} className="skill-delete-dialog" aria-labelledby="skill-delete-title" onCancel={()=>setConfirmation(undefined)}><h2 id="skill-delete-title">删除 {confirmation?.name}？</h2><p>删除后无法再次加载此技能。正在执行的脚本不会因此中止。</p>{error&&<p role="alert">{error}</p>}<div className="skill-dialog-actions"><button className="secondary" disabled={!!busy} onClick={()=>setConfirmation(undefined)}>取消</button><button disabled={!!busy} onClick={()=>void action('remove',async()=>{await service.request('skill/remove',{id:confirmation!.id,revision:confirmation!.revision});setConfirmation(undefined);await service.refresh();})}>删除技能</button></div></dialog>
  </div>;
}
