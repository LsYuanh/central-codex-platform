// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/** Immutable helpers shared by the React UI and the multi-session smoke test. */
export function withThreadRunning(current: ReadonlySet<string>, threadId: string, running: boolean): Set<string> {
  if (current.has(threadId) === running) return current as Set<string>;
  const next = new Set(current);
  if (running) next.add(threadId); else next.delete(threadId);
  return next;
}

export function withThreadTurn(current: ReadonlyMap<string, string>, threadId: string, turnId?: string): Map<string, string> {
  if (current.get(threadId) === turnId) return current as Map<string, string>;
  const next = new Map(current);
  if (turnId) next.set(threadId, turnId); else next.delete(threadId);
  return next;
}

