// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale, message as uiMessage, useMessageState } from "./i18n";

import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label = t("复制原文") }: { text: string; label?: string }) {
  useLocale();
  const [state, setState] = useMessageState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement("textarea");
        const previous = document.activeElement as HTMLElement | null;
        field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
        document.body.appendChild(field);
        try { field.select(); if (!document.execCommand("copy")) throw new Error(); }
        finally { field.remove(); previous?.focus(); }
      }
      setState(uiMessage("已复制"));
    } catch { setState(uiMessage("复制失败，请重试")); }
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setState(""), 2200);
  }
  return <button type="button" className="result-control" onClick={() => void copy()} aria-label={label}><span role="status">{state || label}</span></button>;
}

export function fileDescription(file: { name: string; bytes?: number; mimeType?: string }) {
  const extension = file.name.match(/\.([a-z0-9]{1,12})$/i)?.[1].toUpperCase();
  const bytes = file.bytes;
  const size = bytes === undefined ? t("大小待确认") : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${extension || file.mimeType || t("文件")} · ${size}`;
}
