// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useRef, useState } from "react";
import { setLanguage, t, useLocale, type Language } from "./i18n";

export function LanguagePicker() {
  const language = useLocale();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function change(next: Language) {
    if (pending.current || next === language) return;
    pending.current = true; setBusy(true); setFailed(false);
    try { await setLanguage(next); }
    catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="language-setting">
    <div className="settings-field"><label htmlFor="desktop-language"><strong>{t("语言 / Language")}</strong><small>{t("立即应用，下次启动时保留。")}</small></label>
      <select id="desktop-language" value={language} disabled={busy} onChange={event => void change(event.target.value as Language)}>
        <option value="zh-CN" lang="zh-CN">简体中文</option><option value="en" lang="en">English</option>
      </select>
    </div>
    {failed && <p className="settings-error" role="alert">{t("语言设置未确认，请重试。")}</p>}
  </div>;
}
