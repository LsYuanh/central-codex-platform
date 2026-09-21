// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from "react";
import { nativeAvailable } from "./native";
import type { SetupDraft } from "./setup-draft";
import { validateDraft } from "./setup-draft";
import { configSaveBlock, matchesDraft, type CentralConfig } from "./central-management";
import { getServiceSnapshot, type ServiceSnapshot } from "./service-client";
import type { CentralManagement } from "./use-central-management";
import { ResourceSelection } from "./ResourceSelection";

export function ManagementFeedback({ management }: { management: CentralManagement }) {
  return <>
    {management.error && <div className="management-error" role="alert"><p>{management.error}</p><div className="button-row">
      {management.pending ? <button className="button secondary" disabled={!!management.busy} onClick={() => void management.recover()}>核对上次保存结果</button> : <button className="button secondary" disabled={!!management.busy} onClick={() => void management.read()}>重新读取本机配置</button>}
    </div></div>}
    {management.message && <p className="management-success" role="status">{management.message}</p>}
  </>;
}

export function NativeConfiguration({ draft, management, onOverview }: { draft: SetupDraft; management: CentralManagement; onOverview: () => void }) {
  const stored = management.config;
  const [certificateId, setCertificateId] = useState(stored?.tls.certificateId ?? "");
  const [packageId, setPackageId] = useState(stored?.runtimePackageId ?? "");
  const [maxWorkers, setMaxWorkers] = useState(String(stored?.limits.maxWorkers ?? 8));
  const [perUserTurns, setPerUserTurns] = useState(String(stored?.limits.perUserTurns ?? 2));
  const [totalTurns, setTotalTurns] = useState(String(stored?.limits.totalTurns ?? 8));
  const [formError, setFormError] = useState("");
  const [resourceBusy, setResourceBusy] = useState(false);
  const [service, setService] = useState<ServiceSnapshot | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const active = useRef(false), statusLock = useRef(false);
  const saveBlock = configSaveBlock(service);
  async function refreshService() {
    if (!nativeAvailable || statusLock.current) return;
    statusLock.current = true; setStatusBusy(true);
    try { const value = await getServiceSnapshot(); if (active.current) setService(value); }
    catch { if (active.current) setService(null); }
    finally { statusLock.current = false; if (active.current) setStatusBusy(false); }
  }
  useEffect(() => {
    active.current = true; void refreshService();
    const timer = window.setInterval(() => void refreshService(), 5000);
    return () => { active.current = false; window.clearInterval(timer); };
  }, []);
  async function save() {
    if (saveBlock) return;
    if (Object.keys(validateDraft(draft)).length) { setFormError("前两步的配置仍有错误，请返回检查。"); return; }
    const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
    if (!id.test(certificateId) || !id.test(packageId)) { setFormError("请填写证书和运行包标识，仅使用字母、数字、点、短横线或下划线，最多 101 字符。"); return; }
    const limits = { maxWorkers: Number(maxWorkers), perUserTurns: Number(perUserTurns), totalTurns: Number(totalTurns) };
    if (![maxWorkers, perUserTurns, totalTurns].every(value => /^\d+$/.test(value)) ||
      ![limits.maxWorkers, limits.perUserTurns, limits.totalTurns].every(value => Number.isInteger(value) && value >= 1 && value <= 128) ||
      limits.perUserTurns > 32 || limits.perUserTurns > limits.totalTurns) { setFormError("并发值须为正整数：运行进程和总任务最多 128，每用户最多 32 且不超过总任务数。"); return; }
    setFormError("");
    const config: CentralConfig = {
      schemaVersion: 1, revision: stored?.revision ?? 0, dataDirectory: draft.dataDirectory.trim(),
      listen: { host: draft.host.trim(), port: Number(draft.port) }, clientUrl: draft.clientUrl.trim(),
      tls: { certificateId }, runtimePackageId: packageId, limits,
      shutdown: stored?.shutdown ?? { graceMs: 10000, forceMs: 5000 },
    };
    await management.save(config);
  }
  return <section className="native-configuration">
    <h3>保存到本机配置文件</h3><p className="field-hint">配置将由桌面 App 独立保存。保存后可检查环境，不会创建用户库或启动服务。</p>
    {!nativeAvailable ? <div className="info-box"><p>浏览器只能保存草稿。本机配置与运行检查请在中央管理桌面 App 中操作。</p></div> : <>
      {saveBlock && <div className="info-box" role="status"><div><p>{saveBlock}</p><div className="button-row"><button className="button secondary" onClick={onOverview}>前往运行概览</button><button className="button secondary" disabled={statusBusy} onClick={() => void refreshService()}>{statusBusy ? "正在读取状态…" : "刷新服务状态"}</button></div></div></div>}
      <fieldset disabled={!!management.busy || !!management.pending || !management.loaded || management.conflict}>
        <ResourceSelection clientUrl={draft.clientUrl.trim()} certificateId={certificateId} packageId={packageId} onCertificate={setCertificateId} onPackage={setPackageId} onBusy={setResourceBusy} />
        <p className="field-hint">保存会记录所选资源的引用。服务启动前仍需完成全部运行条件检查。</p>
        <div className="limit-fields"><label className="native-field">最多运行进程<input value={maxWorkers} onChange={event => setMaxWorkers(event.target.value)} inputMode="numeric" /></label><label className="native-field">每用户任务数<input value={perUserTurns} onChange={event => setPerUserTurns(event.target.value)} inputMode="numeric" /></label><label className="native-field">总任务数<input value={totalTurns} onChange={event => setTotalTurns(event.target.value)} inputMode="numeric" /></label></div>
        {formError && <p className="field-error" role="alert">{formError}</p>}
        <button className="button primary" disabled={resourceBusy || !!saveBlock} onClick={() => void save()}>{management.busy === "save" ? "保存中…" : "保存本机配置"}</button>
      </fieldset>
      <p className="field-hint">{stored ? `当前本机配置版本 ${stored.revision}。${matchesDraft(stored, draft) ? "" : "当前填写内容与已保存配置不同。"}` : management.loaded ? "尚未保存本机配置。" : "本机配置尚未读取完成。"}</p>
      <ManagementFeedback management={management} />
    </>}
  </section>;
}

