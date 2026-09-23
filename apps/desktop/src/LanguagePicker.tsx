// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useId, useRef, useState } from "react";
import { setLanguage, t, useLocale, type Language } from "./i18n";

export function LanguagePicker() {
  const language = useLocale();
  const name = useId();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Gate pending changes without disabling the radios, so keyboard focus survives saving.
  async function change(next: Language) {
    if (pending.current || next === language) return;
    pending.current = true; setBusy(true); setFailed(false);
    try { await setLanguage(next); }
    catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="language-setting">
    <div className="settings-field"><span><strong id={`${name}-label`}>{t("语言 / Language")}</strong><small id={`${name}-hint`}>{t("立即应用，下次启动时保留。")}</small></span>
      <fieldset id="desktop-language" className="theme-picker" aria-labelledby={`${name}-label`} aria-describedby={`${name}-hint`} aria-disabled={busy} aria-busy={busy}>
        {(["zh-CN", "en"] as const).map(value => <label key={value}>
          <input type="radio" name={name} value={value} checked={language === value} onChange={() => void change(value)} />
          <span lang={value}>{value === "zh-CN" ? "简体中文" : "English"}</span>
        </label>)}
      </fieldset>
    </div>
    {failed && <p className="settings-error" role="alert">{t("语言设置未确认，请重试。")}</p>}
  </div>;
}
