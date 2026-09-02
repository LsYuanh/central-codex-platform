// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppServerClient, type AppServerMessage, type JsonRpcId, threadIdFromResult } from "./app-server-client";
import { CodexiaGatewayAdapter } from "./codexia-gateway-adapter";
import { PlatformGatewayClient, type RpcClient } from "./platform-gateway-client";
import { MarkdownMessage } from "./MarkdownMessage";
import { WorkspacePanel } from "./WorkspacePanel";

type ConnectionState = "connecting" | "online" | "offline";
type TestMode = "central-gateway" | "local-app-server" | "fake-central";
type ChatRole = "user" | "assistant" | "system";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

interface ThreadSummary {
  id: string;
  name?: string;
  cwd?: string;
  updatedAt?: string;
  archived?: boolean;
}

interface GatewayStatus {
  gateway: ConnectionState;
  agent: ConnectionState;
  worker?: { workerId: string; state: string; threadCount: number };
}

interface ApprovalRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
  kind: "approval" | "user-input" | "other";
}

interface WorkspaceEntry {
  name: string;
  kind: "directory" | "file" | "other";
  bytes?: number;
}

const gatewayUrl = "ws://127.0.0.1:4310/ws/ui";
const configuredGatewayUrl = import.meta.env.VITE_PLATFORM_GATEWAY_URL?.trim();
const defaultGatewayUsesTestPrincipal = !configuredGatewayUrl;
const defaultCentralHost = import.meta.env.VITE_CENTRAL_HOST?.trim() || "192.0.2.10";
const defaultGatewayUrl = configuredGatewayUrl || `ws://${defaultCentralHost}:4510/ws?userId=desktop-user&deviceId=desktop-device`;
const defaultAppServerUrl = import.meta.env.VITE_CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4501";
const defaultAppServerCwd = import.meta.env.VITE_CODEX_APP_SERVER_CWD ?? "";

