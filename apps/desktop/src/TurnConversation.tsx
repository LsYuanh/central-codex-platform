// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
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
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const open = expanded || reveal;
  return <div className={`execution-sequence${open ? " is-expanded" : ""}`}>
    <div className="execution-sequence-rows" id={contentId}>
      {(open ? rows : rows.slice(-1)).map(renderRow)}
    </div>
    {rows.length > 1 && !reveal && <button type="button" className="execution-sequence-toggle"
      aria-label={`${open ? "收起" : "展开全部"}执行步骤`} aria-expanded={open} aria-controls={contentId}
      onClick={() => setExpanded(!open)}>{open ? "收起" : `展开 ${rows.length} 项`}</button>}
  </div>;
}

export function TurnConversation({ group, timing, running, now, executions, renderMessage, renderExecution }: Props) {
  const contentId = useId();
  const mode = running ? "running" : timing?.status ?? "completed";
  const [choice, setChoice] = useState<{ mode: string; open: boolean }>();
  const [revealExecutions, setRevealExecutions] = useState(false);
  const open = choice?.mode === mode ? choice.open : false;
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
  const activity = active?.phase === "dispatched" ? "等待本机执行" : active?.tool === "device_exec" ? "正在本机执行命令"
    : active?.tool.includes("search") ? "正在搜索代码" : active?.tool.includes("read") ? "正在读取文件" : "正在处理";
  const status = mode === "failed" ? "任务失败 · " : mode === "interrupted" ? "已停止 · " : "";
  const label = running ? [activity, completedCount ? `已完成 ${completedCount} 项操作` : undefined,
      timing?.startedAt !== undefined ? formatTurnDuration(Math.max(0, now - timing.startedAt)) : undefined].filter(Boolean).join(" · ")
    : mode === "unknown" ? "连接中断，结果待核对"
    : `${status}${timing?.durationMs !== undefined ? `用时 ${formatTurnDuration(timing.durationMs)}` : hasProcess ? "处理过程" : "用时未记录"}`;
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
      {row.kind === "reasoning" && <span className="turn-process-label">思考摘要</span>}
      {renderMessage(row.kind === "tool" && row.itemStatus === "running" && !running ? { ...row, itemStatus: "unknown" } : row)}
    </div>;
    return renderMessage(row);
  };
  return <section className="conversation-turn" aria-label="本轮对话">
    {leading.map(renderMessage)}
    {showHeader && <div className="turn-process-header">
      <button type="button" className="turn-process-toggle" aria-label={`${open ? "收起" : "展开"}处理过程`} aria-expanded={open} aria-controls={contentId}
        disabled={!hasProcess} onClick={() => { setChoice({ mode, open: !open }); setRevealExecutions(false); }}>
        {running && <span className="spinner" aria-hidden="true" />}
        <span>{label}</span>{hasProcess && <span className={`turn-process-chevron${open ? " is-open" : ""}`} aria-hidden="true">›</span>}
      </button>
      {uncertainChanges && <button type="button" className="turn-process-warning" onClick={() => { setChoice({mode, open:true}); setRevealExecutions(true); }}>文件修改结果需要核对，查看详情</button>}
    </div>}
    <div className="turn-content" id={contentId}>
      {entries.map(entry => Array.isArray(entry)
        ? <ExecutionSequence key={entry[0].id} rows={entry} renderRow={renderRow} reveal={revealExecutions} />
        : renderRow(entry))}

    </div>
  </section>;
}
