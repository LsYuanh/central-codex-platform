// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AgentRpcMethod, AgentRpcResponsePayload } from "@central-codex-spike/agentrpc-types";

export type AgentRequestSender = (
  method: AgentRpcMethod,
  params: Record<string, unknown>,
  metadata?: { taskId?: string; traceId?: string; operationId?: string; idempotencyKey?: string },
) => Promise<AgentRpcResponsePayload>;

/**
 * Converts the Fake App Server's tool calls into the device-bound AgentRPC
 * methods. The bridge is the policy boundary: a caller cannot select a device
 * or workspace root, and only known tools can cross it.
 */
export class RemoteWorkspaceBridge {
  private readonly toolMethods: ReadonlyMap<string, AgentRpcMethod> = new Map([
    ["workspace/list", "workspace/list"],
    ["workspace/stat", "workspace/stat"],
    ["fs/list_dir", "workspace/list"],
    ["read_file", "read_file"],
    ["fs/read_file", "read_file"],
    ["exec", "exec"],
    ["process/exec", "exec"],
    ["process/cancel", "process/cancel"],
    ["git/status", "git/status"],
    ["git/diff", "git/diff"],
  ]);

  public constructor(private readonly send: AgentRequestSender) {}

  public async callTool(
    tool: string,
    input: unknown,
    metadata: { taskId?: string; traceId?: string; operationId?: string; idempotencyKey?: string } = {},
  ): Promise<AgentRpcResponsePayload> {
    const method = this.toolMethods.get(tool);
    if (!method) {
      return { ok: false, error: `unsupported remote tool: ${tool}`, errorCode: "UNSUPPORTED_TOOL" };
    }
    if (!isRecord(input)) {
      return { ok: false, error: "tool arguments must be an object", errorCode: "INVALID_PARAMS" };
    }

    // Device/workspace identity is injected by the central service in the real
    // implementation. Reject attempts to smuggle either through tool args.
    for (const key of ["deviceId", "device_id", "workspaceRoot", "workspace_root"]) {
      if (key in input) {
        return { ok: false, error: `${key} is controlled by the bridge`, errorCode: "FORBIDDEN_SCOPE" };
      }
    }

    // The current Local Agent supports only the safe version commands. Keep
    // unsupported future tools explicit instead of silently changing semantics.
    if (method === "process/cancel" || method === "git/status" || method === "git/diff" || method === "workspace/stat") {
      return { ok: false, error: `${method} is not implemented by the local Spike`, errorCode: "NOT_IMPLEMENTED" };
    }

    return this.send(method, input, metadata);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