const checkLabels = { package: "中央运行包", system: "操作系统", port: "监听地址与端口", tls: "服务器证书", directory: "中央数据目录", isolation: "用户进程隔离" };
export function RuntimeInspectionPanel({ management, onConfigure }: { management: CentralManagement; onConfigure: () => void }) {
  return <section className="card inspection-panel">
    <div className="section-title"><h2>启动前检查</h2><button className="button secondary" disabled={!nativeAvailable || !management.config || !!management.busy || !!management.pending || management.conflict} onClick={() => void management.inspect()}>{management.busy === "inspect" ? "正在检查…" : "检查本机环境"}</button></div>
    <p className="section-description">检查已保存的本机配置。单项检查通过不代表中央服务或模型已经可用。</p>
    {!management.config && <p className="field-hint">{nativeAvailable ? "先保存本机配置，再检查启动条件。" : "本机检查仅在桌面 App 中可用。"}<button className="text-button" onClick={onConfigure}> 前往首次配置 →</button></p>}
    {management.config && <div className="inspection-config"><span>配置版本 {management.config.revision}</span><span>{management.config.clientUrl}</span></div>}
    {management.inspection ? <>
      <div className="inspection-result" role="status">{management.inspection.checks.some(check => check.state === "failed") ? "发现待处理项" : "基础检查已返回"} · 完整启动条件尚未满足</div>
      <div className="inspection-checks">{management.inspection.checks.map(check => <div className="inspection-check" key={check.component}><div><strong>{checkLabels[check.component]}</strong><span className={`check-state ${check.state}`}>{check.state === "passed" ? "通过" : check.state === "failed" ? "需处理" : "未检查"}</span></div><p>{check.message ?? "此项检查未提供详细说明。"}</p></div>)}</div>
      <p className="page-footnote">检查于 {new Date(management.inspection.inspectedAt).toLocaleString("zh-CN", { hour12: false })} · 仅对应配置版本 {management.inspection.configRevision}；地址或环境变化后需重新检查。</p>
    </> : management.config && <p className="field-hint">尚无本次检查结果。</p>}
    <ManagementFeedback management={management} />
  </section>;
}
