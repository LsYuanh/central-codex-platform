// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AppServerClientInfo, AppServerMessage, JsonRpcId } from "./app-server-client";

type GatewayEnvelope = {
  type?: string;
  requestId?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
  eventType?: string;
  name?: string;
  method?: string;
  kind?: "approval" | "user-input";
  sequence?: number;
  agent?: string;
  agentInfo?: unknown;
  lastHeartbeatAt?: string;
};

type PlatformGatewayClientOptions = {
  /** Reconnect only after a connection that was previously established. */
  autoReconnect?: boolean;
  maxReconnectDelayMs?: number;
};

type PendingRequest = {
  resolve: (message: AppServerMessage) => void;
  reject: (error: Error) => void;
  timer: number;
};

type MessageListener = (message: AppServerMessage) => void;

export interface RpcClient {
  readonly connected: boolean;
  subscribe(listener: MessageListener): () => void;
  connect(): Promise<AppServerMessage>;
  request(method: string, params?: Record<string, unknown>): Promise<AppServerMessage>;
  respond(id: JsonRpcId, result: unknown): void;
  close(): void;
}

export class PlatformGatewayClient implements RpcClient {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();
  private connectingPromise: Promise<AppServerMessage> | undefined;
  private reconnectTimer: number | undefined;
  private reconnectAttempt = 0;
  private everConnected = false;
  private closedByUser = false;
  private lastSequence = 0;

  public constructor(
    public readonly url: string,
    private readonly clientInfo: AppServerClientInfo = {
      name: "central-codex-platform-desktop",
      title: "Central Codex Platform Desktop",
      version: "0.1.0",
    },
    private readonly options: PlatformGatewayClientOptions = {},
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
    if (this.connectingPromise) return this.connectingPromise;
    this.closedByUser = false;
    this.connectingPromise = this.connectInternal().finally(() => {
      this.connectingPromise = undefined;
    });
    return this.connectingPromise;
  }

  private async connectInternal(): Promise<AppServerMessage> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    // Install all handlers before awaiting `open`: gateway.ready and device
    // status may be sent immediately after the WebSocket handshake.
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.handleClose(socket));
    socket.addEventListener("error", () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("中央测试网关连接超时")), 8_000);
        const onOpen = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        const onError = () => {
          window.clearTimeout(timeout);
          reject(new Error(`无法连接中央测试网关：${this.url}`));
        };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      });

      const initialized = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: {},
      });
      const wasReconnect = this.everConnected;
      this.everConnected = true;
      this.reconnectAttempt = 0;
      if (wasReconnect) this.emit({ method: "gateway/reconnected", params: { url: this.url } });
      return initialized;
    } catch (error) {
      // Do not leave a half-open socket behind after a failed handshake or
      // initialize request. Its close event is harmless and identity-checked.
      if (this.socket === socket) socket.close();
      throw error;
    }
  }

  public async request(method: string, params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    const operation = operationForMethod(method);
    if (!operation) throw new Error(`中央测试网关不支持 ${method}`);
    return this.requestOperation(operation, params);
  }

  /** Device Broker operations intentionally use a separate stable namespace from App Server methods. */
  public async requestDevice(method: "workspace/list" | "read_file" | "exec", params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    const operation = deviceOperationForMethod(method);
    if (!operation) throw new Error(`中央 Device Broker 不支持 ${method}`);
    return this.requestOperation(operation, params);
  }

  private requestOperation(operation: string, params: Record<string, unknown>): Promise<AppServerMessage> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("中央测试网关尚未连接");
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${operation} 请求超时`));
      }, 60_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "request", requestId, operation, payload: params }));
    });
  }

  public respond(id: JsonRpcId, result: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("中央测试网关尚未连接");
    socket.send(JSON.stringify({ type: "approval.response", requestId: String(id), result }));
  }

  public close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectPending(new Error("中央测试网关客户端已断开"));
    this.socket?.close();
    this.socket = undefined;
  }

  private handleClose(socket: WebSocket): void {
    this.rejectPending(new Error("中央测试网关连接已关闭"));
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.emit({ method: "gateway/disconnected", params: { url: this.url } });
    if (this.options.autoReconnect !== false && this.everConnected && !this.closedByUser) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.closedByUser) return;
    const maxDelay = this.options.maxReconnectDelayMs ?? 15_000;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, maxDelay);
    this.reconnectAttempt += 1;
    this.emit({ method: "gateway/reconnecting", params: { url: this.url, attempt: this.reconnectAttempt, delayMs: delay } });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private handleMessage(raw: string): void {
    let message: GatewayEnvelope;
    try {
      message = JSON.parse(raw) as GatewayEnvelope;
    } catch {
      this.emit({ method: "client/parseError", params: { raw } });
      return;
    }

    if (message.type === "response" && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.ok === false) pending.reject(new Error(message.error ?? "中央测试网关请求失败"));
      else pending.resolve({ result: message.data });
      return;
    }
    if (message.type === "approval.request" && message.requestId) {
      if (!this.acceptSequence(message.sequence)) return;
      this.emit({ id: message.requestId, method: message.method, params: message.data, requestKind: message.kind, sequence: message.sequence });
      return;
    }
    if (message.type === "approval.resolved") {
      if (!this.acceptSequence(message.sequence)) return;
      this.emit({ method: "serverRequest/resolved", params: { requestId: message.requestId }, sequence: message.sequence });
      return;
    }
    if (message.type === "gateway.ready") {
      this.emit({ method: "device/status", params: { agent: message.agent ?? "offline" } });
      return;
    }
    if (message.type === "event") {
      if (this.acceptSequence(message.sequence)) this.emit(normalizeEvent(message));
    }
    if (message.type === "device.status") this.emit({ method: "device/status", params: { agent: message.agent, agentInfo: message.agentInfo, lastHeartbeatAt: message.lastHeartbeatAt } });
  }

  private acceptSequence(sequence: number | undefined): boolean {
    if (sequence === undefined) return true;
    if (sequence <= this.lastSequence) return false;
    if (this.lastSequence > 0 && sequence > this.lastSequence + 1) {
      this.emit({ method: "gateway/sequenceGap", params: { expected: this.lastSequence + 1, received: sequence } });
    }
    this.lastSequence = sequence;
    return true;
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

function operationForMethod(method: string): string | undefined {
  return {
    initialize: "session.initialize",
    "thread/start": "conversation.create",
    "thread/resume": "conversation.resume",
    "thread/read": "conversation.read",
    "thread/archive": "conversation.archive",
    "thread/unarchive": "conversation.unarchive",
    "thread/delete": "conversation.delete",
    "thread/name/set": "conversation.rename",
    "turn/start": "conversation.turn.create",
    "turn/interrupt": "conversation.turn.cancel",
    "thread/list": "conversation.list",
  }[method];
}

function deviceOperationForMethod(method: string): string | undefined {
  return {
    "workspace/list": "device.workspace.list",
    read_file: "device.read_file",
    exec: "device.exec",
  }[method];
}

function normalizeEvent(message: GatewayEnvelope): AppServerMessage {
  if (message.eventType === "assistant.delta") {
    const data = asRecord(message.data);
    return { method: "item/agentMessage/delta", params: data, sequence: message.sequence };
  }
  if (message.eventType === "turn.completed") {
    const data = asRecord(message.data);
    return { method: "turn/completed", params: data, sequence: message.sequence };
  }
  return { method: message.name ?? "codex/notification", params: message.data, sequence: message.sequence };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
