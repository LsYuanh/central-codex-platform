// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { UiIcon } from "./UiIcon";
import type { ClientGitDiff } from "./gateway-ui-events";

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
  resultStatus?: "idle" | "loading" | "success" | "error";
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
  diffScope?: string;
  loadDiff?: (staged: boolean) => Promise<ClientGitDiff>;
}

export function WorkspacePanel({
  mode,
  deviceState,
  path,
  entries,
  loading,
  output,
  resultStatus = "idle",
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
  diffScope,
  loadDiff,
}: WorkspacePanelProps) {
  const handlePathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onOpen();
  };

  return (
    <section className="panel workspace-panel" id="workspace-panel">
      <div className="panel-heading workspace-heading">
        <div className="workspace-title-wrap"><div className="workspace-icon"><UiIcon name="folder" /></div><div><p className="panel-kicker">{mode === "central-gateway" ? "Central Device Broker / AgentRPC" : "AgentRPC fallback"}</p><h2>本机文件</h2><p className="workspace-subtitle">输入本机目录，浏览文件或查看 Git 变更</p></div></div>
        {mode === "central-gateway" && <span className={`status-pill pill-${deviceState}`}><span />{deviceState === "online" ? "设备在线" : deviceState === "connecting" ? "连接中" : "设备离线"}</span>}
      </div>
      {!available && <div className="workspace-offline"><UiIcon name="monitor" /><div><strong>等待设备连接</strong><small>本机设备在线后即可访问本机文件</small></div></div>}
      <div className="workspace-path-card">
        <span className="path-prefix">/</span>
        <input aria-label="本机文件路径" value={path} onChange={(event) => onPathChange(event.target.value)} onKeyDown={handlePathKeyDown} placeholder="输入本机目录的绝对路径或相对路径" disabled={!available} />
        <button className="button-secondary" disabled={!available || loading} onClick={onOpen}>{loading ? "读取中…" : "打开"}</button>
      </div>
      <div className="workspace-toolbar">
        <div className="workspace-nav-actions"><button className="button-quiet" disabled={!available || loading} onClick={onParent}>‹ 上级</button><button className="button-quiet" disabled={!available || loading} onClick={onRefresh}>↻ 刷新</button></div>
        <span className="workspace-location" title={path}>{path === "." ? "默认输出目录" : path}</span><span className="workspace-count">{entries.length ? `${entries.length} 项` : ""}</span>
      </div>
      <div className="workspace-list" aria-live="polite">
        {loading && <div className="workspace-placeholder"><span className="spinner" /> 正在读取目录…</div>}
        {!loading && available && entries.length === 0 && <div className="workspace-placeholder"><UiIcon name="folder" /><span>点击“打开”列出目录内容</span></div>}
        {!loading && available && entries.map((entry) => (
          <button key={`${entry.kind}:${entry.name}`} className="workspace-entry" onClick={() => onEntryClick(entry)} disabled={entry.kind === "other"}>
            <span className={`entry-icon entry-${entry.kind}`}><UiIcon name={entry.kind === "directory" ? "folder" : "file"} /></span>
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
        <div className={`workspace-result-card result-${resultStatus}`}><div className="workspace-result-heading"><span>{resultStatus === "loading" ? "执行中" : resultStatus === "success" ? "已完成" : resultStatus === "error" ? "执行失败" : "最近结果"}</span>{resultStatus === "loading" && <span className="spinner" />}</div><pre className="compact-output">{output}</pre></div>
      </div>
      {contentPath && <div className="workspace-file-view"><div className="workspace-file-heading"><span><i>FILE</i>{contentPath}</span><button className="button-quiet" onClick={onCloseContent}>关闭</button></div><pre>{content}</pre></div>}
      <WorkspaceChanges key={diffScope ?? path} available={available} loadDiff={loadDiff} />
    </section>
  );
}

function WorkspaceChanges({ available, loadDiff }: {available: boolean; loadDiff?: (staged:boolean) => Promise<ClientGitDiff>}) {
  const [staged, setStaged] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [diff, setDiff] = useState<ClientGitDiff>();
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  useEffect(() => () => { requestVersion.current += 1; }, []);
  useEffect(() => {
    if (!available) {
      requestVersion.current += 1;
      setDiff(undefined);
      setState("idle");
    }
  }, [available]);
  const refresh = async () => {
    if (!available || !loadDiff || state === "loading") return;
    const version = ++requestVersion.current;
    setState("loading"); setError(""); setDiff(undefined);
    try {
      const result = await loadDiff(staged);
      if (version !== requestVersion.current) return;
      setDiff(result); setState("success");
    } catch (e) {
      if (version !== requestVersion.current) return;
      setError(e instanceof Error ? e.message : String(e)); setState("error");
    }
  };
  return <div className="workspace-command-card" aria-label="客户端实际变更">
    <div className="workspace-section-label"><span>实际 Git 变更</span><small>从本机工作区读取；未跟踪文件不包含在 diff 中</small></div>
    <div className="workspace-command-row">
      <select aria-label="变更范围" value={staged ? "staged" : "working"} disabled={state === "loading"} onChange={event => {setStaged(event.target.value === "staged"); setDiff(undefined); setState("idle");}}><option value="working">未暂存变更</option><option value="staged">已暂存变更</option></select>
      <button className="button-secondary" disabled={!available || !loadDiff || state === "loading"} onClick={() => void refresh()}>{state === "loading" ? "读取中…" : "读取实际 diff"}</button>
    </div>
    {!loadDiff && <div className="execution-notice">当前网关未声明客户端 Git diff 能力，请升级并重新连接。</div>}
    {state === "error" && <div className="execution-error" role="alert">{error}</div>}
    {diff && <div className="workspace-file-view"><div className="workspace-file-heading"><span>本机 · {diff.repositoryRoot} · {diff.staged ? "已暂存" : "未暂存"}</span></div><pre>{diff.stdout || "该范围没有已跟踪文件的变更。"}</pre>{diff.stderr && <pre>{diff.stderr}</pre>}{diff.truncated && <div className="execution-notice">diff 超出输出上限，当前展示不完整。</div>}</div>}
  </div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
