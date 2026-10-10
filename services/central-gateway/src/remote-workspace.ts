// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import type { AgentRpcResponsePayload } from "@central-codex-spike/agentrpc-types";

export const REMOTE_WORKSPACE_POLICY = "remote-workspace/v1";
export function explainRuntimeError(message: string): string {
  const modelCode=/\b(MODEL_[A-Z_0-9]+)\b/.exec(message)?.[1];
  if(modelCode){
    const transport=/^MODEL_PROVIDER_(?:REQUEST|STREAM|CATALOG)_TRANSPORT_FAILED(?:_(DNS|TIMEOUT|CONNECTION_RESET|CONNECTION_REFUSED|UNREACHABLE|TLS|CANCELLED|MIXED|UNKNOWN))?$/.exec(modelCode);
    if(transport?.[1]==='CANCELLED'||modelCode==='MODEL_REQUEST_CANCELLED')return `${modelCode}: 模型请求已取消；当前任务不会自动重发。`;
    if(transport||modelCode==='MODEL_PROVIDER_STREAM_ABORTED'||modelCode==='MODEL_REQUEST_TIMEOUT'){
      const descriptions:Record<string,string>={DNS:'域名解析失败',TIMEOUT:'连接或响应超时',CONNECTION_RESET:'连接被中断',CONNECTION_REFUSED:'连接被拒绝',UNREACHABLE:'网络不可达',TLS:'安全连接校验或握手失败',CANCELLED:'请求已取消'};
      const category=modelCode==='MODEL_REQUEST_TIMEOUT'?'TIMEOUT':transport?.[1]??'';
      const reason=descriptions[category]??'连接异常';
      return `${modelCode}: 中央机访问模型服务时${reason}，请管理员检查中央网络、代理及服务连通性；当前任务不会自动重发。`;
    }
    if(modelCode==='MODEL_CATALOG_UNAVAILABLE')return `${modelCode}: 中央模型目录暂不可用，请管理员检查上游连接及模型目录响应；当前任务不会自动重发。`;
    if(modelCode==='MODEL_PROVIDER_RATE_LIMITED')return `${modelCode}: 模型服务请求受限，请稍后再试；当前任务不会自动重发。`;
    const reason=modelCode==='MODEL_CREDENTIAL_DISABLED'?'模型访问已被管理员停用':/UNCONFIGURED|MISSING/.test(modelCode)?'尚未配置模型访问':/EXPIRED|REJECTED/.test(modelCode)?'中央模型凭据已过期或被服务拒绝':modelCode==='MODEL_LEASE_INVALID'?'当前模型访问令牌已失效':modelCode.endsWith('MODEL_UNSUPPORTED')?'所选模型当前不可用':'中央模型访问暂不可用';
    const credential=/^MODEL_CREDENTIAL_|^MODEL_LEASE_INVALID$/.test(modelCode);
    return `${modelCode}: ${reason}，${credential?'请联系管理员检查授权后重新连接':'请管理员根据错误码检查模型服务'}；当前任务不会自动重发。`;
  }
  return message.includes("disabled://read-only-shared-auth")
    ? "CENTRAL_SHARED_AUTH_EXPIRED: 中央只读共享登录已过期，请由凭据所有者更新登录；隔离运行时不会刷新共享令牌。"
    : message;
}
export interface RemoteWorkspaceBinding {
  policy: typeof REMOTE_WORKSPACE_POLICY;
  userId: string;
  deviceId: string;
  deviceKey: string;
  workspaceRoot: string;
  projectRoot?: string;
}

/** Bind to the original device; changing its default output directory does not move the Thread. */
export function assertBinding(binding: RemoteWorkspaceBinding, current: RemoteWorkspaceBinding): void {
  for (const key of ["policy", "userId", "deviceId", "deviceKey", "projectRoot"] as const) {
    if (binding[key] !== current[key]) throw new Error(`REMOTE_WORKSPACE_CHANGED: ${key}; reconnect the original client device or create a new conversation`);
  }
}

