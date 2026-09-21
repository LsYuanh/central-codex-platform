// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState, type ElementType, type ReactNode } from "react";

interface MarkdownMessageProps {
  content: string;
}

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language?: string; text: string };

/**
 * A deliberately small Markdown renderer for chat messages. It renders text
 * as React nodes (rather than injecting HTML), so assistant output cannot
 * execute markup or scripts in the desktop webview.
 */
export function MarkdownMessage({ content }: MarkdownMessageProps) {
  const blocks = parseBlocks(content);
  return (
    <div className="markdown-message">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <CodeBlock key={`code-${index}`} language={block.language} text={block.text} />
          );
        }
        if (block.type === "heading") {
          const Heading = `h${block.level}` as ElementType;
          return <Heading className={`markdown-heading markdown-heading-${block.level}`} key={`heading-${index}`}>{renderInline(block.text)}</Heading>;
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List className="markdown-list" key={`list-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{renderInline(item)}</li>)}
            </List>
          );
        }
        return (
          <p className="markdown-paragraph" key={`paragraph-${index}`}>
            {block.lines.map((line, lineIndex) => <span key={`${index}-${lineIndex}`}>{lineIndex > 0 && <br />}{renderInline(line)}</span>)}
          </p>
        );
      })}
    </div>
  );
}

function CodeBlock({ language, text }: { language?: string; text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="markdown-code-wrap">
      <div className="markdown-code-toolbar"><span>{language || "代码"}</span><button type="button" onClick={() => void copy}>{copied ? "已复制" : "复制"}</button></div>
      <pre className="markdown-code-block"><code className={language ? `language-${language}` : undefined}>{text}</code></pre>
    </div>
  );
}

function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1] || undefined, text: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const match = isOrdered ? lines[index].match(/^\s*\d+[.)]\s+(.+)$/) : lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      if (/^\s*```\s*[\w+-]*\s*$/.test(lines[index]) || /^\s{0,3}#{1,6}\s+/.test(lines[index]) || /^\s*[-*+]\s+/.test(lines[index]) || /^\s*\d+[.)]\s+/.test(lines[index])) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Keep the expression intentionally small: code spans, Markdown links,
  // autolinks, and the most common emphasis forms cover chat output well.
  const tokenPattern = /(`+[^`\n]+?`+|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<((?:https?:\/\/|mailto:)[^>]+)>|(https?:\/\/[^\s<]+)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code className="markdown-inline-code" key={`code-${match.index}`}>{token.replace(/^`+|`+$/g, "")}</code>);
    } else if (match[2] && match[3]) {
      nodes.push(safeLink(match[2], match[3], match.index));
    } else if (match[4]) {
      nodes.push(safeLink(match[4], match[4], match.index));
    } else if (match[5]) {
      nodes.push(safeLink(match[5].replace(/[),.!?;:]+$/, ""), match[5].replace(/[),.!?;:]+$/, ""), match.index));
      const trailing = match[5].slice(match[5].replace(/[),.!?;:]+$/, "").length);
      if (trailing) nodes.push(trailing);
    } else if (match[6] || match[7]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[6] ?? match[7]}</strong>);
    } else {
      nodes.push(<em key={`em-${match.index}`}>{match[8] ?? match[9]}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function safeLink(label: string, href: string, key: number): ReactNode {
  const externalUrl = normalizeExternalUrl(href);
  if (!externalUrl) return label;
  return <ExternalLink href={externalUrl} key={`link-${key}`} label={label} />;
}

function normalizeExternalUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  const [error, setError] = useState("");
  const desktopRuntime = isTauri();

  const openExternal = async () => {
    if (!desktopRuntime) return;
    setError("");
    try {
      await openUrl(href);
    } catch {
      setError("无法使用系统浏览器打开");
    }
  };

  return (
    <span className="markdown-external-link">
      <a
        className="markdown-link"
        href={href}
        target={desktopRuntime ? undefined : "_blank"}
        rel="noopener noreferrer"
        onClick={desktopRuntime ? (event) => { event.preventDefault(); void openExternal(); } : undefined}
        onAuxClick={desktopRuntime ? (event) => { event.preventDefault(); void openExternal(); } : undefined}
      >
        {label}
      </a>
      {error && <span className="markdown-link-error" role="alert">{error}</span>}
    </span>
  );
}
