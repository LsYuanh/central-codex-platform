// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import { localAttachment } from "./attachments";
import { UiIcon } from "./UiIcon";
import { CopyButton, fileDescription } from "./result-controls";
import { ImageViewer } from "./ImageViewer";
import { checkLocalFile, revealLocalFile, useFullImage } from "./file-preview";
import type { OutputArtifact } from "../../../packages/agentrpc-types/src/index";
export type { OutputArtifact };

export function OutputCard({ output, retry }: { output: OutputArtifact; retry: (output: OutputArtifact) => Promise<void> }) {
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const viewer = useFullImage(output);
  const reload = useCallback(async () => {
    const attempt = ++generation.current;
    setBusy(true); setError(""); setPreview("");
    try {
      await checkLocalFile(output);
      if (output.kind === "image") {
        const result = await localAttachment<{ url: string }>("attachment/output_preview", {path: output.path, version: output.version});
        if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(result.url)) throw new Error("不支持的图片预览格式");
        if (attempt === generation.current) setPreview(result.url);
      }
    } catch (reason) { if (attempt === generation.current) setError(String(reason)); }
    finally { if (attempt === generation.current) setBusy(false); }
  }, [output.deviceId, output.deviceKey, output.path, output.version, output.kind]);
  useEffect(() => { if (output.status === "saved") void reload(); else { setPreview(""); setBusy(false); setError(""); } return () => { generation.current++; }; }, [output.status, reload]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  const pending = busy || viewer.busy;
  return <>
    <section className={`output-card output-${output.status} output-kind-${output.kind}`} aria-label={`输出文件 ${output.name}`}>
      {preview && <button className="output-image-button" type="button" onClick={() => void viewer.open()} disabled={pending} aria-label={`查看图片 ${output.name}`}><img src={preview} alt={output.name} onError={() => { setPreview(""); setError("图片预览无法加载，请重新读取"); }}/></button>}
      <div className="output-file-heading"><span className="output-file-icon"><UiIcon name="file" /></span><div className="output-file-copy"><strong title={output.name}>{output.name}</strong><small>{fileDescription(output)}</small><span role="status">{output.status === "saved" ? "已保存到本机" : output.status === "saving" ? "正在保存到本机…" : "保存失败"}</span></div></div>
      {output.path && <details className="output-location"><summary>文件位置</summary><p className="output-path">{output.path}</p></details>}
      {(output.error || error || viewer.error) && <p role="alert" className="attachment-error-text">{error || viewer.error || output.error}</p>}
      <div className="output-actions">
        {output.path && <CopyButton text={output.path} label="复制路径"/>}
        {output.status === "saved" && <>{output.kind === "image" && <button type="button" onClick={() => void viewer.open()} disabled={pending}>查看大图</button>}<button type="button" onClick={() => void act(() => revealLocalFile(output))} disabled={pending}>打开所在目录</button>{error && <button type="button" onClick={() => void reload()} disabled={pending}>重新读取</button>}</>}
        {output.status === "failed" && output.source === "generatedImage" && <button type="button" onClick={() => void act(() => retry(output))} disabled={pending}>重试保存</button>}
        {pending && <span role="status">正在处理…</span>}
      </div>
    </section>
    {viewer.full && <ImageViewer url={viewer.full} name={output.name} onClose={viewer.close} returnFocus={viewer.returnFocus}/>}
  </>;
}
