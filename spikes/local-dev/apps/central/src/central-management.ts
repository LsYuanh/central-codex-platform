// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Type-only import: the Node validator never enters the browser bundle.
import type { CentralConfig, RuntimeInspection, PublicFailure } from "../../../services/test-gateway/src/central-management-contract";
import type { SetupDraft } from "./setup-draft";
import type { ServiceSnapshot } from "./service-client";
export type { CentralConfig, RuntimeInspection };
export type Inspection = Omit<RuntimeInspection, "checks"> & { checks: Array<RuntimeInspection["checks"][number] & { message?: string }> };
export type SaveRequest = { requestId: string; expectedRevision: number; config: CentralConfig };
const messages: Record<string, string> = {
  CONFIG_INVALID: "配置不完整或格式不正确，请检查填写内容。",
  CONFIG_VERSION_UNSUPPORTED: "配置版本不兼容，原文件已保留。",
  CONFIG_REVISION_CONFLICT: "配置已被其他窗口修改。请读取最新版本，再决定是否使用当前填写内容保存。",
  CONFIG_STORAGE_UNSAFE: "配置文件或目录无法安全访问，原文件未被自动修复。请检查权限和目录状态。",
  CONFIG_STORAGE_FULL: "配置保存记录已达到当前版本容量上限。已保存配置仍可读取；需要后续版本的存储迁移，重复保存无法解决。",
  RUNTIME_PLATFORM_MISMATCH: "所选运行包与当前系统或处理器架构不匹配，请选择本机对应的运行包。",
  DATA_DIRECTORY_IN_USE: "中央数据目录正在使用中。",
  DATA_MIGRATION_REQUIRED: "数据目录已有内容，需要兼容检查或迁移。",
  OPERATION_BUSY: "另一个配置操作正在进行，请稍后核对。",
  OPERATION_TIMEOUT: "未能及时确认操作结果。请核对结果，避免重复提交新操作。",
  SERVICE_ALREADY_ACTIVE: "中央服务正在启动、运行或停止，配置未保存。请到运行概览停止服务，确认已停止后再保存。",
  SERVICE_CLEANUP_UNVERIFIED: "服务进程退出尚未确认，配置未保存。请到运行概览核对停止状态，确认退出后再保存。",
  SERVICE_APP_CLOSING: "中央管理正在退出，配置未保存。请重新打开应用后再操作。",
  INTERNAL_ERROR: "操作未能完成，请重试读取并核对配置。",
};
export function publicFailure(error: unknown): PublicFailure {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && Object.hasOwn(messages, error.code)) {
    return { code: error.code as PublicFailure["code"], recoverable: error.code !== "CONFIG_STORAGE_FULL" && error.code !== "RUNTIME_PLATFORM_MISMATCH", diagnosticId: "native" };
  }
  return { code: "INTERNAL_ERROR", recoverable: true, diagnosticId: "ui-response" };
}
export function failureMessage(error: unknown): string {
  const message = messages[publicFailure(error).code] ?? messages.INTERNAL_ERROR;
  const fields: Record<string, string> = { dataDirectory: "数据目录", "listen.host": "监听地址", "listen.port": "端口", clientUrl: "客户端连接地址", "tls.certificateId": "证书标识", runtimePackageId: "运行包标识", limits: "并发限制", shutdown: "停止策略" };
  if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
    const labels = [...new Set(error.issues.map(issue => issue && typeof issue.field === "string" && Object.hasOwn(fields, issue.field) ? fields[issue.field] : null).filter(Boolean))];
    if (labels.length) return `${message} 需检查：${labels.join("、")}。`;
  }
  return message;
}
export function configToDraft(config: CentralConfig): SetupDraft {
  return { version: 1, dataDirectory: config.dataDirectory, host: config.listen.host, port: String(config.listen.port), clientUrl: config.clientUrl, modelSource: "existing-codex" };
}
export function configSaveBlock(snapshot: ServiceSnapshot | null): string {
  if (!snapshot) return "服务状态尚未确认，暂不能保存配置。请刷新服务状态。";
  if (["starting", "running", "stopping"].includes(snapshot.state)) return "中央服务正在启动、运行或停止，当前使用已保存的配置。修改配置前，请到运行概览停止服务。";
  if (!snapshot.cleanupVerified) return "服务进程退出尚未确认，暂不能保存配置。请到运行概览核对停止状态。";
  return "";
}
export function matchesDraft(config: CentralConfig | null, draft: SetupDraft): boolean {
  return !!config && config.dataDirectory === draft.dataDirectory.trim() && config.listen.host === draft.host.trim() && config.listen.port === Number(draft.port) && config.clientUrl === draft.clientUrl.trim();
}
// Fail closed if an incompatible native shell returns the wrong response shape.
export function readConfigResponse(value: unknown): { initialized: boolean; config: CentralConfig | null } {
  if (!value || typeof value !== "object" || !("initialized" in value) || !("config" in value)) throw new Error("invalid config response");
  if (value.initialized === false && value.config === null) return { initialized: false, config: null };
  const c = value.config as CentralConfig | null;
  if (value.initialized !== true || !c || c.schemaVersion !== 1 || !Number.isSafeInteger(c.revision) || c.revision < 1 ||
    typeof c.dataDirectory !== "string" || typeof c.listen?.host !== "string" || !Number.isInteger(c.listen?.port) ||
    typeof c.clientUrl !== "string" || typeof c.tls?.certificateId !== "string" || typeof c.runtimePackageId !== "string" ||
    ![c.limits?.maxWorkers, c.limits?.perUserTurns, c.limits?.totalTurns, c.shutdown?.graceMs, c.shutdown?.forceMs].every(Number.isInteger)) throw new Error("invalid config response");
  return { initialized: true, config: c };
}
export function readInspection(value: unknown): Inspection {
  const inspection = value as Inspection;
  const components = ["package", "system", "port", "tls", "directory", "isolation"];
  if (!inspection || !["win32", "darwin"].includes(inspection.platform) || !Number.isSafeInteger(inspection.configRevision) ||
    !Number.isFinite(inspection.inspectedAt) || !Array.isArray(inspection.checks) || inspection.checks.length !== components.length ||
    components.some(component => inspection.checks.filter(check => check.component === component).length !== 1) ||
    inspection.checks.some(check => !["passed", "failed", "not-checked"].includes(check.state) || (check.message !== undefined && typeof check.message !== "string"))) throw new Error("invalid inspection");
  return inspection;
}
