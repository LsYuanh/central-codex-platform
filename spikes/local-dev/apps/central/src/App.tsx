// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState, type ReactNode } from "react";
import { UiIcon } from "../../desktop/src/UiIcon";
import { loadDraft, saveDraft, validateDraft, type DraftErrors, type SetupDraft } from "./setup-draft";
import { nativeAvailable, nativeCall, type NativeContext } from "./native";
import { configToDraft, matchesDraft } from "./central-management";
import { useCentralManagement } from "./use-central-management";
import { NativeConfiguration, RuntimeInspectionPanel } from "./NativeConfiguration";
import { ModelAccounts } from "./ModelAccounts";
import { ServiceControls } from "./ServiceControls";
import { PeopleManagement } from "./PeopleManagement";
import { OverviewMetrics } from "./OverviewMetrics";
import { Diagnostics } from "./Diagnostics";

type Page = "overview" | "setup" | "people" | "models" | "diagnostics";
const navigation: { id: Page; label: string; icon: Parameters<typeof UiIcon>[0]["name"] }[] = [
  { id: "overview", label: "运行概览", icon: "panel" },
  { id: "setup", label: "首次配置", icon: "settings" },
  { id: "people", label: "用户与设备", icon: "monitor" },
  { id: "models", label: "模型接入", icon: "activity" },
  { id: "diagnostics", label: "设置与诊断", icon: "terminal" },
];
const steps = ["中央数据", "连接设置", "模型与检查"];
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warning" | "success" }) {
  return <span className={`badge ${tone}`}><i />{children}</span>;
}
function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className="field"><label>{label}{children}</label>{error ? <p className="field-error" role="alert">{error}</p> : hint && <p className="field-hint">{hint}</p>}</div>;
}

