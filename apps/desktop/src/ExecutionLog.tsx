// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale } from "./i18n";

import { useEffect, useRef, useState } from "react";
import type { ExecutionLogChunk } from "./gateway-ui-events";
import { CopyButton } from "./result-controls";

export function ExecutionLog({ logs }: { logs: ExecutionLogChunk[] }) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [filter, setFilter] = useState("all");
  const visible = logs.filter(row => filter === "all" || row.stream === filter);
  useEffect(() => { if (ref.current && pinned.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs, filter]);
  return <div className="execution-output"><div className="result-toolbar"><div className="log-filters" role="group" aria-label={t("输出筛选")}>{[["all", t("全部")], ["stdout", t("标准输出")], ["stderr", t("错误输出")], ["progress", t("进度")]].map(([value, label]) => <button className="result-control" type="button" key={value} aria-pressed={filter === value} onClick={() => { pinned.current = true; setFilter(value); }}>{label}</button>)}</div><CopyButton text={visible.map(row => row.chunk).join("")} label={t("复制当前输出")} /></div>
    <div ref={ref} className="execution-log" role="log" tabIndex={0} aria-label={t("实时命令输出")} onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28; }}>{visible.length ? visible.map((entry, index) => <span className={`execution-log-${entry.stream}`} key={`${entry.sequence}-${index}`}>{entry.chunk}</span>) : t("当前分类暂无输出")}</div>
  </div>;
}
