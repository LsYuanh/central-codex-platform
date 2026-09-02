// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { KeyboardEvent } from "react";

export interface WorkspaceEntry {
  name: string;
  kind: "directory" | "file" | "other";
  bytes?: number;
}

export interface WorkspacePanelProps {
  mode: "central-gateway" | "local-app-server" | "fake-central";
  deviceState: string;
  path: string;
  entries: WorkspaceEntry[];
  loading: boolean;
  output: string;
  content?: string;
  contentPath?: string;
  command: "git" | "node";
  available: boolean;
  onPathChange: (path: string) => void;
  onOpen: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onEntryClick: (entry: WorkspaceEntry) => void;
  onCommandChange: (command: "git" | "node") => void;
  onRunCommand: () => void;
  onCloseContent: () => void;
}

export function WorkspacePanel({
  mode,
  deviceState,
  path,
  entries,
  loading,
  output,
  content,
  contentPath,
  command,
  available,
  onPathChange,
  onOpen,
  onParent,
  onRefresh,
  onEntryClick,
  onCommandChange,
  onRunCommand,
  onCloseContent,
}: WorkspacePanelProps) {
  const handlePathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onOpen();
  };

  return (
    <section className="panel workspace-panel" id="workspace-panel">
      <div className="panel-heading workspace-heading">
        <div className="workspace-title-wrap"><div className="workspace-icon">⌘</div><div><p className="panel-kicker">{mode === "central-gateway" ? "Central Device Broker / AgentRPC" : "AgentRPC fallback"}</p><h2>工作区</h2><p className="workspace-subtitle">浏览项目文件，查看内容或运行受控命令</p></div></div>
        {mode === "central-gateway" && <span className={`status-pill pill-${deviceState}`}><span />{deviceState === "online" ? "设备在线" : deviceState === "connecting" ? "连接中" : "设备离线"}</span>}
      </div>
      {!available && <div className="workspace-offline"><span>⌁</span><div><strong>等待设备连接</strong><small>Local Agent 在线后才能访问中央工作区</small></div></div>}
      <div className="workspace-path-card">
        <span className="path-prefix">/</span>
        <input aria-label="工作区相对路径" value={path} onChange={(event) => onPathChange(event.target.value)} onKeyDown={handlePathKeyDown} placeholder="输入相对路径，例如 src/components" disabled={!available} />
        <button className="button-secondary" disabled={!available || loading} onClick={onOpen}>{loading ? "读取中…" : "打开"}</button>
      </div>
      <div className="workspace-toolbar">
        <div className="workspace-nav-actions"><button className="button-quiet" disabled={!available || loading || path === "."} onClick={onParent}>‹ 上级</button><button className="button-quiet" disabled={!available || loading} onClick={onRefresh}>↻ 刷新</button></div>
        <span className="workspace-location" title={path}>{path === "." ? "项目根目录" : path}</span><span className="workspace-count">{entries.length ? `${entries.length} 项` : ""}</span>
      </div>
      <div className="workspace-list" aria-live="polite">
        {loading && <div className="workspace-placeholder"><span className="spinner" /> 正在读取工作区…</div>}
        {!loading && available && entries.length === 0 && <div className="workspace-placeholder"><span className="workspace-empty-icon">⌂</span><span>点击“打开”列出目录内容</span></div>}
        {!loading && available && entries.map((entry) => (
          <button key={`${entry.kind}:${entry.name}`} className="workspace-entry" onClick={() => onEntryClick(entry)} disabled={entry.kind === "other"}>
            <span className={`entry-icon entry-${entry.kind}`}>{entry.kind === "directory" ? "▰" : entry.kind === "file" ? "▤" : "·"}</span>
            <span className="entry-name">{entry.name}</span>
            <span className="entry-size">{entry.kind === "file" && typeof entry.bytes === "number" ? formatBytes(entry.bytes) : entry.kind === "directory" ? "目录" : ""}</span>
            {entry.kind !== "other" && <span className="entry-chevron">›</span>}
          </button>
        ))}
      </div>
      <div className="workspace-command-card">
        <div className="workspace-section-label"><span>客户端命令</span><small>命令在本机 Local Agent 执行（含 PowerShell）</small></div>
        <div className="workspace-command-row">
          <select aria-label="允许的版本命令" value={command} onChange={(event) => onCommandChange(event.target.value as "git" | "node")} disabled={!available || loading}><option value="git">git --version</option><option value="node">node --version</option></select>
          <button className="button-secondary" disabled={!available || loading} onClick={onRunCommand}>运行命令</button>
        </div>
        <pre className="compact-output">{output}</pre>
      </div>
      {contentPath && <div className="workspace-file-view"><div className="workspace-file-heading"><span><i>FILE</i>{contentPath}</span><button className="button-quiet" onClick={onCloseContent}>关闭</button></div><pre>{content}</pre></div>}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
