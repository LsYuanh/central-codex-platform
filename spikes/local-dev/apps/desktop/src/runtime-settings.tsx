// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

export interface DesktopConfig { gatewayUrl: string; userId: string; deviceId: string; workspaceRoot: string }
export interface ConfigView {
  saved: DesktopConfig;
  effective: DesktopConfig;
  uiGatewayUrl: string;
  agentGatewayUrl: string;
  overrides: string[];
  hasSaved: boolean;
  needsSetup: boolean;
  running: boolean;
  error?: string;
}

export function RuntimeSettings({ view, draft, setDraft, applying, busy, error, notice, apply, reload }: {
  view?: ConfigView; draft: DesktopConfig; setDraft: (value: DesktopConfig) => void;
  applying: boolean; busy: boolean; error: string; notice: string;
  apply: () => void; reload: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const gatewayOverride = view?.overrides.includes("CODEXIA_GATEWAY_AGENT_URL");
  const workspaceOverride = view?.overrides.includes("CODEXIA_WORKSPACE_ROOT");
  const changed = view && (draft.gatewayUrl !== view.saved.gatewayUrl || draft.userId !== view.saved.userId || draft.deviceId !== view.saved.deviceId || draft.workspaceRoot !== view.saved.workspaceRoot);
  const pick = async () => {
    setSelecting(true); setPickerError("");
    try {
      const directory = await invoke<string | null>("select_workspace_directory");
      if (directory) setDraft({ ...draft, workspaceRoot: directory });
    } catch (error) { setPickerError(String(error)); }
    finally { setSelecting(false); }
  };
  return <>
    {view?.needsSetup && <p className="runtime-config-notice" role="status">首次使用：请确认自动填写的用户 ID、设备 ID 和本机工作区，点击“保存并应用”后开始连接。</p>}
    <div className="settings-card form-settings-card runtime-config-card">
      <label className="settings-field"><span><strong>中央网关地址</strong><small>{gatewayOverride ? "由 CODEXIA_GATEWAY_AGENT_URL 覆盖" : "桌面与 Local Agent 共用同一中央网关"}</small></span><input aria-label="中央网关地址" value={gatewayOverride ? view!.effective.gatewayUrl : draft.gatewayUrl} disabled={applying || selecting || gatewayOverride || !view} onChange={e => setDraft({ ...draft, gatewayUrl: e.target.value })} placeholder="ws://192.0.2.10:4510/ws" /></label>
      <label className="settings-field"><span><strong>用户 ID</strong><small>按当前系统登录用户名自动填写；同一用户可在不同设备使用相同值</small></span><input aria-label="用户 ID" value={draft.userId} disabled={applying || selecting || !view} onChange={e => setDraft({ ...draft, userId: e.target.value })} placeholder="当前系统用户名" maxLength={128} /></label>
      <label className="settings-field"><span><strong>设备 ID</strong><small>按电脑名和安装实例自动生成；用于把工具请求路由到这台设备</small></span><input aria-label="设备 ID" value={draft.deviceId} disabled={applying || selecting || !view} onChange={e => setDraft({ ...draft, deviceId: e.target.value })} placeholder="电脑名-安装标识" maxLength={128} /></label>
      <div className="settings-field"><span><strong>本机工作区</strong><small>{workspaceOverride ? "由 CODEXIA_WORKSPACE_ROOT 覆盖" : "文件浏览和命令默认使用此目录"}</small></span><div className="runtime-directory-input"><input aria-label="本机工作区" value={workspaceOverride ? view!.effective.workspaceRoot : draft.workspaceRoot} disabled={applying || selecting || workspaceOverride || !view} onChange={e => setDraft({ ...draft, workspaceRoot: e.target.value })} placeholder="选择已有的本机目录" /><button type="button" disabled={applying || selecting || workspaceOverride || !view} onClick={() => void pick()}>{selecting ? "选择中…" : "选择目录"}</button></div></div>
      <p className="runtime-config-hint">本机工作区是 Local Agent 浏览文件及执行命令的默认目录。相对路径以此为起点；选择目录不会自动上传文件，中央机也不会把它当作自己的工作目录。</p>
      {view && <div className="runtime-effective"><strong>当前生效</strong><span>中央网关：<code>{view.uiGatewayUrl}</code></span><span>用户 ID：<code>{view.effective.userId}</code></span><span>设备 ID：<code>{view.effective.deviceId}</code></span><span>Agent 网关：<code>{view.agentGatewayUrl}</code></span><span>本机工作区：<code>{view.effective.workspaceRoot}</code></span><span>Agent 进程：{view.running ? "已启动（设备在线状态见上方）" : "未运行"}</span></div>}
    </div>
    {Boolean(view?.overrides.length) && <p className="settings-warning">开发覆盖已启用：{view!.overrides.join("、")}。退出客户端并移除相应环境变量后，恢复使用已保存配置。</p>}
    <p className="runtime-config-hint">{busy ? "任务、附件处理或文件保存尚未结束，暂时不能切换配置。提交状态不明时请先核对历史。" : changed ? "配置已修改，点击“保存并应用”后生效。" : "保存并应用会重启 Local Agent 并重新连接，下次启动自动恢复。"}</p>
    {(error || pickerError || view?.error) && <p className="settings-error" role="alert">{error || pickerError || view?.error}</p>}
    {notice && <p className="runtime-config-notice" role="status">{notice}</p>}
    <div className="settings-actions"><button type="button" disabled={applying || busy || selecting || !view} onClick={apply}>{applying ? "正在应用配置…" : "保存并应用"}</button><button type="button" className="button-secondary" disabled={applying || selecting} onClick={reload}>{view ? "重新读取配置" : "重试读取配置"}</button></div>
  </>;
}
