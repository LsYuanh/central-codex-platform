// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "./result-controls";

function JsonSource({ text, streaming }: { text: string; streaming: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (ref.current) ref.current.textContent = text;
    if (!streaming && text.length <= 100_000) void import("./markdown-highlight").then(({ highlight }) => {
      if (!cancelled && ref.current) ref.current.innerHTML = highlight(text, "json");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [text, streaming]);
  return <pre className="result-source markdown-code-block" tabIndex={0}><code ref={ref}>{text}</code></pre>;
}

function JsonNode({ value, label, depth = 0 }: { value: unknown; label: string; depth?: number }) {
  const [open, setOpen] = useState(depth === 0);
  const [limit, setLimit] = useState(100);
  if (value === null || typeof value !== "object") return <div className="json-leaf"><span>{label}: </span><code>{JSON.stringify(value)}</code></div>;
  const entries = Object.entries(value);
  return <div className="json-node"><button className="json-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "▾" : "▸"} {label} <span>{Array.isArray(value) ? `数组 [${entries.length}]` : `对象 {${entries.length}}`}</span></button>
    {open && (depth >= 32 ? <p>嵌套过深，请切换源码查看。</p> : <div className="json-children">{entries.slice(0, limit).map(([key, child]) => <JsonNode key={key} label={key} value={child} depth={depth + 1} />)}{entries.length > limit && <button className="result-control" type="button" onClick={() => setLimit(limit + 100)}>显示后续 {Math.min(100, entries.length - limit)} 项</button>}</div>)}
  </div>;
}

export function JsonView({ text, streaming }: { text: string; streaming: boolean }) {
  const [source, setSource] = useState(false);
  const parsed = useMemo(() => {
    if (streaming) return { error: "生成中，先展示原文" };
    if (text.length > 100_000) return { error: "JSON 较大，已保留源码" };
    try {
      const value = JSON.parse(text) as unknown, pending = [value];
      while (pending.length) {
        const entry = pending.pop();
        if (typeof entry === "number" && (!Number.isFinite(entry) || (Number.isInteger(entry) && !Number.isSafeInteger(entry)))) return {error: "JSON 包含超出安全精度的数字，已保留原文"};
        if (entry !== null && typeof entry === "object") pending.push(...Object.values(entry));
      }
      return { value };
    } catch { return { error: "JSON 格式不完整或无效，已保留原文" }; }
  }, [text, streaming]);
  return <section className="structured-result" aria-label="JSON 内容"><div className="result-toolbar"><strong>JSON</strong>{!parsed.error && <button className="result-control" type="button" onClick={() => setSource(!source)}>{source ? "树形视图" : "查看源码"}</button>}<CopyButton text={text} /></div>
    {parsed.error && <p className="result-notice" role="status">{parsed.error}</p>}
    {source || parsed.error ? <JsonSource text={text} streaming={streaming}/> : <div className="json-tree" key={text}><JsonNode label="根节点" value={parsed.value} /></div>}
  </section>;
}
