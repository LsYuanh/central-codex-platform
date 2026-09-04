// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  AGENTRPC_VERSION,
  createEnvelope,
  parseEnvelope,
  type AgentEventPayload,
  type AgentHelloPayload,
  type AgentRpcMethod,
  type AgentRpcResponsePayload,
  type AttachmentSubmission,
} from "@central-codex-spike/agentrpc-types";
import { parseAttachments, prepareAttachments } from "./attachments.js";
import { OutputBroker } from "./outputs.js";

type JsonObject = Record<string, unknown>;
type JsonRpcMessage = JsonObject & { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

type GatewayRequest = {
  type: "request";
  requestId: string;
  operation:
    | "session.initialize"
    | "model.list"
    | "conversation.create"
    | "conversation.resume"
    | "conversation.read"
    | "conversation.archive"
    | "conversation.unarchive"
    | "conversation.delete"
    | "conversation.rename"
    | "conversation.turn.create"
    | "conversation.message.status"
    | "conversation.message.cancel"
    | "conversation.turn.cancel"
    | "conversation.list"
    | "conversation.output.retry"
    | "device.workspace.list"
    | "device.read_file"
    | "device.exec"
    | "device.file.stat"
    | "device.file.read_text"
    | "test.approval.inject";
  payload?: JsonObject;
};

type GatewayApprovalResponse = {
  type: "approval.response";
  requestId: string;
  result: unknown;
};

type GatewayMessage = GatewayRequest | GatewayApprovalResponse;

type ConnectedClient = {
  id: string;
  socket: WebSocket;
  userId: string;
  deviceId: string;
};

type PendingServerRequest = {
  clientId: string;
  upstreamId: number | string;
  userId: string;
  method: string;
  data: unknown;
  timer: NodeJS.Timeout;
};

type PendingAgentRequest = {
  resolve: (payload: AgentRpcResponsePayload) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
  lastEventSequence: number;
  onEvent?: (event: AgentEventPayload) => void;
};

type AgentRequestOptions = {
  taskId?: string;
  traceId?: string;
  timeoutMs?: number;
  onRegistered?: (requestId: string) => void;
  onEvent?: (event: AgentEventPayload) => void;
};

type ActiveDeviceTool = {
  agentRequestId: string;
  clientId: string;
  deviceId: string;
  threadId?: string;
  turnId?: string;
};

type PendingSyntheticApproval = {
  clientId: string;
  userId: string;
  deviceId: string;
  timer: NodeJS.Timeout;
};

type AgentSession = {
  socket: WebSocket;
  deviceId: string;
  ready: boolean;
  hello?: AgentHelloPayload;
  lastHeartbeatAt?: string;
};

type AuditEvent = {
  id: string;
  at: string;
  action: string;
  status: "started" | "succeeded" | "failed" | "requested" | "resolved" | "connected" | "disconnected";
  userId?: string;
  deviceId?: string;
  requestId?: string;
  errorCode?: string;
};

const listenHost = process.env.TEST_GATEWAY_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.TEST_GATEWAY_PORT ?? 4510);
const codexCommand = process.env.CODEX_BIN ?? "codex";
const stateFile = resolve(process.env.TEST_GATEWAY_STATE_FILE ?? "data/test-gateway-state.json");
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// The central worker is for reasoning only. System operations are exposed as
// dynamic tools so app-server asks the connected desktop client to execute
// them through its Local Agent instead of touching the Mac worker filesystem.
const CLIENT_DEVICE_TOOLS = [
  {
    type:"function", name:"device_write_file",
    description:"Write UTF-8 text to the client and return verified saved-file metadata. path is a client absolute path (or workspace-relative); omit path and set name to save in client Downloads/Codexia. Existing files require overwrite=true and expectedVersion from device_read_text. Content <=256 KiB. Never use a central path.",
    inputSchema:{type:"object",properties:{path:{type:"string"},name:{type:"string"},content:{type:"string"},overwrite:{type:"boolean"},expectedVersion:{type:"string"}},required:["content"]},
  },
  {
    type:"function",name:"device_publish_file",description:"Verify a file actually exists on the client and show it in chat as an output image/file card. Call after using device_exec to create a file. path must be a client path; maximum 20 MiB.",
    inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"]},
  },
  {
    type:"function",name:"device_copy_file",description:"Copy an existing client file to a client destination and show the verified output in chat. Omit path and provide name for Downloads/Codexia. Existing destinations require overwrite=true and expectedVersion.",
    inputSchema:{type:"object",properties:{sourcePath:{type:"string"},path:{type:"string"},name:{type:"string"},overwrite:{type:"boolean"},expectedVersion:{type:"string"}},required:["sourcePath"]},
  },
  {type:"function",name:"device_output_paths",description:"Return the actual client Downloads/Codexia and workspace directories. Do not guess home or Downloads paths.",inputSchema:{type:"object",properties:{}}},
  {type:"function",name:"device_list_outputs",description:"Wait for generated images to finish saving to the client and list verified output paths and any save errors for this thread. Call before claiming a generated image was saved.",inputSchema:{type:"object",properties:{}}},
  {
    type: "function", name: "device_read_text",
    description: "Read UTF-8 text/code from the client's absolute attachment path or workspace-relative path, in 64 KiB pages. Pass version to detect changes; nextOffset and truncated describe remaining data. PDF/Office/binary parsing is not available.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, version: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "device_workspace_list",
    description: "List entries in the user's approved local workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative workspace path; defaults to the workspace root." } } },
  },
  {
    type: "function",
    name: "device_read_file",
    description: "Read a UTF-8 text file from the user's approved local workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "device_exec",
    description: "Run a command on the user's local device with live stdout/stderr. Use PowerShell explicitly for shell operations. cwd may be a client absolute path in trusted LAN mode. timeoutMs defaults to 30 minutes and is capped at 2 hours. After creating output files use device_publish_file to verify/show them. The command executes only on the client.",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: MAX_COMMAND_TIMEOUT_MS },
      },
      required: ["program"],
    },
  },
] as const;

const CLIENT_DEVICE_INSTRUCTIONS = [
  "You are the central reasoning worker for a remote desktop client.",
  "The central machine is never the user's computer.",
  "Never use built-in shell, filesystem, process, git, or other host-system tools for user-device work.",
  "For files, Git, commands, disk, or other system information, use the provided device_* dynamic tools; they execute on the connected user's device through Local Agent.",
  "If a required device_* tool is unavailable or rejects an operation, explain that limitation instead of inspecting the central worker.",
  "Generated imageGeneration outputs are automatically saved by the platform to the CLIENT Downloads/Codexia folder and displayed as image cards. The savedPath in a native image-generation tool result is CENTRAL ONLY; never pass that path to a client tool. Use device_list_outputs to obtain the real client file path and status before claiming a save succeeded.",
  "Use device_write_file for text, device_copy_file to save an existing output to a requested client path, and device_publish_file after creating files with device_exec. Only claim a file exists or was modified after a successful tool result. Prefer a new file when editing images unless the user explicitly requests overwriting.",
  "Compatibility for existing threads without the new tool names: device_exec accepts the reserved broker operation program='codexia.files', args=[operation, JSON.stringify(parameters)]. Supported operations: paths, list_outputs, write_text, publish, copy. This is a broker RPC routed to Local Agent, not a shell executable. Use it when new device tools are absent.",
].join(" ");

