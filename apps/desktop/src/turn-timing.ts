// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
export type TurnTimingStatus = "running" | "completed" | "failed" | "interrupted" | "unknown";
export interface TurnTiming {
  threadId: string;
  turnId: string;
  status: TurnTimingStatus;
  startedAt?: number;
  serverStartedAt?: number;
  durationMs?: number;
  gap?: boolean;
  updatedAt: number;
}
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const keyOf = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

export function timingScope(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    // Exclude credentials and unrelated query parameters from the stored key.
    return JSON.stringify([url.origin, url.pathname, url.searchParams.get("userId") ?? "desktop-user"]);
  } catch { return "unconfigured"; }
}

function timestamp(value: unknown): number | undefined {
  if (finite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return undefined;
}

function statusFrom(value: unknown): TurnTimingStatus {
  if (["inProgress", "in_progress", "running"].includes(String(value))) return "running";
  if (["cancelled", "canceled", "interrupted"].includes(String(value))) return "interrupted";
  if (value === "completed" || value === "failed") return value;
  return "unknown";
}

/** Prefer protocol timing. Never use history-fetch time as the completion time. */
export function reconcileTiming(previous: TurnTiming | undefined, threadId: string, value: unknown, kind: "start" | "finish" | "history", now: number): TurnTiming | undefined {
  const turn = record(value);
  if (typeof turn.id !== "string") return previous;
  const status = kind === "start" ? "running" : statusFrom(turn.status);
  // Replayed starts cannot reopen a finished turn or reset its clock.
  if (previous && kind === "start") return previous;
  if (previous?.durationMs !== undefined && status === "running") return previous;
  // Elapsed UI time uses the client clock; never subtract a server timestamp
  // from Date.now(), since the two machines can have different clock offsets.
  const startedAt = previous?.startedAt ?? (kind === "start" ? now : undefined);
  const serverStartedAt = timestamp(turn.startedAt ?? turn.started_at) ?? previous?.serverStartedAt;
  const endedAt = timestamp(turn.completedAt ?? turn.completed_at);
  const suppliedDuration = turn.durationMs ?? turn.duration_ms;
  const terminal = status === "completed" || status === "failed" || status === "interrupted";
  let durationMs = previous?.durationMs;
  if (terminal) {
    if (finite(suppliedDuration)) durationMs = suppliedDuration;
    else if (serverStartedAt !== undefined && endedAt !== undefined && endedAt >= serverStartedAt) durationMs = endedAt - serverStartedAt;
    else if (durationMs === undefined && kind === "finish" && previous?.status === "running" && !previous.gap && startedAt !== undefined && now >= startedAt) durationMs = now - startedAt;
  }
  // Old history without reliable metrics should not gain invented durations.
  if (!previous && kind !== "start" && serverStartedAt === undefined && durationMs === undefined) return undefined;
  return {
    threadId, turnId: turn.id, status,
    startedAt, serverStartedAt,
    durationMs: terminal ? durationMs : undefined,
    gap: status === "unknown" || (terminal && durationMs === undefined),
    updatedAt: now,
  };
}

export class TurnTimingStore {
  private scope = "";
  private rows = new Map<string, TurnTiming>();
  private readonly storage?: StorageAccess;
  constructor(storage?: StorageAccess) { this.storage = storage; }
  useScope(scope: string) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.rows.clear();
    try {
      const rows: unknown = JSON.parse(this.storage?.getItem(this.storageKey()) ?? "[]");
      if (Array.isArray(rows)) for (const value of rows) {
        const row = record(value);
        if (typeof row.threadId !== "string" || typeof row.turnId !== "string" || !finite(row.updatedAt)) continue;
        const status = statusFrom(row.status);
        this.rows.set(keyOf(row.threadId, row.turnId), {
          threadId: row.threadId, turnId: row.turnId, updatedAt: row.updatedAt,
          status: status === "running" ? "unknown" : status,
          startedAt: finite(row.startedAt) ? row.startedAt : undefined,
          serverStartedAt: finite(row.serverStartedAt) ? row.serverStartedAt : undefined,
          durationMs: status !== "running" && status !== "unknown" && finite(row.durationMs) ? row.durationMs : undefined,
          gap: status === "running" || row.gap === true,
        });
      }
    } catch { /* Malformed or unavailable local storage must not affect chat. */ }
  }
  get(threadId: string, turnId: string) { return this.rows.get(keyOf(threadId, turnId)); }
  forThread(threadId: string) { return [...this.rows.values()].filter(row => row.threadId === threadId); }
  observe(threadId: string, turn: unknown, kind: "start" | "finish" | "history", now = Date.now()) {
    const id = record(turn).id;
    if (typeof id !== "string") return;
    const key = keyOf(threadId, id);
    const next = reconcileTiming(this.rows.get(key), threadId, turn, kind, now);
    if (next) { this.rows.set(key, next); this.save(); }
    return next;
  }
  uncertain(threadId?: string) {
    for (const [key, row] of this.rows) if ((!threadId || row.threadId === threadId) && row.status === "running") this.rows.set(key, { ...row, status: "unknown", gap: true });
    this.save();
  }
  removeThread(threadId: string) {
    for (const [key, row] of this.rows) if (row.threadId === threadId) this.rows.delete(key);
    this.save();
  }
  private storageKey() { return `yuanzhou.turn-timings.v1:${this.scope}`; }
  private save() {
    if (!this.scope) return;
    // Bound the cache; keep every active/uncertain record and the latest 2000 completed turns.
    const rows = [...this.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const pending = rows.filter(row => row.status === "running" || row.status === "unknown");
    const terminal = rows.filter(row => row.status !== "running" && row.status !== "unknown").slice(0, 2000);
    this.rows = new Map([...pending, ...terminal].map(row => [keyOf(row.threadId, row.turnId), row]));
    try { this.storage?.setItem(this.storageKey(), JSON.stringify([...this.rows.values()])); } catch { /* Best-effort, never block a turn. */ }
  }
}

export function formatTurnDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}小时 ` : ""}${minutes || hours ? `${minutes}分 ` : ""}${seconds % 60}秒`;
}

export interface TimedMessage { id: string; role: string; content: string; turnId?: string; timingOnly?: boolean }
/** Keep one summary before the first assistant reply; before a reply, show it after user input. */
export function timingAnchors(messages: TimedMessage[], timings: TurnTiming[]): Map<string, TurnTiming> {
  const anchors = new Map<string, TurnTiming>();
  for (const timing of timings) {
    const rows = messages.filter(row => row.turnId === timing.turnId);
    const anchor = rows.find(row => row.role === "assistant" && !row.timingOnly)
      ?? rows.find(row => row.timingOnly) ?? rows.at(-1);
    if (anchor) anchors.set(anchor.id, timing);
  }
  return anchors;
}
