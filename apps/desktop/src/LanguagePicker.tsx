// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { setLanguage, t, useLocale, type Language } from "./i18n";
import { UiIcon } from "./UiIcon";

const languages: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

export function LanguagePicker() {
  const language = useLocale();
  const name = useId();
  const pending = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: "", time: 0 });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 240 });
  const selected = languages.findIndex(option => option.value === language);
  const expanded = open && !busy;
  function show() {
    if (pending.current) return;
    setActive(selected); search.current.text = ""; setOpen(true);
  }
  // Keep the trigger focused while saving, but ignore further changes until it settles.
  async function change(next: Language) {
    if (pending.current) return;
    setOpen(false); trigger.current?.focus({ preventScroll: true });
    if (next === language) return;
    pending.current = true; setBusy(true); setFailed(false);
    try { await setLanguage(next); }
    catch { setFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const bounds = root.current?.closest(".settings-scroll")?.getBoundingClientRect();
      const below = Math.min(innerHeight, bounds?.bottom ?? innerHeight) - box.bottom - 12;
      const above = box.top - Math.max(0, bounds?.top ?? 0) - 12;
      const flip = below < 140 && above > below;
      setPlacement({ above: flip, maxHeight: Math.max(32, Math.min(240, flip ? above : below)) });
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [expanded]);
  useEffect(() => {
    if (expanded) document.getElementById(`${name}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, active, name]);
  return <div className="language-setting">
    <div className="settings-field"><span><strong id={`${name}-label`}>{t("语言 / Language")}</strong><small id={`${name}-hint`}>{t("立即应用，下次启动时保留。")}</small></span>
      <div className="language-picker" ref={root} onBlur={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
        <button id="desktop-language" ref={trigger} type="button" role="combobox" className="language-picker-trigger"
          aria-labelledby={`${name}-label ${name}-value`} aria-describedby={`${name}-hint`} aria-haspopup="listbox"
          aria-expanded={expanded} aria-controls={expanded ? `${name}-list` : undefined}
          aria-activedescendant={expanded ? `${name}-option-${active}` : undefined} aria-disabled={busy} aria-busy={busy}
          onClick={() => expanded ? setOpen(false) : show()} onKeyDown={event => {
            if (event.nativeEvent.isComposing || pending.current) return;
            if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
            if (event.key === "Tab") { setOpen(false); return; }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault(); if (expanded) void change(languages[active].value); else show(); return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); if (!expanded) show();
              else setActive((active + (event.key === "ArrowDown" ? 1 : -1) + languages.length) % languages.length);
              return;
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault(); show(); setActive(event.key === "Home" ? 0 : languages.length - 1); return;
            }
            if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              const now = Date.now();
              const text = (now - search.current.time < 700 ? search.current.text : "") + event.key.toLocaleLowerCase();
              if (!expanded) show();
              search.current = { text, time: now };
              const index = languages.findIndex(option => option.label.toLocaleLowerCase().startsWith(text));
              if (index >= 0) setActive(index);
            }
          }}><span id={`${name}-value`} lang={language}>{languages[selected].label}</span><UiIcon name="chevronDown" /></button>
        {expanded && <div id={`${name}-list`} role="listbox" aria-labelledby={`${name}-label`}
          className={`language-picker-menu${placement.above ? " above" : ""}`} style={{ maxHeight: placement.maxHeight }}>
          {languages.map((option, index) => <button key={option.value} id={`${name}-option-${index}`} type="button" role="option"
            className={`language-picker-option${active === index ? " highlighted" : ""}`} aria-selected={option.value === language}
            tabIndex={-1} onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => void change(option.value)}>
            <span lang={option.value}>{option.label}</span><span className="language-picker-check">{option.value === language && <UiIcon name="check" />}</span>
          </button>)}
        </div>}
      </div>
    </div>
    {failed && <p className="settings-error" role="alert">{t("语言设置未确认，请重试。")}</p>}
  </div>;
}
