// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { useSkills, SkillsPanel, SkillPicker } from "./skills";
import { ProjectSidebar } from "./ProjectSidebar";
import { ComposerProjectPicker } from "./ComposerProjectPicker";
import { useSidebarOrganization, useThreadDrag, OrganizeThreadDialog } from "./SidebarOrganization";
import { useProjects, readProject, type ClientProject } from "./projects";
import { joinClientPath, parentClientPath } from "./client-paths";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RuntimeSettings, type ConfigView, type DesktopConfig } from "./runtime-settings";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppServerClient, type AppServerMessage, threadIdFromResult } from "./app-server-client";
import { reduceExecutions, type GatewayUiEvent, type ExecutionActivity, type ExecutionLogChunk, type ExecutionStatus, type ConnectionState, type DeviceState, type ChatMessage, type ThreadSummary, type ApprovalRequest, type PlatformCapabilities, type CentralEngineState } from "./gateway-ui-events";
import { CodexiaGatewayAdapter } from "./codexia-gateway-adapter";
import { PlatformGatewayClient, type RpcClient } from "./platform-gateway-client";
import { MarkdownMessage } from "./MarkdownMessage";
import { messagesFromThreadRead } from "./thread-history";
import { recoverInitialThread, threadRecoveryError } from "./thread-recovery";
import { WorkspacePanel } from "./WorkspacePanel";
import { useAttachments, MessageAttachments, localAttachment, type DraftAttachment } from "./attachments";
import { OutputCard, type OutputArtifact } from "./outputs";
import { withThreadRunning, withThreadTurn } from "./thread-session-state";
import { appendStreamDelta } from "./chat-stream";
import { UiIcon } from "./UiIcon";
import { ThemePicker } from "./ThemePicker";
import { ThreadActions } from "./ThreadActions";
import { TurnTimingStore, timingScope } from "./turn-timing";
import { groupConversation, reduceConversationEvent } from "./conversation-content";
import { TurnConversation } from "./TurnConversation";
import { ClientUpdatePanel, useClientUpdates } from "./client-updates";
import { applyTheme, settingsStorageKey, type ThemeMode } from "./theme";

type TestMode = "central-gateway" | "local-app-server" | "fake-central";
type AppPage = "conversation" | "settings";
type SettingsSection = "skills" | "connection" | "conversations" | "workspace" | "diagnostics" | "updates";
type EventFilter = "all" | "turn" | "tool" | "error";
type WorkspaceResultStatus = "idle" | "loading" | "success" | "error";
type ModelPickerSubmenu = "model" | "effort" | "speed";

interface ModelReasoningOption {
  reasoningEffort: string;
  description: string;
}

interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

interface ModelDescriptor {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  defaultServiceTier?: string;
  supportedReasoningEfforts: ModelReasoningOption[];
  serviceTiers: ModelServiceTier[];
}

interface GatewayStatus {
  gateway: ConnectionState;
  agent: ConnectionState;
  worker?: { workerId: string; state: string; threadCount: number };
}

interface ThreadDraft {
  text: string;
  attachments: DraftAttachment[];
}

interface BackgroundNotice {
  id: string;
  threadId: string;
  message: string;
}

interface WorkspaceEntry {
  name: string;
  kind: "directory" | "file" | "other";
  bytes?: number;
}

const gatewayUrl = "ws://127.0.0.1:4310/ws/ui";
const configuredGatewayUrl = import.meta.env.VITE_PLATFORM_GATEWAY_URL?.trim();
const defaultCentralHost = import.meta.env.VITE_CENTRAL_HOST?.trim() || "192.0.2.10";
const defaultGatewayUrl = configuredGatewayUrl || `ws://${defaultCentralHost}:4510/ws`;
const defaultAppServerUrl = import.meta.env.VITE_CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4501";
const defaultAppServerCwd = import.meta.env.VITE_CODEX_APP_SERVER_CWD ?? "";
const desktopRuntime = isTauri();

function loadSavedSettings(): Partial<{ mode: TestMode; appUrl: string; appCwd: string; appModel: string; appEffort: string; appServiceTier: string; theme: ThemeMode }> {
  try {
    const value = JSON.parse(window.localStorage.getItem(settingsStorageKey) ?? "null") as Record<string, unknown> | null;
    return {
      mode: value?.mode === "central-gateway" || value?.mode === "local-app-server" || value?.mode === "fake-central" ? value.mode : undefined,
      appUrl: typeof value?.appUrl === "string" ? value.appUrl : undefined,
      appCwd: typeof value?.appCwd === "string" ? value.appCwd : undefined,
      appModel: typeof value?.appModel === "string" ? value.appModel : undefined,
      appEffort: typeof value?.appEffort === "string" ? value.appEffort : undefined,
      appServiceTier: typeof value?.appServiceTier === "string" ? value.appServiceTier : undefined,
      theme: value?.theme === "dark" || value?.theme === "light" || value?.theme === "system" ? value.theme : undefined,
    };
  } catch {
    return {};
  }
}