const BLOCKED_CENTRAL_OPERATION_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

class CodexStdioBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();
  private initializedResult: unknown = undefined;
  private hasInitialized = false;
  private initializePromise: Promise<unknown> | undefined;

  public constructor() {
    this.child = spawn(codexCommand, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.warn(`[codex-app-server] ${message}`);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Codex App Server exited (${code ?? "signal"} ${signal ?? ""})`.trim()));
    });
  }

  public subscribe(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public request(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      // App Server initializes once per process. Reconnects and additional UI
      // clients reuse the negotiated result instead of sending initialize again.
      if (this.hasInitialized) return Promise.resolve(this.initializedResult);
      if (this.initializePromise) return this.initializePromise;
      this.initializePromise = this.sendRequest(method, params).then(
        (result) => {
          this.initializedResult = result;
          this.hasInitialized = true;
          this.initializePromise = undefined;
          return result;
        },
        (error) => {
          this.initializePromise = undefined;
          throw error;
        },
      );
      return this.initializePromise;
    }
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  public respond(id: number | string, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  public close(): void {
    this.rejectAll(new Error("Gateway shutting down"));
    this.child.kill();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      console.warn("[codex-app-server] ignored non-JSON stdout line");
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = Number.isFinite(numericId) ? this.pending.get(numericId) : undefined;
      if (pending) {
        this.pending.delete(numericId);
        if (message.error) pending.reject(new Error(`App Server request failed: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
        return;
      }
    }

    for (const listener of this.listeners) listener(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const bridge = new CodexStdioBridge();
const clients = new Map<string, ConnectedClient>();
const pendingServerRequests = new Map<string, PendingServerRequest>();
const pendingAgentRequests = new Map<string, PendingAgentRequest>();
const activeDeviceTools = new Map<string, ActiveDeviceTool>();
const pendingSyntheticApprovals = new Map<string, PendingSyntheticApproval>();
// Durable-for-process ownership fence: reconnects using the same userId retain
// their Thread ownership, while a different user cannot enumerate or mutate it.
const ownedThreadIdsByUser = new Map<string, Set<string>>();
const threadOwnerById = new Map<string, string>();
const threadSummaryById = new Map<string, JsonObject>();
const agents = new Map<string, AgentSession>();
const auditEvents: AuditEvent[] = [];
let lastAppClientId: string | undefined;
let sequence = 0;
const controlsEnabled = process.env.TEST_GATEWAY_ENABLE_CONTROLS === "1";
let activeAttachmentSubmissions = 0;

type GatewayState = {
  version: 1;
  users: Record<string, Array<{ id: string; summary: JsonObject }>>;
};

function loadState(): void {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<GatewayState>;
    if (parsed.version !== 1 || !isRecord(parsed.users)) return;
    for (const [userId, entries] of Object.entries(parsed.users)) {
      if (!Array.isArray(entries)) continue;
      const owned = new Set<string>();
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.summary)) continue;
        owned.add(entry.id);
        threadOwnerById.set(entry.id, userId);
        threadSummaryById.set(entry.id, entry.summary);
        if(Array.isArray(entry.summary.outputs)) for(const output of entry.summary.outputs) {
          if(isRecord(output)&&output.status==="saving"){output.status="failed";output.error="保存过程中网关重启，请重试并核对本机文件";}
        }
        for (const submission of submissionsFor(entry.id)) {
          if (submission.status === "preparing") { submission.status = "failed"; submission.error = "网关重启，图片尚未提交，可重试"; }
          if (submission.status === "submitting") submission.status = "unknown";
        }
      }
      ownedThreadIdsByUser.set(userId, owned);
    }
  } catch {
    // A missing or partially written state file should not prevent the gateway
    // from starting; the next mutation will create a fresh file.
  }
}

