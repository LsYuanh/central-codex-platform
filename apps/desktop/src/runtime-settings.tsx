// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState, type ReactNode } from "react";
import { PlatformAccountSettings } from "./platform-account-settings";
import { UiIcon } from "./UiIcon";

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

export function RuntimeSettings({ view, draft, setDraft, applying, busy, error, notice, apply, reload, onAuthBoundary, connectionStatus, connectionAction, connectionError }: {
  view?: ConfigView; draft: DesktopConfig; setDraft: (value: DesktopConfig) => void;
  applying: boolean; busy: boolean; error: string; notice: string;
  apply: (config?: DesktopConfig) => Promise<boolean>; reload: () => void;
  onAuthBoundary: () => void;
  connectionStatus?: ReactNode; connectionAction?: ReactNode; connectionError?: string;
}) {
  const [selecting, setSelecting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const draftRef = useRef(draft); draftRef.current = draft;
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
    <section className="settings-section connection-section" aria-labelledby="connection-settings-title">
    <div className="settings-section-heading settings-section-heading-with-action"><h2 id="connection-settings-title">连接与设备</h2>{connectionAction}</div>
    <div className="connection-group">
    {connectionStatus}
    {view?.needsSetup && <p className="runtime-config-notice" role="status">首次使用：粘贴管理员提供的一体配对码，自动配置中央连接。输出目录沿用下方设置。</p>}
    {<PlatformAccountSettings key={gatewayOverride?view!.effective.gatewayUrl:draft.gatewayUrl} gateway={gatewayOverride?view!.effective.gatewayUrl:draft.gatewayUrl} disabled={applying||busy||Boolean(gatewayOverride)||!view} onBundlePaired={async(gatewayUrl,userId,deviceId)=>{const next={...draftRef.current,gatewayUrl,userId,deviceId};setDraft(next);await apply(next);}} onWorkingChange={setAuthorizing} onBoundary={onAuthBoundary} onIdentity={(userId,deviceId)=>setDraft({...draftRef.current,userId,deviceId})}/>}
    </div>
    {connectionError && <p className="settings-error" role="alert">{connectionError}</p>}
    </section>
    <section className="settings-section runtime-output-card" aria-labelledby="output-settings-title">
      <div className="settings-section-heading"><h2 id="output-settings-title">默认输出目录</h2><p>{workspaceOverride ? "由 CODEXIA_WORKSPACE_ROOT 覆盖" : "未指定保存位置时，文档和图片保存到此目录。"}</p></div>
      <div className="runtime-directory-input"><label className="runtime-directory-field"><UiIcon name="folder"/><input aria-label="默认输出目录" value={workspaceOverride ? view!.effective.workspaceRoot : draft.workspaceRoot} disabled={applying || authorizing || selecting || workspaceOverride || !view} onChange={e => setDraft({ ...draft, workspaceRoot: e.target.value })} placeholder="选择已有的本机目录" /></label><button type="button" className="button-secondary" disabled={applying || authorizing || selecting || workspaceOverride || !view} onClick={() => void pick()}>{selecting ? "选择中…" : "选择目录"}</button></div>
      <p className="runtime-config-hint">此目录仅作为默认保存位置，不限制文件访问范围。</p>
      {view && <details className="runtime-effective"><summary>查看当前生效配置</summary><div className="runtime-effective-body"><span>中央网关：<code>{view.uiGatewayUrl}</code></span><span>用户 ID：<code>{view.effective.userId}</code></span><span>设备 ID：<code>{view.effective.deviceId}</code></span><span>Agent 网关：<code>{view.agentGatewayUrl}</code></span><span>默认输出目录：<code>{view.effective.workspaceRoot}</code></span><span>Agent 进程：{view.running ? "已启动（设备在线状态见上方）" : "未运行"}</span></div></details>}
    {Boolean(view?.overrides.length) && <p className="settings-warning">开发覆盖已启用：{view!.overrides.join("、")}。退出客户端并移除相应环境变量后，恢复使用已保存配置。</p>}
    {(error || pickerError || view?.error) && <p className="settings-error" role="alert">{error || pickerError || view?.error}</p>}
    {notice && <p className="runtime-config-notice" role="status">{notice}</p>}
    <div className="runtime-save-row"><p className="runtime-config-hint">{busy ? "任务、附件处理或文件保存尚未结束，暂时不能切换配置。提交状态不明时请先核对历史。" : changed ? "配置已修改，点击“保存并应用”后生效。" : "保存后重新连接设备，任务运行时不可修改。"}</p><div className="settings-actions"><button type="button" className="button-secondary" disabled={applying || authorizing || selecting} onClick={reload}>{view ? "重新读取配置" : "重试读取配置"}</button><button type="button" className="runtime-save-button" disabled={applying || authorizing || busy || selecting || !view} onClick={()=>void apply()}>{applying ? "正在应用配置…" : "保存并应用"}</button></div></div>
    </section>
  </>;
}
