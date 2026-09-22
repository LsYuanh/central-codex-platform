// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useMemo, useState } from "react";
import { CopyButton } from "./result-controls";

type DiffLine = { text: string; kind: "add" | "remove" | "context" | "meta"; before?: number; after?: number };
export function parseDiff(text: string) {
  const files: { label: string; lines: DiffLine[]; added: number; removed: number }[] = [];
  let oldLine: number | undefined, newLine: number | undefined;
  for (const line of text.split("\n")) {
    if (!files.length || line.startsWith("diff --git ")) {
      files.push({ label: line.startsWith("diff --git ") ? line.slice(11) : "文件变更", lines: [], added: 0, removed: 0 });
      oldLine = newLine = undefined;
    }
    const file = files[files.length - 1];
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    let row: DiffLine = { text: line, kind: "meta" };
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
    else if (oldLine !== undefined && newLine !== undefined) {
      if (line.startsWith("+")) { row = { text: line, kind: "add", after: newLine++ }; file.added++; }
      else if (line.startsWith("-")) { row = { text: line, kind: "remove", before: oldLine++ }; file.removed++; }
      else if (line.startsWith(" ")) row = { text: line, kind: "context", before: oldLine++, after: newLine++ };
      else if (!line.startsWith("\\")) oldLine = newLine = undefined;
    }
    file.lines.push(row);
  }
  return files;
}

export function DiffView({ text, truncated = false }: { text: string; truncated?: boolean }) {
  const [source, setSource] = useState(false);
  const large = text.length > 200_000 || text.split("\n").length > 3000;
  const files = useMemo(() => large ? [] : parseDiff(text), [text, large]);
  return <section className="structured-result diff-view" aria-label="文件差异"><div className="result-toolbar"><strong>文件变更</strong>{!large && text && <button className="result-control" type="button" onClick={() => setSource(!source)}>{source ? "差异视图" : "查看原文"}</button>}<CopyButton text={text} /></div>
    {truncated && <p className="result-notice">Diff 已截断，统计仅包含当前收到的内容。</p>}
    {!text ? <p className="result-notice">该范围没有已跟踪文件的变更。</p> : source || large ? <>{large && <p className="result-notice">内容较大，使用原文视图。</p>}<pre className="result-source" tabIndex={0}>{text}</pre></> : files.map((file, index) => <details className="diff-file" key={`${index}-${file.label}`} open={files.length === 1 ? true : undefined}><summary><span>{file.label}</span><small>+{file.added} −{file.removed}</small></summary><div className="diff-lines" tabIndex={0} role="region" aria-label={`${file.label} 的差异`}>{file.lines.map((line, i) => <div className={`diff-line diff-${line.kind}`} key={i}><span className="diff-number" aria-label="原行号">{line.before}</span><span className="diff-number" aria-label="新行号">{line.after}</span><code>{line.text || " "}</code></div>)}</div></details>)}
  </section>;
}
