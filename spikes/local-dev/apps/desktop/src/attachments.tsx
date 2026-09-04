// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRef, MessageAttachment } from "../../../packages/agentrpc-types/src/index";
export type { AttachmentRef, MessageAttachment };
export type DraftAttachment = Partial<AttachmentRef> & {id:string; name:string; source:AttachmentRef["source"]; preview?:string; clipboard?:File; error?:string};
export const localAttachment = <T,>(method:string, params:Record<string,unknown> = {}) => invoke<T>("attachment_request",{method,params});
const readDataUrl = (file:Blob) => new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error("剪贴板图片读取失败"));reader.readAsDataURL(file);});

export function useAttachments(locked:boolean, enabled:boolean) {
  const [drafts,setDrafts]=useState<DraftAttachment[]>([]);
  const [error,setError]=useState("");
  const [adding,setAdding]=useState(false);
  const guard=useRef(false);
  const addPaths=useCallback(async(paths:string[])=>{
    if(locked || guard.current || !enabled)return;
    if(!isTauri()){setError("请在桌面客户端添加本机附件");return;}
    guard.current=true;setAdding(true);setError("");
    try {
      if(drafts.length+paths.length>10)throw new Error("最多添加 10 个附件");
      const next:DraftAttachment[]=[];
      for(const path of paths){
        const stat=await localAttachment<AttachmentRef>("file/stat",{path});
        let preview:string|undefined;
        let failure:string|undefined;
        if(stat.kind==="image"){
          try {preview=(await localAttachment<{url:string}>("attachment/preview",{path:stat.path,version:stat.version})).url;} catch(e){failure=String(e);}
        }
        next.push({...stat,id:crypto.randomUUID(),source:"localFile",preview,error:failure});
      }
      setDrafts(current=>[...current,...next]);
    }catch(e){setError(String(e));}finally{guard.current=false;setAdding(false);}
  },[drafts.length,enabled,locked]);
  useEffect(()=>{
    if(!isTauri()||!enabled)return;
    let disposed=false;let unlisten:(()=>void)|undefined;
    void getCurrentWebview().onDragDropEvent(event=>{if(event.payload.type==="drop")void addPaths(event.payload.paths);}).then(fn=>{if(disposed)fn();else unlisten=fn;}).catch(e=>setError(String(e)));
    return()=>{disposed=true;unlisten?.();};
  },[addPaths,enabled]);
  const paste=async(event:React.ClipboardEvent)=>{
    if(locked||adding||!enabled)return;
    const files=Array.from(event.clipboardData.items).filter(item=>item.type.startsWith("image/")).map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
    if(!files.length)return;
    event.preventDefault();setError("");
    if(!isTauri()){setError("请在桌面客户端粘贴图片");return;}
    if(files.some(file=>file.size>5*1024*1024)||drafts.length+files.length>10){setError("单张图片最大 5 MiB，最多 10 个附件");return;}
    setAdding(true);guard.current=true;
    try {const next=await Promise.all(files.map(async(file)=>({id:crypto.randomUUID(),name:`截图-${new Date().toISOString().replace(/[:.]/g,"-")}.png`,source:"clipboardTemp" as const,kind:"image" as const,bytes:file.size,mimeType:file.type,clipboard:file,preview:await readDataUrl(file)})));setDrafts(current=>[...current,...next]);}
    catch(e){setError(String(e));}finally{guard.current=false;setAdding(false);}
  };
  const prepare=async(deviceId:string):Promise<AttachmentRef[]>=>{
    if(!drafts.length)return [];
    const localDeviceId=await invoke<string>("attachment_device_id");
    if(deviceId!==localDeviceId)throw new Error("中央连接的设备与本机 Agent 不一致，请检查连接设置");
    const refs:AttachmentRef[]=[];
    for(const draft of drafts){
      let path=draft.path;
      if(!path&&draft.clipboard){
        const transfer=await localAttachment<{transferId:string}>("attachment/import_begin");
        try {
          for(let offset=0;offset<draft.clipboard.size;offset+=256*1024){
            const encoded=await readDataUrl(draft.clipboard.slice(offset,offset+256*1024));
            await localAttachment("attachment/import_chunk",{transferId:transfer.transferId,offset,data:encoded.split(",")[1]});
          }
          const stat=await localAttachment<AttachmentRef>("attachment/import_commit",{transferId:transfer.transferId});
          path=stat.path;
          setDrafts(current=>current.map(item=>item.id===draft.id?{...item,...stat,clipboard:undefined}:item));
        }finally{await localAttachment("file/close_transfer",{transferId:transfer.transferId}).catch(()=>undefined);}
      }
      if(!path)throw new Error(`${draft.name}：路径不可用，请重新选择`);
      const stat=await localAttachment<AttachmentRef>("file/stat",{path});
      if(draft.version&&stat.version!==draft.version)throw new Error(`${draft.name}：文件已变化，请移除后重新选择`);
      if(stat.kind==="image"&&stat.bytes>5*1024*1024)throw new Error("单张图片最大 5 MiB");
      refs.push({...stat,id:draft.id,source:draft.source});
    }
    if(refs.filter(ref=>ref.kind==="image").reduce((sum,ref)=>sum+ref.bytes,0)>10*1024*1024)throw new Error("每回合图片总量最大 10 MiB");
    return refs;
  };
  const pickerButton=(
    <button type="button" className="attachment-add-button" aria-label="添加附件" title="添加附件（支持拖入文件、粘贴截图）" disabled={locked||adding||!enabled} onClick={()=>void invoke<string[]>("select_attachment_paths").then(addPaths).catch(e=>setError(String(e)))}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
  );
  const controls=<>
    {adding&&<p className="attachment-notice" role="status">正在本机准备预览…</p>}
    {drafts.length>0&&<div className="attachment-list">{drafts.map(draft=><div className={`attachment-card ${draft.error?"attachment-error":""}`} key={draft.id} title={draft.path??"剪贴板图片：发送时保存到本机"}>{draft.preview?<img src={draft.preview} alt={draft.name}/>:<span className="attachment-file-icon">▤</span>}<div><strong>{draft.name}</strong><small>{sizeLabel(draft.bytes)} · {draft.error??"待发送"}</small></div><button type="button" aria-label={`移除 ${draft.name}`} disabled={locked||adding} onClick={()=>setDrafts(current=>current.filter(item=>item.id!==draft.id))}>×</button></div>)}</div>}
    {error&&<p role="alert" className="attachment-error-text">{error}</p>}
    {drafts.length>0&&<p className="attachment-notice">点击发送后，附件内容会经中央推理链路处理。普通文件按需读取。</p>}
  </>;
  return {drafts,setDrafts,prepare,paste,controls,pickerButton,adding};
}

