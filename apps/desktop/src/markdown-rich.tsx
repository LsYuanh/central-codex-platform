// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useId, useRef, useState } from "react";
import { JsonView } from "./JsonView";
import { DiffView } from "./DiffView";

export function MarkdownMath({ text, display = false, streaming = false }: { text: string; display?: boolean; streaming?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (ref.current) ref.current.textContent = text;
    if (streaming) return;
    void Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([{ default: katex }]) => {
      if (cancelled || !ref.current) return;
      if (text.length > 20_000) throw new Error("公式过长");
      katex.render(text, ref.current, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 });
    }).catch(() => { if (!cancelled) { if (ref.current) ref.current.textContent = text; setError("公式无法显示，已保留源码"); } });
    return () => { cancelled = true; };
  }, [text, display, streaming]);
  return <span className={display ? "markdown-math markdown-math-display" : "markdown-math"}><span ref={ref}>{text}</span>{error && <small role="status" className="markdown-render-error">{error}</small>}</span>;
}

export function MarkdownCode({ text, language, streaming }: { text: string; language: string; streaming: boolean }) {
  if (language.toLowerCase() === "json") return <JsonView text={text} streaming={streaming} />;
  if (["diff", "patch"].includes(language.toLowerCase()) && !streaming) return <DiffView text={text} />;
  return <CodeBlock text={text} language={language} streaming={streaming} />;
}
function CodeBlock({ text, language, streaming }: { text: string; language: string; streaming: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [copyState, setCopyState] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    let cancelled = false;
    if (ref.current) ref.current.textContent = text;
    if (!language || language === "mermaid" || streaming || text.length > 100_000) return;
    void import("./markdown-highlight").then(({ highlight }) => {
      if (!cancelled && ref.current) ref.current.innerHTML = highlight(text, language);
    }).catch(() => { /* Plain code remains readable if highlighting is unavailable. */ });
    return () => { cancelled = true; };
  }, [text, language, streaming]);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement("textarea"); field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
        document.body.appendChild(field);
        try { field.select(); if (!document.execCommand("copy")) throw new Error("copy failed"); } finally { field.remove(); }
      }
      setCopyState("已复制");
    } catch { setCopyState("复制失败，请重试"); }
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCopyState(""), 2000);
  };
  return <div className="markdown-code-wrap"><div className="markdown-code-toolbar"><span>{language || "代码"}</span><button type="button" onClick={() => void copy()}>{copyState || "复制"}</button></div>
    {language.toLowerCase() === "mermaid" ? <MermaidDiagram text={text} streaming={streaming} /> : <pre className="markdown-code-block" tabIndex={0}><code ref={ref} className={language ? `language-${language}` : undefined}>{text}</code></pre>}
  </div>;
}

// Mermaid has shared configuration; serialize initialize/render across all messages.
let diagramQueue: Promise<unknown> = Promise.resolve();
function MermaidDiagram({ text, streaming }: { text: string; streaming: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  useEffect(() => { const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); return () => observer.disconnect(); }, []);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setUrl(""); setError("");
    if (streaming) return;
    const timer = window.setTimeout(() => { cancelled = true; setError("图表显示超时，请查看源码"); }, 15_000);
    const job = async () => {
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;
      if (text.length > 30_000 || /^\s*---/.test(text) || /%%\s*\{/.test(text)) throw new Error("不支持图表配置指令或超长图表");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default", htmlLabels: false, suppressErrorRendering: true, maxTextSize: 30_000, maxEdges: 500, flowchart: { htmlLabels: false } });
      const container = document.createElement("div"); container.className = "markdown-diagram-measure"; document.body.appendChild(container);
      try {
        const { svg } = await mermaid.render(`diagram-${id}`, text, container);
        if (!cancelled) { objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); setUrl(objectUrl); }
      } finally { container.remove(); }
    };
    diagramQueue = diagramQueue.catch(() => undefined).then(job).catch(() => { if (!cancelled) setError("图表无法显示，请检查源码格式"); }).finally(() => window.clearTimeout(timer));
    return () => { cancelled = true; window.clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [text, streaming, theme, id]);
  return <div className="markdown-diagram">
    {url && <div className="markdown-diagram-scroll" tabIndex={0} role="region" aria-label="Mermaid 图表"><img src={url} alt="Mermaid 图表，源码见下方" onError={() => { setUrl(""); setError("图表图片无法显示，请查看源码"); }} /></div>}
    {!url && <p className="markdown-render-error" role="status">{error || (streaming ? "图表生成中，先展示源码" : "正在绘制图表…")}</p>}
    {url ? <details><summary>查看源码</summary><pre className="markdown-code-block">{text}</pre></details> : <pre className="markdown-code-block">{text}</pre>}
  </div>;
}
