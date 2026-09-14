// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { PlatformAccountSettings } from "./platform-account-settings";

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

export function RuntimeSettings({ view, draft, setDraft, applying, busy, error, notice, apply, reload, onAuthBoundary }: {
  view?: ConfigView; draft: DesktopConfig; setDraft: (value: DesktopConfig) => void;
  applying: boolean; busy: boolean; error: string; notice: string;
  apply: (config?: DesktopConfig) => Promise<void>; reload: () => void;
  onAuthBoundary: () => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const draftRef = useRef(draft); draftRef.current = draft;
  const gatewayOverride = view?.overrides.includes("CODEXIA_GATEWAY_AGENT_URL");
  const workspaceOverride = view?.overrides.includes("CODEXIA_WORKSPACE_ROOT");
  const secure=(gatewayOverride?view!.effective.gatewayUrl:draft.gatewayUrl).startsWith("wss://");
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
    {view?.needsSetup && <p className="runtime-config-notice" role="status">首次使用：粘贴管理员提供的一体配对码，自动配置中央连接。输出目录沿用下方设置。</p>}
    <details><summary>高级：手动设置中央地址</summary>
    <div className="settings-card form-settings-card runtime-config-card">
      <label className="settings-field settings-field-long"><span><strong>中央网关地址</strong><small>{gatewayOverride ? "由 CODEXIA_GATEWAY_AGENT_URL 覆盖" : "填写管理员提供的 wss:// 中央地址"}</small></span><input aria-label="中央网关地址" value={gatewayOverride ? view!.effective.gatewayUrl : draft.gatewayUrl} disabled={applying || authorizing || selecting || gatewayOverride || !view} onChange={e => setDraft({ ...draft, gatewayUrl: e.target.value })} placeholder="wss://central.example.com/ws" /></label>
    </div>
    </details>
    {<PlatformAccountSettings key={gatewayOverride?view!.effective.gatewayUrl:draft.gatewayUrl} gateway={gatewayOverride?view!.effective.gatewayUrl:draft.gatewayUrl} disabled={applying||busy||Boolean(gatewayOverride)||!view} onBundlePaired={async(gatewayUrl,userId,deviceId)=>{const next={...draftRef.current,gatewayUrl,userId,deviceId};setDraft(next);await apply(next);}} onWorkingChange={setAuthorizing} onBoundary={onAuthBoundary} onIdentity={(userId,deviceId)=>setDraft({...draftRef.current,userId,deviceId})}/>}
    <div className="settings-card form-settings-card runtime-config-card">
      {!secure&&<details><summary>高级：旧版身份设置</summary><label className="settings-field"><span><strong>用户 ID</strong><small>按当前系统登录用户名自动填写；同一用户可在不同设备使用相同值</small></span><input aria-label="用户 ID" value={draft.userId} disabled={applying || authorizing || selecting || !view} onChange={e => setDraft({ ...draft, userId: e.target.value })} placeholder="当前系统用户名" maxLength={128} /></label>
      <label className="settings-field"><span><strong>设备 ID</strong><small>按电脑名和安装实例自动生成；用于把工具请求路由到这台设备</small></span><input aria-label="设备 ID" value={draft.deviceId} disabled={applying || authorizing || selecting || !view} onChange={e => setDraft({ ...draft, deviceId: e.target.value })} placeholder="电脑名-安装标识" maxLength={128} /></label></details>}
      <div className="settings-field settings-field-long"><span><strong>默认输出目录</strong><small>{workspaceOverride ? "由 CODEXIA_WORKSPACE_ROOT 覆盖" : "未指定保存位置时，生成的文档和图片保存到此目录"}</small></span><div className="runtime-directory-input"><input aria-label="默认输出目录" value={workspaceOverride ? view!.effective.workspaceRoot : draft.workspaceRoot} disabled={applying || authorizing || selecting || workspaceOverride || !view} onChange={e => setDraft({ ...draft, workspaceRoot: e.target.value })} placeholder="选择已有的本机目录" /><button type="button" disabled={applying || authorizing || selecting || workspaceOverride || !view} onClick={() => void pick()}>{selecting ? "选择中…" : "选择目录"}</button></div></div>
      <p className="runtime-config-hint">此目录用于默认保存生成的文档和图片，不限制文件访问范围。你可以直接指定其他项目或文件路径，访问权限由本机系统账号决定。</p>
      {view && <details className="runtime-effective"><summary>查看当前生效配置</summary><div className="runtime-effective-body"><span>中央网关：<code>{view.uiGatewayUrl}</code></span><span>用户 ID：<code>{view.effective.userId}</code></span><span>设备 ID：<code>{view.effective.deviceId}</code></span><span>Agent 网关：<code>{view.agentGatewayUrl}</code></span><span>默认输出目录：<code>{view.effective.workspaceRoot}</code></span><span>Agent 进程：{view.running ? "已启动（设备在线状态见上方）" : "未运行"}</span></div></details>}
    </div>
    {Boolean(view?.overrides.length) && <p className="settings-warning">开发覆盖已启用：{view!.overrides.join("、")}。退出客户端并移除相应环境变量后，恢复使用已保存配置。</p>}
    <p className="runtime-config-hint">{busy ? "任务、附件处理或文件保存尚未结束，暂时不能切换配置。提交状态不明时请先核对历史。" : changed ? "配置已修改，点击“保存并应用”后生效。" : "保存并应用会重启 Local Agent 并重新连接，下次启动自动恢复。"}</p>
    {(error || pickerError || view?.error) && <p className="settings-error" role="alert">{error || pickerError || view?.error}</p>}
    {notice && <p className="runtime-config-notice" role="status">{notice}</p>}
    <div className="settings-actions"><button type="button" disabled={applying || authorizing || busy || selecting || !view} onClick={()=>void apply()}>{applying ? "正在应用配置…" : "保存并应用"}</button><button type="button" className="button-secondary" disabled={applying || authorizing || selecting} onClick={reload}>{view ? "重新读取配置" : "重试读取配置"}</button></div>
  </>;
}