export default function App() {
  const [initial] = useState(loadDraft);
  const [accountId, setAccountId] = useState(() => {
    try { const id = localStorage.getItem("central.selected-model-account"); return id && /^[a-f0-9]{32}$/.test(id) ? id : ""; } catch { return ""; }
  });
  function selectAccount(id: string) {
    setAccountId(id);
    try { localStorage.setItem("central.selected-model-account", id); } catch { /* Selection remains available in this window. */ }
  }
  const [draft, setDraft] = useState(initial.draft);
  const [saved, setSaved] = useState(initial.draft.savedAt ? initial.draft : null);
  const [page, setPage] = useState<Page>("overview");
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [notice, setNotice] = useState(initial.warning ?? "");
  const [context, setContext] = useState<NativeContext | null>(null);
  const [contextError, setContextError] = useState("");
  const [checking, setChecking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [inspectedAt, setInspectedAt] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const management = useCentralManagement();
  const edited = useRef(false);
  const restored = useRef(false);
  const dirty = ["dataDirectory", "host", "port", "clientUrl"].some(key => draft[key as keyof SetupDraft] !== saved?.[key as keyof SetupDraft]);

  useEffect(() => {
    if (!management.loaded || restored.current) return;
    restored.current = true;
    if (management.config && !edited.current) setDraft(configToDraft(management.config));
  }, [management.loaded, management.config]);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    setChecking(true); setContextError("");
    nativeCall<NativeContext>("central_ui_context").then(value => {
      if (!active) return;
      setContext(value); setInspectedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      setDraft(previous => previous.dataDirectory ? previous : { ...previous, dataDirectory: value.dataDirectory });
    }).catch(() => { if (active) { setContext(null); setContextError("无法读取本机应用信息，请重试。"); } })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [refreshKey]);

  function update(key: keyof DraftErrors, value: string) {
    edited.current = true;
    setDraft(previous => ({ ...previous, [key]: value }));
    setErrors(previous => ({ ...previous, [key]: undefined }));
    setNotice("");
  }
  function next() {
    const all = validateDraft(draft);
    const relevant: DraftErrors = step === 0 ? { dataDirectory: all.dataDirectory } : { host: all.host, port: all.port, clientUrl: all.clientUrl };
    setErrors(relevant);
    if (Object.values(relevant).some(Boolean)) return;
    setStep(step + 1);
  }
  function persist() {
    const validation = validateDraft(draft);
    setErrors(validation);
    if (Object.keys(validation).length) { setStep(validation.dataDirectory ? 0 : 1); return; }
    try {
      const value = saveDraft(draft); setSaved(value); setDraft(value);
      setNotice("配置草稿已保存到此应用。服务配置尚未生效；运行管理接通后还需执行完整检查。");
    } catch { setNotice("草稿保存失败，填写内容仍保留在页面中。请检查存储权限后重试。"); }
  }
  async function chooseDirectory() {
    setChoosing(true);
    try { const directory = await nativeCall<string | null>("central_choose_directory", 120000); if (directory) update("dataDirectory", directory); }
    catch { setNotice("未能完成目录选择。可以直接输入绝对路径；若选择窗口仍打开，请先关闭它。"); }
    finally { setChoosing(false); }
  }
  const environment = nativeAvailable ? context?.platform === "win32" ? "Windows · 本机中央端" : context?.platform === "darwin" ? "macOS · 本机中央端" : "本机中央端" : "浏览器预览";
  const runtimeReason = contextError || context?.reason || (nativeAvailable ? "正在读取本机运行管理信息。" : "浏览器预览无法读取本机服务。请在中央管理 App 中完成后续运行检查。");

  return <div className="central-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src={new URL("./assets/logo.svg", import.meta.url).href} width={37} height={37} alt="" /><div><strong>远舟</strong><span>中央管理</span></div></div>
      <div className="workspace-card"><span className="machine-icon"><UiIcon name="monitor" /></span><div><strong>本机中央服务</strong><small>{environment}</small></div></div>
      <p className="nav-label">管理工作台</p>
      <nav aria-label="主导航">{navigation.map(item => <button key={item.id} className={page === item.id ? "nav-item selected" : "nav-item"} aria-current={page === item.id ? "page" : undefined} onClick={() => { setPage(item.id); setNotice(""); }}><UiIcon name={item.icon} /><span>{item.label}</span>{item.id === "setup" && !saved && <span className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-note"><UiIcon name="review" /><span>中央推理 · 客户端执行</span></div><div className="version"><span>远舟中央管理</span><span>0.1 · 开发版</span></div></div>
    </aside>

    <div className="main-shell"><header className="topbar"><div><span>管理工作台</span><span className="slash">/</span><strong>{navigation.find(item => item.id === page)?.label}</strong></div><span className="environment"><i />{environment}</span></header>
      <main>
        {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}><UiIcon name="close" /></button></div>}
        {page === "overview" && <>
          <div className="page-heading"><div><p className="eyebrow">CENTRAL WORKSPACE</p><h1>运行概览</h1><p>在这里配置中央服务，连接团队与设备。</p></div><button className="button secondary" disabled={!nativeAvailable || checking} onClick={() => setRefreshKey(value => value + 1)}><UiIcon name="activity" />{checking ? "读取中…" : "刷新本机信息"}</button></div>
          <section className="welcome-panel"><div className="welcome-copy"><Badge tone="warning">开发验证</Badge><h2>{management.config ? "本机配置已保存" : saved ? "配置草稿已就绪" : "让这台电脑成为团队的中央端"}</h2><p>{management.config ? "选择模型账号，检查完整运行包和证书后，可启动本机验证服务。" : saved ? "页面草稿已保存。请完成本机配置保存，再检查启动条件。" : "先选择数据目录和连接地址，再检查模型与运行环境，为客户端接入做好准备。"}</p><button className="button primary" onClick={() => { setPage("setup"); setStep(0); }}>{management.config ? "查看本机配置" : saved ? "查看配置草稿" : "开始首次配置"}<span aria-hidden="true">→</span></button></div><div className="connection-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="central-node"><UiIcon name="build" /><span>CENTRAL</span></div><div className="satellite sat-one"><UiIcon name="monitor" /></div><div className="satellite sat-two"><UiIcon name="terminal" /></div><div className="satellite sat-three"><UiIcon name="folder" /></div></div></section>
          <OverviewMetrics refreshKey={refreshKey} />
          <div className="overview-grid"><ServiceControls configRevision={management.config?.revision ?? null} accountId={accountId} disabled={!!management.busy} />
          <section className="card checklist"><div className="section-title"><h2>接入准备</h2><span className="caption">{management.config || saved ? "1" : "0"} / 3</span></div><ol><li className={management.config || saved ? "done" : ""}><span className="step-number">{management.config || saved ? <UiIcon name="check" /> : "1"}</span><div><strong>准备中央配置</strong><p>数据目录与客户端连接地址</p><button className="text-button" onClick={() => { setPage("setup"); setStep(0); }}>{management.config ? "编辑本机配置" : saved ? "编辑草稿" : "去配置"} →</button></div></li><li><span className="step-number">2</span><div><strong>接入模型账号</strong><p>使用本机已有 Codex 登录</p><button className="text-button" onClick={() => setPage("models")}>{accountId ? "查看所选账号" : "复用 Codex 登录"} →</button></div></li><li><span className="step-number">3</span><div><strong>检查并启动服务</strong><p>检查运行包、目录与连接条件</p><button className="text-button" onClick={() => setPage("diagnostics")}>查看运行检查 →</button></div></li></ol></section></div>
          <p className="page-footnote">{runtimeReason}</p><p className="page-footnote">{inspectedAt ? `本机应用信息读取于 ${inspectedAt}。` : "尚未取得本机运行状态。"} 服务状态由本机原生管理器读取，模型远程可用性需另行验证。</p>
        </>}

        {page === "setup" && <>
          {management.config && <div className="native-config-banner"><span>本机配置 · 版本 {management.config.revision}{matchesDraft(management.config, draft) ? " · 地址与目录已保存" : " · 当前填写内容有差异"}</span>{!matchesDraft(management.config, draft) && <button className="text-button" disabled={!!management.busy} onClick={() => { setDraft(configToDraft(management.config!)); setErrors({}); setNotice("已载入本机保存的目录和连接地址。"); }}>载入已保存的地址与目录</button>}</div>}
          <div className="page-heading"><div><p className="eyebrow">GET STARTED</p><h1>首次配置</h1><p>为安装此 App 的电脑准备中央配置。</p></div><Badge tone={saved && !dirty ? "success" : "neutral"}>{management.config ? `本机配置 v${management.config.revision}` : saved && !dirty ? "草稿已保存" : "未保存的草稿"}</Badge></div>
          <div className="setup-layout"><div className="setup-main"><ol className="stepper" aria-label="配置步骤">{steps.map((label, index) => <li key={label} className={step === index ? "active" : step > index ? "complete" : ""} aria-current={step === index ? "step" : undefined}><span>{step > index ? <UiIcon name="check" /> : index + 1}</span>{label}</li>)}</ol>
          <section className="card setup-form"><div className="form-heading"><span className="large-icon"><UiIcon name={step === 0 ? "folder" : step === 1 ? "review" : "activity"} /></span><h2>{["中央数据存放在哪里？", "客户端如何连接？", "准备模型接入"][step]}</h2><p>{["请选择用于中央配置与用户历史的本机目录。", "分别设置本机监听地址和提供给客户端的连接地址。", "沿用已确认的方案：使用本机已有 Codex 登录。"][step]}</p></div>
            {step === 0 && <><Field label="中央数据目录" error={errors.dataDirectory} hint="此处记录目录路径，不会创建用户库。保存本机配置后可检查目录状态。"><input value={draft.dataDirectory} onChange={event => update("dataDirectory", event.target.value)} placeholder="例如 C:\Yuanzhou\Central" spellCheck={false} aria-invalid={Boolean(errors.dataDirectory)} /></Field><button className="button secondary" onClick={chooseDirectory} disabled={!nativeAvailable || choosing}><UiIcon name="folder" />{choosing ? "选择窗口已打开…" : "选择本机目录"}</button>{!nativeAvailable && <p className="field-hint">浏览器预览可直接填写路径；系统目录选择仅在桌面 App 中可用。</p>}<div className="info-box"><UiIcon name="file" /><div><strong>为中央数据保留独立空间</strong><p>工作文件仍由各客户端的 Local Agent 读写。正式初始化前，还会检查目录是否已有数据。</p></div></div></>}
            {step === 1 && <><div className="field-columns"><Field label="本机监听地址" hint="填写本机网卡 IP；0.0.0.0 或 :: 表示监听所有对应网卡。客户端连接地址仍须填写可访问的具体地址。" error={errors.host}><input value={draft.host} onChange={event => update("host", event.target.value)} placeholder="例如 192.168.1.20" spellCheck={false} aria-invalid={Boolean(errors.host)} /></Field><Field label="监听端口" error={errors.port}><input value={draft.port} onChange={event => update("port", event.target.value)} inputMode="numeric" aria-invalid={Boolean(errors.port)} /></Field></div><Field label="客户端连接地址" hint="客户端需能访问此地址；后续运行检查还需验证服务器证书。" error={errors.clientUrl}><input value={draft.clientUrl} onChange={event => update("clientUrl", event.target.value)} placeholder="wss://central.example:4510/ws" spellCheck={false} aria-invalid={Boolean(errors.clientUrl)} /></Field><div className="info-box"><UiIcon name="monitor" /><div><strong>让客户端主动连接中央</strong><p>中央网关接收客户端的出站连接。此处填写配置不会开放端口或修改系统网络。</p></div></div></>}
            {step === 2 && <><div className="account-option"><span className="account-logo"><UiIcon name="activity" /></span><div><strong>本机 Codex 登录</strong><p>导入并选择账号后，用于本机验证服务。</p></div><Badge>{accountId ? "已选择" : "待选择"}</Badge></div><div className="review-list"><div><span>数据目录</span><strong>{draft.dataDirectory}</strong></div><div><span>监听地址</span><strong>{draft.host.includes(":") ? `[${draft.host}]` : draft.host}:{draft.port}</strong></div><div><span>客户端地址</span><strong>{draft.clientUrl}</strong></div></div><div className="info-box warning-box"><UiIcon name="activity" /><div><strong>保存配置后，请检查本机环境</strong><p>在下方选择完整运行包、导入证书和模型账号，再到运行概览启动验证服务。</p></div></div></>}
            {step === 2 && <><NativeConfiguration key={management.config?.revision ?? 0} draft={draft} management={management} onOverview={() => setPage("overview")} /><ModelAccounts selectedId={accountId} onSelect={selectAccount} disabled={!!management.busy} /></>}
            <div className="form-actions"><button className="button secondary" disabled={management.busy === "save"} onClick={() => step ? setStep(step - 1) : setPage("overview")}>{step ? "上一步" : "返回概览"}</button>{step < 2 ? <button className="button primary" onClick={next}>下一步 <span aria-hidden="true">→</span></button> : <button className="button secondary" onClick={persist}>仅保存页面草稿</button>}</div>
          </section></div><aside className="setup-aside"><span className="eyebrow">配置说明</span><h3>先准备，再启动</h3><p>这份草稿帮助你确定中央数据和连接方式。</p><div className="aside-rule" /><h4>当前可以完成</h4><p>保存配置、导入证书和模型账号、启停验证服务及管理用户设备。</p><h4>接下来会接通</h4><p>真实模型联调和正式发布验收。</p><div className="aside-rule" /><p className="caption">草稿保存在当前应用的本地存储中，不含账号密码或登录凭据。浏览器预览与桌面 App 的草稿分别保存。</p></aside></div>
        </>}

        {(page === "overview" || page === "diagnostics") && <>
          {page === "diagnostics" && <><div className="page-heading"><div><p className="eyebrow">LOCAL CONFIGURATION</p><h1>设置与诊断</h1><p>查看本机状态、并发设置和诊断报告。</p></div></div><Diagnostics onConfigure={() => { setPage("setup"); setStep(2); }} /></>}
          <RuntimeInspectionPanel management={management} onConfigure={() => { setPage("setup"); setStep(0); }} />
        </>}
        {page === "models" && <><div className="page-heading"><div><p className="eyebrow">MODEL ACCESS</p><h1>模型接入</h1><p>管理中央使用的模型账号。</p></div><Badge>本机安全存储</Badge></div><ModelAccounts selectedId={accountId} onSelect={selectAccount} /><p className="page-footnote">本轮所选账号将作为下次启动服务的默认模型账号，供该服务中已启用的用户使用。切换账号后需停止并重新启动服务。</p></>}
        {page === "people" && <><div className="page-heading"><div><p className="eyebrow">CENTRAL MANAGEMENT</p><h1>用户与设备</h1><p>管理团队接入、设备配对与访问状态。</p></div><Badge>本机服务</Badge></div><PeopleManagement onGoOverview={() => setPage("overview")} /></>}
      </main>
    </div>
  </div>;
}
