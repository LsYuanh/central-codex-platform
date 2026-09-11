// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { UiIcon } from "./UiIcon";
import type { ThemeMode } from "./theme";

const options = [
  { value: "system", label: "跟随系统", icon: "monitor" },
  { value: "light", label: "浅色", icon: "sun" },
  { value: "dark", label: "深色", icon: "moon" },
] as const;

export function ThemePicker({ value, onChange }: { value: ThemeMode; onChange: (value: ThemeMode) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find(option => option.value === value) ?? options[0];

  const dismiss = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const top = anchor.bottom + 8 + menu.offsetHeight <= window.innerHeight - 8
        ? anchor.bottom + 8 : Math.max(8, anchor.top - menu.offsetHeight - 8);
      setPosition({ top, left: Math.max(8, Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) });
    };
    place();
    optionRefs.current[options.findIndex(option => option.value === value)]?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
    if (event.key === "Tab") { dismiss(); return; }
    const current = optionRefs.current.findIndex(option => option === document.activeElement);
    const next = event.key === "ArrowDown" ? (current + 1) % options.length
      : event.key === "ArrowUp" ? (current + options.length - 1) % options.length
      : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : undefined;
    if (next !== undefined) { event.preventDefault(); optionRefs.current[next]?.focus(); }
  };

  return <>
    <button ref={triggerRef} type="button" className="theme-picker-trigger" aria-label={`主题：${selected.label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "theme-options" : undefined}
      onClick={() => setOpen(current => !current)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      <span>{selected.label}</span><UiIcon name="chevronDown" />
    </button>
    {open && createPortal(<div ref={menuRef} id="theme-options" className="theme-picker-menu" role="menu" aria-label="主题" style={position} onKeyDown={handleKeyDown}>
      {options.map((option, index) => <button key={option.value} ref={element => { optionRefs.current[index] = element; }} type="button" role="menuitemradio" aria-checked={value === option.value} tabIndex={-1}
        onClick={() => { onChange(option.value); dismiss(); }}>
        <UiIcon name={option.icon} /><span>{option.label}</span>{value === option.value && <UiIcon name="check" />}
      </button>)}
    </div>, document.body)}
  </>;
}