function persistState(): void {
  const users: GatewayState["users"] = {};
  for (const [userId, ids] of ownedThreadIdsByUser) {
    users[userId] = [...ids].map((id) => ({ id, summary: threadSummaryById.get(id) ?? { id } }));
  }
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ version: 1, users } satisfies GatewayState, null, 2), "utf8");
  } catch (error) {
    console.warn(`[gateway-state] failed to persist ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

loadState();

const outputs = new OutputBroker({
  summary:threadId=>threadSummaryById.get(threadId),
  call:sendAgentRequest,
  deviceKey:deviceId=>agents.get(deviceId)?.hello?.agent.deviceKey,
  changed:(threadId,output)=>{
    persistState();
    for(const client of clients.values()) if(threadOwnerById.get(threadId)===client.userId) send(client.socket,{type:"event",eventType:"output.state",name:"output/state",data:{threadId,output},sequence:++sequence});
  },
});

function audit(action: string, status: AuditEvent["status"], fields: Omit<AuditEvent, "id" | "at" | "action" | "status"> = {}): void {
  auditEvents.push({ id: randomUUID(), at: new Date().toISOString(), action, status, ...fields });
  if (auditEvents.length > 1000) auditEvents.splice(0, auditEvents.length - 1000);
}

bridge.subscribe((message) => {
  const notification = isRecord(message.params) ? message.params : {};
  if (typeof notification.threadId === "string" && isRecord(notification.item) && notification.item.type === "imageGeneration") {
    void outputs.image(notification.threadId, typeof notification.turnId === "string" ? notification.turnId : undefined, notification.item);
  }
  if (message.method === "turn/completed" && typeof notification.threadId === "string" && isRecord(notification.turn)) {
    void outputs.collect(notification.threadId,{turns:[notification.turn]});
  }
  if (message.id !== undefined && message.method && BLOCKED_CENTRAL_OPERATION_REQUESTS.has(message.method)) {
    // A central worker must never receive permission to mutate or inspect the
    // user's device. The model should use a device_* dynamic tool instead.
    bridge.respond(message.id, { decision: "decline", reason: "central_system_operations_disabled" });
    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const ownerUserId = threadId ? threadOwnerById.get(threadId) : undefined;
    audit("central.operation.blocked", "failed", { userId: ownerUserId, errorCode: "CENTRAL_SYSTEM_OPERATION_DISABLED" });
    return;
  }
  if (message.id !== undefined && message.method === "item/tool/call") {
    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const ownerUserId = threadId ? threadOwnerById.get(threadId) : undefined;
    const boundDevice = threadId ? threadSummaryById.get(threadId)?.deviceId : undefined;
    const client = [...clients.values()].find((candidate) => ownerUserId && candidate.userId === ownerUserId && (!boundDevice || candidate.deviceId === boundDevice));
    if (!client) {
      bridge.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "No connected desktop client is available for this device operation." }] });
      return;
    }
    // Execute dynamic tools directly through the broker. The UI receives an
    // informational event, but is not a required hop in the execution path;
    // this prevents stale clients from leaving the central turn loading.
    const toolName = typeof params.tool === "string" ? params.tool : "";
    const toolMethods: Record<string, AgentRpcMethod> = {
      device_workspace_list: "workspace/list",
      device_read_file: "read_file",
      device_read_text: "file/read_text",
      device_exec: "exec",
      device_write_file:"file/write_text",
      device_publish_file:"file/publish",
      device_copy_file:"file/copy",
      device_output_paths:"file/output_paths",
    };
    let agentMethod = toolMethods[toolName];
    let toolArgs = isRecord(params.arguments) ? params.arguments : {};
    let listOutputs = toolName === "device_list_outputs";
    let displayToolName = toolName;
    if (toolName === "device_exec" && toolArgs.program === "codexia.files") {
      try {
        const args=toolArgs.args;
        if(!Array.isArray(args)||typeof args[0]!=="string")throw new Error("Invalid file operation");
        const method=({paths:"file/output_paths",write_text:"file/write_text",publish:"file/publish",copy:"file/copy"} as Record<string,AgentRpcMethod>)[args[0]];
        listOutputs=args[0]==="list_outputs";
        const parsed=JSON.parse(typeof args[1]==="string"?args[1]:"{}");
        if(!isRecord(parsed)||(!method&&!listOutputs))throw new Error("Unsupported file operation");
        displayToolName=({paths:"device_output_paths",list_outputs:"device_list_outputs",write_text:"device_write_file",publish:"device_publish_file",copy:"device_copy_file"} as Record<string,string>)[args[0]]??toolName;
        agentMethod=method;toolArgs=parsed;
      }catch(error){bridge.respond(message.id,{success:false,contentItems:[{type:"inputText",text:String(error)}]});return;}
    }
    const requestId = `${client.id}:${String(message.id)}`;
    const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
    const startedAt = Date.now();
    const eventBase = {
      threadId,
      turnId,
      requestId,
      tool: displayToolName,
      ...(agentMethod === "exec" && typeof toolArgs.program === "string" ? { program: toolArgs.program } : {}),
      ...(typeof toolArgs.cwd === "string" ? { cwd: toolArgs.cwd } : {}),
    };
    const emitTool = (phase: "started" | "output" | "completed", data: JsonObject = {}) => {
      for (const target of clients.values()) {
        if (target.userId !== client.userId || target.deviceId !== client.deviceId) continue;
        send(target.socket, {
          type: "event",
          eventType: `device.tool.${phase}`,
          name: `device/tool/${phase}`,
          data: { ...eventBase, ...data },
          sequence: ++sequence,
        });
      }
    };
    audit("device.tool.request", "requested", { userId: client.userId, deviceId: client.deviceId, requestId });
    emitTool("started", {
      startedAt: new Date(startedAt).toISOString(),
      streaming: agentMethod === "exec" && agents.get(client.deviceId)?.hello?.agent.capabilities.includes("exec-stream/v1") === true,
    });
    void (async () => {
      if (!agentMethod && !listOutputs) {
        bridge.respond(message.id!, { success: false, contentItems: [{ type: "inputText", text: `Unsupported client device tool: ${toolName}` }] });
        audit("device.tool.response", "failed", { userId: client.userId, deviceId: client.deviceId, requestId, errorCode: "UNSUPPORTED_DEVICE_TOOL" });
        emitTool("completed", { status: "failed", durationMs: Date.now() - startedAt, error: `Unsupported client device tool: ${toolName}` });
        return;
      }
      let agentRequestId: string | undefined;
      try {
        if (threadId && threadSummaryById.get(threadId)?.deviceKey && threadSummaryById.get(threadId)?.deviceKey !== agents.get(client.deviceId)?.hello?.agent.deviceKey) throw new Error("来源设备身份不一致，拒绝读取同名路径");
        if(listOutputs){
          const result=await outputs.settled(threadId!);
          bridge.respond(message.id!,{success:true,contentItems:[{type:"inputText",text:JSON.stringify({outputs:result})}]});
          emitTool("completed", {status:"succeeded",durationMs:Date.now()-startedAt});return;
        }
        if(!agentMethod)throw new Error("Unsupported device operation");
        const result = await sendAgentRequest(client.deviceId, agentMethod, validateDeviceParams(toolArgs), {
          taskId: turnId,
          traceId: typeof params.callId === "string" ? params.callId : undefined,
          onRegistered: (id) => {
            agentRequestId = id;
            activeDeviceTools.set(id, {agentRequestId:id,clientId:client.id,deviceId:client.deviceId,threadId,turnId});
          },
          onEvent: (event) => emitTool("output", {
            stream:event.stream,
            eventSequence:event.sequence,
            ...(event.chunk !== undefined ? {chunk:event.chunk} : {}),
            ...(event.progress !== undefined ? {progress:event.progress} : {}),
            ...(event.done !== undefined ? {done:event.done} : {}),
            ...(event.truncated !== undefined ? {truncated:event.truncated} : {}),
          }),
        }).finally(() => { if (agentRequestId) activeDeviceTools.delete(agentRequestId); });
        if(threadId && result.ok && isRecord(result.result) && ["file/write_text","file/publish","file/copy"].includes(agentMethod)) {
          const output=outputs.recordFile(threadId,typeof params.turnId==="string"?params.turnId:undefined,typeof params.callId==="string"?params.callId:String(message.id),client.deviceId,result.result);
          Object.assign(result,{output});
        }
        if (threadId && ["file/read_text", "read_file"].includes(agentMethod)) {
          for (const submission of submissionsFor(threadId)) {
            for (const attachment of submission.attachments) {
              if (attachment.path === toolArgs.path && attachment.deviceId === client.deviceId) attachment.state = result.ok ? "read" : "failed";
            }
          }
          persistState();
          send(client.socket, {type:"event", eventType:"attachment.state", name:"attachment/state", data:{threadId, submissions:submissionsFor(threadId)}, sequence:++sequence});
        }
        bridge.respond(message.id!, { success: result.ok, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] });
        audit("device.tool.response", result.ok ? "succeeded" : "failed", { userId: client.userId, deviceId: client.deviceId, requestId, ...(result.ok ? {} : { errorCode: result.errorCode ?? "AGENT_ERROR" }) });
        const resultRecord = isRecord(result.result) ? result.result : {};
        emitTool("completed", {
          status: result.ok ? "succeeded" : /CANCELLED/.test(result.error ?? "") ? "cancelled" : "failed",
          durationMs: Date.now() - startedAt,
          ...(typeof resultRecord.exitCode === "number" ? {exitCode:resultRecord.exitCode} : {}),
          ...(resultRecord.truncated === true ? {truncated:true} : {}),
          ...(!result.ok && result.error ? {error:result.error} : {}),
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (agentRequestId) activeDeviceTools.delete(agentRequestId);
        bridge.respond(message.id!, { success: false, contentItems: [{ type: "inputText", text }] });
        audit("device.tool.response", "failed", { userId: client.userId, deviceId: client.deviceId, requestId, errorCode: "DEVICE_TOOL_ERROR" });
        emitTool("completed", { status:/CANCELLED/.test(text)?"cancelled":"failed", durationMs:Date.now()-startedAt, error:text });
      }
    })();
    return;
  }
  if (message.id !== undefined && message.method) {
    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const ownerUserId = threadId ? threadOwnerById.get(threadId) : undefined;
    const client = [...clients.values()].find((candidate) => ownerUserId && candidate.userId === ownerUserId)
      ?? (lastAppClientId ? clients.get(lastAppClientId) : undefined);
    if (!client) return;
    const requestId = `${client.id}:${String(message.id)}`;
    const timer = setTimeout(() => {
      const timedOut = pendingServerRequests.get(requestId);
      if (!timedOut) return;
      pendingServerRequests.delete(requestId);
      bridge.respond(timedOut.upstreamId, { decision: "reject", reason: "approval_timeout" });
      audit("approval.response", "failed", { userId: timedOut.userId, requestId, errorCode: "APPROVAL_TIMEOUT" });
      const target = clients.get(timedOut.clientId);
      if (target) send(target.socket, { type: "approval.resolved", requestId, status: "timeout", sequence: ++sequence });
    }, 120_000);
    pendingServerRequests.set(requestId, { clientId: client.id, upstreamId: message.id, userId: client.userId, method: message.method, data: message.params, timer });
    audit("approval.request", "requested", { userId: client.userId, requestId });
    send(client.socket, {
      type: "approval.request",
      requestId,
      kind: message.method === "item/tool/requestUserInput" ? "user-input" : "approval",
      method: message.method,
      data: message.params,
      sequence: ++sequence,
    });
    return;
  }

  const event = normalizeNotification(message);
  if (!event) return;
  const threadId = isRecord(event.data) && typeof event.data.threadId === "string" ? event.data.threadId : undefined;
  for (const client of clients.values()) {
    if (threadId ? threadOwnerById.get(threadId) === client.userId : client.id === lastAppClientId) send(client.socket, event);
  }
});

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`);
  if (url.pathname === "/healthz") {
    writeJson(response, 200, {
      ok: true,
      service: "central-test-gateway",
      appServer: "stdio",
      clients: clients.size,
      devices: [...agents.values()].filter((agent) => agent.ready && agent.socket.readyState === WebSocket.OPEN).length,
      controlsEnabled,
      sequence,
    });
    return;
  }
  if (url.pathname === "/audit") {
    writeJson(response, 200, { ok: true, events: auditEvents });
    return;
  }
  response.writeHead(404);
  response.end();
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
httpServer.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`).pathname;
  if (path !== "/ws" && path !== "/ws/agent") {
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (client) => {
    if (path === "/ws/agent") handleAgentConnection(client, request);
    else handleClient(client, request);
  });
});

function handleClient(socket: WebSocket, _request: IncomingMessage): void {
  const query = new URL(_request.url ?? "/", `http://${listenHost}:${listenPort}`).searchParams;
  const userId = query.get("userId")?.trim() || `session-${randomUUID()}`;
  const deviceId = query.get("deviceId")?.trim() || "default-device";
  const client: ConnectedClient = { id: randomUUID(), socket, userId, deviceId };
  clients.set(client.id, client);
  if (!ownedThreadIdsByUser.has(userId)) ownedThreadIdsByUser.set(userId, new Set());
  audit("client.connect", "connected", { userId, deviceId });
  send(socket, {
    type: "gateway.ready",
    protocol: "central-gateway-v1",
    appServerTransport: "stdio",
    deviceBroker: "agentrpc-v1",
    agent: agentState(deviceId) === "online" ? "online" : "offline",
    userId,
    deviceId,
  });

  socket.on("message", (data) => {
    void handleGatewayMessage(client, parseMessage(data));
  });
  socket.on("close", () => {
    rehomePendingApprovals(client);
    clients.delete(client.id);
    audit("client.disconnect", "disconnected", { userId, deviceId });
  });
  socket.on("error", () => {
    rehomePendingApprovals(client);
    clients.delete(client.id);
    audit("client.error", "failed", { userId, deviceId });
  });
}

