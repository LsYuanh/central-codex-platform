// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { randomUUID } from "node:crypto";
import type { AgentRpcResponsePayload } from "@central-codex-spike/agentrpc-types";
import type { RemoteWorkspaceBridge } from "./bridge.js";

export interface FakeAppServerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface FakeAppServerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

interface FakeThread {
  id: string;
  createdAt: string;
  lastTurnId?: string;
}

/**
 * Small in-memory stand-in for a per-user Codex App Server worker. It exposes
 * only enough App Server-shaped methods to exercise the worker/bridge split;
 * it never starts Codex and never has access to OpenAI credentials.
 */
export class FakeAppServerWorker {
  private readonly threads = new Map<string, FakeThread>();

  public constructor(
    private readonly bridge: RemoteWorkspaceBridge,
    public readonly workerId = "fake-worker-1",
    public readonly userId = "local-user",
  ) {}

  public status(): { workerId: string; userId: string; state: "ready"; threadCount: number } {
    return { workerId: this.workerId, userId: this.userId, state: "ready", threadCount: this.threads.size };
  }

  public async handle(request: FakeAppServerRequest): Promise<FakeAppServerResponse> {
    try {
      switch (request.method) {
        case "initialize":
          return this.success(request.id, {
            protocol: "fake-app-server",
            workerId: this.workerId,
            capabilities: ["thread/start", "turn/start", "tool/call", "workspace/list", "read_file", "exec"],
          });
        case "thread/start": {
          const thread: FakeThread = { id: `thread_${randomUUID()}`, createdAt: new Date().toISOString() };
          this.threads.set(thread.id, thread);
          return this.success(request.id, { threadId: thread.id, createdAt: thread.createdAt });
        }
        case "turn/start":
          return this.startTurn(request);
        case "tool/call":
          return this.callTool(request);
        case "thread/interrupt":
          return this.success(request.id, { interrupted: true });
        case "workspace/list":
        case "workspace/stat":
        case "read_file":
        case "fs/list_dir":
        case "fs/read_file":
        case "exec":
        case "process/exec":
          // Direct tool names are useful for the local smoke test while the
          // App Server-shaped `tool/call` path remains the canonical route.
          return this.callTool({ ...request, method: "tool/call", params: { tool: request.method, arguments: request.params } });
        default:
          return this.failure(request.id, `unsupported Fake App Server method: ${request.method}`, "METHOD_NOT_FOUND");
      }
    } catch (error) {
      return this.failure(request.id, error instanceof Error ? error.message : String(error), "WORKER_ERROR");
    }
  }

  private async startTurn(request: FakeAppServerRequest): Promise<FakeAppServerResponse> {
    const threadId = stringParam(request.params, "threadId");
    if (threadId) {
      const thread = this.threads.get(threadId);
      if (!thread) return this.failure(request.id, "thread does not belong to this worker", "NOT_FOUND");
      const turnId = `turn_${randomUUID()}`;
      thread.lastTurnId = turnId;
      if (typeof request.params.tool === "string") {
        const toolResponse = await this.bridge.callTool(request.params.tool, request.params.arguments ?? {}, {
          taskId: turnId,
          traceId: stringParam(request.params, "traceId"),
          operationId: stringParam(request.params, "operationId"),
          idempotencyKey: stringParam(request.params, "idempotencyKey"),
        });
        return toolResponse.ok
          ? this.success(request.id, { turnId, tool: request.params.tool, response: toolResponse })
          : this.wrapAgentResponse(request.id, toolResponse);
      }
      return this.success(request.id, { turnId, status: "started" });
    }
    return this.failure(request.id, "threadId is required", "INVALID_PARAMS");
  }

  private async callTool(request: FakeAppServerRequest): Promise<FakeAppServerResponse> {
    const tool = stringParam(request.params, "tool") ?? stringParam(request.params, "name");
    if (!tool) return this.failure(request.id, "tool is required", "INVALID_PARAMS");
    const argumentsValue = request.params.arguments ?? request.params.args ?? {};
    const response = await this.bridge.callTool(tool, argumentsValue, {
      taskId: stringParam(request.params, "taskId"),
      traceId: stringParam(request.params, "traceId"),
      operationId: stringParam(request.params, "operationId"),
      idempotencyKey: stringParam(request.params, "idempotencyKey"),
    });
    return this.wrapAgentResponse(request.id, response);
  }

  private wrapAgentResponse(id: string, response: AgentRpcResponsePayload): FakeAppServerResponse {
    return response.ok
      ? this.success(id, response.result)
      : this.failure(id, response.error ?? "remote tool failed", response.errorCode, response.retryable);
  }

  private success(id: string, result: unknown): FakeAppServerResponse {
    return { id, ok: true, result };
  }

  private failure(id: string, error: string, errorCode?: string, retryable?: boolean): FakeAppServerResponse {
    return { id, ok: false, error, errorCode, retryable };
  }
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
