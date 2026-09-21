// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// A UI draft only. It is never submitted as an effective CentralConfig.
export const DRAFT_KEY = "yuanzhou.central.setup-draft.v1";
export type SetupDraft = { version: 1; dataDirectory: string; host: string; port: string; clientUrl: string; modelSource: "existing-codex"; savedAt?: string };
export const emptyDraft: SetupDraft = { version: 1, dataDirectory: "", host: "", port: "4510", clientUrl: "", modelSource: "existing-codex" };
export type DraftErrors = Partial<Record<"dataDirectory" | "host" | "port" | "clientUrl", string>>;

export function loadDraft(): { draft: SetupDraft; warning?: string } {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return { draft: { ...emptyDraft } };
    const value = JSON.parse(raw);
    if (value?.version !== 1 || value.modelSource !== "existing-codex" ||
      !["dataDirectory", "host", "port", "clientUrl"].every(key => typeof value[key] === "string" && value[key].length <= 4096) ||
      typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt))) throw new Error("invalid draft");
    return { draft: { version: 1, dataDirectory: value.dataDirectory, host: value.host, port: value.port, clientUrl: value.clientUrl, modelSource: "existing-codex", savedAt: value.savedAt } };
  } catch {
    return { draft: { ...emptyDraft }, warning: "无法读取配置草稿。可以重新填写；保存前不会覆盖原草稿。" };
  }
}

function numericIp(host: string): boolean {
  if (host.includes(":")) {
    try { return new URL(`http://[${host}]/`).hostname.startsWith("["); } catch { return false; }
  }
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split(".").every(part => Number(part) <= 255 && String(Number(part)) === part);
}

export function validateDraft(draft: SetupDraft): DraftErrors {
  const errors: DraftErrors = {};
  const path = draft.dataDirectory.trim();
  const windowsPath = /^[a-z]:[\\/]/i.test(path);
  const segments = path.split(/[\\/]/);
  if (!(windowsPath || path.startsWith("/")) || path.startsWith("//") || path.startsWith("\\\\") ||
    /^[a-z]:[\\/]*$/i.test(path) || /^\/*$/.test(path) || segments.some(segment => segment === ".." || segment === ".") ||
    /[\u0000-\u001f]/.test(path) || (windowsPath && (path.slice(2).includes(":") || segments.slice(1).some(segment => /[<>"|?*]|[ .]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment))))) {
    errors.dataDirectory = "请输入本机绝对目录，不能使用磁盘根目录、网络共享或上级目录。";
  }
  if (!numericIp(draft.host.trim())) errors.host = "请输入有效的 IPv4 或 IPv6 监听地址。";
  const port = Number(draft.port);
  if (!/^\d+$/.test(draft.port) || !Number.isInteger(port) || port < 1024 || port > 65535) errors.port = "端口须为 1024–65535 的整数。";
  try {
    const url = new URL(draft.clientUrl.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "wss:" || url.pathname !== "/ws" || url.username || url.password || url.search || url.hash ||
      host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host.startsWith("127.") ||
      host === "[::]" || host === "[::1]" || host.startsWith("[::ffff:") || Number(url.port || 443) !== port) throw new Error("invalid URL");
  } catch { errors.clientUrl = "请输入客户端可访问的 wss://地址:端口/ws，端口应与监听端口一致，不能使用本机回环地址。"; }
  for (const key of ["dataDirectory", "host", "port", "clientUrl"] as const) {
    if (draft[key].length > 4096) errors[key] = "内容过长，请限制在 4096 个字符以内。";
  }
  return errors;
}

export function saveDraft(draft: SetupDraft): SetupDraft {
  if (Object.keys(validateDraft(draft)).length) throw new Error("配置草稿格式不正确。");
  const saved: SetupDraft = { version: 1, dataDirectory: draft.dataDirectory.trim(), host: draft.host.trim(), port: draft.port, clientUrl: draft.clientUrl.trim(), modelSource: "existing-codex", savedAt: new Date().toISOString() };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(saved));
  return saved;
}