function rehomePendingApprovals(disconnected: ConnectedClient): void {
  const replacement = [...clients.values()].find((candidate) => candidate.id !== disconnected.id && candidate.userId === disconnected.userId && candidate.socket.readyState === WebSocket.OPEN);
  for (const [requestId, pending] of pendingServerRequests) {
    if (pending.clientId !== disconnected.id) continue;
    if (!replacement) {
      pendingServerRequests.delete(requestId);
      clearTimeout(pending.timer);
      bridge.respond(pending.upstreamId, { decision: "reject", reason: "client_disconnected" });
      audit("approval.response", "failed", { userId: disconnected.userId, deviceId: disconnected.deviceId, requestId, errorCode: "CLIENT_DISCONNECTED" });
      continue;
    }
    pending.clientId = replacement.id;
    send(replacement.socket, {
      type: "approval.request",
      requestId,
      kind: pending.method === "item/tool/requestUserInput" ? "user-input" : "approval",
      method: pending.method,
      data: pending.data,
      sequence: ++sequence,
      recovered: true,
    });
    audit("approval.rehome", "requested", { userId: replacement.userId, deviceId: replacement.deviceId, requestId });
  }
  for (const [requestId, pending] of pendingSyntheticApprovals) {
    if (pending.clientId !== disconnected.id) continue;
    pendingSyntheticApprovals.delete(requestId);
    clearTimeout(pending.timer);
    audit("approval.response", "failed", { userId: pending.userId, deviceId: pending.deviceId, requestId, errorCode: "CLIENT_DISCONNECTED" });
  }
}

