// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import { localAttachment } from "./attachments";
import type { OutputArtifact } from "../../../packages/agentrpc-types/src/index";
export type { OutputArtifact };

export function OutputCard({ output, retry }: { output:OutputArtifact; retry:(output:OutputArtifact)=>Promise<void> }) {
  const [preview,setPreview]=useState<string>();
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [full,setFull]=useState<string>();
  const fullRef=useRef<string|undefined>(undefined);
  const mounted=useRef(true);
  const checkLocal=useCallback(async()=>{
    const identity=await localAttachment<{deviceId:string;deviceKey:string}>("attachment/identity");
    if(identity.deviceId!==output.deviceId || (output.deviceKey&&identity.deviceKey!==output.deviceKey))throw new Error("请在来源设备查看此文件");
    if(!output.path)throw new Error("文件尚未保存");
    const stat=await localAttachment<{version:string}>("file/stat",{path:output.path});
    if(stat.version!==output.version)throw new Error("文件已变化，请重新生成或发布最新文件");
  },[output.deviceId,output.deviceKey,output.path,output.version]);
  const reload=useCallback(async()=>{
    setError("");
    try {
      await checkLocal();
      if(output.kind==="image"){
        const result=await localAttachment<{url:string}>("attachment/output_preview",{path:output.path,version:output.version});
        if(mounted.current)setPreview(result.url);
      }
    }catch(e){if(mounted.current){setPreview(undefined);setError(String(e));}}
  },[checkLocal,output.kind,output.path,output.version]);
  const close=useCallback(()=>{if(fullRef.current)URL.revokeObjectURL(fullRef.current);fullRef.current=undefined;setFull(undefined);},[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(fullRef.current)URL.revokeObjectURL(fullRef.current);};},[]);
  useEffect(()=>{if(output.status==="saved")void reload();},[output.status,reload]);
  useEffect(()=>{
    if(!full)return;
    const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape")close();};
    window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);
  },[full,close]);
  const view=async()=>{
    setBusy(true);setError("");let transferId:string|undefined;
    try {
      await checkLocal();
      const opened=await localAttachment<{transferId:string;totalBytes:number;chunkBytes:number;mimeType:string}>("file/read_image",{path:output.path,version:output.version});
      transferId=opened.transferId;
      if(opened.totalBytes>20*1024*1024 || opened.chunkBytes!==256*1024)throw new Error("图片预览大小超限");
      const data=new Uint8Array(opened.totalBytes);const deadline=Date.now()+60_000;
      for(let offset=0;offset<data.length;offset+=opened.chunkBytes){
        if(!mounted.current||Date.now()>deadline)throw new Error("图片读取已取消或超时");
        const chunk=await localAttachment<{data:string;offset:number;done:boolean}>("file/read_chunk",{transferId,offset});
        const raw=atob(chunk.data);const expected=Math.min(opened.chunkBytes,data.length-offset);
        if(chunk.offset!==offset||raw.length!==expected||chunk.done!==(offset+expected===data.length))throw new Error("图片内容校验失败");
        for(let i=0;i<raw.length;i++)data[offset+i]=raw.charCodeAt(i);
      }
      if(mounted.current){close();const url=URL.createObjectURL(new Blob([data],{type:opened.mimeType}));fullRef.current=url;setFull(url);}
    }catch(e){if(mounted.current)setError(String(e));}
    finally{if(transferId)await localAttachment("file/close_transfer",{transferId}).catch(()=>undefined);if(mounted.current)setBusy(false);}
  };
  const reveal=async()=>{setBusy(true);setError("");try{await checkLocal();await localAttachment("file/reveal",{path:output.path});}catch(e){setError(String(e));}finally{setBusy(false);}};
  const retrySave=async()=>{setBusy(true);setError("");try{await retry(output);}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <>
    <section className={`output-card output-${output.status} output-kind-${output.kind}`} aria-label={`输出文件 ${output.name}`}>
      {preview&&<button className="output-image-button" type="button" onClick={()=>void view()} disabled={busy} aria-label={`查看图片 ${output.name}`}><img src={preview} alt={output.name}/></button>}
      <div className="output-file-heading"><strong>{output.name}</strong><span>{output.status==="saved"?"已保存到本机":output.status==="saving"?"正在保存到本机…":"保存失败"}</span></div>
      {output.path&&<p className="output-path" title={output.path}>{output.path}</p>}
      {(output.error||error)&&<p role="alert" className="attachment-error-text">{error||output.error}</p>}
      <div className="output-actions">
        {output.status==="saved"&&<>{output.kind==="image"&&<button type="button" onClick={()=>void view()} disabled={busy}>查看大图</button>}<button type="button" onClick={()=>void reveal()} disabled={busy}>打开所在目录</button>{error&&<button type="button" onClick={()=>void reload()} disabled={busy}>重新读取</button>}</>}
        {output.status==="failed"&&output.source==="generatedImage"&&<button type="button" onClick={()=>void retrySave()} disabled={busy}>重试保存</button>}
        {busy&&<span role="status">正在处理…</span>}
      </div>
    </section>
    {full&&<div className="output-image-overlay" role="dialog" aria-modal="true" aria-label={output.name} onClick={e=>{if(e.target===e.currentTarget)close();}}><button className="output-image-close" type="button" onClick={close} autoFocus aria-label="关闭图片预览">×</button><img src={full} alt={output.name}/></div>}
  </>;
}
