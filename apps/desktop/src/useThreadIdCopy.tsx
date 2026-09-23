// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t } from "./i18n";

import { useEffect, useRef, useState } from "react";

export function useThreadIdCopy() {
  const [notice, setNotice] = useState<{ id: string; state: "copying" | "success" | "failed" }>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; clearTimeout(timer.current); }, []);
  const copy = async (id: string) => {
    const attempt = ++generation.current;
    clearTimeout(timer.current);
    setNotice({ id, state: "copying" });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (navigator.clipboard?.writeText) {
        await Promise.race([navigator.clipboard.writeText(id), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error("timeout")), 5000); })]);
      } else {
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const field = document.createElement("textarea");
        field.value = id; field.style.position = "fixed"; field.style.opacity = "0";
        document.body.appendChild(field);
        try { field.select(); if (!document.execCommand("copy")) throw Error("copy failed"); }
        finally { field.remove(); active?.focus({ preventScroll: true }); }
      }
      if (generation.current !== attempt) return;
      setNotice({ id, state: "success" });
      timer.current = setTimeout(() => setNotice(undefined), 2500);
    } catch {
      if (generation.current === attempt) setNotice({ id, state: "failed" });
    } finally { clearTimeout(deadline); }
  };
  return { copy: (id: string) => { void copy(id); }, feedback: notice && <div className="thread-copy-notice" role="status" aria-live="polite">
    <span>{notice.state === "success" ? t("已复制对话 ID") : notice.state === "copying" ? t("正在复制对话 ID…") : t("复制失败，可重试或手动复制：")}</span>
    {notice.state === "failed" && <><code>{notice.id}</code><button type="button" onClick={() => void copy(notice.id)}>{t("重试")}</button></>}
    <button type="button" aria-label={t("关闭复制提示")} onClick={() => { generation.current++; clearTimeout(timer.current); setNotice(undefined); }}>{t("关闭")}</button>
  </div> };
}