async function handleGatewayMessage(client: ConnectedClient, message: GatewayMessage | undefined): Promise<void> {
  if (!message) return;
  if (message.type === "approval.response") {
    const synthetic = pendingSyntheticApprovals.get(message.requestId);
    if (synthetic) {
      if (synthetic.clientId !== client.id) {
        audit("approval.response", "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "UNKNOWN_APPROVAL" });
        send(client.socket, { type: "error", requestId: message.requestId, message: "unknown approval request" });
        return;
      }
      pendingSyntheticApprovals.delete(message.requestId);
      clearTimeout(synthetic.timer);
      const decision = isRecord(message.result) && typeof message.result.decision === "string" ? message.result.decision : "resolved";
      audit("approval.response", "resolved", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId });
      send(client.socket, { type: "approval.resolved", requestId: message.requestId, status: decision, sequence: ++sequence, synthetic: true });
      return;
    }
    const pending = pendingServerRequests.get(message.requestId);
    if (!pending || pending.clientId !== client.id) {
      audit("approval.response", "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "UNKNOWN_APPROVAL" });
      send(client.socket, { type: "error", requestId: message.requestId, message: "unknown approval request" });
      return;
    }
    pendingServerRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    bridge.respond(pending.upstreamId, message.result);
    audit("approval.response", "resolved", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId });
    send(client.socket, { type: "approval.resolved", requestId: message.requestId, sequence: ++sequence });
    return;
  }

  if (message.operation === "test.approval.inject") {
    if (!controlsEnabled) {
      audit(message.operation, "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "CONTROLS_DISABLED" });
      send(client.socket, { type: "response", requestId: message.requestId, ok: false, error: "test controls are disabled" });
      return;
    }
    const payload = message.payload ?? {};
    const approvalRequestId = `${client.id}:synthetic:${randomUUID()}`;
    const method = typeof payload.method === "string" && payload.method ? payload.method : "item/command/approval";
    const timeoutMs = Math.min(10_000, Math.max(100, typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 5_000));
    const timer = setTimeout(() => {
      const pending = pendingSyntheticApprovals.get(approvalRequestId);
      if (!pending) return;
      pendingSyntheticApprovals.delete(approvalRequestId);
      audit("approval.response", "failed", { userId: pending.userId, deviceId: pending.deviceId, requestId: approvalRequestId, errorCode: "APPROVAL_TIMEOUT" });
      const target = clients.get(pending.clientId);
      if (target) send(target.socket, { type: "approval.resolved", requestId: approvalRequestId, status: "timeout", sequence: ++sequence, synthetic: true });
    }, timeoutMs);
    pendingSyntheticApprovals.set(approvalRequestId, { clientId: client.id, userId: client.userId, deviceId: client.deviceId, timer });
    audit(message.operation, "requested", { userId: client.userId, deviceId: client.deviceId, requestId: approvalRequestId });
    send(client.socket, { type: "approval.request", requestId: approvalRequestId, kind: "approval", method, data: payload.data ?? {}, sequence: ++sequence, synthetic: true, timeoutMs });
    send(client.socket, { type: "response", requestId: message.requestId, ok: true, data: { approvalRequestId, timeoutMs, synthetic: true } });
    return;
  }

  const method = operationMethod(message.operation);
  const agentMethod = deviceOperationMethod(message.operation);
  if(message.operation==="conversation.output.retry") {
    try {
      const payload=message.payload??{};assertOwnedThread(client,payload);
      const tid=String(payload.threadId);
      if(threadSummaryById.get(tid)?.deviceId!==client.deviceId)throw new Error("请在来源设备重新保存");
      const history=await bridge.request("thread/read",{threadId:tid,includeTurns:true});
      const output=await outputs.retry(tid,String(payload.outputId),history);
      send(client.socket,{type:"response",requestId:message.requestId,ok:true,data:{output}});
    }catch(error){send(client.socket,{type:"response",requestId:message.requestId,ok:false,error:String(error)});}
    return;
  }
  if (["conversation.message.status", "conversation.message.cancel"].includes(message.operation)) {
    try {
      const payload = message.payload ?? {};
      assertOwnedThread(client, payload);
      const entry = submissionsFor(String(payload.threadId)).find((s) => s.clientMessageId === payload.clientMessageId);
      if (message.operation === "conversation.message.cancel" && entry?.status === "preparing") { entry.status = "failed"; entry.error = "用户取消附件准备"; persistState(); }
      send(client.socket, {type:"response", requestId:message.requestId, ok:true, data:entry ?? {status:"absent"}});
    } catch(error) { send(client.socket, {type:"response", requestId:message.requestId, ok:false, error:String(error)}); }
    return;
  }
  if (!method && !agentMethod) {
    audit(message.operation, "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "UNSUPPORTED_OPERATION" });
    send(client.socket, { type: "response", requestId: message.requestId, ok: false, error: "unsupported operation" });
    return;
  }
  try {
    lastAppClientId = client.id;
    audit(message.operation, "started", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId });
    if (["conversation.resume", "conversation.read", "conversation.archive", "conversation.unarchive", "conversation.delete", "conversation.rename", "conversation.turn.create", "conversation.turn.cancel"].includes(message.operation)) {
      assertOwnedThread(client, message.payload ?? {});
    }
    if (message.operation === "conversation.turn.cancel" && typeof message.payload?.threadId === "string") {
      cancelDeviceTools(message.payload.threadId, typeof message.payload.turnId === "string" ? message.payload.turnId : undefined);
    }
    if (message.operation === "conversation.turn.create" && (message.payload?.clientMessageId !== undefined || message.payload?.attachments !== undefined)) {
      const result = await submitAttachmentTurn(client, message.payload ?? {});
      send(client.socket, {type:"response", requestId:message.requestId, ok:true, data:result});
      return;
    }
    const appPayload = message.operation === "conversation.create"
      ? {
          ...(message.payload ?? {}),
          approvalPolicy: "untrusted",
          developerInstructions: CLIENT_DEVICE_INSTRUCTIONS,
          dynamicTools: CLIENT_DEVICE_TOOLS,
        }
      : message.operation === "conversation.resume"
      ? {...(message.payload??{}), developerInstructions:CLIENT_DEVICE_INSTRUCTIONS}
      : message.operation === "session.initialize"
        ? {
            ...(message.payload ?? {}),
            capabilities: {
              ...(isRecord(message.payload) && isRecord(message.payload.capabilities) ? message.payload.capabilities : {}),
              // Dynamic client-device tools are an experimental App Server API.
              experimentalApi: true,
            },
          }
        : message.payload ?? {};
    let metadataOnlyMutation = false;
    let result: unknown;
    try {
      result = agentMethod
        ? await sendAgentRequest(client.deviceId, agentMethod, validateDeviceParams(message.payload ?? {}))
        : await bridge.request(method as string, appPayload);
    } catch (error) {
      // Older/archived sessions may no longer have a live rollout in the
      // central App Server. Archive state is platform metadata, so an absent
      // rollout must not make the user's archive/delete action fail.
      if (["conversation.archive", "conversation.unarchive", "conversation.delete"].includes(message.operation) && isMissingRolloutError(error)) {
        metadataOnlyMutation = true;
        result = { thread: { id: message.payload?.threadId } };
      } else if (message.operation === "conversation.read" && /list_turns is not supported yet/.test(String(error)) && !submissionsFor(String(message.payload?.threadId)).some(s=>s.status==="sent")) {
        result = {thread:{id:message.payload?.threadId,turns:[]}};
      } else {
        throw error;
      }
    }
    if (["conversation.read","conversation.resume"].includes(message.operation)) await outputs.collect(String(message.payload?.threadId),result);
    if (message.operation === "conversation.list") rememberListedThreads(client.userId, result);
    let visibleResult = ["conversation.create", "conversation.resume", "conversation.read", "conversation.list"].includes(message.operation)
      ? sanitizeThreadMetadata(message.operation === "conversation.list"
        ? filterOwnedThreads(
            result,
            ownedThreadIdsByUser.get(client.userId) ?? new Set(),
            client.userId,
            message.payload?.archived === true,
          )
        : result)
      : result;
    if (message.operation === "conversation.create") {
      const createdId = threadIdFromResult(result);
      if (createdId) {
        ownedThreadIdsByUser.get(client.userId)?.add(createdId);
        threadOwnerById.set(createdId, client.userId);
        const createdRecord = isRecord(result) && isRecord(result.thread) ? sanitizeThreadMetadata(result.thread) as JsonObject : undefined;
        threadSummaryById.set(createdId, { ...(createdRecord ?? { id: createdId }), deviceId: client.deviceId });
        persistState();
      }
    }
    if (["conversation.read", "conversation.resume"].includes(message.operation) && isRecord(visibleResult)) {
      const tid = String(message.payload?.threadId);
      reconcileSubmissions(tid, visibleResult);
      visibleResult = { ...visibleResult, attachmentSubmissions: submissionsFor(tid), outputs:outputs.list(tid) };
    }
    if (["conversation.rename", "conversation.archive", "conversation.unarchive"].includes(message.operation)) {
      const changedId = typeof message.payload?.threadId === "string" ? message.payload.threadId : undefined;
      if (changedId) {
        const current = threadSummaryById.get(changedId) ?? { id: changedId };
        const returned = isRecord(result) && isRecord(result.thread) ? result.thread : isRecord(result) && typeof result.id === "string" ? result : undefined;
        const next = { ...current, ...(returned ?? {}) };
        if (message.operation === "conversation.rename" && typeof message.payload?.name === "string") next.name = message.payload.name;
        if (message.operation === "conversation.archive") {
          next.isArchived = true;
          next.archivedAt = next.archivedAt ?? new Date().toISOString();
        }
        if (message.operation === "conversation.unarchive") {
          next.isArchived = false;
          delete next.archivedAt;
        }
        threadSummaryById.set(changedId, next);
        persistState();
      }
    }
    if (message.operation === "conversation.delete") {
      const deletedId = typeof message.payload?.threadId === "string" ? message.payload.threadId : undefined;
      if (deletedId) {
        ownedThreadIdsByUser.get(client.userId)?.delete(deletedId);
        threadOwnerById.delete(deletedId);
        threadSummaryById.delete(deletedId);
        persistState();
      }
    }
    const operationFailed = agentMethod && isRecord(result) && result.ok === false;
    const operationErrorCode = isRecord(result) && typeof result.errorCode === "string" ? result.errorCode : undefined;
    audit(message.operation, operationFailed ? "failed" : "succeeded", {
      userId: client.userId,
      deviceId: client.deviceId,
      requestId: message.requestId,
      ...(metadataOnlyMutation ? { errorCode: "APP_SERVER_ROLLOUT_MISSING_METADATA_ONLY" } : {}),
      ...(operationFailed && operationErrorCode ? { errorCode: operationErrorCode } : {}),
    });
    send(client.socket, { type: "response", requestId: message.requestId, ok: true, data: visibleResult });
  } catch (error) {
    audit(message.operation, "failed", { userId: client.userId, deviceId: client.deviceId, requestId: message.requestId, errorCode: "REQUEST_FAILED" });
    send(client.socket, { type: "response", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function operationMethod(operation: GatewayRequest["operation"]): string | undefined {
  const methods: Partial<Record<GatewayRequest["operation"], string>> = {
    "session.initialize": "initialize",
    "model.list": "model/list",
    "conversation.create": "thread/start",
    "conversation.resume": "thread/resume",
    "conversation.read": "thread/read",
    "conversation.archive": "thread/archive",
    "conversation.unarchive": "thread/unarchive",
    "conversation.delete": "thread/delete",
    "conversation.rename": "thread/name/set",
    "conversation.turn.create": "turn/start",
    "conversation.turn.cancel": "turn/interrupt",
    "conversation.list": "thread/list",
  };
  return methods[operation];
}

function submissionsFor(threadId: string): AttachmentSubmission[] {
  const summary = threadSummaryById.get(threadId);
  if (!summary) return [];
  if (!Array.isArray(summary.attachmentSubmissions)) summary.attachmentSubmissions = [];
  return summary.attachmentSubmissions as AttachmentSubmission[];
}

function reconcileSubmissions(threadId: string, result: JsonObject): void {
  const thread = isRecord(result.thread) ? result.thread : result;
  if (!Array.isArray(thread.turns)) return;
  for (const turn of thread.turns) {
    if (!isRecord(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
    for (const entry of submissionsFor(threadId)) {
      if (entry.status === "sent") continue;
      if (turn.items.some((item) => JSON.stringify(item).includes(`[platform-message:${entry.clientMessageId}]`))) {
        entry.turnId = turn.id; entry.status = "sent"; delete entry.error;
      }
    }
  }
  persistState();
}

async function submitAttachmentTurn(client: ConnectedClient, payload: JsonObject): Promise<unknown> {
  const threadId = String(payload.threadId);
  const summary = threadSummaryById.get(threadId)!;
  if (summary.deviceId && summary.deviceId !== client.deviceId) throw new Error("此 Thread 绑定另一台设备，请连接原设备或新建对话");
  const id = payload.clientMessageId;
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,128}$/.test(id)) throw new Error("clientMessageId 无效");
  const entries = submissionsFor(threadId);
  const existing = entries.find((entry) => entry.clientMessageId === id);
  if (existing?.status === "sent") return {turn:{id:existing.turnId}, submission:existing};
  if (existing && existing.status !== "failed") throw new Error("提交结果尚未确认，请先核对历史，勿重复发送");
  if (entries.some((entry) => ["preparing", "submitting", "unknown"].includes(entry.status))) throw new Error("该 Thread 仍有提交待确认，请先核对历史");
  const refs = parseAttachments(payload.attachments);
  if (!Array.isArray(payload.input) || payload.input.some((v) => !isRecord(v) || v.type !== "text" || typeof v.text !== "string")) throw new Error("平台仅接受正文和附件引用");
  const content = payload.input.map((v: {text:string}) => v.text).join("");
  if (content.length > 128_000) throw new Error("正文过长");
  if (refs.length && !agents.get(client.deviceId)?.hello?.agent.capabilities.includes("attachments/v1")) throw new Error("Local Agent 离线或需要升级附件能力");
  const deviceKey = agents.get(client.deviceId)?.hello?.agent.deviceKey;
  if (payload.deviceKey !== undefined && payload.deviceKey !== deviceKey) throw new Error("连接的是另一台同名设备，拒绝发送本机附件");
  if (summary.deviceKey && summary.deviceKey !== deviceKey) throw new Error("Thread 来源设备身份不一致");
  if (deviceKey) summary.deviceKey = deviceKey;
  if (activeAttachmentSubmissions >= 4) throw new Error("图片提交繁忙，请稍后重试");
  activeAttachmentSubmissions += 1;
  let released = false;
  const release = () => { if (!released) { released = true; activeAttachmentSubmissions -= 1; } };
  summary.deviceId = client.deviceId;
  const entry: AttachmentSubmission = {clientMessageId:id, content, attachments:[], status:"preparing"};
  if (existing) entries.splice(entries.indexOf(existing),1,entry); else entries.push(entry);
  persistState();
  const progress = (stage: string) => send(client.socket, {type:"event", eventType:"attachment.progress", name:"attachment/progress", data:{threadId, clientMessageId:id, stage}, sequence:++sequence});
  try {
    const prepared = await prepareAttachments(refs, client.deviceId, (method, params) => sendAgentRequest(client.deviceId, method, params), () => client.socket.readyState === WebSocket.OPEN && entry.status === "preparing" && agents.get(client.deviceId)?.hello?.agent.deviceKey === deviceKey, progress);
    entry.attachments = prepared.attachments;
    entry.status = "submitting";
    persistState();
    progress("正在提交中央模型");
    // Platform fields are consumed here. Client paths never become localImage.path.
    const { attachments: _attachments, clientMessageId: _id, deviceKey: _deviceKey, ...upstream } = payload;
    const task = bridge.request("turn/start", {...upstream, input:[...payload.input, {type:"text",text:`[platform-message:${id}]`}, ...prepared.input, {type:"text",text:"Platform file output support: imageGeneration results are automatically saved to the client's Downloads/Codexia and shown as image cards. Verify real client paths with device_list_outputs before claiming save success. If that tool is absent in this older thread, call device_exec with program='codexia.files' and args=['list_outputs','{}']. The same broker operation supports paths, write_text, publish and copy with a JSON parameters string. Never use a native image-generation savedPath (central path) as a client path."}]}).then((result) => {
      const turn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
      if (typeof turn?.id !== "string") throw new Error("App Server 未返回 turn.id，需核对历史");
      entry.status="sent"; entry.turnId=turn.id; delete entry.error; persistState();
      return {...(isRecord(result)?result:{}),submission:entry};
    }).catch((error: unknown) => {
      // A definitive rejection may arrive after the UI's submission deadline.
      // Persist it so status reconciliation can unlock the retained draft.
      if (entry.status !== "sent" && error instanceof Error && error.message.startsWith("App Server request failed:")) {
        entry.status = "failed";
        entry.error = error.message;
        persistState();
      }
      throw error;
    }).finally(release);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Turn 提交超时，结果未知，请核对历史")),50_000);})]);
    } finally {if(timer) clearTimeout(timer);}
  } catch (error) {
    if (entry.status === "preparing" || entry.status === "failed") release();
    const explicitRejection = error instanceof Error && error.message.startsWith("App Server request failed:");
    if (entry.status !== "sent") entry.status = entry.status === "submitting" && !explicitRejection ? "unknown" : "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    persistState(); throw error;
  }
}

function deviceOperationMethod(operation: GatewayRequest["operation"]): AgentRpcMethod | undefined {
  const methods: Partial<Record<GatewayRequest["operation"], AgentRpcMethod>> = {
    "device.workspace.list": "workspace/list",
    "device.read_file": "read_file",
    "device.exec": "exec",
    "device.file.stat": "file/stat",
    "device.file.read_text": "file/read_text",
  };
  return methods[operation];
}

function validateDeviceParams(params: JsonObject): JsonObject {
  for (const forbidden of ["deviceId", "workspaceId", "workspaceRoot"]) {
    if (forbidden in params) throw new Error(`${forbidden} is selected by the central broker and cannot be supplied by the client`);
  }
  return params;
}

function agentState(deviceId: string): "online" | "offline" {
  const agent = agents.get(deviceId);
  return agent?.ready && agent.socket.readyState === WebSocket.OPEN ? "online" : "offline";
}

function commandTimeoutMs(params: JsonObject): number {
  const requested = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? Math.trunc(params.timeoutMs)
    : DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1_000, requested));
}

function sendAgentRequest(
  deviceId: string,
  method: AgentRpcMethod,
  params: JsonObject,
  options: AgentRequestOptions = {},
): Promise<AgentRpcResponsePayload> {
  const session = agents.get(deviceId);
  const socket = session?.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN || !session.ready) {
    return Promise.resolve({ ok: false, error: "Local Agent is offline", errorCode: "AGENT_OFFLINE", retryable: true });
  }
  if (method.startsWith("file/") && !session.hello?.agent.capabilities.includes(method)) {
    return Promise.resolve({ok:false, error:"需要升级 Local Agent 才能发送附件", errorCode:"AGENT_UPGRADE_REQUIRED"});
  }

  const requestId = randomUUID();
  const envelope = createEnvelope(
    "agent.request",
    { method, params, operationId: requestId, idempotencyKey: requestId },
    { requestId, ...(options.taskId ? { taskId: options.taskId } : {}), ...(options.traceId ? { traceId: options.traceId } : {}) },
  );
  options.onRegistered?.(requestId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAgentRequests.delete(requestId);
      resolve({ ok: false, error: "Local Agent request timed out", errorCode: "TIMEOUT", retryable: true });
    }, options.timeoutMs ?? (method === "exec" ? commandTimeoutMs(params) + 10_000 : 60_000));
    pendingAgentRequests.set(requestId, { resolve, timer, deviceId, lastEventSequence: 0, onEvent: options.onEvent });
    send(socket, envelope as unknown as JsonObject);
  });
}

