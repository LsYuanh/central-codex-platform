// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { localAttachment } from "./attachments";
import type { MessageAttachment, OutputArtifact } from "../../../packages/agentrpc-types/src/index";
import { ImageViewer } from "./ImageViewer";
import { useFullImage } from "./file-preview";
export type MarkdownImageReference = MessageAttachment | OutputArtifact;

function normalizePath(path: string): string {
  if (/^file:\/\//i.test(path)) {
    try { const url = new URL(path); if (!url.hostname) path = url.pathname.replace(/^\/([A-Za-z]:\/)/, "$1"); } catch { /* Leave unsupported URLs unmatched. */ }
  }
  try { path = decodeURIComponent(path); } catch { /* Keep literal invalid escapes. */ }
  path = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}
function findReference(source: string, references: MarkdownImageReference[]) {
  return references.find(ref => ref.kind === "image" && ref.path && normalizePath(ref.path) === normalizePath(source));
}
export function MarkdownImage({ source, alt, title, references = [] }: { source: string; alt: string; title?: string; references?: MarkdownImageReference[] }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const deadline = useRef<number | undefined>(undefined);
  const ref = findReference(source, references);
  const viewer = useFullImage(/^https:\/\//i.test(source) ? undefined : ref, source);
  useEffect(() => {
    let cancelled = false;
    setUrl(""); setError(""); setLoaded(false);
    const timeout = window.setTimeout(() => { cancelled = true; setUrl(""); setError("图片加载超时"); }, 15_000);
    deadline.current = timeout;
    const resolve = async () => {
      if (/^https:\/\//i.test(source)) return new URL(source).href;
      if (!ref) throw new Error("图片未关联本机附件或输出文件，请通过附件／文件输出提供");
      if (!isTauri()) throw new Error("请在来源桌面设备查看图片");
      const identity = await localAttachment<{ deviceId: string; deviceKey: string }>("attachment/identity");
      if (identity.deviceId !== ref.deviceId || ("deviceKey" in ref && ref.deviceKey && identity.deviceKey !== ref.deviceKey)) throw new Error("请在来源设备查看图片");
      if (!ref.version || ("status" in ref && ref.status !== "saved")) throw new Error("图片尚未保存或缺少文件版本");
      const result = await localAttachment<{ url: string }>("status" in ref ? "attachment/output_preview" : "attachment/preview", { path: ref.path, version: ref.version });
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(result.url)) throw new Error("不支持的预览格式");
      return result.url;
    };
    void resolve().then(result => { if (!cancelled) setUrl(result); }).catch(reason => { if (!cancelled) { window.clearTimeout(timeout); setError(String(reason instanceof Error ? reason.message : reason)); } });
    // The separate image load timer handles network/decode after IPC resolution.
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [source, ref?.path, ref?.version, ref?.deviceId, ref && "deviceKey" in ref ? ref.deviceKey : undefined, ref && "status" in ref ? ref.status : undefined, attempt]);
  // A successfully decoded image must not later become a timeout error.
  // Resolution and decoding share a finite deadline; the parent remounts only on source changes.
  return <span className="markdown-image" title={title}>
    {url && !error && <button className="result-image-button" type="button" aria-label={`放大图片 ${alt}`} disabled={!loaded || viewer.busy} onClick={() => void viewer.open()}><img src={url} alt={alt} referrerPolicy="no-referrer" onLoad={() => { window.clearTimeout(deadline.current); setLoaded(true); }} onError={() => { window.clearTimeout(deadline.current); setError("图片无法加载，请检查地址或源文件"); }} /></button>}
    {(!loaded || error) && <span className="markdown-image-status" role="status">{alt} · {error || "正在加载图片…"}{error && <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>}</span>}
    {loaded && !error && (title || alt) && <span className="markdown-image-caption">{title || alt}</span>}
    {(viewer.busy || viewer.error) && <span className="markdown-image-status" role="status">{viewer.error || "正在读取大图…"}</span>}
    {viewer.full && <ImageViewer url={viewer.full} name={alt} onClose={viewer.close} returnFocus={viewer.returnFocus} />}
  </span>;
}