/** Do not permit a UI payload to replace the worker's execution policy/configuration. */
export function validateRemotePayload(payload: Record<string, unknown>): void {
  if ("deferGoalContinuation" in payload) throw new Error("REMOTE_POLICY_OVERRIDE: goal recovery is managed by the gateway");
  if (Array.isArray(payload.input) && payload.input.some(v => v && typeof v === "object" && v.type === "skill")) throw new Error("REMOTE_SKILL_INPUT_DENIED: submit an owned skill ID and revision, never a host path");
  if ("clientProject" in payload) throw new Error("REMOTE_POLICY_OVERRIDE: clientProject is managed by the gateway");
  for (const key of ["cwd", "sandbox", "sandboxPolicy", "approvalPolicy", "config", "baseInstructions", "developerInstructions", "dynamicTools", "mcpServers", "remoteWorkspace", "environment", "permissions", "serviceName"]) {
    if (key in payload) throw new Error(`REMOTE_POLICY_OVERRIDE: ${key} is managed by the gateway`);
  }
}

export function executionStatus(result: AgentRpcResponsePayload): string {
  if (result.ok) return "succeeded";
  const code = result.errorCode ?? result.error ?? "";
  if (/RESULT_UNKNOWN|DISCONNECTED|CONNECTION|^TIMEOUT$/.test(code)) return "unknown";
  if (/CANCEL/.test(code)) return "cancelled";
  if (/TIMED_OUT|COMMAND_TIMEOUT|WORKSPACE_TIMEOUT/.test(code)) return "timed_out";
  if (/DENIED|FORBIDDEN|NOT_ALLOWED|CONFLICT|VERSION|POLICY/.test(code)) return "denied";
  if (/OFFLINE/.test(code)) return "offline";
  return "failed";
}

const path = {type:"string", description:"Absolute client path or relative path from the default output directory; access follows OS account permissions."};
export const WORKSPACE_TOOLS = [
  {type:"function", name:"device_workspace_context", description:"Read actual client OS, shell, workspace and applicable AGENTS project rules. Read context for the target directory before editing.", inputSchema:{type:"object",properties:{path}}},
  {type:"function", name:"device_workspace_search", description:"Search filenames at the specified client directory or UTF-8 text with bounded pagination. No central filesystem is searched.",inputSchema:{type:"object",properties:{path,mode:{type:"string",enum:["files","text"]},query:{type:"string"},cursor:{type:"string"},limit:{type:"integer",minimum:1,maximum:200}},required:["mode","query"]}},
  {type:"function", name:"device_workspace_read_text", description:"Read client UTF-8 project text with a content SHA256 version and bounded pages. Use that version for safe edits.",inputSchema:{type:"object",properties:{path,offset:{type:"integer",minimum:0},version:{type:"string"}},required:["path"]}},
  {type:"function", name:"device_workspace_git_status", description:"Get actual client Git status; pass the project directory; fails if it is not a repository.",inputSchema:{type:"object",properties:{path}}},
  {type:"function", name:"device_workspace_git_diff", description:"Get actual bounded client Git diff, never an inferred model diff. Includes truncation and exit status.",inputSchema:{type:"object",properties:{path,staged:{type:"boolean"}}}},
  {type:"function", name:"device_workspace_apply_patch", description:"Apply a Codex patch at the specified client paths after one-time user approval. Use absolute client paths in patch file headers for projects outside the default output directory; relative patch paths start at the output directory. Gateway prepares a client preview and captures canonical paths and SHA256 versions (missing for a new path) before requesting approval. Optional expectedVersions must match the preview. Client rechecks after approval; conflicts fail without applying stale edits. Multi-file failures report partial changes; never assume rollback.",inputSchema:{type:"object",properties:{patch:{type:"string"},expectedVersions:{type:"object",additionalProperties:{type:"string"}}},required:["patch"]}},
] as const;