export default function App() {
  const gatewaySocketRef = useRef<WebSocket | undefined>(undefined);
  const gatewayReconnectRef = useRef<number | undefined>(undefined);
  const appClientRef = useRef<RpcClient | undefined>(undefined);
  const codexiaRef = useRef<CodexiaGatewayAdapter | undefined>(undefined);
  const appUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const [gateway, setGateway] = useState<GatewayStatus>({ gateway: "connecting", agent: "offline" });
  const [deviceState, setDeviceState] = useState<ConnectionState>("offline");
  const [runtimeVersion, setRuntimeVersion] = useState("browser preview");
  const [mode, setMode] = useState<TestMode>("central-gateway");
  const [appUrl, setAppUrl] = useState(defaultGatewayUrl);
  const [appCwd, setAppCwd] = useState(defaultAppServerCwd);
  const [appModel, setAppModel] = useState("");
  const [appState, setAppState] = useState<ConnectionState>("offline");
  const [appError, setAppError] = useState("");
  const [threadId, setThreadId] = useState<string | undefined>();
  const threadIdRef = useRef<string | undefined>(undefined);
  threadIdRef.current = threadId;
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadQuery, setThreadQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [threadBusy, setThreadBusy] = useState<string | undefined>();
  const [turnId, setTurnId] = useState<string | undefined>();
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | undefined>();
  const [approvalResponse, setApprovalResponse] = useState('{"decision":"accept"}');
  const [turnRunning, setTurnRunning] = useState(false);
  const [gatewayOutput, setGatewayOutput] = useState("等待 Device Broker 连接……");
  const [workspacePath, setWorkspacePath] = useState(".");
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceContent, setWorkspaceContent] = useState("");
  const [workspaceContentPath, setWorkspaceContentPath] = useState("");
  const [workspaceCommand, setWorkspaceCommand] = useState<"git" | "node">("git");

  useEffect(() => {
    getVersion().then(setRuntimeVersion).catch(() => setRuntimeVersion("browser preview"));
  }, []);

  useEffect(() => {
    if (mode !== "fake-central") {
      window.clearTimeout(gatewayReconnectRef.current);
      gatewaySocketRef.current?.close();
      gatewaySocketRef.current = undefined;
      setGateway({ gateway: "offline", agent: "offline" });
      return;
    }

    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setGateway((current) => ({ ...current, gateway: "connecting" }));
      const socket = new WebSocket(gatewayUrl);
      gatewaySocketRef.current = socket;

      socket.addEventListener("open", () => setGateway((current) => ({ ...current, gateway: "online" })));
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            gateway?: ConnectionState;
            agent?: ConnectionState;
            worker?: GatewayStatus["worker"];
            response?: unknown;
            error?: string;
          };
          if (message.type === "gateway.status") {
            setGateway({ gateway: message.gateway ?? "online", agent: message.agent ?? "offline", worker: message.worker });
          } else if (message.type === "agent.response") {
            setGatewayOutput(JSON.stringify(message.response, null, 2));
          } else if (message.type === "gateway.error") {
            setGatewayOutput(message.error ?? "Fake Central 返回未知错误");
          }
        } catch {
          setGatewayOutput("Fake Central 返回了无法解析的消息");
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setGateway({ gateway: "offline", agent: "offline" });
        gatewayReconnectRef.current = window.setTimeout(connect, 1500);
      });
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(gatewayReconnectRef.current);
      gatewaySocketRef.current?.close();
      gatewaySocketRef.current = undefined;
    };
  }, [mode]);

  const addEvent = useCallback((message: AppServerMessage) => {
    const method = message.method ?? (message.error ? "error" : "response");
    setEvents((current) => [`${new Date().toLocaleTimeString()}  ${method}`, ...current].slice(0, 80));
  }, []);

  const appendAssistantDelta = useCallback((delta: string) => {
    if (!delta) return;
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last?.role === "assistant") {
        return [...current.slice(0, -1), { ...last, content: `${last.content}${delta}` }];
      }
      return [...current, { id: crypto.randomUUID(), role: "assistant", content: delta }];
    });
  }, []);

  const handleAppServerMessage = useCallback(
    (message: AppServerMessage) => {
      addEvent(message);
      const params = asRecord(message.params);
      // The Spike gateway currently broadcasts upstream notifications to all
      // connected UI sockets. Render only events belonging to this UI's
      // selected Thread; this is a client-side defense-in-depth measure and
      // does not replace the gateway's server-side ownership checks.
      const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      const threadBound = message.method === "item/agentMessage/delta" || message.method === "turn/completed";
      if (mode === "central-gateway" && threadBound && eventThreadId !== threadIdRef.current) return;
      if (eventThreadId && eventThreadId !== threadIdRef.current) return;

      if (message.method === "device/status") {
        setDeviceState(params?.agent === "online" ? "online" : "offline");
        return;
      }
      if (message.method === "gateway/disconnected") {
        setAppState("offline");
        setDeviceState("offline");
        setTurnRunning(false);
        setTurnId(undefined);
        return;
      }
      if (message.method === "gateway/reconnecting") {
        setAppState("connecting");
        setDeviceState("offline");
        return;
      }
      if (message.method === "gateway/reconnected") {
        // The default test principal gives the gateway durable-for-process
        // ownership across reconnects. Preserve the selected Thread so the
        // user can continue it, but never retry an interrupted write/turn.
        setAppState("online");
        setDeviceState("offline");
        setTurnRunning(false);
        setTurnId(undefined);
        const activeThreadId = threadIdRef.current;
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: activeThreadId ? "中央连接已恢复，正在恢复当前 Thread；中断中的写操作不会自动重试。" : "中央连接已恢复，请创建或恢复 Thread 后继续。" }]);
        if (activeThreadId) {
          const codexia = codexiaRef.current;
          void codexia?.threadRead(activeThreadId).then((history) => {
            setMessages([{ id: crypto.randomUUID(), role: "system", content: `已恢复 Thread ${activeThreadId} 历史` }, ...messagesFromThreadRead(history.result)]);
          }).catch((error) => {
            setAppError(error instanceof Error ? error.message : String(error));
          });
        }
        return;
      }
      if (message.method === "gateway/sequenceGap") {
        const gap = asRecord(message.params);
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: `检测到事件流缺口（收到序号 ${String(gap?.received ?? "?")}），请刷新 Thread 历史。` }]);
        return;
      }

      if (message.id !== undefined && message.method) {
        const kind = message.requestKind ?? (message.method.includes("requestApproval")
          ? "approval"
          : message.method === "item/tool/requestUserInput"
            ? "user-input"
            : "other");
        if (kind !== "other") {
          setApproval({ id: message.id, method: message.method, params: message.params, kind });
          setApprovalResponse(kind === "user-input" ? '{"answers":{}}' : '{"decision":"accept"}');
          setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: "App Server 请求审批或用户输入" }]);
        }
        return;
      }

      if (message.method === "serverRequest/resolved") {
        setApproval(undefined);
      } else if (message.method === "item/agentMessage/delta") {
        const delta = typeof params?.delta === "string" ? params.delta : typeof params?.text === "string" ? params.text : "";
        appendAssistantDelta(delta);
      } else if (message.method === "turn/completed") {
        setTurnRunning(false);
        setTurnId(undefined);
        const turn = asRecord(params?.turn);
        const status = typeof turn?.status === "string" ? turn.status : "completed";
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: `回合 ${status}` }]);
      } else if (message.method === "error" || message.error) {
        setTurnRunning(false);
        setTurnId(undefined);
        const turnError = asRecord(params?.error);
        const errorMessage = typeof turnError?.message === "string" ? turnError.message : message.error?.message ?? "App Server 返回错误";
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: "system", content: errorMessage },
        ]);
      }
    },
    [addEvent, appendAssistantDelta, mode],
  );

  const disconnectAppServer = useCallback(() => {
    appUnsubscribeRef.current?.();
    appUnsubscribeRef.current = undefined;
    appClientRef.current?.close();
    appClientRef.current = undefined;
    codexiaRef.current = undefined;
    setAppState("offline");
    setThreadId(undefined);
    setTurnId(undefined);
    setApproval(undefined);
    setApprovalResponse('{"decision":"accept"}');
    setTurnRunning(false);
    setDeviceState("offline");
    setThreads([]);
    setWorkspaceEntries([]);
    setWorkspaceContent("");
    setWorkspaceContentPath("");
  }, []);

  const refreshThreads = useCallback(async () => {
    const codexia = codexiaRef.current;
    if (!codexia) return;
    try {
      const response = await codexia.threadList({ limit: 100, sortKey: "updated_at", ...(showArchived ? { archived: true } : {}) });
      setThreads(threadSummariesFromResult(response.result));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }, [showArchived]);

  useEffect(() => {
    if (appState === "online") void refreshThreads();
  }, [appState, refreshThreads, showArchived]);

  const renameThread = useCallback(async (thread: ThreadSummary) => {
    const codexia = codexiaRef.current;
    if (!codexia) return;
    const currentName = thread.name || thread.id.slice(0, 12);
    const nextName = window.prompt("重命名 Thread", currentName)?.trim();
    if (!nextName || nextName === currentName) return;
    setThreadBusy(`${thread.id}:rename`);
    setAppError("");
    try {
      await codexia.threadRename(thread.id, nextName);
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, name: nextName } : item));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, []);

  const archiveThread = useCallback(async (thread: ThreadSummary) => {
    const codexia = codexiaRef.current;
    if (!codexia) return;
    setThreadBusy(`${thread.id}:${thread.archived ? "unarchive" : "archive"}`);
    setAppError("");
    try {
      if (thread.archived) await codexia.threadUnarchive(thread.id);
      else await codexia.threadArchive(thread.id);
      if (thread.id === threadIdRef.current && !thread.archived) {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: "Thread 已归档；你仍可继续当前对话。" }]);
      }
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, archived: !thread.archived } : item));
      if (!showArchived && !thread.archived) setThreads((current) => current.filter((item) => item.id !== thread.id));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, [showArchived]);

  const deleteThread = useCallback(async (thread: ThreadSummary) => {
    const codexia = codexiaRef.current;
    if (!codexia || !window.confirm(`确定删除 Thread「${thread.name || thread.id.slice(0, 12)}」？此操作不可恢复。`)) return;
    setThreadBusy(`${thread.id}:delete`);
    setAppError("");
    try {
      await codexia.threadDelete(thread.id);
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      if (thread.id === threadIdRef.current) {
        setThreadId(undefined);
        setTurnId(undefined);
        setMessages([{ id: crypto.randomUUID(), role: "system", content: "Thread 已删除，请创建一个新的 Thread。" }]);
      }
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, []);

  const connectAppServer = useCallback(async () => {
    disconnectAppServer();
    setAppError("");
    setAppState("connecting");
      const client: RpcClient = mode === "central-gateway"
      ? new PlatformGatewayClient(appUrl.trim(), undefined, { autoReconnect: true })
      : new AppServerClient(appUrl.trim());
    const codexia = new CodexiaGatewayAdapter(client);
    appClientRef.current = client;
    codexiaRef.current = codexia;
    appUnsubscribeRef.current = codexia.subscribe(handleAppServerMessage);
    try {
      await codexia.initialize();
      const threadResponse = await codexia.threadStart({
        ...(appModel.trim() ? { model: appModel.trim() } : {}),
        ...(appCwd.trim() ? { cwd: appCwd.trim() } : {}),
        serviceName: "central-codex-local-spike",
      });
      const nextThreadId = threadIdFromResult(threadResponse.result);
      if (!nextThreadId) throw new Error("thread/start 返回中没有 thread.id");
      setThreadId(nextThreadId);
      setTurnId(undefined);
      setAppState("online");
      setMessages([{ id: crypto.randomUUID(), role: "system", content: `${mode === "central-gateway" ? "已连接中央测试网关" : "已连接本机 App Server"}，Thread ${nextThreadId}` }]);
      setThreads([{ id: nextThreadId, cwd: appCwd.trim() || undefined }]);
      void refreshThreads();
    } catch (error) {
      client.close();
      appClientRef.current = undefined;
      appUnsubscribeRef.current?.();
      appUnsubscribeRef.current = undefined;
      setAppState("offline");
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }, [appCwd, appModel, appUrl, disconnectAppServer, handleAppServerMessage, mode, refreshThreads]);

  useEffect(() => disconnectAppServer, [disconnectAppServer]);

  const sendTurn = useCallback(async () => {
    const text = composer.trim();
    const codexia = codexiaRef.current;
    if (!text || !codexia || !threadId || turnRunning) return;
    setComposer("");
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: text }]);
    setTurnRunning(true);
    try {
      const response = await codexia.turnStart({
        threadId,
        input: [{ type: "text", text }],
      });
      const turn = asRecord(asRecord(response.result)?.turn);
      if (typeof turn?.id === "string") setTurnId(turn.id);
    } catch (error) {
      setTurnRunning(false);
      setTurnId(undefined);
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "system", content: error instanceof Error ? error.message : String(error) },
      ]);
    }
  }, [composer, threadId, turnRunning]);

  const startNewThread = useCallback(async () => {
    const codexia = codexiaRef.current;
    if (!codexia) return;
    try {
      const response = await codexia.threadStart({
        ...(appModel.trim() ? { model: appModel.trim() } : {}),
        ...(appCwd.trim() ? { cwd: appCwd.trim() } : {}),
        serviceName: "central-codex-local-spike",
      });
      const nextThreadId = threadIdFromResult(response.result);
      if (!nextThreadId) throw new Error("thread/start 返回中没有 thread.id");
      setThreadId(nextThreadId);
      setTurnId(undefined);
      setMessages([{ id: crypto.randomUUID(), role: "system", content: `已创建新 Thread ${nextThreadId}` }]);
      setEvents([]);
      setThreads((current) => [{ id: nextThreadId, cwd: appCwd.trim() || undefined }, ...current.filter((thread) => thread.id !== nextThreadId)]);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }, [appCwd, appModel, refreshThreads]);

  const resumeThread = useCallback(async (nextThreadId: string) => {
    const codexia = codexiaRef.current;
    if (!codexia) return;
    try {
      await codexia.threadResume(nextThreadId);
      const history = await codexia.threadRead(nextThreadId);
      setThreadId(nextThreadId);
      setTurnId(undefined);
      setMessages([{ id: crypto.randomUUID(), role: "system", content: `已恢复 Thread ${nextThreadId}` }, ...messagesFromThreadRead(history.result)]);
      setEvents([]);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const interruptTurn = useCallback(async () => {
    const codexia = codexiaRef.current;
    if (!codexia || !threadId) return;
    try {
      await codexia.turnInterrupt({ threadId, ...(turnId ? { turnId } : {}) });
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }, [threadId, turnId]);

  const sendApprovalResponse = useCallback((response: unknown) => {
    const client = appClientRef.current;
    if (!client || !approval) return;
    try {
      client.respond(approval.id, response);
      setApproval(undefined);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    }
  }, [approval]);

  const decideApproval = useCallback((decision: "accept" | "acceptForSession" | "decline" | "cancel") => {
    sendApprovalResponse({ decision });
  }, [sendApprovalResponse]);

  const sendCustomApprovalResponse = useCallback(() => {
    setAppError("");
    try {
      sendApprovalResponse(JSON.parse(approvalResponse));
    } catch {
      setAppError("审批响应必须是合法 JSON");
    }
  }, [approvalResponse, sendApprovalResponse]);

  const sendGatewayRequest = useCallback((method: string, params: Record<string, unknown>) => {
    const socket = gatewaySocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setGatewayOutput("Fake Central 尚未连接");
      return;
    }
    const id = crypto.randomUUID();
    setGatewayOutput(`请求 ${method} (${id})……`);
    socket.send(JSON.stringify({ type: "agent.request", request: { id, method, params } }));
  }, []);

  const sendWorkspaceRequest = useCallback(async (method: "workspace/list" | "read_file" | "exec", params: Record<string, unknown>) => {
    if (mode === "fake-central") {
      sendGatewayRequest(method, params);
      return;
    }
    const client = appClientRef.current;
    if (!(client instanceof PlatformGatewayClient)) {
      setGatewayOutput("请先连接中央测试网关");
      return;
    }
    setWorkspaceLoading(true);
    setGatewayOutput(`请求 ${method}……`);
    try {
      const response = await client.requestDevice(method, params);
      const payload = asRecord(response.result);
      if (payload?.ok === false) {
        setGatewayOutput(JSON.stringify(payload, null, 2));
        return;
      }
      const result = payload?.result ?? payload ?? response.result;
      if (method === "workspace/list") {
        const record = asRecord(result);
        const entries = Array.isArray(record?.entries) ? workspaceEntriesFromResult(record.entries) : [];
        setWorkspaceEntries(entries);
        if (typeof record?.path === "string") setWorkspacePath(record.path);
        setWorkspaceContent("");
        setWorkspaceContentPath("");
        setGatewayOutput(`${entries.length} 个条目 · ${typeof record?.path === "string" ? record.path : params.path ?? "."}`);
      } else if (method === "read_file") {
        const record = asRecord(result);
        const content = typeof record?.content === "string" ? record.content : "";
        const path = typeof record?.path === "string" ? record.path : String(params.path ?? "");
        setWorkspaceContent(content);
        setWorkspaceContentPath(path);
        setGatewayOutput(`${path} · ${typeof record?.bytes === "number" ? record.bytes : content.length} bytes`);
      } else {
        setGatewayOutput(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      setGatewayOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceLoading(false);
    }
  }, [mode, sendGatewayRequest]);

  const visibleThreads = threads.filter((thread) => {
    if (!showArchived && thread.archived) return false;
    const query = threadQuery.trim().toLowerCase();
    if (!query) return true;
    return `${thread.name ?? ""} ${thread.id} ${thread.cwd ?? ""}`.toLowerCase().includes(query);
  });

  const workspaceAvailable = mode !== "central-gateway" || deviceState === "online";
  const joinWorkspacePath = useCallback((base: string, name: string) => {
    const normalized = base.trim().replace(/[\\/]+$/, "");
    return normalized && normalized !== "." ? `${normalized}/${name}` : name;
  }, []);

  const navigateWorkspace = useCallback((path: string) => {
    setWorkspacePath(path || ".");
    setWorkspaceContent("");
    setWorkspaceContentPath("");
    void sendWorkspaceRequest("workspace/list", { path: path || "." });
  }, [sendWorkspaceRequest]);

  const readWorkspaceEntry = useCallback((entry: WorkspaceEntry) => {
    const path = joinWorkspacePath(workspacePath, entry.name);
    if (entry.kind === "directory") navigateWorkspace(path);
    else if (entry.kind === "file") void sendWorkspaceRequest("read_file", { path });
  }, [joinWorkspacePath, navigateWorkspace, sendWorkspaceRequest, workspacePath]);

  const parentWorkspacePath = workspacePath.includes("/")
    ? workspacePath.slice(0, workspacePath.lastIndexOf("/")) || "."
    : ".";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">C</div>
          <div>
            <p className="eyebrow">Codexia Workspace</p>
            <h1>Central Codex Platform</h1>
          </div>
        </div>
        <div className="topbar-meta">
          <div className="topbar-connection">
            <span className={`connection-dot dot-${mode !== "fake-central" ? appState : gateway.gateway}`} />
            <span>{mode === "central-gateway" ? `中央网关 · ${appState === "online" ? "已连接" : appState === "connecting" ? "连接中" : "离线"}` : mode === "local-app-server" ? `本机 App Server · ${appState === "online" ? "已连接" : appState === "connecting" ? "连接中" : "离线"}` : `Fake Central · ${gateway.gateway}`}</span>
          </div>
          <span className="runtime">Tauri {runtimeVersion}</span>
        </div>
      </header>

      <div className="layout-grid app-layout">
        <aside className="sidebar app-sidebar">
          <nav className="sidebar-nav" aria-label="主导航">
            <span className="sidebar-nav-title">工作区</span>
            <a className="nav-item active" href="#conversation"><span className="nav-icon">◈</span><span>对话</span><span className="nav-trailing">⌘1</span></a>
            <a className="nav-item" href="#workspace-panel"><span className="nav-icon">▣</span><span>文件与命令</span><span className="nav-trailing">⌘2</span></a>
            <a className="nav-item" href="#events"><span className="nav-icon">≋</span><span>活动日志</span><span className="nav-trailing">⌘3</span></a>
          </nav>

          <section className="panel mode-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">Test transport</p>
                <h2>连接模式</h2>
              </div>
              <span className="dev-badge">DEV</span>
            </div>
            <label className={`mode-option ${mode === "central-gateway" ? "selected" : ""}`}>
              <input type="radio" checked={mode === "central-gateway"} onChange={() => { disconnectAppServer(); setAppUrl(defaultGatewayUrl); setMode("central-gateway"); }} />
              <span><strong>Central Test Gateway</strong><small>中央网关测试 · App Server stdio</small></span>
            </label>
            <label className={`mode-option ${mode === "local-app-server" ? "selected" : ""}`}>
              <input type="radio" checked={mode === "local-app-server"} onChange={() => { disconnectAppServer(); setAppUrl(defaultAppServerUrl); setMode("local-app-server"); }} />
              <span><strong>Local Codex App Server</strong><small>开发专用 · 直连本机桥接</small></span>
            </label>
            <label className={`mode-option ${mode === "fake-central" ? "selected" : ""}`}>
              <input type="radio" checked={mode === "fake-central"} onChange={() => { disconnectAppServer(); setMode("fake-central"); }} />
              <span><strong>Fake Central / AgentRPC</strong><small>工作区与权限验证</small></span>
            </label>
          </section>

          {mode !== "fake-central" ? (
            <section className="panel connection-panel">
              <div className="panel-heading"><h2>{mode === "central-gateway" ? "中央测试网关" : "本机 App Server"}</h2><StatusPill value={appState} /></div>
              <label htmlFor="app-url">WebSocket 地址 {mode === "central-gateway" && defaultGatewayUsesTestPrincipal && appUrl === defaultGatewayUrl && <span className="dev-badge">SPIKE 测试身份</span>}</label>
              <input id="app-url" value={appUrl} onChange={(event) => setAppUrl(event.target.value)} placeholder={mode === "central-gateway" ? "ws://127.0.0.1:4510/ws" : "ws://127.0.0.1:4501"} />
              {mode === "central-gateway" && defaultGatewayUsesTestPrincipal && appUrl === defaultGatewayUrl && <p className="hint">默认 query principal（desktop-user / desktop-device）仅用于 Spike 测试，不能用于生产身份认证。</p>}
              <label htmlFor="app-cwd">工作目录（可选）</label>
              <input id="app-cwd" value={appCwd} onChange={(event) => setAppCwd(event.target.value)} placeholder="C:\\work\\project" />
              <label htmlFor="app-model">模型（可选）</label>
              <input id="app-model" value={appModel} onChange={(event) => setAppModel(event.target.value)} placeholder="gpt-5.6-terra" />
              <div className="button-row">
                {appState === "online" ? <button className="button-secondary" onClick={disconnectAppServer}>断开</button> : <button onClick={() => void connectAppServer()}>连接并创建 Thread</button>}
                <button className="button-secondary" disabled={appState !== "online"} onClick={() => void startNewThread()}>新 Thread</button>
              </div>
              <p className="hint">{mode === "central-gateway" ? <>中央网关直连地址为 <code>ws://{defaultCentralHost}:4510/ws</code>；当前为可信局域网临时模式，客户端不会直连 App Server。</> : <>先在本机运行：<code>codex app-server --listen ws://127.0.0.1:4500</code></>}</p>
              {appError && <p className="error-text">{appError}</p>}
              <div className="thread-list-panel">
                <div className="thread-list-heading"><span>Thread</span><div className="thread-list-tools"><button className="button-quiet" onClick={() => void refreshThreads()}>刷新</button><button className="button-quiet" onClick={() => setShowArchived((value) => !value)}>{showArchived ? "隐藏归档" : "显示归档"}</button></div></div>
                <input className="thread-search" aria-label="搜索 Thread" value={threadQuery} onChange={(event) => setThreadQuery(event.target.value)} placeholder="搜索名称、ID 或工作目录" />
                {visibleThreads.length === 0 ? <span className="muted">{threadQuery ? "没有匹配的 Thread" : showArchived ? "暂无归档 Thread" : "暂无可恢复 Thread"}</span> : visibleThreads.slice(0, 20).map((thread) => {
                  const busy = threadBusy?.startsWith(`${thread.id}:`);
                  return <div key={thread.id} className={`thread-list-item ${thread.id === threadId ? "active" : ""} ${thread.archived ? "archived" : ""}`}>
                    <button className="thread-select" onClick={() => void resumeThread(thread.id)} disabled={Boolean(busy)}><strong>{thread.name || thread.id.slice(0, 12)}</strong><small>{thread.cwd || "中央工作区"}{thread.updatedAt ? ` · ${formatThreadDate(thread.updatedAt)}` : ""}{thread.archived ? " · 已归档" : ""}</small></button>
                    <div className="thread-actions">{busy && <span className="thread-spinner" aria-label="处理中">…</span>}<button className="icon-button" title="重命名" aria-label="重命名" disabled={Boolean(busy)} onClick={() => void renameThread(thread)}>✎</button><button className="icon-button" title={thread.archived ? "恢复" : "归档"} aria-label={thread.archived ? "恢复" : "归档"} disabled={Boolean(busy)} onClick={() => void archiveThread(thread)}>{thread.archived ? "↩" : "⌄"}</button><button className="icon-button danger" title="删除" aria-label="删除" disabled={Boolean(busy)} onClick={() => void deleteThread(thread)}>×</button></div>
                  </div>;
                })}
              </div>
            </section>
          ) : (
            <section className="panel connection-panel">
              <div className="panel-heading"><h2>Fake Central</h2><StatusPill value={gateway.gateway} /></div>
              <p className="hint">中央 Spike 通过 AgentRPC 调用固定工作区。客户端不会读取本机文件。</p>
              <div className="status-list">
                <StatusLine label="Local Agent" value={gateway.agent} />
                <StatusLine label="Worker" value={gateway.worker?.state ?? "unknown"} />
              </div>
            </section>
          )}

          <WorkspacePanel
            mode={mode}
            deviceState={deviceState}
            path={workspacePath}
            entries={workspaceEntries}
            loading={workspaceLoading}
            output={gatewayOutput}
            content={workspaceContent}
            contentPath={workspaceContentPath}
            command={workspaceCommand}
            available={workspaceAvailable}
            onPathChange={setWorkspacePath}
            onOpen={() => navigateWorkspace(workspacePath)}
            onParent={() => navigateWorkspace(parentWorkspacePath)}
            onRefresh={() => navigateWorkspace(workspacePath)}
            onEntryClick={readWorkspaceEntry}
            onCommandChange={setWorkspaceCommand}
            onRunCommand={() => void sendWorkspaceRequest("exec", { program: workspaceCommand, args: ["--version"], cwd: "." })}
            onCloseContent={() => { setWorkspaceContent(""); setWorkspaceContentPath(""); }}
          />
        </aside>

        <section className="chat-column">
          <div className="chat-header panel" id="conversation">
            <div><p className="panel-kicker">Conversation</p><h2>{mode === "central-gateway" ? "中央 Codex 对话" : mode === "local-app-server" ? "本机 Codex 对话" : "Fake Central 工作台"}</h2></div>
            <div className="thread-meta">{threadId ? <><span className="thread-label">THREAD</span><code>{threadId}</code></> : <span>尚未创建 Thread</span>}</div>
          </div>

          <div className="chat-surface panel">
            <div className="message-list" role="log" aria-live="polite" aria-label="对话消息">
              {messages.length === 0 ? (
                <div className="empty-state"><div className="empty-icon">✦</div><h3>准备开始真实测试</h3><p>{mode === "central-gateway" ? "连接中央测试网关后，输入一句话开始一个真实 Codex turn。客户端只访问网关，不接触 App Server。" : "连接本机 App Server 后，输入一句话开始一个真实 Codex turn。命令和文件审批会显示在这里。"}</p></div>
              ) : messages.map((message) => <ChatBubble key={message.id} message={message} />)}
              {turnRunning && <div className="typing-indicator" role="status"><span /><span /><span /> Codex 正在工作<span className="typing-subtext">实时输出中</span></div>}
            </div>

            {appError && <div className="error-banner" role="alert"><span>{appError}</span><button type="button" aria-label="关闭错误" onClick={() => setAppError("")}>×</button></div>}

            {approval && (
              <div className="approval-card" role="alert" aria-live="assertive">
                <div className="approval-heading"><span className="approval-icon">!</span><div><strong>需要你的确认</strong><p>{approval.kind === "user-input" ? "Codex 需要补充输入" : "Codex 请求执行一项操作"}</p><code className="approval-method">{approval.method}</code><pre>{JSON.stringify(approval.params, null, 2)}</pre></div></div>
                {approval.kind === "approval" ? (
                  <div className="button-row"><button onClick={() => decideApproval("accept")}>允许一次</button><button className="button-secondary" onClick={() => decideApproval("acceptForSession")}>本会话允许</button><button className="button-secondary" onClick={() => decideApproval("decline")}>拒绝</button><button className="button-quiet" onClick={() => decideApproval("cancel")}>取消</button></div>
                ) : (
                  <div className="custom-response"><p>该请求需要自定义 JSON 响应（例如 `item/tool/requestUserInput` 的 `answers`）。</p><textarea value={approvalResponse} onChange={(event) => setApprovalResponse(event.target.value)} rows={4} /><button onClick={sendCustomApprovalResponse}>发送 JSON 响应</button></div>
                )}
              </div>
            )}

            <form className={`composer ${turnRunning ? "composer-running" : ""}`} onSubmit={(event) => { event.preventDefault(); if (mode !== "fake-central") void sendTurn(); }}>
              <div className="composer-input-wrap"><span className="composer-mark" aria-hidden="true">✦</span><textarea aria-label="发送消息" value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (mode !== "fake-central") void sendTurn(); } }} disabled={mode === "fake-central" || appState !== "online" || !threadId} placeholder={mode === "central-gateway" ? "描述任务，按 Enter 发送……" : mode === "local-app-server" ? "给本机 Codex 一个任务……" : "切换到对话模式后开始对话"} rows={3} /></div>
              <div className="composer-footer"><span>{turnRunning ? "Codex 正在处理请求 · 可随时中断" : "Enter 发送 · Shift+Enter 换行"}</span><div className="button-row"><button type="button" className="button-secondary" disabled={!turnRunning || !turnId} onClick={() => void interruptTurn()}>中断</button><button type="submit" disabled={!composer.trim() || !threadId || appState !== "online" || turnRunning}>发送 <span>Ctrl/⌘↵</span></button></div></div>
            </form>
          </div>

          <details className="event-panel panel" id="events"><summary><span>事件流</span><span>{events.length} events</span></summary><div className="event-list">{events.length === 0 ? <span className="muted">连接后会显示 App Server 通知</span> : events.map((event, index) => <code key={`${event}-${index}`}>{event}</code>)}</div></details>
        </section>
      </div>
    </main>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const label = message.role === "user" ? "你" : message.role === "assistant" ? "Codex" : "系统";
  const avatar = message.role === "user" ? "你" : message.role === "assistant" ? "✦" : "·";
  return <article className={`chat-bubble bubble-${message.role}`}><div className="bubble-head"><span className="bubble-avatar" aria-hidden="true">{avatar}</span><div className="bubble-author">{label}</div></div><div className="bubble-content"><MarkdownMessage content={message.content} /></div></article>;
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill pill-${value}`}><span />{value}</span>;
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return <div className="status-line"><span>{label}</span><StatusPill value={value} /></div>;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function workspaceEntriesFromResult(value: unknown[]): WorkspaceEntry[] {
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || typeof record.name !== "string") return [];
    const kind = record.kind === "directory" || record.kind === "file" ? record.kind : "other";
    return [{ name: record.name, kind, bytes: typeof record.bytes === "number" ? record.bytes : undefined }];
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function threadSummariesFromResult(result: unknown): ThreadSummary[] {
  const record = asRecord(result);
  const items = Array.isArray(record?.data) ? record.data : Array.isArray(record?.threads) ? record.threads : [];
  return items.flatMap((item) => {
    const value = asRecord(item);
    if (!value || typeof value.id !== "string") return [];
    return [{
      id: value.id,
      name: typeof value.name === "string" ? value.name : undefined,
      cwd: typeof value.cwd === "string" ? value.cwd : undefined,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
      archived: value.archived === true || value.isArchived === true || typeof value.archivedAt === "string",
    }];
  });
}

function formatThreadDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function messagesFromThreadRead(result: unknown): ChatMessage[] {
  const record = asRecord(result);
  const thread = asRecord(record?.thread) ?? record;
  const turns = Array.isArray(thread?.turns) ? thread.turns : Array.isArray(record?.turns) ? record.turns : [];
  const restored: ChatMessage[] = [];
  for (const turnValue of turns) {
    const turn = asRecord(turnValue);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const itemValue of items) {
      const item = asRecord(itemValue);
      const type = typeof item?.type === "string" ? item.type : "";
      const content = extractItemText(item);
      if (!content) continue;
      const role: ChatRole = type.toLowerCase().includes("user") ? "user" : type.toLowerCase().includes("agent") || type.toLowerCase().includes("assistant") ? "assistant" : "system";
      restored.push({ id: crypto.randomUUID(), role, content });
    }
  }
  return restored;
}

function extractItemText(item: Record<string, any> | undefined): string {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (Array.isArray(item.content)) {
    return item.content.map((part: unknown) => {
      const value = asRecord(part);
      return typeof value?.text === "string" ? value.text : "";
    }).join("");
  }
  return "";
}
