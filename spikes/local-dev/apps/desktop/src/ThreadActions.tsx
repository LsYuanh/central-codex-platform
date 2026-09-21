// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UiIcon } from "./UiIcon";

export function ThreadActions({ title, disabled, rename, archive, organize, moveUp, moveDown }: {
  title: string; disabled: boolean; rename: () => void; archive: () => void;
  organize?:()=>void; moveUp?:()=>void; moveDown?:()=>void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const panel = menu.current;
      if (!anchor || !panel) return;
      setPosition({ left: Math.max(8, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - panel.offsetHeight - 8)) });
    };
    place();
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" disabled={disabled} aria-label={`更多操作：${title}`} title="更多操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
      }}><UiIcon name="more" /></button>
    {open && createPortal(<div ref={menu} id={id} className="thread-actions-menu" style={position} role="menu" aria-label={`${title}的操作`} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      if (event.key === "Tab") close(true);
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (current + 1) % buttons.length : event.key === "ArrowUp" ? (current + buttons.length - 1) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
      if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    }}>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => { close(true); rename(); }}><UiIcon name="edit" />重命名</button>
      {organize && <><button type="button" role="menuitem" disabled={disabled||!moveUp} onClick={()=>{close(true);moveUp?.();}}>上移</button><button type="button" role="menuitem" disabled={disabled||!moveDown} onClick={()=>{close(true);moveDown?.();}}>下移</button><button type="button" role="menuitem" disabled={disabled} onClick={()=>{close(true);organize();}}>移动到项目或最近</button></>}
      <button type="button" role="menuitem" disabled={disabled} onClick={() => { close(true); archive(); }}><UiIcon name="archive" />归档对话</button>
    </div>, document.body)}
  </>;
}
