// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale, message as uiMessage, errorMessage, UiError, useMessageState } from "./i18n";

import { invoke } from "./native-invoke";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useRef, useState } from "react";
import { UiIcon } from "./UiIcon";
import { CopyButton, fileDescription } from "./result-controls";
import { checkLocalFile, revealLocalFile, useFullImage } from "./file-preview";
import { ImageViewer } from "./ImageViewer";
import type { AttachmentRef, MessageAttachment } from "../../../packages/agentrpc-types/src/index";
export type { AttachmentRef, MessageAttachment };
export type DraftAttachment = Partial<AttachmentRef> & {id:string; name:string; source:AttachmentRef["source"]; preview?:string; clipboard?:File; error?:string};
export const localAttachment = <T,>(method:string, params:Record<string,unknown> = {}) => invoke<T>("attachment_request",{method,params});
const readDataUrl = (file:Blob) => new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new UiError("剪贴板图片读取失败"));reader.readAsDataURL(file);});

export function useAttachments(locked:boolean, enabled:boolean) {
  const [drafts,setDrafts]=useState<DraftAttachment[]>([]);
  const [error,setError]=useMessageState("");
  const [adding,setAdding]=useState(false);
  const guard=useRef(false);
  const addPaths=useCallback(async(paths:string[])=>{
    if(locked || guard.current || !enabled)return;
    if(!isTauri()){setError(uiMessage("请在桌面客户端添加本机附件"));return;}
    guard.current=true;setAdding(true);setError("");
    try {
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
    }catch(e){setError(errorMessage(e));}finally{guard.current=false;setAdding(false);}
  },[drafts.length,enabled,locked]);
  useEffect(()=>{
    if(!isTauri()||!enabled)return;
    let disposed=false;let unlisten:(()=>void)|undefined;
    void getCurrentWebview().onDragDropEvent(event=>{if(event.payload.type==="drop")void addPaths(event.payload.paths);}).then(fn=>{if(disposed)fn();else unlisten=fn;}).catch(e=>setError(errorMessage(e)));
    return()=>{disposed=true;unlisten?.();};
  },[addPaths,enabled]);
  const paste=async(event:React.ClipboardEvent)=>{
    if(locked||adding||!enabled)return;
    const files=Array.from(event.clipboardData.items).filter(item=>item.type.startsWith("image/")).map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
    if(!files.length)return;
    event.preventDefault();setError("");
    if(!isTauri()){setError(uiMessage("请在桌面客户端粘贴图片"));return;}
    setAdding(true);guard.current=true;
    try {const next=await Promise.all(files.map(async(file)=>({id:crypto.randomUUID(),name:t("截图-{{p0}}.png", { p0: new Date().toISOString().replace(/[:.]/g,"-") }),source:"clipboardTemp" as const,kind:"image" as const,bytes:file.size,mimeType:file.type,clipboard:file,preview:await readDataUrl(file)})));setDrafts(current=>[...current,...next]);}
    catch(e){setError(errorMessage(e));}finally{guard.current=false;setAdding(false);}
  };
  const prepare=async(deviceId:string):Promise<AttachmentRef[]>=>{
    if(!drafts.length)return [];
    const localDeviceId=await invoke<string>("attachment_device_id");
    if(deviceId!==localDeviceId)throw new UiError("中央连接的设备与本机 Agent 不一致，请检查连接设置");
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
      if(!path)throw new UiError("{{p0}}：路径不可用，请重新选择", { p0: draft.name });
      const stat=await localAttachment<AttachmentRef>("file/stat",{path});
      if(draft.version&&stat.version!==draft.version)throw new UiError("{{p0}}：文件已变化，请移除后重新选择", { p0: draft.name });
      refs.push({...stat,id:draft.id,source:draft.source});
    }
    return refs;
  };
  const pickFiles=()=>{
    if(locked||adding||!enabled)return;
    void invoke<string[]>("select_attachment_paths").then(addPaths).catch(e=>setError(errorMessage(e)));
  };
  const controls=<>
    {adding&&<p className="attachment-notice" role="status">{t("正在本机准备预览…")}</p>}
    {drafts.length>0&&<div className="attachment-list">{drafts.map(draft=><div className={`attachment-card ${draft.error?"attachment-error":""}`} key={draft.id} title={draft.path??t("剪贴板图片：发送时保存到本机")}>{draft.preview?<img src={draft.preview} alt={draft.name}/>:<span className="attachment-file-icon">▤</span>}<div><strong>{draft.name}</strong><small>{sizeLabel(draft.bytes)} · {draft.error?t("预览不可用，仍可发送"):t("待发送")}</small></div><button type="button" className="composer-remove-button" aria-label={t("移除 {{p0}}", { p0: draft.name })} disabled={locked||adding} onClick={()=>setDrafts(current=>current.filter(item=>item.id!==draft.id))}><UiIcon name="close" /></button></div>)}</div>}
    {error&&<p role="alert" className="attachment-error-text">{error}</p>}
    {drafts.length>0&&<p className="attachment-notice">{t("点击发送后，附件内容会经中央推理链路处理。普通文件按需读取。")}</p>}
  </>;
  return {drafts,setDrafts,prepare,paste,controls,pickFiles,pickerDisabled:locked||adding||!enabled,adding};
}

