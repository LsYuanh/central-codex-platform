// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { errorMessage, UiError, useMessageState } from "./i18n.ts";

import { invoke } from "./native-invoke";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
type LocalFile = { deviceId: string; deviceKey?: string; path?: string; version?: string; status?: string };
const request = <T>(method: string, params: Record<string, unknown> = {}) => invoke<T>("attachment_request", { method, params });

export async function checkLocalFile(file: LocalFile) {
  if (!isTauri()) throw new UiError("请在来源桌面设备查看此文件");
  if (file.status && file.status !== "saved") throw new UiError("文件尚未保存");
  const identity = await request<{deviceId: string; deviceKey: string}>("attachment/identity");
  if (identity.deviceId !== file.deviceId || (file.deviceKey && identity.deviceKey !== file.deviceKey)) throw new UiError("请在来源设备查看此文件");
  if (!file.path || !file.version) throw new UiError("文件尚未保存或缺少版本信息");
  const stat = await request<{version: string}>("file/stat", {path: file.path});
  if (stat.version !== file.version) throw new UiError("文件已变化，请重新提供最新文件");
}
export async function revealLocalFile(file: LocalFile) {
  await checkLocalFile(file);
  await request("file/reveal", {path: file.path});
}

/** Returns a caller-owned object URL. Always close the bounded Agent transfer. */
export async function readFullImage(file: LocalFile, cancelled: () => boolean) {
  await checkLocalFile(file);
  let transferId: string | undefined;
  try {
    if (cancelled()) throw new UiError("图片读取已取消");
    const opened = await request<{transferId: string; totalBytes: number; chunkBytes: number; mimeType: string}>("file/read_image", {path: file.path, version: file.version});
    transferId = opened.transferId;
    if (!Number.isSafeInteger(opened.totalBytes) || opened.totalBytes <= 0 || opened.totalBytes > 20 * 1024 * 1024 || opened.chunkBytes !== 256 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(opened.mimeType)) throw new UiError("图片预览格式或大小不受支持");
    const data = new Uint8Array(opened.totalBytes), deadline = Date.now() + 60_000;
    for (let offset = 0; offset < data.length; offset += opened.chunkBytes) {
      if (cancelled() || Date.now() > deadline) throw new UiError("图片读取已取消或超时");
      const chunk = await request<{data: string; offset: number; done: boolean}>("file/read_chunk", {transferId, offset});
      const raw = atob(chunk.data), expected = Math.min(opened.chunkBytes, data.length - offset);
      if (chunk.offset !== offset || raw.length !== expected || chunk.done !== (offset + expected === data.length)) throw new UiError("图片内容校验失败");
      for (let i = 0; i < raw.length; i++) data[offset + i] = raw.charCodeAt(i);
    }
    if (cancelled()) throw new UiError("图片读取已取消");
    return URL.createObjectURL(new Blob([data], {type: opened.mimeType}));
  } finally { if (transferId) await request("file/close_transfer", {transferId}).catch(() => undefined); }
}

export function useFullImage(file?: LocalFile, remoteUrl?: string) {
  const [full, setFull] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useMessageState("");
  const generation = useRef(0), owned = useRef("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useCallback(() => { generation.current++; if (owned.current) URL.revokeObjectURL(owned.current); owned.current = ""; setFull(""); setBusy(false); }, []);
  useEffect(() => { close(); setError(""); return () => { generation.current++; if (owned.current) URL.revokeObjectURL(owned.current); owned.current = ""; }; }, [file?.path, file?.version, file?.deviceId, file?.deviceKey, file?.status, remoteUrl, close]);
  async function open() {
    if (busy) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const attempt = ++generation.current;
    setBusy(true); setError("");
    try {
      if (!file && !/^https:\/\//i.test(remoteUrl ?? "")) throw new UiError("图片不可用");
      const url = file ? await readFullImage(file, () => generation.current !== attempt) : remoteUrl!;
      if (generation.current !== attempt) { if (file) URL.revokeObjectURL(url); return; }
      if (owned.current) URL.revokeObjectURL(owned.current);
      owned.current = file ? url : ""; setFull(url);
    } catch (reason) { if (generation.current === attempt) setError(errorMessage(reason)); }
    finally { if (generation.current === attempt) setBusy(false); }
  }
  return {full, busy, error, open, close, returnFocus: returnFocus.current};
}
