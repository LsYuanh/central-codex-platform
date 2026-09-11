// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};

// Only an explicit upstream rejection proves that steering was not accepted.
// A transport failure, timeout or mismatched Turn must never trigger a new Turn.
export function isNoActiveTurn(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.startsWith("App Server request failed:")) return false;
  try {
    const detail = JSON.parse(error.message.slice("App Server request failed:".length));
    return typeof detail.message === "string" && /^no active turn\b/i.test(detail.message);
  } catch { return false; }
}

export async function steerOrStart(
  request: (method: string, params: RecordValue) => Promise<unknown>,
  params: { threadId: string; expectedTurnId: string; input: unknown[] },
  cancelled: () => boolean,
): Promise<{ turnId: string; started: boolean }> {
  try {
    const result = record(await request("turn/steer", params));
    if (result.turnId !== params.expectedTurnId) throw new Error("追加返回的 Turn ID 不一致，请核对历史");
    return { turnId: params.expectedTurnId, started: false };
  } catch (error) {
    if (!isNoActiveTurn(error)) throw error;
    const history = record(await request("thread/read", { threadId: params.threadId, includeTurns: true }));
    const thread = record(history.thread);
    const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : undefined;
    const previous = turns?.find(turn => turn.id === params.expectedTurnId);
    // Only normal completion permits automatic continuation. Preserve an explicit stop.
    if (!turns || turns.at(-1)?.id !== params.expectedTurnId || previous?.status !== "completed" || record(thread.status).type === "active"
      || turns.some(turn => ["inProgress", "in_progress"].includes(String(turn.status))) || cancelled()) throw error;
    const result = record(await request("turn/start", { threadId: params.threadId, input: params.input }));
    const turn = record(result.turn);
    if (typeof turn.id !== "string") throw new Error("续发未返回 Turn ID，请核对历史");
    return { turnId: turn.id, started: true };
  }
}
