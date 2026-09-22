// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { Element, Root } from "hast";
import { defaultSchema, type Options } from "rehype-sanitize";

// Only a single, literal foreground color is accepted. No arbitrary CSS,
// custom properties, URLs, positioning, event handlers or embedded documents.
const colorValue = "(?:red|orange|yellow|green|blue|purple|pink|gray|grey|black|white|#[a-f0-9]{3}|#[a-f0-9]{4}|#[a-f0-9]{6}|#[a-f0-9]{8})";
const colorStyle = new RegExp(`^\\s*color\\s*:\\s*${colorValue}\\s*;?\\s*$`, "i");
export const markdownHtmlSchema: Options = {
  ...defaultSchema,
  // Every ID and ID reference is scoped by scopeMarkdownIds after sanitation.
  clobberPrefix: "",
  tagNames: ["a", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "li", "mark", "ol", "p", "pre", "s", "section", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"],
  strip: ["script", "style", "iframe", "object", "embed", "form", "textarea", "select", "button", "svg", "math", "template"],
  attributes: {
    ...defaultSchema.attributes,
    "*": ["id", "title", "lang", ["dir", "ltr", "rtl", "auto"]],
    code: [["className", /^language-[\w+-]+$/, "math-inline", "math-display"]],
    details: ["open"],
    img: ["src", "alt", "title"],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
    ol: [...(defaultSchema.attributes?.ol ?? []), "start"],
    p: [["style", colorStyle]],
    span: [["style", colorStyle]],
    td: [["align", "left", "center", "right"], "colSpan", "rowSpan"],
    th: [["align", "left", "center", "right"], "colSpan", "rowSpan"],
  },
  // Images always pass through MarkdownImage's source/identity/version checks.
  // Do not strip Windows drive paths before they can match registered images.
  protocols: { href: ["http", "https", "mailto"], cite: ["http", "https"] },
};

function elements(tree: Root | Element, visit: (node: Element) => void) {
  for (const child of tree.children) if (child.type === "element") { visit(child); elements(child, visit); }
}

export function scopeMarkdownIds({ prefix }: { prefix: string }) {
  return (tree: Root) => {
    const ids = new Map<string, string>();
    let count = 0;
    elements(tree, node => {
      if (node.properties.id !== undefined) {
        const old = String(node.properties.id);
        const id = `${prefix}${++count}-${old}`;
        if (!ids.has(old)) ids.set(old, id);
        node.properties.id = id;
      }
    });
    const scoped = (id: string) => ids.get(id) ?? `${prefix}missing-${id}`;
    elements(tree, node => {
      const href = node.properties.href;
      if (typeof href === "string" && href.startsWith("#")) {
        let id = href.slice(1);
        try { id = decodeURIComponent(id); } catch { /* Keep malformed anchors inert. */ }
        node.properties.href = `#${encodeURIComponent(scoped(id))}`;
      }
      for (const name of ["ariaDescribedBy", "ariaLabelledBy"]) {
        const value = node.properties[name];
        if (value) node.properties[name] = (Array.isArray(value) ? value.map(String) : String(value).split(/\s+/)).map(scoped);
      }
    });
  };
}

/** Named colors follow both themes; explicit hex colors retain author intent. */
export function markdownTextColor(color?: string): string | undefined {
  if (!color || !colorStyle.test(`color:${color}`)) return undefined;
  const named: Record<string, string> = {
    red: "var(--danger)", orange: "var(--warning)", yellow: "var(--warning)",
    green: "var(--success)", blue: "var(--accent)", purple: "var(--markdown-purple)",
    pink: "var(--send-accent)", gray: "var(--ink-muted)", grey: "var(--ink-muted)",
    black: "var(--ink)", white: "var(--ink)",
  };
  return named[color.toLowerCase().trim()] ?? color;
}
