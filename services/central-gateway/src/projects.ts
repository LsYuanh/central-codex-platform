// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Client path strings only: this module never accesses a central filesystem.
import { randomUUID } from "node:crypto";

export interface ClientProject {
  id: string;
  name: string;
  folders: string[]; // First folder is primary. Threads capture an immutable copy.
  revision: number;
}
export interface StoredProject extends ClientProject { userId: string; deviceId: string; deviceKey: string }
type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

export function absoluteClientPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) throw Error("PROJECT_PATH_INVALID: 请选择有效的本机绝对目录");
  // Reject drive-relative, root-relative Windows paths and device namespaces.
  if (/^(?:\\\\|\/\/)[?.]/.test(value) || !(/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || value.startsWith("/"))) throw Error("PROJECT_PATH_INVALID: 项目目录必须是本机绝对路径");
  return value;
}

export function projectInput(value: unknown): Pick<ClientProject, "name" | "folders"> {
  if (!record(value) || typeof value.name !== "string" || !value.name.trim()) throw Error("PROJECT_NAME_INVALID: 请输入项目名称");
  if (!Array.isArray(value.folders) || !value.folders.length) throw Error("PROJECT_FOLDERS_INVALID: 请至少保留一个源文件夹");
  return { name: value.name.trim(), folders: value.folders.map(absoluteClientPath) };
}

export function publicProject(p: StoredProject): ClientProject {
  return { id: p.id, name: p.name, folders: [...p.folders], revision: p.revision };
}

export class ProjectCatalog {
  private rows: StoredProject[];
  constructor(value: unknown = []) {
    if (!Array.isArray(value)) throw Error("PROJECT_STATE_CORRUPT");
    this.rows = value.map(v => {
      if (!record(v) || !["id", "userId", "deviceId", "deviceKey"].every(k => typeof v[k] === "string" && v[k]) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1) throw Error("PROJECT_STATE_CORRUPT");
      projectInput(v);
      return v as unknown as StoredProject;
    });
    if (new Set(this.rows.map(p => p.id)).size !== this.rows.length) throw Error("PROJECT_STATE_CORRUPT: duplicate id");
  }
  snapshot(): StoredProject[] { return this.rows.map(p => ({ ...p, folders: [...p.folders] })); }
  list(userId: string, deviceId: string): ClientProject[] { return this.rows.filter(p => p.userId === userId && p.deviceId === deviceId).map(publicProject); }
  get(userId: string, deviceId: string, id: unknown): StoredProject {
    const p = this.rows.find(p => p.id === id && p.userId === userId && p.deviceId === deviceId);
    if (!p) throw Error("PROJECT_NOT_FOUND: 项目已移除或属于其他设备，请刷新项目列表");
    return p;
  }
  save(owner: { userId: string; deviceId: string; deviceKey: string }, value: Json, folders: string[]): ClientProject {
    const input = projectInput(value);
    const creationKey = value.id === undefined && typeof value.creationKey === "string" && /^[a-zA-Z0-9-]{8,128}$/.test(value.creationKey) ? value.creationKey : undefined;
    if (creationKey) {
      const previous = this.rows.find(p => p.id === creationKey);
      if (previous) {
        if (previous.userId !== owner.userId || previous.deviceId !== owner.deviceId || previous.deviceKey !== owner.deviceKey || previous.name !== input.name || JSON.stringify(previous.folders) !== JSON.stringify(folders)) throw Error("PROJECT_CONFLICT: 创建请求已使用，请刷新列表核对");
        return publicProject(previous);
      }
    }
    const old = value.id === undefined ? undefined : this.get(owner.userId, owner.deviceId, value.id);
    if (old && (old.deviceKey !== owner.deviceKey || old.revision !== value.revision)) throw Error("PROJECT_CONFLICT: 项目或设备身份已变化，请重新打开编辑窗口");
    const next: StoredProject = { ...owner, ...input, folders, id: old?.id ?? creationKey ?? randomUUID(), revision: (old?.revision ?? 0) + 1 };
    this.rows = [...this.rows.filter(p => p.id !== next.id), next];
    return publicProject(next);
  }
  remove(userId: string, deviceId: string, id: unknown, revision: unknown): void {
    const p = this.get(userId, deviceId, id);
    if (p.revision !== revision) throw Error("PROJECT_CONFLICT: 项目已变化，请刷新后重试");
    this.rows = this.rows.filter(row => row.id !== p.id);
  }
}

/** Preserve relative .. segments so the Agent, not node:path on the central OS,
 * resolves symlinks and OS permissions. Absolute client paths stay untouched. */
export function projectPath(root: string, raw: string): string {
  if (!raw || /[\x00-\x1f]/.test(raw)) throw Error("PROJECT_PATH_INVALID");
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("\\") || raw.startsWith("/")) return absoluteClientPath(raw);
  const separator = /^[A-Za-z]:|^\\\\/.test(root) ? "\\" : "/";
  return `${root.replace(/[\\/]$/, "")}${separator}${raw}`;
}

export function projectDeviceParams(root: string | undefined, method: string, input: Json): Json {
  if (!root) return input;
  const p = { ...input };
  if (method === "exec") p.cwd = projectPath(root, typeof p.cwd === "string" ? p.cwd : ".");
  else if (method === "workspace/apply_patch") {
    if (typeof p.patch === "string") p.patch = p.patch.replace(/^(\*\*\* (?:Add File|Update File|Delete File|Move to): )([^\r\n]+)(\r?)$/gm, (_line, prefix, path, cr) => prefix + projectPath(root, path) + cr);
    for (const key of ["expectedVersions", "expectedPaths"]) if (record(p[key])) p[key] = Object.fromEntries(Object.entries(p[key]).map(([path, value]) => [projectPath(root, path), value]));
  } else {
    if (typeof p.path === "string") p.path = projectPath(root, p.path);
    else if (["workspace/context", "workspace/list", "workspace/search", "workspace/git_status", "workspace/git_diff"].includes(method)) p.path = root;
    if (method === "file/copy" && typeof p.sourcePath === "string") p.sourcePath = projectPath(root, p.sourcePath);
    // Name-only generated outputs retain the configured output directory policy.
  }
  return p;
}

export function projectInstructions(p?: ClientProject): string {
  return p ? `\nThis conversation belongs to a client project. Primary working directory: ${JSON.stringify(p.folders[0])}. Associated client folders: ${JSON.stringify(p.folders)}. Device workspace paths, relative patch headers and device_exec cwd default to this primary directory for this conversation. Use absolute paths to work in an associated secondary directory and read its applicable rules before editing. The global default output directory remains separate for name-only document outputs. This snapshot is fixed for this conversation; never use it as the CENTRAL App Server cwd.` : "";
}
