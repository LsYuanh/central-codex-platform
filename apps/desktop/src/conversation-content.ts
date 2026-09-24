// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, message as uiMessage } from "./i18n.ts";

import type { ChatMessage, ExecutionActivity } from "./gateway-ui-events";
import type { AppServerMessage } from "./app-server-client";

export type MessagePhase = "commentary" | "final_answer";
export interface MessagePresentation {
  phase?: MessagePhase;
  kind?: "reasoning" | "plan" | "tool" | "execution";
  summaryParts?: string[];
  itemStatus?: "running" | "completed" | "failed" | "unknown";
  executionId?: string;
  toolName?: string;
  lastSequence?: number;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export const messagePhase = (value: unknown): MessagePhase | undefined => value === "commentary" || value === "final_answer" ? value : undefined;
const textParts = (value: unknown): string[] => Array.isArray(value) ? value.map(part => typeof part === "string" ? part : typeof record(part).text === "string" ? record(part).text as string : "") : [];

/** Only returned reasoning summaries are UI content; raw reasoning is never substituted. */
export function processItem(value: unknown, turnId?: string, completed = true): ChatMessage | undefined {
  const item = record(value);
  if (typeof item.id !== "string") return;
  const base = { id: `process-${item.id}`, role: "assistant" as const, turnId,
    itemStatus: (item.status === "failed" || item.success === false ? "failed" : completed ? "completed" : "running") as "running" | "completed" | "failed" };
  if (item.type === "reasoning") {
    const summaryParts = textParts(item.summary);
    return { ...base, kind: "reasoning", summaryParts, content: summaryParts.join("\n\n") };
  }
  if (item.type === "plan") return { ...base, kind: "plan", content: typeof item.text === "string" ? item.text : "" };
  const labels: Record<string, import("./i18n").MessageKey> = {
    webSearch: "搜索网页", mcpToolCall: "调用工具", dynamicToolCall: "请求客户端工具",
    commandExecution: "命令执行记录", fileChange: "文件变更记录", collabToolCall: "子任务记录", imageView: "查看图片",
  };
  if (typeof item.type === "string" && labels[item.type]) {
    // Do not expose central cwd/commands as if they were client execution details.
    const name = typeof item.tool === "string" ? item.tool : undefined;
    return { ...base, kind: "tool", toolName: item.type === "dynamicToolCall" ? name : undefined,
      content: name === "conversation_read" ? t("读取对话历史 · 中央只读") : `${t(labels[item.type])}${name ? ` · ${name}` : ""}`,
      uiMessage: name === "conversation_read" ? uiMessage("读取对话历史 · 中央只读") : uiMessage("{{label}}{{suffix}}", {label: uiMessage(labels[item.type]), suffix: name ? ` · ${name}` : ""}),
    };
  }
}

/** Merge starts, incremental summaries, and authoritative completed items by stable item ID. */
export function reduceConversationEvent(rows: ChatMessage[], message: AppServerMessage, turnId?: string): ChatMessage[] | undefined {
  const p = record(message.params), item = record(p.item);
  const method = message.method ?? "";
  const full = method === "item/started" || method === "item/completed";
  const summary = method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/summaryPartAdded";
  const plan = method === "item/plan/delta";
  if (!full && !summary && !plan) return;
  const itemId = full ? item.id : p.itemId;
  if (typeof itemId !== "string") return;
  const agent = full && item.type === "agentMessage";
  const id = `${agent ? "assistant" : "process"}-${itemId}`;
  const old = rows.find(row => row.id === id);
  if (message.sequence !== undefined && old?.lastSequence !== undefined && message.sequence <= old.lastSequence) return rows;
  if (full && method === "item/started" && old?.itemStatus && old.itemStatus !== "running") return rows;
  let next: ChatMessage | undefined;
  if (agent) {
    const content = typeof item.text === "string" ? item.text : "";
    next = { ...old, id, role: "assistant", turnId: turnId ?? old?.turnId,
      content: method === "item/started" && old ? old.content : content,
      phase: messagePhase(item.phase) ?? old?.phase, itemStatus: method === "item/completed" ? "completed" : "running" };
  } else if (full) {
    next = processItem(item, turnId, method === "item/completed");
    if (next && old && (!next.content || method === "item/started")) {
      next = { ...next, content: old.content, summaryParts: old.summaryParts ?? next.summaryParts };
    }
  } else {
    if (old?.itemStatus && old.itemStatus !== "running") return rows;
    if (summary) {
      const index = p.summaryIndex;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 1000) return rows;
      const parts = [...(old?.summaryParts ?? [])];
      parts[index] = (parts[index] ?? "") + (method.endsWith("summaryTextDelta") && typeof p.delta === "string" ? p.delta : "");
      next = { ...old, id, role: "assistant", turnId, kind: "reasoning", itemStatus: "running", summaryParts: parts, content: parts.join("\n\n") };
    } else next = { ...old, id, role: "assistant", turnId, kind: "plan", itemStatus: "running", content: (old?.content ?? "") + (typeof p.delta === "string" ? p.delta : "") };
  }
  if (!next) return;
  next.lastSequence = message.sequence ?? old?.lastSequence;
  return old ? rows.map(row => row.id === id ? next! : row) : [...rows, next];
}

export function isProcessMessage(message: ChatMessage): boolean {
  if (message.kind === "plan") return false;
  return !message.outputs?.length && (Boolean(message.kind) || message.phase === "commentary");
}

export interface ConversationGroup { id: string; turnId?: string; messages: ChatMessage[] }
export function groupConversation(rows: ChatMessage[]): ConversationGroup[] {
  const groups: ConversationGroup[] = [], byTurn = new Map<string, ConversationGroup>();
  for (const row of rows) {
    let group = row.turnId ? byTurn.get(row.turnId) : undefined;
    if (!group) {
      group = { id: row.turnId ? `turn-${row.turnId}` : row.id, turnId: row.turnId, messages: [] };
      groups.push(group);
      if (row.turnId) byTurn.set(row.turnId, group);
    }
    group.messages.push(row);
  }
  return groups;
}

/** Prefer the client execution record over the matching generic tool notice.
 * Match counts within this turn; never collapse separate executions of the same tool.
 * Keep notices whose detailed record is unavailable (including restored history). */
export function compactConversationRows(rows: ChatMessage[], executions: ExecutionActivity[]): ChatMessage[] {
  const remaining = new Map<string, ExecutionActivity[]>();
  for (const row of rows) {
    const execution = row.kind === "execution" ? executions.find(e => e.requestId === row.executionId) : undefined;
    if (execution) remaining.set(execution.tool, [...(remaining.get(execution.tool) ?? []), execution]);
  }
  return rows.filter(row => {
    if (row.kind === "execution") return executions.some(e => e.requestId === row.executionId);
    if (row.kind !== "tool" || row.outputs?.length) return true;
    const name = row.toolName ?? /^请求客户端工具 · (device_\w+)$/.exec(row.content)?.[1];
    const candidates = name ? remaining.get(name) : undefined;
    const match = candidates?.findIndex(e => row.itemStatus === "failed" ? !["running", "succeeded"].includes(e.status)
      : row.itemStatus === "completed" ? e.status === "succeeded" : true) ?? -1;
    if (match < 0) return true;
    candidates!.splice(match, 1);
    return false;
  });
}
