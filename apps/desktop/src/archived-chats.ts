// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { CodexiaGatewayAdapter } from "./codexia-gateway-adapter";
import type { ThreadSummary } from "./gateway-ui-events";

/** Resolve every cursor before exposing a complete archive snapshot for deletion. */
export async function loadArchivedChats(client: CodexiaGatewayAdapter, isCurrent: () => boolean, parse: (result: unknown) => ThreadSummary[]) {
  const rows = new Map<string, ThreadSummary>();
  const cursors = new Set<string>();
  const started = Date.now();
  let cursor: string | undefined;
  do {
    if (!isCurrent()) throw new Error("连接已变化，请刷新已归档聊天。");
    if (Date.now() - started > 60_000 || cursors.size >= 1000) throw new Error("归档列表加载超时，请刷新后重试。");
    const response = await client.threadList({ limit: 100, sortKey: "updated_at", archived: true, ...(cursor ? { cursor } : {}) });
    if (!isCurrent()) throw new Error("连接已变化，请刷新已归档聊天。");
    const result = response.result as { data?: unknown; nextCursor?: unknown } | undefined;
    if (!result || !Array.isArray(result.data)) throw new Error("归档列表返回格式异常，请刷新后重试。");
    const page = parse(result);
    if (page.length !== result.data.length) throw new Error("归档列表包含无效记录，请刷新后重试。");
    for (const thread of page) rows.set(thread.id, { ...thread, archived: true });
    const next = result.nextCursor;
    if (next != null && (typeof next !== "string" || !next || cursors.has(next))) throw new Error("归档列表分页异常，请刷新后重试。");
    cursor = next as string | undefined;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...rows.values()];
}
