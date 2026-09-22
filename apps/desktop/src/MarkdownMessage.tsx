// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { memo, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { markdownHtmlSchema, markdownTextColor, scopeMarkdownIds } from "./markdown-html";
import { MarkdownCode, MarkdownMath } from "./markdown-rich";
import { MarkdownImage, type MarkdownImageReference } from "./markdown-images";

interface MarkdownMessageProps {
  content: string;
  streaming?: boolean;
  images?: MarkdownImageReference[];
}
const plugins = [remarkGfm, remarkBreaks, remarkMath];

/** Parse Markdown and allowlisted HTML as React nodes after sanitation. */
export const MarkdownMessage = memo(function MarkdownMessage({ content, streaming = false, images }: MarkdownMessageProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const prefix = `md-${id}-`;
  const htmlPlugins = useMemo<NonNullable<ComponentProps<typeof Markdown>["rehypePlugins"]>>(() => [rehypeRaw, [rehypeSanitize, markdownHtmlSchema], [scopeMarkdownIds, { prefix }]], [prefix]);
  const components = useMemo<Components>(() => ({
    p: ({ children, style, id }) => <p id={id} className="markdown-paragraph" style={{ color: markdownTextColor(style?.color) }}>{children}</p>,
    span: ({ children, style, id }) => <span id={id} style={{ color: markdownTextColor(style?.color) }}>{children}</span>,
    h1: ({ children, ...props }) => <h1 className="markdown-heading markdown-heading-1" id={props.id}>{children}</h1>,
    h2: ({ children, ...props }) => <h2 className={props.className === "sr-only" ? "sr-only" : "markdown-heading markdown-heading-2"} id={props.id}>{children}</h2>,
    h3: ({ children, id }) => <h3 id={id} className="markdown-heading markdown-heading-3">{children}</h3>,
    h4: ({ children, id }) => <h4 id={id} className="markdown-heading markdown-heading-4">{children}</h4>,
    h5: ({ children, id }) => <h5 id={id} className="markdown-heading markdown-heading-5">{children}</h5>,
    h6: ({ children, id }) => <h6 id={id} className="markdown-heading markdown-heading-6">{children}</h6>,
    ul: ({ children, className }) => <ul className={`markdown-list ${className ?? ""}`}>{children}</ul>,
    ol: ({ children, start }) => <ol className="markdown-list" start={start}>{children}</ol>,
    table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表格，可横向滚动"><table>{children}</table></div>,
    pre: ({ node, children }) => {
      const code = node?.children[0];
      if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
      const classes = String(code.properties.className ?? "").split(/[ ,]+/);
      const text = code.children.map(child => child.type === "text" ? child.value : "").join("").replace(/\n$/, "");
      if (classes.includes("math-display")) return <MarkdownMath text={text} display streaming={streaming} />;
      const language = classes.find(value => value.startsWith("language-"))?.slice(9) ?? "";
      return <MarkdownCode text={text} language={language} streaming={streaming} />;
    },
    code: ({ className, children }) => className?.includes("math-inline")
      ? <MarkdownMath text={String(children)} streaming={streaming} />
      : <code className="markdown-inline-code">{children}</code>,
    a: ({ href, children, node: _node, ...props }) => {
      if (href?.startsWith("#")) return <a {...props} className="markdown-link" href={href} onClick={event => {
        event.preventDefault();
        let targetId = href.slice(1);
        try { targetId = decodeURIComponent(targetId); } catch { /* Malformed anchors remain inert. */ }
        const target = document.getElementById(targetId);
        if (target) { target.scrollIntoView({ block: "nearest" }); target.tabIndex = -1; target.focus({ preventScroll: true }); }
      }}>{children}</a>;
      const url = externalUrl(href);
      return url ? <ExternalLink href={url}>{children}</ExternalLink> : <span>{children}</span>;
    },
    img: ({ src, alt, title }) => <MarkdownImage key={src} source={typeof src === "string" ? src : ""} alt={alt ?? "图片"} title={title} references={images} />,
  }), [images, streaming, prefix]);
  return <div className="markdown-message"><Markdown remarkPlugins={plugins} rehypePlugins={htmlPlugins} remarkRehypeOptions={{ clobberPrefix: prefix, footnoteLabel: "注释", footnoteBackLabel: "返回正文" }} components={components}
    urlTransform={(url, key, node) => key === "src" && node.tagName === "img" ? url : defaultUrlTransform(url)}>{content}</Markdown></div>;
});

function externalUrl(href?: string): string | null {
  try { const url = new URL(href ?? ""); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const [error, setError] = useState("");
  const desktop = isTauri();
  const open = async () => { setError(""); try { await openUrl(href); } catch { setError("无法使用系统应用打开链接"); } };
  return <span className="markdown-external-link"><a className="markdown-link" href={href} target={desktop ? undefined : "_blank"} rel="noopener noreferrer"
    onClick={desktop ? event => { event.preventDefault(); void open(); } : undefined}
    onAuxClick={desktop ? event => { event.preventDefault(); void open(); } : undefined}>{children}</a>
    {error && <span className="markdown-link-error" role="alert">{error}</span>}</span>;
}
