// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AppServerMessage, JsonRpcId } from "./app-server-client";
import type { RpcClient } from "./platform-gateway-client";

/**
 * Codexia-compatible service boundary. The UI speaks in Thread/Turn terms;
 * only this adapter knows whether the transport is a central stable gateway
 * or the development-only local App Server bridge.
 */
export class CodexiaGatewayAdapter {
  public constructor(public readonly transport: RpcClient) {}

  public subscribe(listener: (message: AppServerMessage) => void): () => void {
    return this.transport.subscribe(listener);
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
    return this.transport.request("thread/delete", { threadId });
  }

  public async turnStart(params: Record<string, unknown>): Promise<AppServerMessage> {
    return this.transport.request("turn/start", params);
  }

  public async turnInterrupt(params: Record<string, unknown>): Promise<AppServerMessage> {
    return this.transport.request("turn/interrupt", params);
  }

  public async requestDevice(method: "workspace/list" | "read_file" | "exec", params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    if (!this.transport.requestDevice) throw new Error("当前传输不支持客户端设备操作");
    return this.transport.requestDevice(method, params);
  }

  public respond(id: JsonRpcId, result: unknown): void {
    this.transport.respond(id, result);
  }

  public close(): void {
    this.transport.close();
  }
}
