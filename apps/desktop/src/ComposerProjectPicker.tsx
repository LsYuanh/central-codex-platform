// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale } from "./i18n";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ProjectDialog } from "./ProjectSidebar";
import { folderName, type ClientProject, type ProjectDraft } from "./projects";
import { UiIcon } from "./UiIcon";

export function ComposerProjectPicker({ selected, projects, disabled, unavailable, loading, error, refresh, choose, save, remove }: {
  selected?: ClientProject; projects: ClientProject[]; disabled: boolean; unavailable: string;
  loading: boolean; error: string; refresh: () => Promise<void>;
  choose: (project?: ClientProject) => void; save: (draft: ProjectDraft) => Promise<ClientProject>;
  remove: (project: ClientProject) => Promise<void>;
}) {
  useLocale();
  const [open, setOpen] = useState(false), [creating, setCreating] = useState(false);
  const [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 360 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = sorted.filter(p => `${p.name} ${p.folders.join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeIndex = Math.min(active, filtered.length - 1);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const select = (project?: ClientProject) => { if (disabled || (project && unavailable)) return; choose(project); close(); };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (box) setPosition({ left: Math.max(8, Math.min(box.left, innerWidth - Math.min(320, innerWidth - 16) - 8)), bottom: innerHeight - box.top + 6, maxHeight: Math.max(80, Math.min(360, box.top - 14)) });
    };
    place(); search.current?.focus();
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !panel.current?.contains(e.target) && !trigger.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true); document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" }); }, [activeIndex, listId, open]);

  return <div className="composer-project-bar">
    <div className={`composer-project-chip${selected ? " has-project" : ""}`}>
      <button ref={trigger} type="button" className="composer-project-trigger" disabled={disabled} aria-label={selected ? t("选择项目：{{p0}}", { p0: selected.name }) : t("选择项目")} aria-haspopup="dialog" aria-expanded={open} title={selected?.folders[0] ?? t("使用默认工作目录")}
        onClick={() => { setQuery(""); setActive(Math.max(0, sorted.findIndex(p => p.id === selected?.id))); setOpen(!open); }}><UiIcon name="folder" /><span>{selected?.name ?? t("选择项目")}</span></button>
      {selected && <button type="button" className="composer-remove-button composer-project-clear" disabled={disabled} aria-label={t("取消项目选择")} title={t("不在项目中工作")} onClick={() => select()}><UiIcon name="close" /></button>}
    </div>
    {open && createPortal(<div ref={panel} role="dialog" aria-label={t("选择新对话项目")} className="composer-project-popover" style={position}
      onBlur={e => { if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget) && !trigger.current?.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); close(); } }}>
      <label className="composer-project-search"><UiIcon name="search" /><input ref={search} role="combobox" aria-label={t("搜索项目")} placeholder={t("搜索项目")} value={query} aria-expanded={!unavailable} aria-controls={unavailable ? undefined : listId} aria-autocomplete="list"
        aria-activedescendant={!unavailable && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (filtered.length) setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length); }
          if (e.key === "Enter") { e.preventDefault(); if (filtered[activeIndex]) select(filtered[activeIndex]); }
        }} /></label>
      {unavailable ? <p className="composer-project-notice" role="status">{unavailable}</p> : <>
        {error && <p className="composer-project-notice" role="alert">{error}<button type="button" disabled={loading} onClick={() => void refresh()}>{t("重试")}</button></p>}
        {loading && <p className="composer-project-notice" role="status">{t("正在加载项目…")}</p>}
        <div id={listId} role="listbox" aria-label={t("项目列表")} className="composer-project-options">
          {filtered.map((p, i) => <button type="button" role="option" aria-selected={selected?.id === p.id} id={`${listId}-${i}`} tabIndex={-1} key={p.id}
            className={`composer-project-option${activeIndex === i ? " highlighted" : ""}`} title={p.folders[0]} onPointerMove={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => select(p)}>
            <UiIcon name="folder" /><span className="composer-project-name">{p.name}</span><span className="composer-project-folder">{folderName(p.folders[0])}</span>{selected?.id === p.id && <UiIcon name="check" />}
          </button>)}
        </div>
        {!loading && !filtered.length && <p className="composer-project-notice" role="status">{query.trim() ? t("没有匹配的项目") : t("暂无项目，可新建项目关联本机文件夹")}</p>}
      </>}
      <div className="composer-project-menu-actions">
        <button type="button" disabled={!!unavailable || disabled} onClick={() => { setOpen(false); setCreating(true); }}><UiIcon name="plus" />{t("新建项目")}</button>
        <button type="button" disabled={disabled} onClick={() => select()}><UiIcon name="close" />{t("不在项目中工作")}{!selected && <UiIcon name="check" />}</button>
      </div>
    </div>, document.body)}
    {creating && <ProjectDialog save={save} remove={remove} close={() => { setCreating(false); trigger.current?.focus(); }} saved={p => { choose(p); setCreating(false); trigger.current?.focus(); }} />}
  </div>;
}
