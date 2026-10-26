// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { randomUUID } from "node:crypto";

export const DEVICE_APPROVAL_MARKER = "yuan-zhou-device-approval/1";
export const DEVICE_APPROVAL_NAMESPACE = "yuan_zhou_device_approval";
export type PermissionMode = "ask" | "auto" | "full";
export function permissionMode(value: unknown): PermissionMode {
  if (value !== "ask" && value !== "auto" && value !== "full") throw Error("PERMISSION_MODE_INVALID");
  return value;
}

/** Only concrete read APIs bypass review. Shell text is never classified by keywords. */
export function needsDeviceApproval(method: string | undefined, args: Record<string, unknown>, tool: string): boolean {
  if (method === "exec" && typeof args.sessionId === "string" && args.stdin === undefined && args.closeStdin !== true) return false;
  return !new Set(["workspace/context", "workspace/search", "workspace/read_text", "workspace/git_status", "workspace/git_diff", "workspace/list", "read_file", "file/read_text", "file/read_document", "file/output_paths"]).has(method ?? "")
    && tool !== "device_list_outputs";
}

type Identity = { bridge: object; clientId: string; threadId: string; turnId?: string };
export type ReviewCompletion = { id: string | number; outcome: "approved" | "manual" | "denied" | "unavailable" | "cancelled"; reason: string };

/** A prepared action is kept in the gateway, never reconstructed from a model-supplied token. */
export class DeviceReviewTickets {
  private pending = new Map<string, Identity & { finish: (value?: ReviewCompletion, error?: string) => void }>();
  prepare(identity: Identity, timeoutMs = 120_000) {
    const token = randomUUID();
    const completion = new Promise<ReviewCompletion>((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, "DEVICE_REVIEW_TIMEOUT"), timeoutMs);
      const finish = (value?: ReviewCompletion, error?: string) => {
        if (!this.pending.delete(token)) return;
        clearTimeout(timer);
        if (value) resolve(value); else reject(Error(error ?? "DEVICE_REVIEW_CANCELLED"));
      };
      this.pending.set(token, { ...identity, finish });
    });
    return { token, completion };
  }
  complete(identity: Identity, token: unknown, value: ReviewCompletion): void {
    const pending = typeof token === "string" ? this.pending.get(token) : undefined;
    if (!pending || pending.bridge !== identity.bridge || pending.clientId !== identity.clientId || pending.threadId !== identity.threadId || pending.turnId !== identity.turnId) throw Error("DEVICE_REVIEW_STALE");
    if (!["approved", "manual", "denied", "unavailable", "cancelled"].includes(value.outcome)) throw Error("DEVICE_REVIEW_INVALID");
    pending.finish(value);
  }
  cancel(match: (identity: Identity) => boolean, reason: string): void {
    for (const pending of this.pending.values()) if (match(pending)) pending.finish(undefined, reason);
  }
  hasThread(threadId: string): boolean {
    return [...this.pending.values()].some(pending => pending.threadId === threadId);
  }
}
