// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
interface StreamMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  outputs?: unknown[];
  turnId?: string;
  kind?: string;
  itemStatus?: string;
}

/** Item identity preserves an earlier stream across an interleaved user message. */
export function appendStreamDelta<T extends StreamMessage>(rows: T[], delta: string, itemId?: string, turnId?: string): Array<T | {id:string;role:"assistant";content:string;createdAt:string;turnId?:string}> {
  if (!delta) return rows;
  if (itemId) {
    const id = `assistant-${itemId}`;
    if (rows.some(row => row.id === id)) return rows.map(row => row.id === id && row.itemStatus !== "completed" ? {...row,content:row.content + delta,turnId:turnId ?? row.turnId} : row);
    return [...rows,{id,role:"assistant",content:delta,createdAt:new Date().toISOString(),turnId}];
  }
  const last = rows[rows.length - 1];
  if (last?.role === "assistant" && !last.kind && last.itemStatus !== "completed" && !last.outputs?.length && (!turnId || last.turnId === turnId)) return [...rows.slice(0,-1),{...last,content:last.content + delta}];
  return [...rows,{id:crypto.randomUUID(),role:"assistant",content:delta,createdAt:new Date().toISOString(),turnId}];
}
