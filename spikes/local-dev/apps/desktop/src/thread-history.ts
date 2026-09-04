// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export type RestoredChatRole = "user" | "assistant" | "system";

export interface RestoredChatMessage {
  id: string;
  role: RestoredChatRole;
  content: string;
  createdAt?: string;
  attachments?: import("./attachments").MessageAttachment[];
  outputs?: import("./outputs").OutputArtifact[];
}

/** Normalize the supported App Server thread/read history shapes for the UI. */
export function messagesFromThreadRead(result: unknown): RestoredChatMessage[] {
  const record = asRecord(result);
  const thread = asRecord(record?.thread) ?? record;
  const turns = Array.isArray(thread?.turns) ? thread.turns : Array.isArray(record?.turns) ? record.turns : [];
  const submissions = (Array.isArray(record?.attachmentSubmissions) ? record.attachmentSubmissions : []) as import("../../../packages/agentrpc-types/src/index").AttachmentSubmission[];
  const outputs = (Array.isArray(record?.outputs) ? record.outputs : []) as import("./outputs").OutputArtifact[];
  const shownOutputs = new Set<string>();
  const itemGroups: Array<{ items: unknown[]; createdAt?: string; turnId?: string }> = turns.map((turnValue) => {
    const turn = asRecord(turnValue);
    return {
      items: Array.isArray(turn?.items) ? turn.items : [],
      createdAt: dateFromRecord(turn),
      turnId: typeof turn?.id === "string" ? turn.id : undefined,
    };
  });

  const flatItems = Array.isArray(thread?.items) ? thread.items : Array.isArray(record?.items) ? record.items : [];
  if (flatItems.length > 0) itemGroups.push({ items: flatItems });

  const restored: RestoredChatMessage[] = [];
  for (const group of itemGroups) {
    for (const itemValue of group.items) {
      const wrapper = asRecord(itemValue);
      const item = asRecord(wrapper?.item) ?? wrapper;
      const output=outputs.find(value=>value.id===item?.id);
      if(output){
        restored.push({id:`output-${output.id}`,role:"assistant",content:"",outputs:[output],createdAt:group.createdAt});
        shownOutputs.add(output.id);
      }
      if(item?.type==="imageGeneration")continue;
      const raw = extractItemText(item);
      const role = roleFromItem(item);
      const submission = role === "user" ? submissions.find(s => (s.turnId && s.turnId === group.turnId) || raw.includes(`[platform-message:${s.clientMessageId}]`)) : undefined;
      const content = submission?.content ?? raw;
      if (!content.trim() && !submission?.attachments.length) continue;
      restored.push({ id: submission?.clientMessageId ?? crypto.randomUUID(), role, content, attachments: submission?.attachments, createdAt: dateFromRecord(item) ?? group.createdAt });
    }
    for(const output of outputs.filter(value=>value.turnId===group.turnId&&!shownOutputs.has(value.id))){
      restored.push({id:`output-${output.id}`,role:"assistant",content:"",outputs:[output],createdAt:group.createdAt});shownOutputs.add(output.id);
    }
  }
  for(const output of outputs.filter(value=>!shownOutputs.has(value.id)))restored.push({id:`output-${output.id}`,role:"assistant",content:"",outputs:[output]});
  return restored;
}

function dateFromRecord(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;
  for (const key of ["createdAt", "created_at", "timestamp"]) {
    if (typeof value[key] === "string" && !Number.isNaN(new Date(value[key]).getTime())) return value[key];
  }
  return undefined;
}

function roleFromItem(item: Record<string, unknown> | undefined): RestoredChatRole {
  const type = typeof item?.type === "string" ? item.type.toLowerCase() : "";
  const role = typeof item?.role === "string" ? item.role.toLowerCase() : "";
  if (type.includes("user") || role === "user") return "user";
  if (type.includes("agent") || type.includes("assistant") || role === "assistant") return "assistant";
  return "system";
}

function extractItemText(item: Record<string, unknown> | undefined): string {
  if (!item) return "";
  for (const key of ["text", "prompt", "outputText", "inputText"]) {
    if (typeof item[key] === "string") return item[key];
  }
  if (typeof item.content === "string") return item.content;
  if (typeof item.message === "string") return item.message;
  const nestedMessage = asRecord(item.message);
  if (nestedMessage) return extractItemText(nestedMessage);

  for (const key of ["content", "input"]) {
    const parts = item[key];
    if (!Array.isArray(parts)) continue;
    const text = parts.map((part) => {
      if (typeof part === "string") return part;
      const value = asRecord(part);
      return extractItemText(value);
    }).filter(Boolean).join("");
    if (text) return text;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
