// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { UiError } from "./i18n.ts";


export type JsonRpcId = number | string;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface AppServerMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
  /** Central gateway metadata; never sent to a local App Server. */
  sequence?: number;
  requestKind?: "approval" | "user-input" | "tool-call";
}

export interface AppServerClientInfo {
  name: string;
  title: string;
  version: string;
}

type PendingRequest = {
  resolve: (message: AppServerMessage) => void;
  reject: (error: Error) => void;
  timer: number;
};

type MessageListener = (message: AppServerMessage) => void;

/**
 * Minimal browser-side JSON-RPC client for the local Codex App Server dev
 * transport. It intentionally has no OpenAI/auth logic; the local `codex`
 * process owns that state.
 */
export class AppServerClient {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();

  public constructor(
    public readonly url: string,
    private readonly clientInfo: AppServerClientInfo = {
      name: "central-codex-local-spike",
      title: "Central Codex Platform Local Spike",
      version: "0.1.0",
    },
  ) {}

  public get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async connect(): Promise<AppServerMessage> {
    if (this.connected) return { result: {} };
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new UiError("App Server WebSocket 连接超时")), 8_000);
      const onOpen = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      const onError = () => {
        window.clearTimeout(timeout);
        reject(new UiError("无法连接 App Server：{{p0}}", { p0: this.url }));
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });

    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => {
      this.rejectPending(new UiError("App Server 连接已关闭"));
      if (this.socket === socket) this.socket = undefined;
    });
    socket.addEventListener("error", () => {
      // The close event carries the actionable state transition. Avoid showing
      // duplicate browser-level error events in the chat transcript.
    });

    const initialized = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {},
    });
    this.notify("initialized", {});
    return initialized;
  }

  public async request(method: string, params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new UiError("App Server 尚未连接");
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(String(id));
        reject(new UiError("{{p0}} 请求超时", { p0: method }));
      }, 60_000);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public notify(method: string, params: Record<string, unknown> = {}): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new UiError("App Server 尚未连接");
    socket.send(JSON.stringify({ method, params }));
  }

  /** Reply to a server-initiated JSON-RPC request (for example an approval). */
  public respond(id: JsonRpcId, result: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new UiError("App Server 尚未连接");
    socket.send(JSON.stringify({ id, result }));
  }

  public close(): void {
    this.rejectPending(new UiError("App Server 客户端已断开"));
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(raw: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(raw) as AppServerMessage;
    } catch {
      this.emit({ method: "client/parseError", params: { raw } });
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        this.emit(message);
        return;
      }
      window.clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message);
      return;
    }

    this.emit(message);
  }

  private emit(message: AppServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function threadIdFromResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const thread = isRecord(result.thread) ? result.thread : undefined;
  if (thread && typeof thread.id === "string") return thread.id;
  return typeof result.threadId === "string" ? result.threadId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