function cancelAgentRequest(deviceId: string, requestId: string, taskId: string | undefined, reason: string): void {
  const session = agents.get(deviceId);
  if (!session?.ready || session.socket.readyState !== WebSocket.OPEN) return;
  send(session.socket, createEnvelope("job.cancel", { reason }, { requestId, ...(taskId ? { taskId } : {}) }) as unknown as JsonObject);
}

function cancelDeviceTools(threadId: string, turnId?: string): void {
  for (const tool of activeDeviceTools.values()) {
    if (tool.threadId !== threadId || (turnId && tool.turnId && tool.turnId !== turnId)) continue;
    cancelAgentRequest(tool.deviceId, tool.agentRequestId, tool.turnId, "turn_interrupted");
  }
}

function handleAgentConnection(socket: WebSocket, request: IncomingMessage): void {
  const query = new URL(request.url ?? "/", `http://${listenHost}:${listenPort}`).searchParams;
  const requestedDeviceId = query.get("deviceId")?.trim() || "default-device";
  const previous = agents.get(requestedDeviceId);
  if (previous?.socket.readyState === WebSocket.OPEN) {
    socket.close(1013, "device already connected");
    return;
  }
  const session: AgentSession = { socket, deviceId: requestedDeviceId, ready: false };
  agents.set(requestedDeviceId, session);
  audit("device.connect", "connected", { deviceId: requestedDeviceId });
  socket.on("message", (data) => handleAgentMessage(socket, data, requestedDeviceId, session));
  socket.on("close", () => {
    rejectAgentRequestsForDevice(requestedDeviceId, "Local Agent connection closed", "AGENT_DISCONNECTED");
    if (agents.get(requestedDeviceId)?.socket === socket) {
      agents.delete(requestedDeviceId);
      audit("device.disconnect", "disconnected", { deviceId: requestedDeviceId });
      broadcastDeviceStatus(requestedDeviceId);
    }
  });
  socket.on("error", () => undefined);
}