export function MessageAttachments({attachments}:{attachments:MessageAttachment[]}) {
  return <div className="attachment-list">{attachments.map(attachment=><HistoryAttachment key={attachment.id} attachment={attachment}/>)}</div>;
}
function HistoryAttachment({attachment}:{attachment:MessageAttachment}){
  const [preview,setPreview]=useState<string>();const [error,setError]=useState("");const [busy,setBusy]=useState(false);
  const reload=useCallback(async()=>{
    if(!isTauri()){setError("请在来源桌面设备查看");return;}
    setBusy(true);setError("");
    try {
      const id=await invoke<string>("attachment_device_id");
      if(id!==attachment.deviceId)throw new Error("请在来源设备查看");
      const result=await localAttachment<{url:string}>("attachment/preview",{path:attachment.path,version:attachment.version});setPreview(result.url);
    }catch(e){setPreview(undefined);setError(`源文件不可用、已变化或附件已过期：${String(e)}`);}finally{setBusy(false);}
  },[attachment.deviceId,attachment.path,attachment.version]);
  useEffect(()=>{if(attachment.kind==="image")void reload();},[attachment.kind,reload]);
  return <div className="attachment-card" title={`${attachment.path}\n来源设备：${attachment.deviceId}`}>
    {preview?<img src={preview} alt={attachment.name}/>:<span className="attachment-file-icon">{attachment.kind==="image"?"▧":"▤"}</span>}
    <div><strong>{attachment.name}</strong><small>{sizeLabel(attachment.bytes)} · {attachment.kind} · {error||({referenced:"仅引用，尚未读取",read:"已读取",failed:"读取失败",unavailable:"源文件不可用"}[attachment.state])}</small>{attachment.kind==="image"&&error&&<button type="button" onClick={()=>void reload()} disabled={busy}>重新读取预览</button>}</div>
  </div>;
}
function sizeLabel(bytes?:number){return bytes===undefined?"大小待确认":bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;}
