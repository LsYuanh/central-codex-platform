// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AppServerMessage, JsonRpcId } from "./app-server-client";
import type { RpcClient, DeviceMethod } from "./platform-gateway-client";
import { clientGitDiff, normalizeGatewayUiEvent, type ClientGitDiff, type GatewayUiEvent } from "./gateway-ui-events";

/**
 * Codexia-compatible service boundary. The UI speaks in Thread/Turn terms;
 * only this adapter knows whether the transport is a central stable gateway
 * or the development-only local App Server bridge.
 */
export class CodexiaGatewayAdapter {
  public constructor(public readonly transport: RpcClient) {}

  public subscribeUi(listener: (event: GatewayUiEvent) => void): () => void {
    return this.transport.subscribe(message => listener(normalizeGatewayUiEvent(message)));
  }

  public async initialize(): Promise<AppServerMessage> {
    return this.transport.connect();
  }

  public async modelList(params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    return this.transport.request("model/list", params);
  }

  public async threadStart(params: Record<string, unknown>): Promise<AppServerMessage> {
    return this.transport.request("thread/start", params);
  }

  public async threadResume(threadId: string): Promise<AppServerMessage> {
    return this.transport.request("thread/resume", { threadId });
  }

  public async threadRead(threadId: string): Promise<AppServerMessage> {
    // App Server omits historical turns unless explicitly requested.
    return this.transport.request("thread/read", { threadId, includeTurns: true });
  }

  public async threadList(params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    return this.transport.request("thread/list", params);
  }

  public async threadRename(threadId: string, name: string): Promise<AppServerMessage> {
    return this.transport.request("thread/name/set", { threadId, name });
  }

  public async threadArchive(threadId: string): Promise<AppServerMessage> {
    return this.transport.request("thread/archive", { threadId });
  }

  public async threadUnarchive(threadId: string): Promise<AppServerMessage> {
    return this.transport.request("thread/unarchive", { threadId });
  }

  public async threadDelete(threadId: string): Promise<AppServerMessage> {
    try {
      return await this.transport.request("thread/delete", { threadId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\bREMOTE_WORKSPACE_UNSUPPORTED: thread\/delete(?:["\s}]|$)/.test(message)) {
        throw new Error("当前中央运行时尚未支持删除对话，请联系管理员升级中央服务后重试。本次未删除对话。", { cause: error });
      }
      throw error;
    }
  }

  public async turnStart(params: Record<string, unknown>): Promise<AppServerMessage> {
    return this.transport.request("turn/start", params);
  }

  public async turnInterrupt(params: Record<string, unknown>): Promise<AppServerMessage> {
    return this.transport.request("turn/interrupt", params);
  }

  public async turnSteer(params: Record<string, unknown>): Promise<AppServerMessage> {
    return this.transport.request("turn/steer", params);
  }

  public async requestDevice(method: DeviceMethod, params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    if (!this.transport.requestDevice) throw new Error("当前传输不支持客户端设备操作");
    return this.transport.requestDevice(method, params);
  }

  public async workspaceDiff(path: string, staged = false): Promise<ClientGitDiff> {
    const response = await this.requestDevice("workspace/git_diff", {path, staged});
    const payload = response.result as {ok?: boolean; result?: unknown; error?: unknown; errorCode?: string} | undefined;
    if (payload?.ok === false) throw new Error(`${payload.errorCode ?? "DIFF_FAILED"}: ${String(payload.error ?? "无法读取客户端 diff")}`);
    return clientGitDiff(payload?.result ?? payload);
  }

  public respond(id: JsonRpcId, result: unknown): void {
    this.transport.respond(id, result);
  }

  public close(): void {
    this.transport.close();
  }
}
