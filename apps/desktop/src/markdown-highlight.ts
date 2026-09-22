// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import hljs from "highlight.js/lib/common";
import powershell from "highlight.js/lib/languages/powershell";
hljs.registerLanguage("powershell", powershell);
export function highlight(text: string, language: string): string {
  const name = language.toLowerCase();
  if (hljs.getLanguage(name)) return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