function handleAgentMessage(socket: WebSocket, data: WebSocket.RawData, requestedDeviceId: string, session: AgentSession): void {
  const parsed = parseEnvelope(toText(data));
  if ("error" in parsed) {
    send(socket, { type: "gateway.error", code: parsed.error.code, error: parsed.error.message });
    return;
  }
  const envelope = parsed.envelope;
  if (envelope.type === "agent.hello") {
    const payload = envelope.payload as unknown as Record<string, unknown>;
    const agent = payload.agent;
    if (!isRecord(agent) || typeof agent.version !== "string" || !Array.isArray(agent.capabilities)) {
      send(socket, { type: "gateway.error", code: "INVALID_HELLO", error: "invalid agent hello" });
      socket.close(1002, "invalid agent hello");
      return;
    }
    const helloDeviceId = typeof payload.deviceId === "string" && payload.deviceId.trim() ? payload.deviceId.trim() : requestedDeviceId;
    if (helloDeviceId !== requestedDeviceId) {
      send(socket, { type: "gateway.error", code: "DEVICE_MISMATCH", error: "agent deviceId does not match connection" });
      socket.close(1008, "device mismatch");
      return;
    }
    session.hello = payload as unknown as AgentHelloPayload;
    session.ready = true;
    session.lastHeartbeatAt = new Date().toISOString();
    send(socket, createEnvelope("agent.hello_ack", {
      accepted: true,
      server: "central-test-gateway",
      capabilities: ["agent.request", "agent.response", "agent.event", "job.cancel", "agent.heartbeat"],
      heartbeatIntervalMs: 10_000,
    }) as unknown as JsonObject);
    audit("device.hello", "succeeded", { deviceId: requestedDeviceId });
    broadcastDeviceStatus(requestedDeviceId);
    return;
  }
  if (envelope.type === "agent.heartbeat") {
    if (!session.ready) return;
    session.lastHeartbeatAt = new Date().toISOString();
    broadcastDeviceStatus(requestedDeviceId);
    return;
  }
  if (envelope.type === "agent.event") {
    if (!session.ready || !envelope.requestId) return;
    const pending = pendingAgentRequests.get(envelope.requestId);
    if (!pending || pending.deviceId !== requestedDeviceId) return;
    const payload = envelope.payload as unknown as AgentEventPayload;
    if (payload.sequence <= pending.lastEventSequence) return;
    pending.lastEventSequence = payload.sequence;
    pending.onEvent?.(payload);
    return;
  }
  if (envelope.type === "job.cancel_ack") return;
  if (envelope.type === "agent.response") {
    const payload = envelope.payload as unknown as AgentRpcResponsePayload;
    if (typeof payload.ok !== "boolean" || !envelope.requestId) return;
    const pending = pendingAgentRequests.get(envelope.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAgentRequests.delete(envelope.requestId);
    pending.resolve({ ...payload, id: payload.id ?? envelope.requestId });
  }
}

function rejectAgentRequestsForDevice(deviceId: string, error: string, errorCode: string): void {
  for (const [requestId, pending] of pendingAgentRequests) {
    if (pending.deviceId !== deviceId) continue;
    clearTimeout(pending.timer);
    pendingAgentRequests.delete(requestId);
    pending.resolve({ ok: false, error, errorCode, retryable: true, id: requestId });
  }
}

function rejectAllAgentRequests(error: string, errorCode: string): void {
  for (const deviceId of agents.keys()) rejectAgentRequestsForDevice(deviceId, error, errorCode);
}

function broadcastDeviceStatus(deviceId: string): void {
  const session = agents.get(deviceId);
  for (const client of clients.values()) {
    if (client.deviceId !== deviceId) continue;
    send(client.socket, {
      type: "device.status",
      agent: agentState(deviceId),
      agentInfo: session?.hello?.agent,
      lastHeartbeatAt: session?.lastHeartbeatAt,
      deviceId,
    });
  }
}

function threadIdFromResult(result: unknown): string | undefined {
  const record = isRecord(result) ? result : undefined;
  const thread = record && isRecord(record.thread) ? record.thread : undefined;
  if (thread && typeof thread.id === "string") return thread.id;
  return record && typeof record.threadId === "string" ? record.threadId : undefined;
}

function assertOwnedThread(client: ConnectedClient, payload: JsonObject): void {
  const requestedThreadId = payload.threadId;
  const owned = ownedThreadIdsByUser.get(client.userId);
  if (typeof requestedThreadId !== "string" || !owned?.has(requestedThreadId)) {
    throw new Error("thread does not belong to this platform session");
  }
}

function filterOwnedThreads(result: unknown, ownedThreadIds: Set<string>, userId: string, archivedOnly = false): unknown {
  if (!isRecord(result)) return result;
  const known = [...threadSummaryById.entries()]
    .filter(([id]) => ownedThreadIds.has(id) && threadOwnerById.get(id) === userId)
    .map(([, summary]) => summary);
  const filter = (value: unknown): unknown[] => {
    const visible = (Array.isArray(value)
      ? value.filter((item) => isRecord(item) && typeof item.id === "string" && ownedThreadIds.has(item.id))
      : []).map((item) => {
        const current = isRecord(item) && typeof item.id === "string" ? threadSummaryById.get(item.id) : undefined;
        const merged = { ...(current ?? {}), ...(isRecord(item) ? item : {}) };
        // Archive state is owned by the gateway mutation path. App Server list
        // responses do not consistently echo these fields, so a refresh must
        // not silently resurrect a locally archived conversation.
        if (current && Object.hasOwn(current, "isArchived")) merged.isArchived = current.isArchived;
        if (current && Object.hasOwn(current, "archivedAt")) merged.archivedAt = current.archivedAt;
        return merged;
      });
    const visibleIds = new Set(visible.map((item) => isRecord(item) && typeof item.id === "string" ? item.id : ""));
    return [...visible, ...known.filter((item) => typeof item.id === "string" && !visibleIds.has(item.id))]
      .filter((item) => {
        const archived = item.isArchived === true || typeof item.archivedAt === "string";
        return archivedOnly ? archived : !archived;
      });
  };
  if (Array.isArray(result.data)) return { ...result, data: filter(result.data) };
  if (Array.isArray(result.threads)) return { ...result, threads: filter(result.threads) };
  return result;
}

/** Never expose the central worker's filesystem metadata as a client workspace. */
function sanitizeThreadMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeThreadMetadata);
  if (!isRecord(value)) return value;
  if (value.type === "localImage") return {type:"image", unavailable:true};
  if(value.type==="imageGeneration") return {type:"imageGeneration",id:value.id,status:value.status,failure:value.failure};
  const sanitized: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (["cwd", "workingDirectory", "workspaceRoot", "workspacePath"].includes(key)) continue;
    if (["url", "image_url", "imageUrl"].includes(key) && typeof nested === "string" && nested.startsWith("data:image/")) continue;
    sanitized[key] = sanitizeThreadMetadata(nested);
  }
  if (typeof value.id === "string") {
    const entries = threadSummaryById.get(value.id)?.attachmentSubmissions as AttachmentSubmission[] | undefined;
    for (const key of ["preview", "name"]) {
      const label = sanitized[key];
      if (typeof label !== "string" || !label.includes("[platform-message:")) continue;
      const entry = entries?.find(item => label.includes(item.clientMessageId)) ?? entries?.find(item => item.status === "sent");
      sanitized[key] = entry
        ? (entry.content.trim() || entry.attachments.map(attachment => attachment.name).join("、") || "附件消息").slice(0, 400)
        : "附件消息";
    }
  }
  return sanitized;
}

