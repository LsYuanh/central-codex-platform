// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, UiError } from "./i18n.ts";


import type { AppServerClientInfo, AppServerMessage, JsonRpcId } from "./app-server-client";
import { invoke } from "./native-invoke";
import { isTauri } from "@tauri-apps/api/core";
import { NativeGatewaySocket } from "./native-gateway-socket";
import {gatewayAuthCode,gatewayAuthNotice,gatewayAuthMessage} from "./gateway-auth-error";
import {centralTransportNotice,centralTransportMessage} from "./platform-pairing-state";

type GatewayEnvelope = {
  type?: string;
  requestId?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
  eventType?: string;
  name?: string;
  method?: string;
  kind?: "approval" | "user-input" | "tool-call";
  sequence?: number;
  agent?: string;
  agentInfo?: unknown;
  deviceId?: string;
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
function connectionError(message:string):Error {
  const code=gatewayAuthCode(message);
  const value = code ? gatewayAuthMessage(code) : centralTransportMessage(message);
  return value && typeof value !== "string" ? new UiError(value.key, value.values) : new Error(message);
}
function terminalIdentityError(message:string):boolean {
  return gatewayAuthCode(message)!==undefined||/请先登录|请应用/.test(message);
}
export type DeviceMethod = "workspace/list" | "read_file" | "exec" | "workspace/git_diff";

export interface RpcClient {
  readonly connected: boolean;
  subscribe(listener: MessageListener): () => void;
  connect(): Promise<AppServerMessage>;
  request(method: string, params?: Record<string, unknown>): Promise<AppServerMessage>;
  requestDevice?(method: DeviceMethod, params?: Record<string, unknown>): Promise<AppServerMessage>;
  respond(id: JsonRpcId, result: unknown): void;
  close(): void;
}

export class PlatformGatewayClient implements RpcClient {
  private socket: WebSocket | NativeGatewaySocket | undefined;
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
    const target = new URL(this.url);
    if (isTauri()) {
      const identity = await invoke<{deviceId:string}>("attachment_request", {method:"attachment/identity",params:{}});
      if (!target.searchParams.get("deviceId") || target.searchParams.get("deviceId") === "desktop-device") target.searchParams.set("deviceId",identity.deviceId);
      if (target.searchParams.get("deviceId") !== identity.deviceId) throw new UiError("中央连接设备 ID 与本机 Local Agent 不一致，请检查连接设置");
    }
    if (this.closedByUser) throw new UiError("中央连接已取消");
    if(target.protocol==="wss:"&&!isTauri())throw new UiError("平台登录连接需要桌面客户端");
    const socket = target.protocol==="wss:" ? new NativeGatewaySocket() : new WebSocket(target);
    this.socket = socket;
    // Install all handlers before awaiting `open`: gateway.ready and device
    // status may be sent immediately after the WebSocket handshake.
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.handleMessage(String((event as MessageEvent).data));
    });
    socket.addEventListener("close", () => this.handleClose(socket));
    socket.addEventListener("error", () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup=()=>{window.clearTimeout(timeout);socket.removeEventListener("open",onOpen);socket.removeEventListener("error",onError);socket.removeEventListener("close",onClose);};
        const timeout = window.setTimeout(() => {cleanup();reject(new UiError("中央测试网关连接超时"));}, 8_000);
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          if(socket instanceof NativeGatewaySocket && terminalIdentityError(socket.failureError))this.stopReconnect();
          reject((socket instanceof NativeGatewaySocket && socket.failureError ? connectionError(socket.failureError) : new UiError("无法连接中央测试网关：{{p0}}", { p0: this.url })));
        };
        const onClose=()=>{cleanup();reject((socket instanceof NativeGatewaySocket&&socket.failureError?connectionError(socket.failureError):new UiError("中央连接在建立前关闭")));};
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
        socket.addEventListener("close", onClose, { once: true });
      });

      const initialized = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: {},
      });
      this.emit({method:"gateway/capabilities", params:asRecord(initialized.result).platformCapabilities});
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
    if (!operation) throw new UiError("中央测试网关不支持 {{p0}}", { p0: method });
    return this.requestOperation(operation, params);
  }

  /** Device Broker operations intentionally use a separate stable namespace from App Server methods. */
  public async requestDevice(method: DeviceMethod, params: Record<string, unknown> = {}): Promise<AppServerMessage> {
    const operation = deviceOperationForMethod(method);
    if (!operation) throw new UiError("中央 Device Broker 不支持 {{p0}}", { p0: method });
    return this.requestOperation(operation, params);
  }

  private requestOperation(operation: string, params: Record<string, unknown>): Promise<AppServerMessage> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new UiError("中央测试网关尚未连接");
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new UiError("{{p0}} 请求超时", { p0: operation }));
      }, operation === "conversation.turn.create" ? 110_000 : 60_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "request", requestId, operation, payload: params }));
    });
  }

  public respond(id: JsonRpcId, result: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new UiError("中央测试网关尚未连接");
    socket.send(JSON.stringify({ type: "approval.response", requestId: String(id), result }));
  }

  public close(): void {
    this.stopReconnect();
    this.rejectPending(new UiError("中央测试网关客户端已断开"));
    this.socket?.close();
    this.socket = undefined;
  }

  private stopReconnect():void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleClose(socket: WebSocket | NativeGatewaySocket): void {
    if (this.socket !== socket) return;
    if(socket instanceof NativeGatewaySocket && socket.pageUnloaded)this.stopReconnect();
    const code=socket instanceof NativeGatewaySocket?gatewayAuthCode(socket.failureError):undefined;
    if(code)this.stopReconnect();
    this.rejectPending((code?connectionError(code):new UiError("中央测试网关连接已关闭")));
    this.socket = undefined;
    this.emit({ method: "gateway/disconnected", params: { url: this.url,...(code?{code,error:gatewayAuthNotice(code),retryable:false}:{}) } });
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
      if (message.ok === false) {
        const error=message.error??t("中央测试网关请求失败");
        if(terminalIdentityError(error))this.stopReconnect();
        pending.reject(connectionError(error));
        const code=gatewayAuthCode(error);
        if(code&&this.socket instanceof NativeGatewaySocket){this.socket.failureError=code;this.socket.close();}
      }
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
      this.lastSequence = 0;
      this.emit({ method: "device/status", params: { agent: message.agent ?? "offline", deviceId:message.deviceId } });
      return;
    }
    if (message.type === "event") {
      if (this.acceptSequence(message.sequence)) this.emit(normalizeEvent(message));
    }
    if (message.type === "device.status") this.emit({ method: "device/status", params: { agent: message.agent, deviceId:message.deviceId, agentInfo: message.agentInfo, lastHeartbeatAt: message.lastHeartbeatAt } });
  }

  private acceptSequence(sequence: number | undefined): boolean {
    if (sequence === undefined) return true;
    if (sequence <= this.lastSequence) return false;
    // The gateway sequence is global, while events are filtered per owner.
    // Gaps caused by other clients are expected and are not transport failures.
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
    "model/list": "model.list",
    "collaborationMode/list": "collaboration.list",
    "thread/goal/get": "conversation.goal.get",
    "thread/goal/set": "conversation.goal.set",
    "thread/goal/clear": "conversation.goal.clear",
    "project/list": "project.list",
    "skill/list": "skill.list",
    "skill/draft": "skill.draft",
    "skill/preview": "skill.preview",
    "skill/save": "skill.save",
    "skill/update": "skill.update",
    "skill/remove": "skill.remove",
    "skill/discard": "skill.discard",
    "skill/read": "skill.read",

    "project/save": "project.save",
    "project/remove": "project.remove",
    "thread/start": "conversation.create",
    "thread/resume": "conversation.resume",
    "thread/read": "conversation.read",
    "thread/archive": "conversation.archive",
    "thread/unarchive": "conversation.unarchive",
    "thread/delete": "conversation.delete",
    "thread/name/set": "conversation.rename",
    "turn/start": "conversation.turn.create",
    "turn/steer": "conversation.turn.steer",
    "turn/interrupt": "conversation.turn.cancel",
    "message/status": "conversation.message.status",
    "message/cancel": "conversation.message.cancel",
    "output/retry": "conversation.output.retry",
    "thread/list": "conversation.list",
  }[method];
}

function deviceOperationForMethod(method: string): string | undefined {
  return {
    "workspace/list": "device.workspace.list",
    read_file: "device.read_file",
    exec: "device.exec",
    "workspace/git_diff": "device.workspace.git_diff",
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