export default function App() {
  const savedSettings = useRef<ReturnType<typeof loadSavedSettings> | undefined>(undefined);
  if (!savedSettings.current) savedSettings.current = loadSavedSettings();
  const persisted = savedSettings.current;
  const gatewaySocketRef = useRef<WebSocket | undefined>(undefined);
  const gatewayReconnectRef = useRef<number | undefined>(undefined);
  const connectionGenerationRef = useRef(0);
  const connectionInFlightRef = useRef(false);
  const appClientRef = useRef<RpcClient | undefined>(undefined);
  const codexiaRef = useRef<CodexiaGatewayAdapter | undefined>(undefined);
  const appUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const [gateway, setGateway] = useState<GatewayStatus>({ gateway: "connecting", agent: "offline" });
  const [deviceState, setDeviceState] = useState<DeviceState>("offline");
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities>({});
  const [engineState, setEngineState] = useState<CentralEngineState>("unknown");
  const [deviceId, setDeviceId] = useState("");
  const [runtimeVersion, setRuntimeVersion] = useState("browser preview");
  const [activePage, setActivePage] = useState<AppPage>("conversation");
  const [pendingNavigation, setPendingNavigation] = useState<{ page: AppPage; section: SettingsSection }>();
  const unsavedDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = unsavedDialogRef.current;
    if (pendingNavigation && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [pendingNavigation]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("connection");
  const [mode, setMode] = useState<TestMode>(import.meta.env.PROD ? "central-gateway" : persisted.mode ?? "central-gateway");
  const runtimeModeRef = useRef(mode);
  runtimeModeRef.current = mode;
  const [appUrl, setAppUrl] = useState(persisted.appUrl ?? defaultGatewayUrl);
  const [appCwd, setAppCwd] = useState(persisted.appCwd ?? defaultAppServerCwd);
  const [runtimeConfig, setRuntimeConfig] = useState<ConfigView>();
  const [configDraft, setConfigDraft] = useState<DesktopConfig>({ gatewayUrl: "", userId: "", deviceId: "", workspaceRoot: "" });
  const [configReady, setConfigReady] = useState(!desktopRuntime);
  const [configApplying, setConfigApplying] = useState(false);
  const configApplyingRef = useRef(false);
  const configLoadingRef = useRef(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configNotice, setConfigNotice] = useState("");
  const runtimeWorkRef = useRef(new Set<string>());
  const [runtimeWorkCount, setRuntimeWorkCount] = useState(0);
  const [runningThreadIds, setRunningThreadIds] = useState<Set<string>>(() => new Set());
  const runningThreadIdsRef = useRef<Set<string>>(new Set());
  const reconnectThreadIdsRef = useRef<Set<string>>(new Set());
  const [appModel, setAppModel] = useState(persisted.appModel ?? "");
  const [appEffort, setAppEffort] = useState(persisted.appEffort ?? "");
  const [appServiceTier, setAppServiceTier] = useState(persisted.appServiceTier ?? "");
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const modelPickerRef = useRef<HTMLDetailsElement | null>(null);
  const [openModelSubmenu, setOpenModelSubmenu] = useState<ModelPickerSubmenu | null>(null);
  const appModelRef = useRef(appModel);
  const appEffortRef = useRef(appEffort);
  const appServiceTierRef = useRef(appServiceTier);
  appModelRef.current = appModel;
  appEffortRef.current = appEffort;
  appServiceTierRef.current = appServiceTier;
  const [theme, setTheme] = useState<ThemeMode>(persisted.theme ?? "light");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarWasOpenRef = useRef(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia("(max-width: 959px)").matches);
  const [appState, setAppState] = useState<ConnectionState>("offline");
  const [appError, setAppError] = useState("");
  const [threadId, setThreadId] = useState<string | undefined>();
  const threadIdRef = useRef<string | undefined>(undefined);
  threadIdRef.current = threadId;
  const [draftProject, setDraftProject] = useState<ClientProject>();
  const projectScope = JSON.stringify([mode, appUrl, runtimeConfig?.effective.userId, deviceId]);
  const skillService = useSkills(projectScope, appClientRef.current, mode === "central-gateway" && appState === "online" && platformCapabilities.skills === true);
  const projectService = useProjects(projectScope, appClientRef.current, mode === "central-gateway" && appState === "online" && platformCapabilities.projects === true);
  // The selector changes this draft's destination; sidebar navigation switches draft slots.
  const newDraftSlotRef = useRef("__new__:");
  useEffect(() => { setDraftProject(undefined); newDraftSlotRef.current = "__new__:"; }, [projectScope]);
  const newDraftKey = () => newDraftSlotRef.current;
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const sidebarOrder = useSidebarOrganization(projectScope, threads, projectService.projects);
  const threadDrag = useThreadDrag(projectScope, sidebarOrder.move);
  const [organizingThread, setOrganizingThread] = useState<ThreadSummary>();
  useEffect(() => setOrganizingThread(undefined), [projectScope]);
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [threadBusy, setThreadBusy] = useState<string | undefined>();
  const [renameTarget, setRenameTarget] = useState<ThreadSummary | undefined>();
  const [renameDraft, setRenameDraft] = useState("");
  const [threadsLoading, setThreadsLoading] = useState(false);
  const threadsLoadingRef = useRef(false);
  const [archivedThreadsLoading, setArchivedThreadsLoading] = useState(false);
  const archivedThreadsLoadingRef = useRef(false);
  const archivedThreadIdsRef = useRef<Set<string>>(new Set());
  const restoredThreadIdsRef = useRef<Set<string>>(new Set());
  const [turnIdsByThread, setTurnIdsByThread] = useState<Map<string, string>>(() => new Map());
  const [composer, setComposer] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const threadMessageCacheRef = useRef(new Map<string, ChatMessage[]>());
  const threadDraftsRef = useRef(new Map<string, ThreadDraft>());
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const conversationSurfaceRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const followMessagesRef = useRef(true);
  const scrollThreadRef = useRef<string | undefined>(undefined);
  const [showLatest, setShowLatest] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [backgroundNotices, setBackgroundNotices] = useState<BackgroundNotice[]>([]);
  const [approvalResponse, setApprovalResponse] = useState('{"decision":"accept"}');
  const [executions, setExecutions] = useState<ExecutionActivity[]>([]);
  const [executionClock, setExecutionClock] = useState(() => Date.now());
  const timingStoreRef = useRef<TurnTimingStore | null>(null);
  if (!timingStoreRef.current) {
    try { timingStoreRef.current = new TurnTimingStore(window.localStorage); }
    catch { timingStoreRef.current = new TurnTimingStore(); }
  }
  const [timingVersion, setTimingVersion] = useState(0);
  const refreshTimings = useCallback(() => setTimingVersion(version => version + 1), []);
  const [sending, setSending] = useState(false);
  const sendGuard = useRef(false);
  const steeringRequestRef = useRef(false);
  const cancelSendRef = useRef(false);
  const pendingMessageRef = useRef<{threadId:string;clientMessageId:string} | undefined>(undefined);
  const [sendStage, setSendStage] = useState("");
  const [uncertainSubmissions, setUncertainSubmissions] = useState<Map<string, {id:string;threadId:string}>>(() => new Map());
  const uncertainSubmission = threadId ? uncertainSubmissions.get(threadId) : undefined;
  const attachments = useAttachments(sending || configApplying || Boolean(uncertainSubmission), mode === "central-gateway");
  const [gatewayOutput, setGatewayOutput] = useState("等待 Device Broker 连接……");
  const [workspaceResultStatus, setWorkspaceResultStatus] = useState<WorkspaceResultStatus>("idle");
  const [workspacePath, setWorkspacePath] = useState(".");
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceContent, setWorkspaceContent] = useState("");
  const [workspaceContentPath, setWorkspaceContentPath] = useState("");
  const [workspaceCommand, setWorkspaceCommand] = useState<"git" | "node">("git");
  const turnId = threadId ? turnIdsByThread.get(threadId) : undefined;
  const turnRunning = Boolean(threadId && runningThreadIds.has(threadId));
  const approval = approvals.find((item) => !item.threadId || item.threadId === threadId);
  const hasRunningExecution = executions.some((execution) => execution.status === "running");

  const updateThreadRunning = useCallback((id: string, running: boolean) => {
    setRunningThreadIds((current) => {
      const next = withThreadRunning(current, id, running);
      runningThreadIdsRef.current = next;
      return next;
    });
  }, []);

  const updateThreadTurnId = useCallback((id: string, nextTurnId?: string) => {
    setTurnIdsByThread((current) => withThreadTurn(current, id, nextTurnId));
  }, []);

  const updateUncertainSubmission = useCallback((id: string, submission?: {id:string;threadId:string}) => {
    setUncertainSubmissions((current) => {
      const next = new Map(current);
      if (submission) next.set(id, submission); else next.delete(id);
      return next;
    });
  }, []);

  const updateThreadMessages = useCallback((id: string, updater: (current: ChatMessage[]) => ChatMessage[]) => {
    if (threadIdRef.current === id) {
      setMessages((current) => {
        const next = updater(current);
        threadMessageCacheRef.current.set(id, next);
        return next;
      });
      return;
    }
    const next = updater(threadMessageCacheRef.current.get(id) ?? []);
    threadMessageCacheRef.current.set(id, next);
  }, []);

  const persistCurrentDraft = useCallback(() => {
    threadDraftsRef.current.set(threadIdRef.current ?? newDraftKey(), { text: composer, attachments: attachments.drafts });
  }, [attachments.drafts, composer]);

  const restoreThreadDraft = useCallback((id?: string) => {
    const draft = threadDraftsRef.current.get(id ?? newDraftKey());
    setComposer(draft?.text ?? "");
    attachments.setDrafts(draft?.attachments ?? []);
  }, [attachments]);

  useEffect(() => {
    if (!hasRunningExecution && !turnRunning) return;
    setExecutionClock(Date.now());
    const timer = window.setInterval(() => setExecutionClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningExecution, turnRunning]);

  useEffect(() => {
    if (threadId) threadMessageCacheRef.current.set(threadId, messages);
  }, [messages, threadId]);

  useEffect(() => { runningThreadIdsRef.current = runningThreadIds; }, [runningThreadIds]);

  useEffect(() => {
    threadDraftsRef.current.set(threadId ?? newDraftKey(), { text: composer, attachments: attachments.drafts });
  }, [attachments.drafts, composer, threadId, draftProject]);

  useEffect(() => {
    if (!approval) return;
    setApprovalResponse(approval.kind === "user-input" ? '{"answers":{}}' : '{"decision":"accept"}');
  }, [approval?.id, approval?.kind]);

  const loadRuntimeConfig = useCallback(async () => {
    if (configLoadingRef.current) return;
    configLoadingRef.current = true; setConfigLoading(true);
    setConfigError(""); setConfigNotice("");
    try {
      let view = await invoke<ConfigView>("desktop_config");
      // Adopt the existing saved gateway once. The former Thread cwd was never an Agent workspace.
      if (!view.hasSaved && !view.needsSetup && persisted.mode !== "local-app-server" && persisted.mode !== "fake-central" && persisted.appUrl && !view.overrides.includes("CODEXIA_GATEWAY_AGENT_URL") && persisted.appUrl !== view.uiGatewayUrl) {
        try { view = await invoke<ConfigView>("apply_desktop_config", { config: { ...view.saved, gatewayUrl: persisted.appUrl } }); }
        catch (error) { setConfigError(`旧连接配置迁移失败：${String(error)}。请检查后保存并应用。`); setRuntimeConfig(view); setConfigDraft({ ...view.saved, gatewayUrl: persisted.appUrl }); return; }
      }
      setRuntimeConfig(view); setConfigDraft(view.saved);
      if (view.needsSetup) {
        setMode("central-gateway"); setActivePage("settings"); setSettingsSection("connection");
      }
      if (runtimeModeRef.current === "central-gateway") setAppUrl(view.uiGatewayUrl);
      setConfigReady(!view.needsSetup && !view.error);
    } catch (error) { setConfigError(String(error)); }
    finally { configLoadingRef.current = false; setConfigLoading(false); }
  }, []);

  useEffect(() => { if (desktopRuntime) void loadRuntimeConfig(); }, [loadRuntimeConfig]);

  const syncRuntimeHistory = useCallback((id: string, result: unknown) => {
    const thread = asRecord(asRecord(result)?.thread);
    if (!thread) return;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    for (const turn of turns) timingStoreRef.current?.observe(id, turn, "history");
    refreshTimings();
    const activeTurn = turns.find(turn => ["inProgress", "in_progress"].includes(String(asRecord(turn)?.status)));
    const active = asRecord(thread.status)?.type === "active" || Boolean(activeTurn);
    if (active) runtimeWorkRef.current.add(`turn:${id}`); else runtimeWorkRef.current.delete(`turn:${id}`);
    updateThreadRunning(id, active);
    const restoredTurnId = asRecord(activeTurn)?.id;
    updateThreadTurnId(id, typeof restoredTurnId === "string" ? restoredTurnId : undefined);
    const rows = messagesFromThreadRead(result);
    const pendingSteer = rows.find(row => row.delivery === "unknown");
    if (pendingSteer) updateUncertainSubmission(id, {id:pendingSteer.id,threadId:id});
    for (const row of rows) for (const output of row.outputs ?? []) {
      if (output.status === "saving") runtimeWorkRef.current.add(`output:${output.id}`); else runtimeWorkRef.current.delete(`output:${output.id}`);
    }
    setRuntimeWorkCount(runtimeWorkRef.current.size);
  }, [updateThreadRunning, updateThreadTurnId, updateUncertainSubmission, refreshTimings]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 959px)");
    const update = () => { setCompactLayout(media.matches); setSidebarOpen(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const wasOpen = sidebarWasOpenRef.current;
    sidebarWasOpenRef.current = sidebarOpen;
    const frame = requestAnimationFrame(() => {
      if (sidebarOpen && compactLayout) sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      else if (wasOpen && compactLayout) sidebarToggleRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [sidebarOpen, compactLayout]);

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(180, Math.max(34, input.scrollHeight))}px`;
  }, [composer, activePage]);

  useEffect(() => {
    try {
      window.localStorage.setItem(settingsStorageKey, JSON.stringify({ mode, appUrl, appCwd, appModel, appEffort, appServiceTier, theme }));
    } catch {
      // Settings persistence is best-effort in restricted webviews.
    }
  }, [appCwd, appEffort, appModel, appServiceTier, appUrl, mode, theme]);

  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => { if (theme === "system") applyTheme(theme); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const picker = modelPickerRef.current;
      if (picker?.open && event.target instanceof Node && !picker.contains(event.target)) {
        picker.open = false;
        setOpenModelSubmenu(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

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
            setWorkspaceResultStatus(asRecord(message.response)?.ok === false ? "error" : "success");
          } else if (message.type === "gateway.error") {
            setGatewayOutput(message.error ?? "Fake Central 返回未知错误");
            setWorkspaceResultStatus("error");
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

  const appendAssistantDelta = useCallback((delta: string, targetThreadId: string, itemId?: string, targetTurnId?: string) => {
    if (!delta) return;
    updateThreadMessages(targetThreadId, (current) => appendStreamDelta(current, delta, itemId, targetTurnId));
  }, [updateThreadMessages]);

  const handleDynamicToolCall = useCallback(async (message: AppServerMessage) => {
    const toolParams = asRecord(message.params);
    const tool = typeof toolParams?.tool === "string" ? toolParams.tool : "";
    const args = asRecord(toolParams?.arguments) ?? {};
    const client = appClientRef.current;
    const codexia = codexiaRef.current;
    if (!client?.requestDevice || !codexia || message.id === undefined) return;

    const toolMap: Record<string, "workspace/list" | "read_file" | "exec"> = {
      device_workspace_list: "workspace/list",
      device_read_file: "read_file",
      device_exec: "exec",
    };
    const method = toolMap[tool];
    if (!method) {
      codexia.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: `Unsupported client device tool: ${tool}` }] });
      return;
    }

    try {
      const response = await client.requestDevice(method, args);
      const result = response.result ?? {};
      setGatewayOutput(JSON.stringify(result, null, 2));
      codexia.respond(message.id, {
        success: asRecord(result)?.ok !== false,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      codexia.respond(message.id, { success: false, contentItems: [{ type: "inputText", text }] });
      setGatewayOutput(text);
    }
  }, []);

  const refreshModels = useCallback(async (codexia: CodexiaGatewayAdapter) => {
    setModelsLoading(true);
    setModelsError("");
    try {
      const modelResponse = await codexia.modelList({ limit: 100, includeHidden: false });
      const availableModels = modelsFromResult(modelResponse.result);
      setModels(availableModels);
      const defaultModel = availableModels.find((model) => model.isDefault) ?? availableModels[0];
      if (!appModelRef.current.trim() && defaultModel) setAppModel(defaultModel.model || defaultModel.id);
      if (!appEffortRef.current.trim() && defaultModel?.defaultReasoningEffort) setAppEffort(defaultModel.defaultReasoningEffort);
      if (!appServiceTierRef.current.trim() && defaultModel?.defaultServiceTier) setAppServiceTier(defaultModel.defaultServiceTier);
    } catch (error) {
      setModels([]);
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const handleAppServerMessage = useCallback(
    (event: GatewayUiEvent) => {
      const message = event.message;
      addEvent(message);
      if (event.kind === "invalid") { setAppError(event.error); return; }
      setExecutions(current => reduceExecutions(current, event));
      if (event.kind === "capabilities") { setPlatformCapabilities(event.capabilities); setEngineState("ready"); return; }
      if (event.kind === "runtime-unavailable") {
        setEngineState("unavailable");
        setAppError(event.error);
        timingStoreRef.current?.uncertain(); refreshTimings();
        reconnectThreadIdsRef.current = new Set(runningThreadIdsRef.current);
        for (const key of runtimeWorkRef.current) if (key.startsWith("turn:")) runtimeWorkRef.current.delete(key);
        setRuntimeWorkCount(runtimeWorkRef.current.size);
        setRunningThreadIds(new Set()); setTurnIdsByThread(new Map());
        return;
      }
      const params = asRecord(message.params);
      // The gateway can interleave events from several owned Threads. Update
      // lifecycle/tool/approval state globally, then route visible messages to
      // the selected Thread or its background cache.
      const eventThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      const eventTurn = asRecord(params?.turn);
      const timingThreadId = eventThreadId ?? threadIdRef.current;
      const eventTurnId = typeof eventTurn?.id === "string" ? eventTurn.id : typeof params?.turnId === "string" ? params.turnId
        : timingThreadId ? timingStoreRef.current?.forThread(timingThreadId).find(row => row.status === "running")?.turnId : undefined;
      const terminalEvent = message.method === "turn/completed" || message.method === "turn/failed" || message.method === "turn/cancelled";
      const activityItem = asRecord(params?.item);
      if (eventThreadId && eventTurnId && (message.method === "turn/started" || message.method === "item/agentMessage/delta" || (message.method === "item/completed" && activityItem?.type === "agentMessage"))) sidebarOrder.activity(eventThreadId, `turn:${eventTurnId}`);
      if (timingThreadId && eventTurnId && (message.method === "turn/started" || terminalEvent)) {
        timingStoreRef.current?.observe(timingThreadId, {
          ...params, ...eventTurn, id: eventTurnId,
          status: eventTurn?.status ?? message.method?.replace("turn/", ""),
        }, terminalEvent ? "finish" : "start");
        refreshTimings();
        if (message.method === "turn/started") {
          const pending = pendingMessageRef.current;
          if (pending?.threadId === timingThreadId) updateThreadMessages(timingThreadId, rows => rows.map(row => row.id === pending.clientMessageId ? { ...row, turnId: eventTurnId } : row));
        }
      }
      if (timingThreadId && eventTurnId && reduceConversationEvent([], message, eventTurnId) !== undefined) {
        updateThreadMessages(timingThreadId, rows => reduceConversationEvent(rows, message, eventTurnId) ?? rows);
        return;
      }
      if (eventThreadId && message.method === "turn/started") {
        runtimeWorkRef.current.add(`turn:${eventThreadId}`);
        updateThreadRunning(eventThreadId, true);
        const startedTurnId = typeof eventTurn?.id === "string" ? eventTurn.id : typeof params?.turnId === "string" ? params.turnId : undefined;
        updateThreadTurnId(eventThreadId, startedTurnId);
      }
      if (!eventThreadId && message.method === "turn/started" && threadIdRef.current) {
        const startedTurnId = typeof eventTurn?.id === "string" ? eventTurn.id : typeof params?.turnId === "string" ? params.turnId : undefined;
        runtimeWorkRef.current.add(`turn:${threadIdRef.current}`);
        updateThreadRunning(threadIdRef.current, true);
        updateThreadTurnId(threadIdRef.current, startedTurnId);
      }
      const turnFinished = message.method === "turn/completed" || message.method === "turn/failed" || message.method === "turn/cancelled";
      if (eventThreadId && turnFinished) {
        runtimeWorkRef.current.delete(`turn:${eventThreadId}`);
        updateThreadRunning(eventThreadId, false);
        updateThreadTurnId(eventThreadId, undefined);
        if (eventThreadId !== threadIdRef.current) {
          const status = typeof eventTurn?.status === "string" ? eventTurn.status : message.method?.replace("turn/", "") ?? "completed";
          setBackgroundNotices((current) => [...current.filter((notice) => notice.threadId !== eventThreadId), { id: crypto.randomUUID(), threadId: eventThreadId, message: status === "completed" ? "后台对话已完成" : `后台对话 ${status}` }].slice(-3));
        }
      }
      if (!eventThreadId && turnFinished && threadIdRef.current) {
        runtimeWorkRef.current.delete(`turn:${threadIdRef.current}`);
        updateThreadRunning(threadIdRef.current, false);
        updateThreadTurnId(threadIdRef.current, undefined);
      }
      if (eventThreadId && (message.method === "error" || message.error)) {
        if (params?.willRetry !== true) { timingStoreRef.current?.uncertain(eventThreadId); refreshTimings(); }
        runtimeWorkRef.current.delete(`turn:${eventThreadId}`);
        updateThreadRunning(eventThreadId, false);
        updateThreadTurnId(eventThreadId, undefined);
        if (eventThreadId !== threadIdRef.current) {
          setBackgroundNotices((current) => [...current.filter((notice) => notice.threadId !== eventThreadId), { id: crypto.randomUUID(), threadId: eventThreadId, message: "后台对话执行失败" }].slice(-3));
        }
      }
      if (event.kind === "output") {
        const output = event.output;
        if (output.status === "saving") runtimeWorkRef.current.add(`output:${output.id}`); else runtimeWorkRef.current.delete(`output:${output.id}`);
      }
      setRuntimeWorkCount(runtimeWorkRef.current.size);

      if (message.method === "turn/started") {
        return;
      }

      if (event.kind === "device") {
        setDeviceState(event.state);
        if (event.deviceId) setDeviceId(event.deviceId);
        return;
      }
      if (event.kind === "execution-start" || event.kind === "execution-end") {
        const execution = event.kind === "execution-start" ? event.execution : event;
        const target = execution.threadId ?? timingThreadId;
        if (target) updateThreadMessages(target, rows => rows.some(row => row.executionId === execution.requestId) ? rows : [...rows, {
          id: `execution-${execution.requestId}`, role: "assistant", content: "", kind: "execution", executionId: execution.requestId, turnId: execution.turnId ?? eventTurnId,
        }]);
        return;
      }
      if (event.kind === "execution-output") return;
      if (message.method === "attachment/progress") {
        if (!eventThreadId || eventThreadId === pendingMessageRef.current?.threadId) setSendStage(String(params?.stage ?? "正在准备附件"));
        return;
      }
      if(event.kind==="output"){
        const output=event.output;
        const targetThreadId = eventThreadId ?? output.threadId ?? threadIdRef.current;
        if (!targetThreadId) return;
        updateThreadMessages(targetThreadId, current=>{
          const id=`output-${output.id}`;
          return current.some(item=>item.id===id)
            ?current.map(item=>item.id===id?{...item,turnId:output.turnId ?? item.turnId,outputs:[output]}:item)
            :[...current,{id,role:"assistant",content:"",turnId:output.turnId,outputs:[output]}];
        });return;
      }
      if (message.method === "attachment/state") {
        const submissions = Array.isArray(params?.submissions) ? params.submissions : [];
        const targetThreadId = eventThreadId ?? threadIdRef.current;
        if (!targetThreadId) return;
        updateThreadMessages(targetThreadId, current=>current.map(item=>{
          const submission=submissions.find((s:{clientMessageId:string})=>s.clientMessageId===item.id);
          return submission?{...item,attachments:submission.attachments}:item;
        })); return;
      }
      if (event.kind === "connection" && event.state === "offline") {
        timingStoreRef.current?.uncertain();
        refreshTimings();
        setAppState(event.retryable===false?"error":"offline");
        if(event.retryable===false){
          const error=event.error??"本机授权已失效，请在设置中重新配对。";
          setAppError(error);setConfigReady(false);
          setMessages(current=>[...current,{id:crypto.randomUUID(),role:"system",content:error}]);
        }
        setDeviceState("offline");
        reconnectThreadIdsRef.current = new Set(runningThreadIdsRef.current);
        runtimeWorkRef.current.clear();
        setRuntimeWorkCount(0);
        setRunningThreadIds(new Set());
        setTurnIdsByThread(new Map());
        return;
      }
      if (event.kind === "connection" && event.state === "reconnecting") {
        setAppState("reconnecting");
        setDeviceState("offline");
        const attempt = event.attempt;
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: attempt ? `中央连接已断开，正在重连（第 ${attempt} 次）……` : "中央连接已断开，正在重连……" }]);
        return;
      }
      if (event.kind === "connection" && event.state === "online") {
        // The default test principal gives the gateway durable-for-process
        // ownership across reconnects. Preserve the selected Thread so the
        // user can continue it, but never retry an interrupted write/turn.
        setAppState("online");
        // gateway.ready/device.status already reported this connection's
        // device state; initialization completion must not overwrite it.
        const activeThreadId = threadIdRef.current;
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", content: activeThreadId ? "中央连接已恢复，正在恢复当前 Thread；中断中的写操作不会自动重试。" : "中央连接已恢复，请创建或恢复 Thread 后继续。" }]);
        const codexia = codexiaRef.current;
        if (codexia) void refreshModels(codexia);
        const reconnectThreadIds = [...reconnectThreadIdsRef.current].filter((id) => id !== activeThreadId);
        reconnectThreadIdsRef.current.clear();
        for (const reconnectThreadId of reconnectThreadIds) {
          void codexia?.threadRead(reconnectThreadId).then((history) => {
            syncRuntimeHistory(reconnectThreadId, history.result);
            threadMessageCacheRef.current.set(reconnectThreadId, messagesFromThreadRead(history.result));
            if (reconnectThreadId === threadIdRef.current) setMessages(messagesFromThreadRead(history.result));
          }).catch(() => updateThreadRunning(reconnectThreadId, false));
        }
        if (activeThreadId) {
          void codexia?.threadRead(activeThreadId).then((history) => {
            syncRuntimeHistory(activeThreadId, history.result);
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

      if (message.id !== undefined && message.method === "item/tool/call") {
        void handleDynamicToolCall(message);
        return;
      }

      if (event.kind === "approval") {
        const { kind } = event.approval;
        setApprovals((current) => [...current.filter((item) => item.id !== event.approval.id), event.approval]);
        setApprovalResponse(kind === "user-input" ? '{"answers":{}}' : '{"decision":"accept"}');
        if (eventThreadId) updateThreadMessages(eventThreadId, (current) => [...current, { id: crypto.randomUUID(), role: "system", content: "App Server 请求审批或用户输入" }]);
        if (eventThreadId && eventThreadId !== threadIdRef.current) {
          setBackgroundNotices((current) => [...current.filter((notice) => notice.threadId !== eventThreadId), { id: crypto.randomUUID(), threadId: eventThreadId, message: "后台对话需要你的确认" }].slice(-3));
        }
        return;
      }

      if (event.kind === "approval-resolved") {
        setApprovals((current) => current.filter((item) => item.id !== event.requestId));
        return;
      }

      if (eventThreadId && eventThreadId !== threadIdRef.current) {
        if (message.method === "item/agentMessage/delta") {
          const delta = typeof params?.delta === "string" ? params.delta : typeof params?.text === "string" ? params.text : "";
          appendAssistantDelta(delta, eventThreadId, typeof params?.itemId === "string" ? params.itemId : undefined, eventTurnId);
        } else if (turnFinished) {
          const status = typeof eventTurn?.status === "string" ? eventTurn.status : message.method?.replace("turn/", "") ?? "completed";
          updateThreadMessages(eventThreadId, (current) => eventTurnId ? current.some(row => row.id === `timing-${eventTurnId}`) ? current : [...current, { id: `timing-${eventTurnId}`, role: "system", content: "", turnId: eventTurnId, timingOnly: true }] : [...current, { id: crypto.randomUUID(), role: "system", content: `回合 ${status}` }]);
        }
        return;
      }

      if (message.method === "item/agentMessage/delta") {
        const delta = typeof params?.delta === "string" ? params.delta : typeof params?.text === "string" ? params.text : "";
        const targetThreadId = eventThreadId ?? threadIdRef.current;
        if (targetThreadId) appendAssistantDelta(delta, targetThreadId, typeof params?.itemId === "string" ? params.itemId : undefined, eventTurnId);
      } else if (turnFinished) {
        const turn = asRecord(params?.turn);
        const status = typeof turn?.status === "string" ? turn.status : message.method?.replace("turn/", "") ?? "completed";
        setMessages((current) => eventTurnId ? current.some(row => row.id === `timing-${eventTurnId}`) ? current : [...current, { id: `timing-${eventTurnId}`, role: "system", content: "", turnId: eventTurnId, timingOnly: true }] : [...current, { id: crypto.randomUUID(), role: "system", content: `回合 ${status}` }]);
      } else if (message.method === "error" || message.error) {
        const failedThreadId = eventThreadId ?? threadIdRef.current;
        if (failedThreadId) {
          if (params?.willRetry !== true) { timingStoreRef.current?.uncertain(failedThreadId); refreshTimings(); }
          runtimeWorkRef.current.delete(`turn:${failedThreadId}`);
          updateThreadRunning(failedThreadId, false);
          setRuntimeWorkCount(runtimeWorkRef.current.size);
        }
        const turnError = asRecord(params?.error);
        const errorMessage = typeof turnError?.message === "string" ? turnError.message : message.error?.message ?? "App Server 返回错误";
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: "system", content: errorMessage },
        ]);
      }
    },
    [addEvent, appendAssistantDelta, handleDynamicToolCall, refreshModels, syncRuntimeHistory, updateThreadMessages, updateThreadRunning, updateThreadTurnId, refreshTimings],
  );

  const disconnectAppServer = useCallback(() => {
    timingStoreRef.current?.uncertain();
    refreshTimings();
    connectionGenerationRef.current += 1;
    connectionInFlightRef.current = false;
    appUnsubscribeRef.current?.();
    appUnsubscribeRef.current = undefined;
    appClientRef.current?.close();
    appClientRef.current = undefined;
    codexiaRef.current = undefined;
    setAppState("offline");
    setPlatformCapabilities({});
    setEngineState("unknown");
    setThreadId(undefined);
    threadIdRef.current = undefined;
    setTurnIdsByThread(new Map());
    setApprovals([]);
    setUncertainSubmissions(new Map());
    setApprovalResponse('{"decision":"accept"}');
    reconnectThreadIdsRef.current.clear();
    runtimeWorkRef.current.clear();
    setRuntimeWorkCount(0);
    setRunningThreadIds(new Set());
    setExecutions([]);
    setThreadBusy(undefined);
    threadsLoadingRef.current = false;
    setThreadsLoading(false);
    archivedThreadsLoadingRef.current = false;
    setArchivedThreadsLoading(false);
    setDeviceState("offline");
    setThreads([]);
    setArchivedThreads([]);
    setWorkspaceEntries([]);
    setWorkspaceContent("");
    setWorkspaceContentPath("");
  }, []);

  const refreshThreads = useCallback(async () => {
    const codexia = codexiaRef.current;
    if (!codexia || appState !== "online" || threadsLoadingRef.current) return;
    threadsLoadingRef.current = true;
    setThreadsLoading(true);
    try {
      const response = await codexia.threadList({ limit: 100, sortKey: "updated_at" });
      const summaries = threadSummariesFromResult(response.result).filter((thread) => !thread.archived && !archivedThreadIdsRef.current.has(thread.id) || restoredThreadIdsRef.current.has(thread.id));
      setThreads(summaries);
      for (const thread of summaries) {
        if (thread.active === true) runtimeWorkRef.current.add(`turn:${thread.id}`);
        else if (thread.active === false) runtimeWorkRef.current.delete(`turn:${thread.id}`);
      }
      setRuntimeWorkCount(runtimeWorkRef.current.size);
      setRunningThreadIds((current) => {
        const next = new Set(current);
        for (const thread of summaries) {
          if (thread.active === true) next.add(thread.id);
          else if (thread.active === false) next.delete(thread.id);
        }
        return next;
      });
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      threadsLoadingRef.current = false;
      setThreadsLoading(false);
    }
  }, [appState]);

  const refreshArchivedThreads = useCallback(async () => {
    const codexia = codexiaRef.current;
    if (!codexia || appState !== "online" || archivedThreadsLoadingRef.current) return;
    archivedThreadsLoadingRef.current = true;
    setArchivedThreadsLoading(true);
    try {
      const response = await codexia.threadList({ limit: 100, sortKey: "updated_at", archived: true });
      const fetched = threadSummariesFromResult(response.result)
        .filter((thread) => !restoredThreadIdsRef.current.has(thread.id) && (thread.archived || archivedThreadIdsRef.current.has(thread.id)))
        .map((thread) => ({ ...thread, archived: true }));
      setArchivedThreads((current) => {
        const fetchedIds = new Set(fetched.map((thread) => thread.id));
        return [...fetched, ...current.filter((thread) => archivedThreadIdsRef.current.has(thread.id) && !fetchedIds.has(thread.id))];
      });
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      archivedThreadsLoadingRef.current = false;
      setArchivedThreadsLoading(false);
    }
  }, [appState]);

  useEffect(() => {
    if (appState === "online") void refreshThreads();
  }, [appState, refreshThreads]);

  useEffect(() => {
    if (appState === "online" && activePage === "settings" && settingsSection === "conversations") {
      void refreshArchivedThreads();
    }
  }, [activePage, appState, refreshArchivedThreads, settingsSection]);

  const renameThread = useCallback((thread: ThreadSummary) => {
    setRenameTarget(thread);
    setRenameDraft(threadDisplayTitle(thread));
  }, []);

  const confirmRenameThread = useCallback(async () => {
    const codexia = codexiaRef.current;
    const thread = renameTarget;
    const nextName = renameDraft.trim();
    if (!codexia || !thread || !nextName || nextName === threadDisplayTitle(thread)) return;
    setThreadBusy(`${thread.id}:rename`);
    setAppError("");
    try {
      await codexia.threadRename(thread.id, nextName);
      setThreads((current) => current.map((item) => item.id === thread.id ? { ...item, name: nextName } : item));
      setRenameTarget(undefined);
      setRenameDraft("");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, [renameDraft, renameTarget]);

  const closeRenameDialog = useCallback(() => {
    if (threadBusy?.endsWith(":rename")) return;
    setRenameTarget(undefined);
    setRenameDraft("");
  }, [threadBusy]);

  const archiveThread = useCallback(async (thread: ThreadSummary) => {
    const codexia = codexiaRef.current;
    if (!codexia || thread.archived) return;
    if (runtimeWorkRef.current.has(`turn:${thread.id}`)) {
      setAppError("运行中的对话不能归档，请先等待完成或中断该对话");
      return;
    }
    setThreadBusy(`${thread.id}:archive`);
    setAppError("");
    try {
      try {
        await codexia.threadArchive(thread.id);
      } catch (error) {
        if (!isMissingRolloutError(error)) throw error;
      }
      archivedThreadIdsRef.current.add(thread.id);
      restoredThreadIdsRef.current.delete(thread.id);
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      setArchivedThreads((current) => [{ ...thread, archived: true }, ...current.filter((item) => item.id !== thread.id)]);
      if (thread.id === threadIdRef.current) {
        persistCurrentDraft();
        setThreadId(undefined);
        threadIdRef.current = undefined;
        updateThreadTurnId(thread.id, undefined);
        restoreThreadDraft(undefined);
        setMessages([]);
      }
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, [persistCurrentDraft, restoreThreadDraft, updateThreadTurnId]);

  const restoreThread = useCallback(async (thread: ThreadSummary) => {
    const codexia = codexiaRef.current;
    if (!codexia || !thread.archived) return;
    setThreadBusy(`${thread.id}:unarchive`);
    setAppError("");
    try {
      try {
        await codexia.threadUnarchive(thread.id);
      } catch (error) {
        if (!isMissingRolloutError(error)) throw error;
      }
      archivedThreadIdsRef.current.delete(thread.id);
      restoredThreadIdsRef.current.add(thread.id);
      setArchivedThreads((current) => current.filter((item) => item.id !== thread.id));
      setThreads((current) => [{ ...thread, archived: false }, ...current.filter((item) => item.id !== thread.id)]);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, []);

  const deleteThread = useCallback(async (thread: ThreadSummary) => {
    const codexia = codexiaRef.current;
    if (!codexia) return;
    if (runtimeWorkRef.current.has(`turn:${thread.id}`)) {
      setAppError("运行中的对话不能删除，请先等待完成或中断该对话");
      return;
    }
    if (!window.confirm(`确定永久删除已归档对话「${threadDisplayTitle(thread)}」？此操作不可恢复。`)) return;
    setThreadBusy(`${thread.id}:delete`);
    setAppError("");
    try {
      try {
        await codexia.threadDelete(thread.id);
      } catch (error) {
        if (!isMissingRolloutError(error)) throw error;
      }
      timingStoreRef.current?.removeThread(thread.id);
      refreshTimings();
      archivedThreadIdsRef.current.delete(thread.id);
      restoredThreadIdsRef.current.delete(thread.id);
      setArchivedThreads((current) => current.filter((item) => item.id !== thread.id));
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, []);

  const connectAppServer = useCallback(async (overrideUrl?: string, preferredThreadId?: string) => {
    if (connectionInFlightRef.current) return false;
    disconnectAppServer();
    timingStoreRef.current?.useScope(timingScope((overrideUrl ?? appUrl).trim()));
    refreshTimings();
    const generation = ++connectionGenerationRef.current;
    connectionInFlightRef.current = true;
    setAppError("");
    setAppState("connecting");
    const client: RpcClient = mode === "central-gateway"
      ? new PlatformGatewayClient((overrideUrl ?? appUrl).trim(), undefined, { autoReconnect: true })
      : new AppServerClient(appUrl.trim());
    const codexia = new CodexiaGatewayAdapter(client);
    appClientRef.current = client;
    codexiaRef.current = codexia;
    appUnsubscribeRef.current = codexia.subscribeUi(handleAppServerMessage);
    try {
      await codexia.initialize();
      if (connectionGenerationRef.current !== generation) return;

      await refreshModels(codexia);
      if (connectionGenerationRef.current !== generation) return;

      const listed = await codexia.threadList({ limit: 100, sortKey: "updated_at" });
      if (connectionGenerationRef.current !== generation) return;
      const summaries = threadSummariesFromResult(listed.result).filter((thread) => !thread.archived && !archivedThreadIdsRef.current.has(thread.id) || restoredThreadIdsRef.current.has(thread.id));
      setRunningThreadIds(new Set(summaries.filter((thread) => thread.active === true).map((thread) => thread.id)));
      for (const thread of summaries) if (thread.active === true) runtimeWorkRef.current.add(`turn:${thread.id}`);
      setRuntimeWorkCount(runtimeWorkRef.current.size);
      let nextThreadId: string | undefined;
      let restoredMessages: ChatMessage[] = [];

      if (summaries.length > 0) {
        nextThreadId = summaries.find(thread => thread.id === preferredThreadId)?.id ?? summaries[0].id;
        const recovery = await recoverInitialThread(codexia, nextThreadId, () => connectionGenerationRef.current === generation);
        if (recovery.state === "superseded") return;
        if (recovery.state === "unavailable") {
          setAppError(recovery.notice);
          nextThreadId = undefined;
        } else {
          syncRuntimeHistory(nextThreadId, recovery.history.result);
          restoredMessages = messagesFromThreadRead(recovery.history.result);
        }
      }

      setThreadId(nextThreadId);
      threadIdRef.current = nextThreadId;
      setAppState("online");
      setMessages(nextThreadId ? restoredMessages : []);
      setThreads(summaries);
      return true;
    } catch (error) {
      client.close();
      if (connectionGenerationRef.current === generation) {
        if (appClientRef.current === client) appClientRef.current = undefined;
        appUnsubscribeRef.current?.();
        appUnsubscribeRef.current = undefined;
        setAppState("error");
        setAppError(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (connectionGenerationRef.current === generation) connectionInFlightRef.current = false;
    }
  }, [appUrl, disconnectAppServer, handleAppServerMessage, mode, refreshModels, syncRuntimeHistory]);

  const configBusy = sending || uncertainSubmissions.size > 0 || approvals.length > 0 || attachments.adding || workspaceLoading || Boolean(threadBusy) || runtimeWorkCount > 0 || messages.some(message => message.outputs?.some(output => output.status === "saving"));
  const updateEnabled = desktopRuntime && mode === "central-gateway" && configReady && !configApplying && !configLoading;
  const clientUpdate = useClientUpdates(`${runtimeConfig?.effective.gatewayUrl}:${runtimeConfig?.effective.deviceId}`, updateEnabled);
  const updateBusy = configBusy || runningThreadIds.size > 0 || Boolean(composer.trim()) || attachments.drafts.length > 0 || [...threadDraftsRef.current.values()].some(d => d.text.trim() || d.attachments.length);
  const applyRuntimeConfig = async (selectedConfig?: DesktopConfig) => {
    if (configApplyingRef.current || configLoadingRef.current || configBusy || !runtimeConfig) return false;
    configApplyingRef.current = true; setConfigApplying(true); setConfigError(""); setConfigNotice("");
    const previousUrl = runtimeConfig.uiGatewayUrl;
    const previousThread = threadIdRef.current;
    try {
      // Check a restored/running Turn before changing the target workspace.
      if (previousThread && codexiaRef.current && appState === "online") {
        const history = await codexiaRef.current.threadRead(previousThread);
        syncRuntimeHistory(previousThread, history.result);
        if (runtimeWorkRef.current.size) throw new Error("任务或文件保存尚未结束，请完成后再应用配置");
      }
      disconnectAppServer();
      const view = await invoke<ConfigView>("apply_desktop_config", { config: selectedConfig ?? configDraft });
      setRuntimeConfig(view); setConfigDraft(view.saved); setAppUrl(view.uiGatewayUrl); setConfigReady(true);
      setWorkspacePath("."); setWorkspaceResultStatus("idle"); setGatewayOutput("默认输出目录已更新，请刷新目录");
      if (previousUrl !== view.uiGatewayUrl) {
        archivedThreadIdsRef.current.clear(); restoredThreadIdsRef.current.clear(); runtimeWorkRef.current.clear(); setRuntimeWorkCount(0); setRunningThreadIds(new Set()); setMessages([]);
      }
      setConfigNotice("配置已保存，Local Agent 已启动，正在连接中央网关…");
      const connected = await connectAppServer(view.uiGatewayUrl, previousUrl === view.uiGatewayUrl ? previousThread : undefined);
      setConfigNotice(connected ? "配置已保存并应用。中央网关已连接；设备在线状态见上方。" : "配置已保存，Local Agent 已启动；中央连接失败，请重试连接或修改地址后重新应用。");
      return Boolean(connected);
    } catch (error) {
      setConfigError(String(error));
      try {
        const current = await invoke<ConfigView>("desktop_config"); setRuntimeConfig(current); setAppUrl(current.uiGatewayUrl);
        setConfigReady(!current.needsSetup && !current.error);
        if (!current.needsSetup && current.running && !appClientRef.current) await connectAppServer(previousUrl, previousThread);
      }
      catch { /* Preserve the explicit apply error; the reload button remains available. */ }
      return false;
    } finally { configApplyingRef.current = false; setConfigApplying(false); }
  };

  // Central Gateway is the product's primary transport. Start its handshake
  // as soon as the project opens; development-only transports remain manual.
  useEffect(() => {
    if (mode !== "central-gateway" || !configReady || configApplyingRef.current || appClientRef.current) return;
    void connectAppServer();
  }, [mode, configReady]);

  useEffect(() => disconnectAppServer, [disconnectAppServer]);

  useLayoutEffect(() => {
    const surface = conversationSurfaceRef.current;
    const composerElement = composerRef.current;
    const messagesElement = messageListRef.current;
    if (!surface || !composerElement || !messagesElement) return;
    const approvalElement = surface.querySelector<HTMLElement>(".approval-card");
    let frame = 0;
    const measure = () => {
      surface.style.setProperty("--composer-height", `${composerElement.getBoundingClientRect().height}px`);
      surface.style.setProperty("--approval-height", `${approvalElement ? approvalElement.getBoundingClientRect().height + 16 : 0}px`);
      window.cancelAnimationFrame(frame);
      if (followMessagesRef.current) frame = window.requestAnimationFrame(() => {
        messagesElement.scrollTo({ top: messagesElement.scrollHeight, behavior: "auto" });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(composerElement);
    observer.observe(surface);
    if (approvalElement) observer.observe(approvalElement);
    measure();
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, [activePage, Boolean(approval)]);

  useEffect(() => {
    const element = messageListRef.current;
    if (!element) return;
    if (scrollThreadRef.current !== threadId) {
      scrollThreadRef.current = threadId;
      followMessagesRef.current = true;
      setShowLatest(false);
    }
    if (!followMessagesRef.current) { setShowLatest(true); return; }
    const frame = window.requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, executions, turnRunning, threadId, activePage, timingVersion]);

  const sendSteering = useCallback(async () => {
    const codexia = codexiaRef.current;
    if (engineState === "unavailable" || !codexia || !threadId || !composer.trim() || sendGuard.current || uncertainSubmission || appState !== "online") return;
    if (mode !== "central-gateway") { setAppError("运行中追加需要中央网关连接"); return; }
    if (attachments.drafts.length) { setAppError("运行中追加目前仅支持文字，请移除附件后发送"); return; }
    if (!turnId) { setAppError("当前轮次尚未确认，请等待启动完成或重新选择对话"); return; }
    const target = threadId;
    const text = composer;
    const clientMessageId = crypto.randomUUID();
    sendGuard.current = true; steeringRequestRef.current = true; setSending(true); setSendStage("正在追加要求…"); setAppError("");
    const delivery = (state: ChatMessage["delivery"]) => updateThreadMessages(target, rows => rows.map(row => row.id === clientMessageId ? {...row,delivery:state} : row));
    updateThreadMessages(target, rows => [...rows,{id:clientMessageId,role:"user",content:text,delivery:"sending",turnId}]);
    const accepted = () => {
      delivery("sent");
      sidebarOrder.activity(target, `message:${clientMessageId}`);
      threadDraftsRef.current.set(target, {text:"",attachments:[]});
      if (threadIdRef.current === target) setComposer("");
      updateUncertainSubmission(target, undefined);
    };
    try {
      await codexia.turnSteer({threadId:target,expectedTurnId:turnId,clientMessageId,input:[{type:"text",text}]});
      // turn/steer emits no new turn/started. Existing lifecycle events remain authoritative.
      accepted();
    } catch (error) {
      setAppError(String(error));
      try {
        const history = await codexia.threadRead(target);
        syncRuntimeHistory(target, history.result);
        const status = asRecord((await appClientRef.current?.request("message/status", {threadId:target,clientMessageId}))?.result);
        if (status?.status === "sent") { accepted(); setAppError(""); }
        else if (status?.status === "failed" || status?.status === "absent") { delivery("failed"); updateUncertainSubmission(target, undefined); }
        else { delivery("unknown"); updateUncertainSubmission(target, {id:clientMessageId,threadId:target}); }
      } catch {
        delivery("unknown"); updateUncertainSubmission(target, {id:clientMessageId,threadId:target});
      }
    } finally { sendGuard.current = false; steeringRequestRef.current = false; setSending(false); setSendStage(""); }
  }, [threadId,turnId,composer,uncertainSubmission,appState,engineState,mode,attachments.drafts,updateThreadMessages,updateUncertainSubmission,syncRuntimeHistory]);

  const sendTurn = useCallback(async () => {
    if (configApplyingRef.current) return;
    if (turnRunning) { if (!threadBusy && !attachments.adding) await sendSteering(); return; }
    const text = composer;
    const codexia = codexiaRef.current;
    if (engineState === "unavailable" || (!text.trim() && !attachments.drafts.length) || !codexia || appState !== "online" || turnRunning || threadBusy || sendGuard.current || attachments.adding || uncertainSubmission) return;
    if (attachments.drafts.length && deviceState !== "online") { setAppError("Local Agent 离线，请等待设备上线后重试"); return; }
    sendGuard.current = true; cancelSendRef.current = false;
    setSending(true); setSendStage("正在客户端校验附件"); setAppError("");
    const clientMessageId = crypto.randomUUID();
    let submitted = false;
    let targetThreadId = threadId;
    const creatingThread = !targetThreadId;
    if (targetThreadId) updateThreadRunning(targetThreadId, true);
    if (creatingThread) setThreadBusy("__new__:create");
    try {
      const refs = await attachments.prepare(deviceId);
      const identity = refs.length ? await localAttachment<{deviceKey:string}>("attachment/identity") : undefined;
      if (cancelSendRef.current) throw new Error("已取消附件准备，草稿已保留");
      if (!targetThreadId) {
        const project = draftProject ? projectService.projects.find(p => p.id === draftProject.id) : undefined;
        if (draftProject && (!project || !platformCapabilities.projects)) throw new Error("项目暂不可用，请刷新项目列表或重新选择项目；草稿已保留");
        const response = await codexia.threadStart({
          ...(project ? {projectId:project.id,projectRevision:project.revision} : {}),
          ...(appModel.trim() ? { model: appModel.trim() } : {}),
          ...(appServiceTier.trim() ? { serviceTier: appServiceTier.trim() } : {}),
          ...(mode !== "central-gateway" && appCwd.trim() ? { cwd: appCwd.trim() } : {}),
        });
        targetThreadId = threadIdFromResult(response.result);
        if (!targetThreadId) throw new Error("thread/start 返回中没有 thread.id");
        setThreadId(targetThreadId); threadIdRef.current = targetThreadId;
        setThreads(current => [{id:targetThreadId!,preview:text || refs[0]?.name,updatedAt:new Date().toISOString(),clientProject:readProject(asRecord(asRecord(response.result)?.thread)?.clientProject)},...current.filter(t=>t.id!==targetThreadId)]);
        updateThreadRunning(targetThreadId, true);
      }
      if (cancelSendRef.current) throw new Error("已取消附件准备，草稿已保留");
      updateThreadMessages(targetThreadId, current => [...current,{id:clientMessageId,role:"user",content:text,attachments:refs.map(ref=>({...ref,deviceId,state:"referenced" as const})),createdAt:new Date().toISOString()}]);
      setSendStage(refs.some(ref=>ref.kind==="image")?"正在通过 Agent 准备图片":"正在提交中央网关");
      submitted = true;
      runtimeWorkRef.current.add(`turn:${targetThreadId}`); setRuntimeWorkCount(runtimeWorkRef.current.size);
      pendingMessageRef.current = {threadId:targetThreadId,clientMessageId};
      const response = await codexia.turnStart({
        threadId:targetThreadId, input:[{type:"text",text}],
        ...(mode === "central-gateway" ? {clientMessageId,attachments:refs,...(identity?{deviceKey:identity.deviceKey}:{})} : {}),
        ...(appModel.trim() ? {model:appModel.trim()} : {}),
        ...(appEffort.trim() ? {effort:appEffort.trim()} : {}),
        ...(appServiceTier.trim() ? {serviceTierForTurn:appServiceTier.trim()} : {}),
      });
      const result = asRecord(response.result);
      const turn = asRecord(result?.turn);
      if (typeof turn?.id === "string") {
        timingStoreRef.current?.observe(targetThreadId, turn, "start");
        refreshTimings();
        updateThreadMessages(targetThreadId, rows => rows.map(row => row.id === clientMessageId ? { ...row, turnId: turn.id as string } : row));
      }
      const submission = asRecord(result?.submission);
      if (typeof turn?.id === "string") sidebarOrder.activity(targetThreadId, `turn:${turn.id}`);
      if (submission?.attachments) setMessages(current=>current.map(item=>item.id===clientMessageId?{...item,attachments:submission.attachments}:item));
      threadDraftsRef.current.set(targetThreadId, { text: "", attachments: [] });
      if (creatingThread) threadDraftsRef.current.delete(newDraftKey());
      setComposer(""); attachments.setDrafts([]);
      if (typeof turn?.id === "string") updateThreadTurnId(targetThreadId, turn.id);
    } catch (error) {
      if (targetThreadId) updateThreadTurnId(targetThreadId, undefined);
      if (targetThreadId) updateThreadMessages(targetThreadId, current=>current.filter(item=>item.id!==clientMessageId));
      setAppError(error instanceof Error ? error.message : String(error));
      if (!submitted && targetThreadId) updateThreadRunning(targetThreadId, false);
      if (submitted && targetThreadId && mode === "central-gateway") {
        try {
          const status = asRecord((await appClientRef.current?.request("message/status",{threadId:targetThreadId,clientMessageId}))?.result);
          if (status?.status === "sent") {
            threadDraftsRef.current.set(targetThreadId, { text: "", attachments: [] });
            setComposer(""); attachments.setDrafts([]);
            const history=await codexia.threadRead(targetThreadId);syncRuntimeHistory(targetThreadId,history.result);setMessages(messagesFromThreadRead(history.result));setAppError("");
          } else if (status?.status !== "failed" && status?.status !== "absent") updateUncertainSubmission(targetThreadId, {id:clientMessageId,threadId:targetThreadId});
          else { runtimeWorkRef.current.delete(`turn:${targetThreadId}`); setRuntimeWorkCount(runtimeWorkRef.current.size); updateThreadRunning(targetThreadId, false); }
        } catch { updateUncertainSubmission(targetThreadId, {id:clientMessageId,threadId:targetThreadId}); }
      } else if (submitted && targetThreadId) updateThreadRunning(targetThreadId, false);
    } finally {
      sendGuard.current=false;pendingMessageRef.current=undefined;setSending(false);setSendStage("");
      if (creatingThread) setThreadBusy(undefined);
    }
  }, [draftProject,projectService.projects,platformCapabilities.projects,appCwd,appEffort,appModel,appServiceTier,appState,engineState,composer,threadBusy,threadId,turnRunning,attachments,deviceId,deviceState,mode,uncertainSubmission,updateThreadMessages,updateThreadRunning,updateThreadTurnId,updateUncertainSubmission,sendSteering]);

  const reconcileSubmission = async () => {
    if (!uncertainSubmission || !codexiaRef.current) return;
    setSending(true);
    try {
      const history=await codexiaRef.current.threadRead(uncertainSubmission.threadId);
      syncRuntimeHistory(uncertainSubmission.threadId, history.result);
      const status=asRecord((await appClientRef.current?.request("message/status",{threadId:uncertainSubmission.threadId,clientMessageId:uncertainSubmission.id}))?.result);
      if (status?.status === "sent") {threadDraftsRef.current.set(uncertainSubmission.threadId,{text:"",attachments:[]});setComposer("");attachments.setDrafts([]);setMessages(messagesFromThreadRead(history.result));updateUncertainSubmission(uncertainSubmission.threadId, undefined);setAppError("");}
      else if (status?.status === "failed" || status?.status === "absent") {
        updateThreadMessages(uncertainSubmission.threadId, rows => rows.map(row => row.id === uncertainSubmission.id ? {...row,delivery:"failed"} : row));
        if (!composer.trim()) {
          const failed = messagesFromThreadRead(history.result).find(row => row.id === uncertainSubmission.id);
          if (failed) setComposer(failed.content);
        }
        updateUncertainSubmission(uncertainSubmission.threadId, undefined);setAppError("该消息尚未提交，可以重试发送");
      }
      else setAppError("提交结果仍未确认，请稍后再次核对历史；草稿已保留");
    } catch(e) {setAppError(String(e));} finally {setSending(false);}
  };

  const startNewConversation = useCallback((project?: ClientProject) => {
    if (appState !== "online" || threadBusy || sendGuard.current) return;
    persistCurrentDraft();
    setAppError("");
    setThreadId(undefined);
    threadIdRef.current = undefined;
    setDraftProject(project);
    newDraftSlotRef.current = `__new__:${project?.id ?? ""}`;
    restoreThreadDraft(undefined);
    setMessages([]);
    setEvents([]);
  }, [appState, persistCurrentDraft, restoreThreadDraft, threadBusy]);

  const resumeThread = useCallback(async (nextThreadId: string) => {
    const codexia = codexiaRef.current;
    if (!codexia || appState !== "online" || threadBusy || sendGuard.current || nextThreadId === threadIdRef.current) return;
    persistCurrentDraft();
    setThreadBusy(`${nextThreadId}:resume`);
    setAppError("");
    let autoUnarchived = false;
    try {
      if (!runningThreadIdsRef.current.has(nextThreadId)) {
        try {
          await codexia.threadResume(nextThreadId);
        } catch (error) {
          if (!isArchivedThreadError(error)) throw error;
          // Older gateways may still return an archived Thread in the regular
          // list. Repair that stale entry on first selection, then retry once.
          await codexia.threadUnarchive(nextThreadId);
          archivedThreadIdsRef.current.delete(nextThreadId);
          restoredThreadIdsRef.current.add(nextThreadId);
          setArchivedThreads((current) => current.filter((thread) => thread.id !== nextThreadId));
          setThreads((current) => current.map((thread) => thread.id === nextThreadId ? { ...thread, archived: false } : thread));
          autoUnarchived = true;
          await codexia.threadResume(nextThreadId);
        }
      }
      const history = await codexia.threadRead(nextThreadId);
      syncRuntimeHistory(nextThreadId, history.result);
      setThreadId(nextThreadId);
      threadIdRef.current = nextThreadId;
      restoreThreadDraft(nextThreadId);
      setBackgroundNotices((current) => current.filter((notice) => notice.threadId !== nextThreadId));
      const restored = [{ id: crypto.randomUUID(), role: "system" as const, content: autoUnarchived ? `检测到归档 Thread，已自动恢复 ${nextThreadId}` : `已恢复 Thread ${nextThreadId}` }, ...messagesFromThreadRead(history.result)];
      threadMessageCacheRef.current.set(nextThreadId, restored);
      setMessages(restored);
      setEvents([]);
    } catch (error) {
      setAppError(threadRecoveryError(error));
    } finally {
      setThreadBusy(undefined);
    }
  }, [appState, persistCurrentDraft, restoreThreadDraft, syncRuntimeHistory, threadBusy]);

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
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
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
      setWorkspaceResultStatus("error");
      return;
    }
    const id = crypto.randomUUID();
    setWorkspaceResultStatus("loading");
    setGatewayOutput(`请求 ${method} (${id})……`);
    socket.send(JSON.stringify({ type: "agent.request", request: { id, method, params } }));
  }, []);

  const sendWorkspaceRequest = useCallback(async (method: "workspace/list" | "read_file" | "exec", params: Record<string, unknown>) => {
    if (configApplyingRef.current) return;
    if (mode === "fake-central") {
      sendGatewayRequest(method, params);
      return;
    }
    const client = appClientRef.current;
    if (!(client instanceof PlatformGatewayClient)) {
      setGatewayOutput("请先连接中央测试网关");
      setWorkspaceResultStatus("error");
      return;
    }
    setWorkspaceLoading(true);
    setWorkspaceResultStatus("loading");
    setGatewayOutput(`请求 ${method}……`);
    try {
      const response = await client.requestDevice(method, params);
      const payload = asRecord(response.result);
      if (payload?.ok === false) {
        setGatewayOutput(JSON.stringify(payload, null, 2));
        setWorkspaceResultStatus("error");
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
      setWorkspaceResultStatus("success");
    } catch (error) {
      setGatewayOutput(error instanceof Error ? error.message : String(error));
      setWorkspaceResultStatus("error");
    } finally {
      setWorkspaceLoading(false);
    }
  }, [mode, sendGatewayRequest]);

  const visibleThreads = sidebarOrder.rows;
  const recentThreads = visibleThreads.filter(t => sidebarOrder.group(t) === null);
  const currentProject = threadId ? threads.find(t => t.id === threadId)?.clientProject : projectService.projects.find(p => p.id === draftProject?.id) ?? draftProject;
  const renderThread = (thread: ThreadSummary) => {
                  const group = sidebarOrder.group(thread);
                  const siblings = visibleThreads.filter(t => sidebarOrder.group(t) === group);
                  const index = siblings.findIndex(t => t.id === thread.id);
                  const busy = threadBusy?.startsWith(`${thread.id}:`);
                  const running = runningThreadIds.has(thread.id);
                  const needsApproval = approvals.some((item) => item.threadId === thread.id);
                  const needsReconcile = uncertainSubmissions.has(thread.id);
                  const drop = threadDrag.drag?.target;
                  return <div key={thread.id} data-thread-id={thread.id} className={`conversation-item ${thread.id === threadId ? "active" : ""} ${thread.archived ? "archived" : ""} ${running ? "running" : ""} ${threadDrag.drag?.id === thread.id ? "thread-drag-source" : ""} ${drop?.anchor === thread.id && threadDrag.drag?.id !== thread.id ? drop.after ? "thread-drop-after" : "thread-drop-before" : ""}`}>
                    <button className="conversation-select" aria-current={thread.id === threadId ? "page" : undefined} onClick={() => { void resumeThread(thread.id); setSidebarOpen(false); }} disabled={sending || Boolean(busy) || Boolean(threadBusy)}>
                      <span className="conversation-copy"><strong title={threadDisplayTitle(thread)}>{threadDisplayTitle(thread)}</strong></span>
                    </button>
                    <div className="conversation-actions">{busy ? <span className="thread-spinner" aria-label="处理中">…</span> : needsApproval || needsReconcile ? <span className="conversation-attention" role="status" aria-label={needsApproval ? "对话等待确认" : "对话等待核对"} title={needsApproval ? "这个对话需要你的确认" : "这个对话的提交结果需要核对"}><span aria-hidden="true">!</span><span>{needsApproval ? "待确认" : "待核对"}</span></span> : running ? <span className="conversation-loading" role="status" aria-label="对话进行中" title="Codex 正在处理这个对话"><span className="conversation-loading-spinner" aria-hidden="true" /><span>进行中</span></span> : <ThreadActions title={threadDisplayTitle(thread)} disabled={Boolean(threadBusy)} rename={() => void renameThread(thread)} archive={() => void archiveThread(thread)} organize={() => setOrganizingThread(thread)} moveUp={index > 0 ? () => sidebarOrder.move(thread.id, group, siblings[index-1].id) : undefined} moveDown={index < siblings.length-1 ? () => sidebarOrder.move(thread.id, group, siblings[index+1].id, true) : undefined} />}</div>
                  </div>;
  };
  const visibleEvents = events.filter((event) => {
    if (eventFilter === "all") return true;
    const normalized = event.toLowerCase();
    if (eventFilter === "error") return normalized.includes("error") || normalized.includes("fail") || normalized.includes("reject");
    if (eventFilter === "tool") return normalized.includes("tool") || normalized.includes("device") || normalized.includes("approval");
    return normalized.includes("turn") || normalized.includes("message") || normalized.includes("thread");
  });

  const workspaceAvailable = mode === "fake-central" ? gateway.gateway === "online" : mode === "central-gateway" && appState === "online" && deviceState === "online";
  const joinWorkspacePath = joinClientPath;

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

  const parentWorkspacePath = parentClientPath(workspacePath);

  const primaryConnectionState = mode === "fake-central" ? gateway.gateway : appState;
  const connectionTitle = mode === "central-gateway" ? "中央网关" : mode === "local-app-server" ? "本机 App Server" : "Fake Central";
  const connectionStateLabel = primaryConnectionState === "online" ? "已连接" : primaryConnectionState === "connecting" ? "连接中" : primaryConnectionState === "reconnecting" ? "重连中" : primaryConnectionState === "error" ? "连接错误" : "未连接";
  const canStartConversation = mode !== "fake-central" && appState === "online" && engineState !== "unavailable";
  const selectedModel = models.find((model) => (model.model || model.id) === appModel || model.id === appModel);
  const modelLabel = selectedModel?.displayName || selectedModel?.model || appModel || "服务端默认模型";
  const reasoningOptions = selectedModel?.supportedReasoningEfforts ?? [];
  const serviceTierOptions = selectedModel?.serviceTiers ?? [];
  const visibleExecutions = executions.filter((execution) => !execution.threadId || execution.threadId === threadId);
  const threadTimings = threadId ? timingStoreRef.current?.forThread(threadId) ?? [] : [];
  const conversationGroups = groupConversation([...messages, ...visibleExecutions.filter(execution => !messages.some(row => row.executionId === execution.requestId)).map(execution => ({
    id: `execution-${execution.requestId}`, role: "assistant" as const, content: "", kind: "execution" as const, executionId: execution.requestId, turnId: execution.turnId,
  }))]);

  const configDirty = runtimeConfig && (Object.keys(configDraft) as (keyof DesktopConfig)[]).some(key => configDraft[key] !== runtimeConfig.saved[key]);
  const finishNavigation = (page: AppPage, section: SettingsSection) => {
    setSettingsSection(section); setActivePage(page); setPendingNavigation(undefined);
    setSidebarOpen(false);
  };
  const navigatePage = (page: AppPage, section: SettingsSection = "connection") => {
    if (activePage === "settings" && settingsSection === "connection" && configDirty && (page !== "settings" || section !== "connection")) {
      setPendingNavigation({ page, section });
    } else finishNavigation(page, section);
  };
  const openSettings = (section: SettingsSection = "connection") => navigatePage("settings", section);

  const closeSidebar = () => setSidebarOpen(false);

  const startConversationFromSidebar = () => {
    if (canStartConversation) startNewConversation();
    else openSettings("connection");
  };

  return (
    <main className={`desktop-shell ${sidebarOpen ? "sidebar-open" : ""}`}>
      {threadDrag.overlay}
      {organizingThread && <OrganizeThreadDialog key={`${projectScope}:${organizingThread.id}`} thread={organizingThread} group={sidebarOrder.group(organizingThread)} projects={projectService.projects} close={() => setOrganizingThread(undefined)} move={group => sidebarOrder.move(organizingThread.id,group)} />}
      {clientUpdate.phase === "installing" && <div className="update-install-overlay" role="status" aria-live="assertive"><strong>正在安装更新</strong><p>远舟即将关闭并重新启动，请稍候。</p></div>}
      {sidebarOpen && compactLayout && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={closeSidebar} />}
      <aside ref={sidebarRef} id="app-sidebar" className="codex-sidebar" inert={compactLayout && !sidebarOpen} aria-label="应用导航" onKeyDown={(event) => {
        if (!compactLayout || !sidebarOpen) return;
        if (event.key === "Escape") { event.preventDefault(); closeSidebar(); }
        if (event.key === "Tab") {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]'));
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <button className="sidebar-close text-icon-button" aria-label="关闭导航" onClick={closeSidebar}><UiIcon name="close" /></button>
        {activePage === "conversation" ? (
          <>
            <nav className="conversation-nav" aria-label="对话导航">
              <button className="sidebar-primary-action" onClick={() => { startConversationFromSidebar(); setSidebarOpen(false); }} disabled={sending || Boolean(threadBusy) || appState === "connecting"}>
                <UiIcon name="edit" /><strong>新对话</strong>
              </button>
            </nav>

            <div className={`sidebar-lists${threadDrag.drag ? " thread-dragging" : ""}`} {...threadDrag.handlers}>
            {sidebarOrder.error && <p role="alert" className="project-list-notice">{sidebarOrder.error}</p>}
            {mode === "central-gateway" && <ProjectSidebar key={projectScope} scope={projectScope} projects={projectService.projects} threads={visibleThreads} activeProjectId={threadId ? sidebarOrder.group(threads.find(t => t.id === threadId) ?? {id:threadId}) ?? undefined : currentProject?.id}
              disabled={sending || Boolean(threadBusy)} loading={projectService.loading} error={projectService.error}
              unavailable={appState !== "online" ? "连接后管理本机项目" : !platformCapabilities.projects ? "中央服务需更新后启用项目" : ""}
              refresh={projectService.refresh} save={projectService.save} remove={projectService.remove}
              newThread={p => {startNewConversation(p);setSidebarOpen(false);}} renderThread={renderThread} groupFor={sidebarOrder.group} dropGroup={threadDrag.drag?.target && !threadDrag.drag.target.anchor ? threadDrag.drag.target.group : undefined} dragging={!!threadDrag.drag} />}
            <section data-thread-group="" className={`conversation-list-section${threadDrag.drag?.target?.group === null && !threadDrag.drag.target.anchor ? " thread-drop-group" : ""}`}>
              <div className="conversation-list-heading">
                <div><span>最近</span>{runningThreadIds.size > 0 && <small>{runningThreadIds.size} 个进行中</small>}</div>
                <button className="text-icon-button" title="刷新" aria-label="刷新对话" disabled={appState !== "online" || threadsLoading} onClick={() => void refreshThreads()}>{threadsLoading ? <span className="icon-loading">…</span> : <RefreshIcon />}</button>
              </div>
              <div className="conversation-list">
                {recentThreads.length === 0 ? (
                  <div className="sidebar-empty">{appState === "online" ? "还没有对话" : "连接后显示对话"}</div>
                ) : recentThreads.slice(0, 40).map(renderThread)}
              </div>
            </section>
            </div>

            <div className="sidebar-footer">
              <div className="connection-summary" role="status" aria-label="连接状态">
                <span className="connection-summary-lines"><span><i className={`connection-dot dot-${primaryConnectionState}`} />{connectionTitle} · {connectionStateLabel}</span><span><i className={`connection-dot dot-${deviceState}`} />本机设备 · {deviceState === "online" ? "在线" : deviceState === "connecting" || deviceState === "reconnecting" ? "连接中" : "离线"}</span></span>
              </div>
              {clientUpdate.release.version && <button className="sidebar-settings-button" onClick={() => openSettings("updates")}><UiIcon name="activity" /><span>新版本 {clientUpdate.release.version}</span></button>}
              <button className="sidebar-settings-button" onClick={() => openSettings("skills")}><UiIcon name="review" /><span>我的技能</span></button>
              <button className="sidebar-settings-button" onClick={() => openSettings()}><UiIcon name="settings" /><span>设置</span></button>
            </div>
          </>
        ) : (
          <>
            <button className="back-to-app" onClick={() => navigatePage("conversation")}><UiIcon name="arrow" /> 返回应用</button>
            <div className="settings-nav-title">设置</div>
            <nav className="settings-nav" aria-label="设置分类">
              <button className={settingsSection === "skills" ? "active" : ""} onClick={() => openSettings("skills")}><UiIcon name="review" /><strong>我的技能</strong></button>
              <button className={settingsSection === "connection" ? "active" : ""} onClick={() => openSettings("connection")}><UiIcon name="settings" /><strong>常规与连接</strong></button>
              <button className={settingsSection === "conversations" ? "active" : ""} onClick={() => openSettings("conversations")}><UiIcon name="review" /><strong>对话管理</strong></button>
              <button className={settingsSection === "workspace" ? "active" : ""} onClick={() => openSettings("workspace")}><UiIcon name="folder" /><strong>文件与工具</strong></button>
              <button className={settingsSection === "diagnostics" ? "active" : ""} onClick={() => openSettings("diagnostics")}><UiIcon name="activity" /><strong>诊断</strong></button>
              <button className={settingsSection === "updates" ? "active" : ""} onClick={() => openSettings("updates")}><UiIcon name="settings" /><strong>版本更新{clientUpdate.release.version ? " · 有更新" : ""}</strong></button>
            </nav>
            <div className="settings-connection-summary"><span><i className={`connection-dot dot-${primaryConnectionState}`} />{connectionTitle} · {connectionStateLabel}</span><span><i className={`connection-dot dot-${deviceState}`} />本机设备 · {deviceState === "online" ? "在线" : deviceState === "offline" ? "离线" : "状态待核对"}</span></div>
          </>
        )}
      </aside>

      <section className="main-stage" inert={compactLayout && sidebarOpen}>
        <button ref={sidebarToggleRef} className="sidebar-toggle text-icon-button" aria-label="打开导航" aria-controls="app-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><UiIcon name="panel" /></button>
        {activePage === "conversation" ? (
          <div className="conversation-page">
            <header className="conversation-header">
              <div className="conversation-title">
                <UiIcon name="folder" />
                <div><strong>{threadId ? threadDisplayTitle(threads.find((thread) => thread.id === threadId)) : "新对话"}</strong></div>
              </div>
              {threadId && currentProject && <details className="conversation-project-context"><summary>{projectService.projects.find(p => p.id === currentProject.id)?.name ?? currentProject.name}</summary><div>{currentProject.folders.map((path,i) => <p key={path}><span>{i === 0 ? "工作目录" : "关联目录"}</span><code>{path}</code></p>)}</div></details>}
            </header>

            {appError && (
              <div className="conversation-error-region">
                <div className="error-banner" role="alert" aria-live="assertive">
                  <span className="error-banner-icon" aria-hidden="true">!</span>
                  <span className="error-banner-copy"><strong>发生错误</strong><span>{appError}</span></span>
                  <button type="button" aria-label="关闭错误" title="关闭" onClick={() => setAppError("")}>×</button>
                </div>
              </div>
            )}

            <section ref={conversationSurfaceRef} className={`conversation-surface${approval ? " has-approval" : ""}`}>
              <div ref={messageListRef} className="message-list" tabIndex={-1} onScroll={(event) => { const el = event.currentTarget; followMessagesRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; setShowLatest(!followMessagesRef.current); }} role="log" aria-live="polite" aria-label="对话消息">
                {messages.length === 0 ? (
                  <div className="conversation-empty-state">
                    <img className="welcome-brand-logo" src={new URL("./assets/logo.svg", import.meta.url).href} width={48} height={48} alt="远舟" />
                    <h1>{runtimeConfig?.needsSetup ? "先连接这台电脑" : appState === "online" ? "今天想完成什么？" : "连接后开始工作"}</h1>
                    <p>{appState === "online" ? "从一个想法开始，让远舟帮你把工作往前推进。" : "在设置中完成配对与连接，即可开始对话。"}</p>
                    {canStartConversation && !threadId && <div className="conversation-starters">{([
                      ["search", "了解一个项目", "请先梳理项目结构，解释主要模块及其关系。"],
                      ["folder", "整理本机文件", "帮我制定本机文件整理方案，先列出建议。"],
                      ["file", "起草一份文档", "帮我起草一份文档，先和我确认内容。"],
                    ] as const).map(([icon, label, prompt]) => <button key={icon} type="button" onClick={() => { setComposer(current => current ? `${current}\n${prompt}` : prompt); composerInputRef.current?.focus(); }}><UiIcon name={icon} /><span>{label}</span></button>)}</div>}
                    {!canStartConversation && <button className="empty-action" onClick={() => openSettings("connection")}>打开连接设置</button>}
                  </div>
                ) : conversationGroups.map(group => <TurnConversation key={`${threadId}:${group.id}`} group={group}
                  timing={threadTimings.find(timing => timing.turnId === group.turnId)}
                  running={turnRunning && Boolean(group.turnId) && group.turnId === turnId} now={executionClock}
                  executions={visibleExecutions.filter(execution => execution.turnId === group.turnId)}
                  renderExecution={execution => <ExecutionPanel executions={[execution]} now={executionClock} continuing={false} />}
                  renderMessage={message => <ChatBubble key={message.id} message={message} retryOutput={async(output)=>{
                  if(!appClientRef.current)throw new Error("请先连接中央网关");
                  const reply=await appClientRef.current.request("output/retry",{threadId:output.threadId,outputId:output.id});
                  const result=asRecord(reply.result);
                  if(asRecord(result?.output))setMessages(current=>current.map(item=>item.id===`output-${output.id}`?{...item,outputs:[result!.output as OutputArtifact]}:item));
                }}/>} />)}
              </div>

              {showLatest && messages.length > 0 && <button className="jump-to-latest" type="button" aria-label="回到最新" title="回到最新" onClick={() => {
                followMessagesRef.current = true;
                setShowLatest(false);
                const element = messageListRef.current;
                element?.scrollTo({ top: element.scrollHeight, behavior: "auto" });
                element?.focus({ preventScroll: true });
              }}><UiIcon name="arrowDown" /></button>}

              {approval && (
                <div className="approval-card" role="alert" aria-live="assertive">
                  <div className="approval-heading"><span className="approval-icon">!</span><div><strong>需要你的确认</strong><p>{approval.kind === "user-input" ? "Codex 需要补充输入" : "Codex 请求执行一项操作"}</p><code className="approval-method">{approval.method}</code>{approval.method === "device/fileChange/requestApproval" && <p>仅批准本次客户端补丁；Local Agent 将在执行前重新核对文件版本。目标设备、工作区及完整补丁如下。</p>}<pre>{JSON.stringify(approval.params, null, 2)}</pre></div></div>
                  {approval.kind === "approval" ? (
                    <div className="button-row"><button onClick={() => decideApproval("accept")}>允许一次</button>{approval.method !== "device/fileChange/requestApproval" && <button className="button-secondary" onClick={() => decideApproval("acceptForSession")}>本会话允许</button>}<button className="button-secondary" onClick={() => decideApproval("decline")}>拒绝</button><button className="button-quiet" onClick={() => decideApproval("cancel")}>取消</button></div>
                  ) : (
                    <div className="custom-response"><p>该请求需要自定义 JSON 响应。</p><textarea value={approvalResponse} onChange={(event) => setApprovalResponse(event.target.value)} rows={4} /><button onClick={sendCustomApprovalResponse}>发送 JSON 响应</button></div>
                  )}
                </div>
              )}

              <form ref={composerRef} className={`composer ${turnRunning ? "composer-running" : ""}`} onSubmit={(event) => { event.preventDefault(); if (mode !== "fake-central") void sendTurn(); }}>
                {!threadId && mode === "central-gateway" && <ComposerProjectPicker key={projectScope}
                  selected={projectService.projects.find(p => p.id === draftProject?.id) ?? draftProject} projects={projectService.projects}
                  disabled={sending || Boolean(threadBusy) || configApplying} loading={projectService.loading} error={projectService.error}
                  unavailable={appState !== "online" ? "连接后选择项目" : !platformCapabilities.projects ? "中央服务需更新后启用项目" : ""}
                  refresh={projectService.refresh} save={projectService.save} remove={projectService.remove}
                  choose={project => { if (threadIdRef.current || sendGuard.current || configApplyingRef.current || threadBusy) return; setDraftProject(project); }} />}
                <div className="composer-shell">
                  <div className="composer-body">
                    {mode === "central-gateway" && attachments.controls}
                    {sending && <p className="attachment-notice" role="status">{sendStage || "正在核对提交结果…"}{sendStage && sendStage !== "正在追加要求…" && sendStage !== "正在提交中央模型" && <button type="button" onClick={()=>{cancelSendRef.current=true;if(pendingMessageRef.current)void appClientRef.current?.request("message/cancel",pendingMessageRef.current).catch(e=>setAppError(String(e)));}}>取消准备</button>}</p>}
                    {uncertainSubmission && <div className="attachment-error-text">提交结果未知，草稿已保留。<button type="button" disabled={sending||appState!=="online"} onClick={()=>void reconcileSubmission()}>核对历史</button></div>}
                  <div className="composer-input-wrap"><textarea ref={composerInputRef} aria-label="发送消息" onPaste={attachments.paste} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (mode !== "fake-central") void sendTurn(); } }} disabled={engineState === "unavailable" || sending || Boolean(uncertainSubmission) || mode === "fake-central" || appState !== "online"} placeholder={engineState === "unavailable" ? "中央引擎不可用，请重新连接并核对任务状态" : mode === "fake-central" ? "Fake Central 仅用于设置页的工具验证" : appState !== "online" ? "请先在设置中连接中央网关" : "描述任务，按 Enter 发送"} rows={1} /></div>
                  </div>
                  <div className="composer-footer">
                    {mode === "central-gateway" && attachments.pickerButton}
                    {mode === "central-gateway" && <SkillPicker service={skillService} disabled={sending || turnRunning || appState !== "online"} insert={text => {setComposer(current => current + (current && !/\s$/.test(current) ? " " : "") + text);composerInputRef.current?.focus();}} manage={() => openSettings("skills")} />}
                    <details ref={modelPickerRef} className="model-picker" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }} onToggle={(event) => { if (!event.currentTarget.open) setOpenModelSubmenu(null); }}>
                      <summary aria-label="切换模型、推理强度和速度"><span className="model-picker-name">{modelLabel}</span><span className="model-picker-meta">{appEffort || selectedModel?.defaultReasoningEffort || "自动"}</span><span className="model-picker-chevron" aria-hidden="true" /></summary>
                      <div className="model-picker-popover">
                        <details className="model-picker-submenu" open={openModelSubmenu === "model"}>
                          <summary className="model-picker-row" onClick={(event) => { event.preventDefault(); setOpenModelSubmenu((current) => current === "model" ? null : "model"); }}><span>模型</span><span className="model-picker-row-value">{modelLabel}</span><span className="model-picker-row-arrow">›</span></summary>
                          <div className="model-picker-submenu-panel"><span className="model-picker-submenu-title">模型</span><button type="button" className={appModel === "" ? "selected" : ""} onClick={() => { setAppModel(""); setAppEffort(""); setAppServiceTier(""); }}><span>服务端默认</span>{appModel === "" && <span>✓</span>}</button>{models.map((model) => { const key = model.model || model.id; return <button type="button" key={model.id} className={appModel === key ? "selected" : ""} onClick={() => { setAppModel(key); if (model.defaultReasoningEffort) setAppEffort(model.defaultReasoningEffort); setAppServiceTier(model.defaultServiceTier ?? ""); }}><span>{model.displayName || key}{model.isDefault ? " · 默认" : ""}</span>{appModel === key && <span>✓</span>}</button>; })}{modelsLoading && <span className="model-picker-hint">正在读取中央模型列表…</span>}</div>
                        </details>
                        <details className="model-picker-submenu" open={openModelSubmenu === "effort"}>
                          <summary className="model-picker-row" onClick={(event) => { event.preventDefault(); setOpenModelSubmenu((current) => current === "effort" ? null : "effort"); }}><span>推理强度</span><span className="model-picker-row-value">{appEffort || selectedModel?.defaultReasoningEffort || "自动"}</span><span className="model-picker-row-arrow">›</span></summary>
                          <div className="model-picker-submenu-panel"><span className="model-picker-submenu-title">推理强度</span>{reasoningOptions.length === 0 ? <span className="model-picker-hint">当前模型不提供推理强度选项</span> : reasoningOptions.map((option) => <button type="button" key={option.reasoningEffort} className={appEffort === option.reasoningEffort ? "selected" : ""} onClick={() => setAppEffort(option.reasoningEffort)}><span>{option.reasoningEffort}</span>{appEffort === option.reasoningEffort && <span>✓</span>}</button>)}<small>更快消耗使用额度</small></div>
                        </details>
                        <details className="model-picker-submenu" open={openModelSubmenu === "speed"}>
                          <summary className="model-picker-row" onClick={(event) => { event.preventDefault(); setOpenModelSubmenu((current) => current === "speed" ? null : "speed"); }}><span>速度</span><span className="model-picker-row-value">{serviceTierOptions.find((tier) => tier.id === appServiceTier)?.name || "标准"}</span><span className="model-picker-row-arrow">›</span></summary>
                          <div className="model-picker-submenu-panel"><span className="model-picker-submenu-title">速度</span><button type="button" className={appServiceTier === "" ? "selected" : ""} onClick={() => setAppServiceTier("")}><span>标准</span>{appServiceTier === "" && <span>✓</span>}</button>{serviceTierOptions.map((tier) => <button type="button" key={tier.id} className={appServiceTier === tier.id ? "selected" : ""} onClick={() => setAppServiceTier(tier.id)}><span>{tier.name}</span>{appServiceTier === tier.id && <span>✓</span>}</button>)}{serviceTierOptions.length === 0 && <span className="model-picker-hint">当前模型不提供额外速度选项</span>}</div>
                        </details>
                        {modelsError && <small className="model-picker-error">无法读取中央模型列表：{modelsError}</small>}
                        {!modelsLoading && !modelsError && models.length === 0 && <small className="model-picker-hint">连接中央网关后获取可用模型</small>}
                      </div>
                    </details>
                    <div className="button-row">
                      {turnRunning && <button className="send-button send-button-stop" type="button" aria-label="停止当前任务" title="停止当前任务" disabled={appState !== "online" || (sending && !steeringRequestRef.current)} onClick={() => void interruptTurn()}><PauseIcon /></button>}
                      <button className="send-button" type="submit" aria-label={turnRunning ? "追加要求" : "发送"} title={turnRunning ? "追加要求" : "发送"} disabled={engineState === "unavailable" || sending || attachments.adding || Boolean(uncertainSubmission) || appState !== "online" || Boolean(threadBusy) || (turnRunning ? !composer.trim() || !turnId || mode !== "central-gateway" || Boolean(attachments.drafts.length) : !composer.trim() && !attachments.drafts.length)}><SendIcon /></button>
                    </div>
                  </div>
                </div>
              </form>
            </section>
          </div>
        ) : (
          <div className="settings-page">
            <header className="settings-header"><div><h1>{settingsSection === "skills" ? "我的技能" : settingsSection === "updates" ? "版本更新" : settingsSection === "connection" ? "常规与连接" : settingsSection === "conversations" ? "对话管理" : settingsSection === "workspace" ? "文件与工具" : "诊断"}</h1><p>{settingsSection === "skills" ? "创建和管理个人技能，在不同设备上使用。" : settingsSection === "connection" ? "调整外观，管理远舟与这台电脑的连接。" : settingsSection === "conversations" ? "查看和管理你的历史对话。" : settingsSection === "workspace" ? "管理默认保存位置，查看本机文件与工具。" : settingsSection === "updates" ? "检查并管理远舟客户端的版本。" : "查看连接与运行信息，定位问题。"}</p></div></header>
            <div className="settings-scroll">
              {settingsSection === "skills" && <SkillsPanel key={projectScope} service={skillService} disabled={sending || Boolean(threadBusy) || deviceState !== "online"} startDraft={prompt => { startNewConversation(); setComposer(prompt); navigatePage("conversation"); requestAnimationFrame(() => composerInputRef.current?.focus()); }} />}
              {settingsSection === "connection" && (
                <div className="settings-content">
                  <section className="settings-section">
                    <div className="settings-section-heading"><h2>外观</h2></div>
                    <div className="settings-card form-settings-card theme-settings-card">
                      <div className="settings-field"><span><strong>主题</strong><small>立即应用，并在下次启动时恢复</small></span><ThemePicker value={theme} onChange={setTheme} /></div>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div className="settings-section-heading"><h2>连接状态</h2></div>
                    <div className="status-card-grid">
                      <div className="status-card"><div><strong>{connectionTitle}</strong><small>对话与任务处理</small></div><StatusPill value={primaryConnectionState} /></div>
                      <div className="status-card"><div><strong>本机设备</strong><small>本机文件与命令执行</small></div><StatusPill value={deviceState} /></div>
                    </div>
                  </section>

                  {import.meta.env.DEV && <section className="settings-section">
                    <div className="settings-section-heading"><h2>连接模式</h2><p>开发模式用于协议验证；正式客户端默认只连接中央网关。</p></div>
                    <fieldset className="settings-card mode-settings-card runtime-mode-options" disabled={configApplying || configBusy}>
                      <label className={`settings-choice ${mode === "central-gateway" ? "selected" : ""}`}><input type="radio" checked={mode === "central-gateway"} onChange={() => { disconnectAppServer(); setAppUrl(runtimeConfig?.uiGatewayUrl ?? defaultGatewayUrl); setMode("central-gateway"); }} /><span><strong>Central Test Gateway</strong><small>推荐 · 中央 Codex App Server 与客户端 Local Agent</small></span><i>中央</i></label>
                      <label className={`settings-choice ${mode === "local-app-server" ? "selected" : ""}`}><input type="radio" checked={mode === "local-app-server"} onChange={() => { disconnectAppServer(); setAppUrl(defaultAppServerUrl); setMode("local-app-server"); }} /><span><strong>Local Codex App Server</strong><small>仅本机开发与协议调试</small></span><i>DEV</i></label>
                      <label className={`settings-choice ${mode === "fake-central" ? "selected" : ""}`}><input type="radio" checked={mode === "fake-central"} onChange={() => { disconnectAppServer(); setMode("fake-central"); }} /><span><strong>Fake Central / AgentRPC</strong><small>仅验证工作区权限与设备协议</small></span><i>TEST</i></label>
                    </fieldset>
                  </section>}

                  {mode !== "fake-central" ? (
                    <section className="settings-section">
                      <div className="settings-section-heading"><h2>连接配置</h2><p>管理设备配对和默认文件保存位置。</p></div>
                      {desktopRuntime && mode === "central-gateway" && <RuntimeSettings view={runtimeConfig} draft={configDraft} setDraft={setConfigDraft} applying={configApplying || configLoading} busy={configBusy} error={configError} notice={configNotice} apply={applyRuntimeConfig} reload={() => void loadRuntimeConfig()} onAuthBoundary={() => { disconnectAppServer(); setConfigReady(false); threadMessageCacheRef.current.clear(); threadDraftsRef.current.clear(); setMessages([]); setComposer(""); attachments.setDrafts([]); setEvents([]); setBackgroundNotices([]); archivedThreadIdsRef.current.clear(); restoredThreadIdsRef.current.clear(); }} />}
                      <details className="connection-details"><summary>高级连接选项</summary><div className="settings-card form-settings-card">
                        {!(desktopRuntime && mode === "central-gateway") && <>
                        <label className="settings-field"><span><strong>WebSocket 地址</strong><small>{mode === "central-gateway" ? "桌面客户端连接中央网关，不直连 App Server" : "开发代理监听地址"}</small></span><input value={appUrl} onChange={(event) => setAppUrl(event.target.value)} placeholder={mode === "central-gateway" ? "wss://192.0.2.10:4510/ws" : "ws://127.0.0.1:4501"} /></label>
                        {mode === "local-app-server" && <label className="settings-field"><span><strong>默认工作目录</strong><small>开发模式创建新 Thread 时使用，可留空</small></span><input value={appCwd} onChange={(event) => setAppCwd(event.target.value)} placeholder="C:\\work\\project" /></label>}
                        </>}
                        <label className="settings-field"><span><strong>默认模型</strong><small>由中央 App Server 解析，可留空</small></span><input value={appModel} onChange={(event) => setAppModel(event.target.value)} placeholder="使用服务端默认模型" /></label>
                      </div></details>
                      {appError && <p className="settings-error">{appError}</p>}
                      <div className="settings-actions">{appState === "online" ? <button className="button-secondary" disabled={configApplying || configBusy} onClick={disconnectAppServer}>断开连接</button> : <button disabled={configApplying || (desktopRuntime && mode === "central-gateway" && !configReady) || appState === "connecting" || appState === "reconnecting"} onClick={() => void connectAppServer()}>{appState === "connecting" ? "正在连接…" : appState === "reconnecting" ? "正在重连…" : appState === "error" ? "重试连接" : "连接"}</button>}</div>
                    </section>
                  ) : (
                    <section className="settings-section"><div className="settings-section-heading"><h2>Fake Central 状态</h2></div><div className="settings-card compact-settings-card"><StatusLine label="Gateway" value={gateway.gateway} /><StatusLine label="Local Agent" value={gateway.agent} /><StatusLine label="Worker" value={gateway.worker?.state ?? "unknown"} /></div></section>
                  )}
                </div>
              )}

              {settingsSection === "workspace" && (
                <div className="settings-content workspace-settings-content">
                  <div className="settings-section-heading page-intro"><h2>客户端工作区</h2><p>文件读取和命令执行始终由当前设备的 Local Agent 完成。</p></div>
                  {desktopRuntime && mode === "central-gateway" && <div className="settings-card runtime-workspace-summary"><span>默认输出目录：<code>{runtimeConfig?.effective.workspaceRoot || "尚未读取配置"}</code></span><button className="button-secondary" onClick={() => openSettings("connection")}>修改输出目录</button></div>}
                  {platformCapabilities.remoteWorkspace === true && <p className="attachment-notice">当前运行时使用客户端工作区。{platformCapabilities.imageGeneration === false ? "新图片生成暂不可用；已有图片输出仍可查看和保存。" : ""}{platformCapabilities.plugins === false ? "插件暂不可用。" : ""}{platformCapabilities.subagents === false ? "子任务暂不可用。" : ""}</p>}
                  <WorkspacePanel diffScope={`${appUrl}:${deviceId}:${runtimeConfig?.effective.workspaceRoot ?? ""}:${workspacePath}`} loadDiff={mode === "central-gateway" && platformCapabilities.remoteWorkspace === true ? staged => { const adapter = codexiaRef.current; if (!adapter) return Promise.reject(new Error("中央网关尚未连接")); return adapter.workspaceDiff(workspacePath, staged); } : undefined} mode={mode} deviceState={deviceState} path={workspacePath} entries={workspaceEntries} loading={workspaceLoading} output={gatewayOutput} resultStatus={workspaceResultStatus} content={workspaceContent} contentPath={workspaceContentPath} command={workspaceCommand} available={workspaceAvailable} onPathChange={setWorkspacePath} onOpen={() => navigateWorkspace(workspacePath)} onParent={() => navigateWorkspace(parentWorkspacePath)} onRefresh={() => navigateWorkspace(workspacePath)} onEntryClick={readWorkspaceEntry} onCommandChange={setWorkspaceCommand} onRunCommand={() => void sendWorkspaceRequest("exec", { program: workspaceCommand, args: ["--version"], cwd: workspacePath })} onCloseContent={() => { setWorkspaceContent(""); setWorkspaceContentPath(""); }} />
                </div>
              )}

              {settingsSection === "conversations" && (
                <div className="settings-content">
                  <section className="settings-section">
                    <div className="settings-section-heading settings-section-heading-with-action">
                      <div><h2>归档对话</h2><p>归档对话不会出现在主页列表中。你可以恢复它，或在这里永久删除。</p></div>
                      <button className="button-secondary settings-refresh-button" aria-label="刷新归档对话" disabled={appState !== "online" || archivedThreadsLoading} onClick={() => void refreshArchivedThreads()}>{archivedThreadsLoading ? "刷新中…" : "刷新"}</button>
                    </div>
                    <div className="settings-card archived-thread-card">
                      {archivedThreadsLoading && archivedThreads.length === 0 ? <div className="settings-empty-state">正在加载归档对话…</div> : archivedThreads.length === 0 ? <div className="settings-empty-state">{appState === "online" ? "暂无归档对话" : "连接后显示归档对话"}</div> : archivedThreads.map((thread) => {
                        const busy = threadBusy?.startsWith(`${thread.id}:`);
                        return <div className="archived-thread-row" key={thread.id}>
                          <div className="archived-thread-copy"><strong title={threadDisplayTitle(thread)}>{threadDisplayTitle(thread)}</strong><small>{thread.preview && thread.preview !== threadDisplayTitle(thread) ? thread.preview : "已归档"}</small></div>
                          <div className="archived-thread-actions">{busy ? <span className="thread-spinner" aria-label="处理中">…</span> : <><button className="button-secondary" disabled={Boolean(threadBusy)} onClick={() => void restoreThread(thread)}>恢复</button><button className="button-danger" disabled={Boolean(threadBusy)} onClick={() => void deleteThread(thread)}>永久删除</button></>}</div>
                        </div>;
                      })}
                    </div>
                    {appError && <p className="settings-error">{appError}</p>}
                  </section>
                </div>
              )}

              {settingsSection === "updates" && <div className="settings-content"><ClientUpdatePanel update={clientUpdate} version={runtimeVersion} busy={updateBusy} enabled={updateEnabled} /></div>}
              {settingsSection === "diagnostics" && (
                <div className="settings-content">
                  <section className="settings-section">
                    <div className="settings-section-heading"><h2>运行信息</h2><p>用于定位中央连接、设备连接和事件流问题。</p></div>
                    <div className="settings-card form-settings-card diagnostic-card">
                      <div className="settings-value-row"><span><strong>客户端版本</strong><small>Tauri Desktop</small></span><code>{runtimeVersion}</code></div>
                      <div className="settings-value-row"><span><strong>中央连接</strong><small>{connectionTitle}</small></span><StatusPill value={primaryConnectionState} /></div>
                      <div className="settings-value-row"><span><strong>Local Agent</strong><small>客户端设备通道</small></span><StatusPill value={deviceState} /></div>
                      <div className="settings-value-row"><span><strong>当前 Thread</strong><small>仅显示用户已选中的对话</small></span><code>{threadId || "—"}</code></div>
                      <div className="settings-value-row"><span><strong>并行对话</strong><small>当前窗口仍在运行的 Thread</small></span><code>{runningThreadIds.size}</code></div>
                    </div>
                  </section>
                  <section className="settings-section">
                    <div className="settings-section-heading"><h2>最近事件</h2><p>最多保留当前会话的 80 条 App Server 与网关事件。</p></div>
                    <div className="diagnostics-toolbar"><div className="diagnostics-filter-group" role="group" aria-label="事件筛选"><button className={eventFilter === "all" ? "active" : ""} onClick={() => setEventFilter("all")}>全部</button><button className={eventFilter === "turn" ? "active" : ""} onClick={() => setEventFilter("turn")}>对话</button><button className={eventFilter === "tool" ? "active" : ""} onClick={() => setEventFilter("tool")}>工具</button><button className={eventFilter === "error" ? "active" : ""} onClick={() => setEventFilter("error")}>错误</button></div><span>{visibleEvents.length}/{events.length}</span></div>
                    <div className="settings-card diagnostics-events">{visibleEvents.length === 0 ? <span className="muted">{events.length === 0 ? "连接后会显示协议事件" : "当前筛选条件下没有事件"}</span> : visibleEvents.map((event, index) => <code key={`${event}-${index}`}>{event}</code>)}</div>
                  </section>
                  <section className="settings-section"><div className="settings-section-heading"><h2>最近设备结果</h2></div><ExpandableOutput content={gatewayOutput} /></section>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
      {backgroundNotices.length > 0 && <div className="background-notices" aria-live="polite">
        {backgroundNotices.map((notice) => <button key={notice.id} className="background-notice" disabled={sending || Boolean(threadBusy)} onClick={() => void resumeThread(notice.threadId)}>
          <span><strong>{notice.message}</strong><small>{threadDisplayTitle(threads.find((thread) => thread.id === notice.threadId))}</small></span><span>查看</span>
        </button>)}
      </div>}
      {pendingNavigation && <dialog ref={unsavedDialogRef} className="unsaved-dialog" aria-labelledby="unsaved-title" onCancel={event => { event.preventDefault(); if (!configApplying) setPendingNavigation(undefined); }}>
        <h2 id="unsaved-title">连接配置尚未保存</h2>
        <p>保存并应用后生效。你也可以放弃修改，或返回继续编辑。</p>
        {(configError || configNotice) && <p role="status">{configError || configNotice}</p>}
        <div className="button-row">
          <button type="button" disabled={configApplying || configBusy || configLoading} onClick={async () => {
            const target = pendingNavigation;
            if (await applyRuntimeConfig()) finishNavigation(target.page, target.section);
          }}>{configApplying ? "正在保存…" : "保存并应用"}</button>
          <button type="button" className="button-secondary" disabled={configApplying} onClick={() => {
            if (runtimeConfig) setConfigDraft(runtimeConfig.saved);
            finishNavigation(pendingNavigation.page, pendingNavigation.section);
          }}>放弃修改</button>
          <button type="button" className="button-quiet" disabled={configApplying} autoFocus onClick={() => setPendingNavigation(undefined)}>继续编辑</button>
        </div>
        {configBusy && <p>任务尚未结束，暂时不能应用配置。</p>}
      </dialog>}
      {renameTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRenameDialog(); }}>
          <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title" onSubmit={(event) => { event.preventDefault(); void confirmRenameThread(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeRenameDialog(); } }} onMouseDown={(event) => event.stopPropagation()}>
            <div className="rename-dialog-heading"><div><span className="rename-dialog-kicker">对话管理</span><h2 id="rename-dialog-title">重命名对话</h2></div><button type="button" className="modal-close-button" aria-label="关闭重命名对话框" onClick={closeRenameDialog}>×</button></div>
            <label className="rename-field"><span>对话名称</span><input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} placeholder="输入对话名称" maxLength={120} /></label>
            <p className="rename-dialog-hint">名称只用于本地对话列表展示，不会影响对话内容。</p>
            <div className="rename-dialog-actions"><button type="button" className="button-secondary" onClick={closeRenameDialog}>取消</button><button type="submit" disabled={!renameDraft.trim() || renameDraft.trim() === threadDisplayTitle(renameTarget) || Boolean(threadBusy)}>保存</button></div>
          </form>
        </div>
      )}
    </main>
  );
}

function RefreshIcon() {
  return <svg className="ui-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 5.8A5.2 5.2 0 1 0 13 9.4" /><path d="M13.2 2.8v3h-3" /></svg>;
}

function SendIcon() {
  return <svg className="ui-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.2V2.8" /><path d="m4.5 6.3 3.5-3.5 3.5 3.5" /></svg>;
}

function PauseIcon() {
  return <svg className="ui-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4h8v8H4z" /></svg>;
}

function ExecutionPanel({ executions, now, continuing }: { executions: ExecutionActivity[]; now: number; continuing: boolean }) {
  return <aside className="execution-dock" aria-label="本机任务执行状态" aria-live="polite">
    {executions.map((execution) => {
      const elapsed = execution.durationMs ?? Math.max(0, now - execution.startedAt);
      const title = execution.status === "running" && execution.phase === "dispatched" ? "已派发操作，等待本机确认" : execution.tool === "device_exec"
        ? "正在本机执行命令"
        : executionToolLabel(execution.tool);
      const status = execution.status === "running" && execution.phase === "dispatched" ? "中央已派发" : executionStatusLabel(execution.status);
      return <details className={`execution-card execution-${execution.status}`} key={execution.requestId}>
        <summary>
          <span className={execution.status === "running" ? "spinner" : "execution-status-dot"} aria-hidden="true" />
          <span className="execution-summary-copy"><strong>{execution.status === "running" ? title : title.replace("正在", "")}</strong><small>{status} · {formatDuration(elapsed)}</small></span>
          <span className="execution-chevron">›</span>
        </summary>
        <div className="execution-body">
          {execution.program && <div className="execution-cwd">命令：{execution.program}</div>}
          {typeof execution.exitCode === "number" && <div className="execution-cwd">退出码：{execution.exitCode}</div>}
          {execution.deviceId && <div className="execution-cwd">目标设备：{execution.deviceId}</div>}
          {execution.cwd && <div className="execution-cwd" title={execution.cwd}>目录：{execution.cwd}</div>}
          {execution.logs.length > 0 ? <ExecutionLog logs={execution.logs} /> : <div className="execution-waiting">{execution.status === "running" ? execution.tool !== "device_exec" ? "正在等待本机操作结果…" : execution.streaming ? "等待命令输出…" : "当前 Local Agent 不支持实时输出，正在等待最终结果…" : "该操作没有命令行输出"}</div>}
          {execution.truncated && <div className="execution-notice">输出过长，界面仅保留受限内容。</div>}
          {execution.error && <div className="execution-error">{execution.error}</div>}
          {execution.patch && <div className="workspace-file-view"><div className="workspace-file-heading"><span>{execution.patch.outcome === "partial" ? "补丁部分已应用" : execution.patch.outcome === "unknown" ? "补丁结果未知" : execution.patch.outcome === "completed" ? "补丁已应用" : "补丁失败"}</span></div><pre>{execution.patch.applied.length ? execution.patch.applied.map(file => `${file.path} · ${file.version}`).join("\n") : "未收到已应用文件的确认。"}</pre>{execution.patch.failedPath && <p>失败路径：{execution.patch.failedPath}</p>}{execution.patch.error && <p className="execution-error">{execution.patch.error}</p>}<p className="execution-notice">多文件修改不保证整体回滚；请核对本机实际 diff 与文件版本后继续，不会自动重试。</p></div>}
          {execution.diff && <div className="workspace-file-view"><div className="workspace-file-heading"><span>本机实际 diff · {execution.diff.repositoryRoot} · {execution.diff.staged ? "已暂存" : "未暂存"}</span></div><pre>{execution.diff.stdout || "该范围没有已跟踪文件的变更。"}</pre>{execution.diff.truncated && <div className="execution-notice">diff 超出输出上限，当前展示不完整。</div>}</div>}
        </div>
      </details>;
    })}
    {continuing && <div className="execution-followup" role="status"><span className="spinner" aria-hidden="true" />本机操作已结束，Codex 正在继续处理<span>等待下一步输出</span></div>}
  </aside>;
}

function ExecutionLog({ logs }: { logs: ExecutionLogChunk[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [logs]);
  return <div ref={ref} className="execution-log" role="log" aria-label="实时命令输出" onScroll={(event) => {
    const element = event.currentTarget;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
  }}>{logs.map((entry, index) => <span className={`execution-log-${entry.stream}`} key={`${entry.sequence}-${index}`}>{entry.chunk}</span>)}</div>;
}

function executionToolLabel(tool: string): string {
  return ({
    device_workspace_list:"正在读取本机目录",
    device_workspace_context:"正在读取本机项目规则",
    device_workspace_search:"正在搜索本机代码",
    device_workspace_read_text:"正在读取本机文本",
    device_workspace_git_status:"正在核对本机 Git 状态",
    device_workspace_git_diff:"正在读取本机实际 diff",
    device_workspace_apply_patch:"正在应用本机补丁",
    device_read_file:"正在读取本机文件",
    device_read_text:"正在读取本机文本",
    device_write_file:"正在写入本机文件",
    device_publish_file:"正在核验本机文件",
    device_copy_file:"正在复制本机文件",
    device_output_paths:"正在查询本机输出目录",
    device_list_outputs:"正在核对本机输出",
  } as Record<string,string>)[tool] ?? "正在执行本机操作";
}

function executionStatusLabel(status: ExecutionStatus): string {
  return ({running:"执行中",succeeded:"已完成",failed:"执行失败",cancelled:"已中断",timed_out:"执行超时",denied:"权限拒绝",offline:"设备离线",unknown:"结果未知"} as Record<ExecutionStatus,string>)[status];
}

function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`
    : `${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
}

function ChatBubble({ message, retryOutput }: { message: ChatMessage; retryOutput:(output:OutputArtifact)=>Promise<void> }) {
  const displayTime = formatMessageTime(message.createdAt);
  if (message.timingOnly) return null;
  if (message.kind === "tool") return <div className="process-tool-summary">
    <UiIcon name="terminal" /><span>{message.content}</span>
    <span>{message.itemStatus === "running" ? "处理中" : message.itemStatus === "failed" ? "未成功" : message.itemStatus === "unknown" ? "状态待核对" : "已结束"}</span>
  </div>;
  if (!message.content && !message.outputs?.length && !message.attachments?.length) return null;
  return (
    <div className={`chat-message-row chat-message-row-${message.role}`}>
      <article className={`chat-bubble bubble-${message.role}`}>
        {message.attachments?.length ? <MessageAttachments attachments={message.attachments}/> : null}
        {message.outputs?.map(output=><OutputCard key={output.id} output={output} retry={retryOutput}/>)}
        <div className="bubble-content">
          <MarkdownMessage content={message.content} />
        </div>
      </article>
      {displayTime && <time className="bubble-meta" dateTime={message.createdAt}>{displayTime}</time>}
      {message.delivery && <span className="bubble-meta" role="status">{({sending:"正在发送追加要求…",sent:"追加要求已接收",failed:"追加未发送，可在输入框重试",unknown:"追加结果待核对"})[message.delivery]}</span>}
    </div>
  );
}

function ExpandableOutput({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 4_000;
  return <div className="expandable-output"><pre className={isLong && !expanded ? "output-collapsed" : ""}>{content}</pre>{isLong && <button className="output-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起输出" : "展开完整输出"}</button>}</div>;
}

function StatusPill({ value }: { value: string }) {
  const label: Record<string, string> = { online: "已连接", offline: "离线", connecting: "连接中", reconnecting: "重连中", error: "连接错误", ready: "就绪", unknown: "未知" };
  return <span className={`status-pill pill-${value}`}><span />{label[value] ?? value}</span>;
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
      preview: typeof value.preview === "string" && value.preview.trim() ? normalizeThreadPreview(value.preview) : undefined,
      clientProject: readProject(value.clientProject),
      cwd: typeof value.cwd === "string" ? value.cwd : undefined,
      updatedAt: threadDateFromValue(value.updatedAt ?? value.recencyAt),
      archived: value.archived === true || value.isArchived === true || typeof value.archivedAt === "string",
      active: threadActiveFromValue(value),
    }];
  });
}

function threadActiveFromValue(value: Record<string, any>): boolean | undefined {
  const status = asRecord(value.status);
  const type = typeof status?.type === "string" ? status.type : typeof value.status === "string" ? value.status : undefined;
  if (!type) return undefined;
  const normalized = type.toLowerCase();
  if (["active", "inprogress", "in_progress", "running"].includes(normalized)) return true;
  if (["idle", "completed", "failed", "cancelled", "canceled"].includes(normalized)) return false;
  return undefined;
}

function threadDisplayTitle(thread: ThreadSummary | undefined): string {
  if (!thread) return "当前对话";
  return thread.name?.trim() || thread.preview?.trim() || "新对话";
}

function formatMessageTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function normalizeThreadPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function threadDateFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return new Date(milliseconds).toISOString();
}

function isArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:is archived|codex\s+unarchive|thread\s+is\s+archived)/i.test(message);
}

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found/i.test(message);
}

function modelsFromResult(result: unknown): ModelDescriptor[] {
  const record = asRecord(result) ?? {};
  const values = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return values.flatMap((value): ModelDescriptor[] => {
    const item = asRecord(value);
    if (!item) return [];
    const id = typeof item.id === "string" ? item.id : "";
    const model = typeof item.model === "string" ? item.model : id;
    if (!id || !model) return [];
    const reasoning = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.flatMap((option): ModelReasoningOption[] => {
        const value = asRecord(option);
        if (!value) return [];
        return typeof value.reasoningEffort === "string" ? [{ reasoningEffort: value.reasoningEffort, description: typeof value.description === "string" ? value.description : "" }] : [];
      })
      : [];
    const tiers = Array.isArray(item.serviceTiers)
      ? item.serviceTiers.flatMap((tier): ModelServiceTier[] => {
        const value = asRecord(tier);
        if (!value) return [];
        return typeof value.id === "string" ? [{ id: value.id, name: typeof value.name === "string" ? value.name : value.id, description: typeof value.description === "string" ? value.description : "" }] : [];
      })
      : [];
    return [{
      id,
      model,
      displayName: typeof item.displayName === "string" ? item.displayName : model,
      description: typeof item.description === "string" ? item.description : "",
      hidden: item.hidden === true,
      isDefault: item.isDefault === true,
      defaultReasoningEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : "",
      defaultServiceTier: typeof item.defaultServiceTier === "string" ? item.defaultServiceTier : undefined,
      supportedReasoningEfforts: reasoning,
      serviceTiers: tiers,
    }];
  });
}
