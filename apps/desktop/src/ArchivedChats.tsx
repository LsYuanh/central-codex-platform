// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale, currentLanguage } from "./i18n";

import { useState, type RefObject } from "react";
import type { ThreadSummary } from "./gateway-ui-events";
import type { ClientProject } from "./projects";
import { UiIcon } from "./UiIcon";

export function ArchivedChats({ threads, projects, groupFor, online, loading, complete, busy, error, notice, refreshRef, refresh, restore, remove, removeAll, copyId }: {
  threads: ThreadSummary[]; projects: ClientProject[]; groupFor: (thread: ThreadSummary) => string | null;
  online: boolean; loading: boolean; complete: boolean; busy?: string; error: string; notice: string;
  refreshRef: RefObject<HTMLButtonElement | null>; refresh: () => void; restore: (thread: ThreadSummary) => void;
  remove: (thread: ThreadSummary, trigger: HTMLElement) => void; removeAll: (trigger: HTMLElement) => void; copyId: (id: string) => void;
}) {
  useLocale();
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("all");
  const title = (thread: ThreadSummary) => thread.name?.trim() || thread.preview?.trim() || t("新对话");
  const query = search.trim().toLocaleLowerCase();
  const grouped = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const key = groupFor(thread) ?? "none";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(thread);
  }
  const groups = [...grouped].sort(([a], [b]) => a === "none" ? -1 : b === "none" ? 1 : projects.findIndex(p => p.id === a) - projects.findIndex(p => p.id === b));
  const name = (key: string) => projects.find(p => p.id === key)?.name ?? t("无项目");
  const selected = project === "all" || grouped.has(project) ? project : "all";
  const visible = groups.filter(([key]) => selected === "all" || key === selected).map(([key, rows]) => ({
    key, rows: rows.filter(t => !query || `${title(t)} ${t.preview ?? ""} ${t.id}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0)),
  })).filter(group => group.rows.length);
  const disabled = !online || loading || Boolean(busy);
  return <>
    <header className="settings-header archived-header">
      <h1>{t("已归档聊天")}</h1>
      <div className="archived-header-actions">
        <button ref={refreshRef} className="button-quiet archived-refresh" aria-label={t("刷新归档对话")} title={t("刷新")} disabled={disabled} onClick={refresh}><UiIcon name="refresh" /></button>
        <button className="archived-delete-all" disabled={disabled || !complete || !threads.length} onClick={e => removeAll(e.currentTarget)}><UiIcon name="trash" />{t("全部删除")}</button>
      </div>
    </header>
    <div className="settings-content archived-settings-content">
      <div className="archived-toolbar">
        <label className="archived-search"><UiIcon name="search" /><input type="search" aria-label={t("搜索已归档聊天")} placeholder={t("搜索已归档聊天")} value={search} onChange={e => setSearch(e.target.value)} /></label>
        <label className="archived-project-filter"><UiIcon name="folder" /><select aria-label={t("筛选项目")} value={selected} onChange={e => setProject(e.target.value)}><option value="all">{t("所有项目")}</option>{groups.map(([key]) => <option key={key} value={key}>{name(key)}</option>)}</select><UiIcon name="chevronDown" /></label>
      </div>
      {error && <p className="settings-error" role="alert">{error}<button className="button-quiet" disabled={disabled} onClick={refresh}>{t("重新加载")}</button></p>}
      <div className="archived-feedback" role="status">{loading ? t("正在加载已归档聊天…") : !online ? t("连接后显示已归档聊天") : notice}</div>
      <div aria-busy={loading}>
        {visible.map(({key, rows}) => <section className="archived-group" key={key} aria-label={name(key)}>
          <div className="archived-group-heading"><h2><UiIcon name="folder" />{name(key)}</h2><span>{t("聊天数量", { count: rows.length })}</span></div>
          <div className="archived-thread-list" role="list" aria-label={t("{{p0}}的已归档聊天", { p0: name(key) })}>
            {rows.map(thread => {
              const date = thread.updatedAt ? new Date(thread.updatedAt) : undefined;
              const validDate = date && Number.isFinite(date.getTime());
              return <div className="archived-thread-row" role="listitem" key={thread.id}>
                <div className="archived-thread-copy"><strong title={title(thread)}>{title(thread)}</strong><small title={t("最后更新时间")}>{validDate ? <time dateTime={date.toISOString()}>{date.toLocaleString(currentLanguage(), {year:"numeric", month:"long", day:"numeric", hour:"2-digit", minute:"2-digit", hour12:false})}</time> : t("更新时间未知")}</small></div>
                <div className="archived-thread-actions">
                  <button className="button-quiet archived-thread-copy-id" title={t("复制对话 ID")} aria-label={t("复制对话 ID：{{p0}}", { p0: title(thread) })} onClick={() => copyId(thread.id)}><UiIcon name="copy" /></button>
                  <button className="button-quiet archived-thread-delete" title={t("永久删除")} aria-label={t("永久删除对话：{{p0}}", { p0: title(thread) })} disabled={disabled} onClick={e => remove(thread, e.currentTarget)}><UiIcon name="trash" /></button>
                  <button className="button-secondary archived-restore" aria-label={t("取消归档：{{p0}}", { p0: title(thread) })} disabled={disabled} onClick={() => restore(thread)}>{busy === `${thread.id}:unarchive` ? t("恢复中…") : t("取消归档")}</button>
                </div>
              </div>;
            })}
          </div>
        </section>)}
        {!visible.length && !loading && online && !error && <div className="settings-empty-state"><span>{threads.length ? t("没有匹配的已归档聊天") : t("暂无已归档聊天")}</span>{(search || selected !== "all") && <button className="button-quiet" onClick={() => {setSearch(""); setProject("all");}}>{t("清除筛选")}</button>}</div>}
      </div>
    </div>
  </>;
}
