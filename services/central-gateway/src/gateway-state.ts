// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type GatewayState = { version: 1; users: Record<string, Array<{id:string; summary:Record<string,unknown>}>> };
const record = (value: unknown): value is Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve v1 metadata. Malformed ownership/submission data must never become an empty database. */
export function readGatewayState(path: string): GatewayState {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {version:1,users:{}};
    throw new Error(`GATEWAY_STATE_UNREADABLE: ${String(error)}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 1 || !record(parsed.users)) throw new Error("unsupported state version or users");
    const ids = new Set<string>();
    for (const [userId, entries] of Object.entries(parsed.users)) {
      if (!userId || !Array.isArray(entries)) throw new Error("invalid user entries");
      for (const entry of entries) {
        if (!record(entry) || typeof entry.id !== "string" || !entry.id || !record(entry.summary) || ids.has(entry.id)) throw new Error("invalid or duplicate thread ownership");
        ids.add(entry.id);
      }
    }
    return parsed as GatewayState;
  } catch (error) {
    throw new Error(`GATEWAY_STATE_CORRUPT: preserve the state file and restore a verified backup before restarting (${String(error)})`);
  }
}

/** Sync a new sibling before rename; interrupted writes leave the last committed file intact. */
export function writeGatewayState(path: string, state: unknown): void {
  mkdirSync(dirname(path), {recursive:true});
  const pending = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(pending, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(state, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(pending, path);
    // Directory fsync is supported on the central macOS/Linux host, not Windows.
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
