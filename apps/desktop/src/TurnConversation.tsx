// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, useLocale } from "./i18n";

import { useId, useState, type ReactNode } from "react";
import type { ChatMessage, ExecutionActivity } from "./gateway-ui-events";
import { isProcessMessage, compactConversationRows, type ConversationGroup } from "./conversation-content";
import { formatTurnDuration, type TurnTiming } from "./turn-timing";

interface Props {
  group: ConversationGroup;
  timing?: TurnTiming;
  running: boolean;
  now: number;
  executions: ExecutionActivity[];
  renderMessage: (message: ChatMessage) => ReactNode;
  renderExecution: (execution: ExecutionActivity) => ReactNode;
}

function ExecutionSequence({ rows, renderRow, reveal }: {
  rows: ChatMessage[];
  renderRow: (row: ChatMessage) => ReactNode;
  reveal: boolean;
}) {
  useLocale();
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const open = expanded || reveal;
  return <div className={`execution-sequence${open ? " is-expanded" : ""}`}>
    <div className="execution-sequence-rows" id={contentId}>
      {(open ? rows : rows.slice(-1)).map(renderRow)}
    </div>
    {rows.length > 1 && !reveal && <button type="button" className="execution-sequence-toggle"
      aria-label={t("{{p0}}执行步骤", { p0: open ? t("收起") : t("展开全部") })} aria-expanded={open} aria-controls={contentId}
      onClick={() => setExpanded(!open)}>{open ? t("收起") : t("展开项目数量", { count: rows.length })}</button>}
  </div>;
}

export function TurnConversation({ group, timing, running, now, executions, renderMessage, renderExecution }: Props) {
  useLocale();
  const contentId = useId();
  const mode = running ? "running" : timing?.status ?? "completed";
  const hasFinalAnswer = group.messages.some(row => row.role === "assistant" && row.phase === "final_answer"
    && (row.content.trim().length > 0 || Boolean(row.outputs?.length)));
  // Final text can start streaming before the turn completes. Collapse once at
  // that boundary, while preserving manual toggles during subsequent deltas.
  const disclosureMode = hasFinalAnswer && (running || mode === "completed") ? "answer" : mode;
  const [choice, setChoice] = useState<{ mode: string; open: boolean }>();
  const [revealExecutions, setRevealExecutions] = useState(false);
  const open = choice?.mode === disclosureMode ? choice.open : disclosureMode === "running";
  const rows = compactConversationRows(group.messages.filter(row => !row.timingOnly), executions);
  const firstReply = rows.findIndex(row => row.role !== "user");
  const leading = firstReply < 0 ? rows : rows.slice(0, firstReply);
  const replies = firstReply < 0 ? [] : rows.slice(firstReply);
  const processRows = replies.filter(isProcessMessage);
  const hasProcess = processRows.length > 0 || running;
  const completedCount = processRows.filter(row => row.kind === "execution"
    ? executions.find(e => e.requestId === row.executionId)?.status === "succeeded"
    : row.kind === "tool" && row.itemStatus === "completed").length;
  const active = executions.find(row => row.status === "running");
  const activity = active?.phase === "dispatched" ? t("等待本机执行") : active?.tool === "device_exec" ? t("正在本机执行命令")
    : active?.tool.includes("search") ? t("正在搜索代码") : active?.tool.includes("read") ? t("正在读取文件") : t("正在处理");
  const status = mode === "failed" ? t("任务失败 · ") : mode === "interrupted" ? t("已停止 · ") : "";
  const label = running ? [activity, completedCount ? t("完成操作数量", { count: completedCount }) : undefined,
      timing?.startedAt !== undefined ? formatTurnDuration(Math.max(0, now - timing.startedAt)) : undefined].filter(Boolean).join(" · ")
    : mode === "unknown" ? t("连接中断，结果待核对")
    : `${status}${timing?.durationMs !== undefined ? t("用时 {{p0}}", { p0: formatTurnDuration(timing.durationMs) }) : hasProcess ? t("处理过程") : t("用时未记录")}`;
  const uncertainChanges = executions.some(row => row.patch?.outcome === "partial" || row.patch?.outcome === "unknown");
  const showHeader = hasProcess || Boolean(timing);
  const visible = replies.filter(row => !isProcessMessage(row) || open);
  const entries: (ChatMessage | ChatMessage[])[] = [];
  for (const row of visible) {
    if (isProcessMessage(row) && (row.kind === "tool" || row.kind === "execution")) {
      const last = entries[entries.length - 1];
      if (Array.isArray(last)) last.push(row);
      else entries.push([row]);
    } else entries.push(row);
  }
  const renderRow = (row: ChatMessage) => {
    if (row.kind === "execution") {
      const execution = executions.find(item => item.requestId === row.executionId);
      return execution ? <div className="turn-process-entry" key={row.id}>{renderExecution(execution)}</div> : null;
    }
    if (row.kind === "reasoning" && !row.content) return null;
    if (isProcessMessage(row)) return <div className={`turn-process-entry turn-process-${row.kind ?? "commentary"}`} key={row.id}>
      {row.kind === "reasoning" && <span className="turn-process-label">{t("思考摘要")}</span>}
      {renderMessage(row.kind === "tool" && row.itemStatus === "running" && !running ? { ...row, itemStatus: "unknown" } : row)}
    </div>;
    return renderMessage(row);
  };
  return <section className="conversation-turn" aria-label={t("本轮对话")}>
    {leading.map(renderMessage)}
    {showHeader && <div className="turn-process-header">
      <button type="button" className="turn-process-toggle" aria-label={t("{{p0}}处理过程", { p0: open ? t("收起") : t("展开") })} aria-expanded={open} aria-controls={contentId}
        disabled={!hasProcess} onClick={() => { setChoice({ mode: disclosureMode, open: !open }); setRevealExecutions(false); }}>
        {running && <span className="spinner" aria-hidden="true" />}
        <span>{label}</span>{hasProcess && <span className={`turn-process-chevron${open ? " is-open" : ""}`} aria-hidden="true">›</span>}
      </button>
      {uncertainChanges && <button type="button" className="turn-process-warning" onClick={() => { setChoice({mode: disclosureMode, open:true}); setRevealExecutions(true); }}>{t("文件修改结果需要核对，查看详情")}</button>}
    </div>}
    <div className="turn-content" id={contentId}>
      {entries.map(entry => Array.isArray(entry)
        ? <ExecutionSequence key={entry[0].id} rows={entry} renderRow={renderRow} reveal={revealExecutions} />
        : renderRow(entry))}

    </div>
  </section>;
}