export function MessageAttachments({attachments}:{attachments:MessageAttachment[]}) {
  useLocale();
  return <div className="attachment-list">{attachments.map(attachment=><HistoryAttachment key={attachment.id} attachment={attachment}/>)}</div>;
}
function HistoryAttachment({attachment}:{attachment:MessageAttachment}){
  useLocale();
  const [preview,setPreview]=useState<string>();const [error,setError]=useMessageState("");const [busy,setBusy]=useState(false);
  const generation = useRef(0);
  const viewer = useFullImage(attachment);
  const reload=useCallback(async()=>{
    const attempt = ++generation.current;
    setPreview(undefined);
    if(!isTauri()){setError(uiMessage("请在来源桌面设备查看"));return;}
    setBusy(true);setError("");
    try {
      await checkLocalFile(attachment);
      const result=await localAttachment<{url:string}>("attachment/preview",{path:attachment.path,version:attachment.version});
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(result.url)) throw new UiError("不支持的图片预览格式");
      if (attempt === generation.current) setPreview(result.url);
    }catch(e){if (attempt === generation.current) {setPreview(undefined);setError(uiMessage("源文件不可用、已变化或附件已过期：{{p0}}", { p0: String(e) }));}}finally{if (attempt === generation.current) setBusy(false);}
  },[attachment.deviceId,attachment.path,attachment.version]);
  useEffect(()=>{if(attachment.kind==="image")void reload();return()=>{generation.current++;};},[attachment.kind,reload]);
  const reveal = async () => { setBusy(true); setError(""); try { await revealLocalFile(attachment); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } };
  return <><div className="attachment-card" title={t("来源设备：{{p0}}", { p0: attachment.deviceId })}>
    {preview?<button className="result-image-button" type="button" disabled={viewer.busy} aria-label={t("放大图片 {{p0}}", { p0: attachment.name })} onClick={()=>void viewer.open()}><img src={preview} alt={attachment.name}/></button>:<span className="attachment-file-icon"><UiIcon name="file" /></span>}
    <div><strong title={attachment.name}>{attachment.name}</strong><small>{fileDescription(attachment)}</small><small role="status">{({referenced:t("仅引用，尚未读取"),read:t("已读取"),partial:t("部分已读取"),failed:t("读取失败"),unavailable:t("源文件不可用")}[attachment.state])}</small><details className="attachment-location"><summary>{t("文件位置")}</summary><p>{attachment.path}</p></details><div className="attachment-actions"><CopyButton text={attachment.path} label={t("复制路径")}/><button className="result-control" type="button" disabled={busy} onClick={()=>void reveal()}>{t("打开所在目录")}</button>{attachment.kind==="image"&&error&&<button className="result-control" type="button" onClick={()=>void reload()} disabled={busy}>{t("重新读取预览")}</button>}</div>{(error||viewer.error)&&<p className="attachment-error-text" role="alert">{error||viewer.error}</p>}{(busy||viewer.busy)&&<small role="status">{t("正在读取…")}</small>}</div>
  </div>{viewer.full&&<ImageViewer url={viewer.full} name={attachment.name} onClose={viewer.close} returnFocus={viewer.returnFocus}/>}</>;
}
function sizeLabel(bytes?:number){return bytes===undefined?t("大小待确认"):bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;}