function rememberListedThreads(userId: string, result: unknown): void {
  if (!isRecord(result)) return;
  const values = Array.isArray(result.data) ? result.data : Array.isArray(result.threads) ? result.threads : [];
  let changed = false;
  for (const value of values) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    if (threadOwnerById.get(value.id) !== userId) continue;
    const current = threadSummaryById.get(value.id) ?? {};
    const next = { ...current, ...(sanitizeThreadMetadata(value) as JsonObject) };
    if (Object.hasOwn(current, "isArchived")) next.isArchived = current.isArchived;
    if (Object.hasOwn(current, "archivedAt")) next.archivedAt = current.archivedAt;
    threadSummaryById.set(value.id, next);
    changed = true;
  }
  if (changed) persistState();
}

function isMissingRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found/i.test(message);
}

function normalizeNotification(message: JsonRpcMessage): JsonObject | undefined {
  const params = isRecord(message.params) ? message.params : {};
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (message.method === "item/agentMessage/delta") {
    return { type: "event", eventType: "assistant.delta", data: { threadId, delta: params.delta ?? params.text ?? "" }, sequence: ++sequence };
  }
  if (message.method === "turn/completed") {
    return { type: "event", eventType: "turn.completed", data: { threadId, turn: sanitizeThreadMetadata(params.turn) }, sequence: ++sequence };
  }
  if (!message.method) return undefined;
  return { type: "event", eventType: "codex.notification", name: message.method, data: sanitizeThreadMetadata(params), sequence: ++sequence };
}

function parseMessage(data: WebSocket.RawData): GatewayMessage | undefined {
  try {
    const value = JSON.parse(toText(data)) as GatewayMessage;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function send(socket: WebSocket, value: JsonObject): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function writeJson(response: ServerResponse, status: number, value: JsonObject): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function toText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

httpServer.listen(listenPort, listenHost, () => {
  console.log(`Central test gateway listening on ws://${listenHost}:${listenPort}/ws (App Server via stdio)`);
});

process.on("SIGINT", () => {
  rejectAllAgentRequests("Gateway shutting down", "GATEWAY_SHUTDOWN");
  for (const session of agents.values()) session.socket.close();
  bridge.close();
  httpServer.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  rejectAllAgentRequests("Gateway shutting down", "GATEWAY_SHUTDOWN");
  for (const session of agents.values()) session.socket.close();
  bridge.close();
  httpServer.close();
  process.exit(0);
});
