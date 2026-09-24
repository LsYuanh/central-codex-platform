// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { nativeText } from "./native-invoke";
import { t, useLocale, errorMessage, useMessageState } from "./i18n";

import { invoke } from "./native-invoke";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { UiIcon } from "./UiIcon";

type Release = { current?: boolean; version?: string; notes?: string; ready?: boolean; notice?: string };
type Progress = { stage: "downloading" | "verifying"; received: number; total?: number };
type Phase = "idle" | "checking" | "available" | "current" | "downloading" | "verifying" | "ready" | "installing" | "error";
export function useClientUpdates(scope: string, enabled: boolean) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [release, setRelease] = useState<Release>({});
  const [error, setError] = useMessageState("");
  const [progress, setProgress] = useState<Progress>();
  const lock = useRef(false), generation = useRef(0);
  const check = useCallback(async () => {
    if (lock.current || !isTauri()) return;
    lock.current = true; const gen = generation.current;
    setPhase("checking"); setError("");
    try {
      const next = await invoke<Release>("desktop_update_check");
      if (gen !== generation.current) return;
      setRelease(next); setPhase(next.current ? "current" : next.ready ? "ready" : "available");
    } catch (e) { if (gen === generation.current) {setError(errorMessage(e));setPhase("error");} }
    finally {lock.current = false;}
  }, []);
  useEffect(() => {
    generation.current++; setRelease({}); setError(""); setPhase("idle");
    if (!enabled || !isTauri()) return;
    const timer = window.setTimeout(() => void check(), 3000);
    return () => {window.clearTimeout(timer);generation.current++;};
  }, [scope, enabled, check]);
  const download = async () => {
    if (lock.current) return;
    lock.current = true; const gen = generation.current;
    setPhase("downloading"); setError(""); setProgress(undefined);
    const onEvent = new Channel<Progress>();
    onEvent.onmessage = event => {if(gen === generation.current){setProgress(event);setPhase(event.stage);}};
    try {
      const next = await invoke<Release>("desktop_update_download", {onEvent});
      if(gen === generation.current){setRelease(next);setPhase("ready");}
    } catch(e){if(gen === generation.current){setError(errorMessage(e));setPhase("error");}}
    finally{lock.current = false;}
  };
  const install = async () => {
    if(lock.current) return;
    lock.current=true; setPhase("installing");setError("");
    try {await invoke("desktop_update_install");}
    catch(e){setError(errorMessage(e));setPhase("error");setRelease(r=>({...r,ready:false}));}
    finally{lock.current=false;}
  };
  return {phase,release,error,progress,check,download,install};
}
export function SidebarSettingsRow({release, openSettings, openUpdates, previewAvailable = false}: {
  release: Release; openSettings: () => void; openUpdates: () => void; previewAvailable?: boolean;
}) {
  useLocale();
  const available = !release.current && Boolean(release.version || release.ready);
  const preview = previewAvailable && !available;
  return <div className={`sidebar-settings-row${available || preview ? " has-update" : ""}`}>
    <button type="button" className="sidebar-settings-button" onClick={openSettings}><UiIcon name="settings" /><span>{t("设置")}</span></button>
    {(available || preview) && <button type="button" className="sidebar-update-button" onClick={openUpdates}
      aria-label={preview ? t("更新（开发预览）") : release.version ? t("更新：新版本 {{p0}}", { p0: release.version }) : t("更新：更新包已就绪")} title={preview ? t("更新（开发预览）") : t("查看版本更新")}>
      <UiIcon name="download" /><span aria-hidden="true">{t("更新")}</span>
    </button>}
  </div>;
}

export function ClientUpdatePanel({update, version, busy, enabled}: {
  update: ReturnType<typeof useClientUpdates>; version: string; busy: boolean; enabled: boolean;
}) {
  useLocale();
  const [confirm, setConfirm] = useState(false);
  const working = ["checking","downloading","verifying","installing"].includes(update.phase);
  const labels: Record<Phase,string> = {idle:t("检查可用的新版本"),checking:t("正在检查更新…"),available:t("发现新版本"),current:t("已是最新版本"),downloading:t("正在下载更新…"),verifying:t("正在校验更新包…"),ready:t("更新已下载，可以安装"),installing:t("正在安装，即将重启…"),error:t("更新未完成")};
  const percentage = update.progress?.total ? Math.min(100, Math.floor(update.progress.received / update.progress.total * 100)) : undefined;
  const desktop = isTauri();
  return <div className="client-update-page">
    <header className="settings-header"><div><h1>{t("版本更新")}</h1><p>{t("检查并更新远舟客户端及本机执行组件。")}</p></div>
      <button className="button-secondary update-check-button" aria-label={t("检查更新")} disabled={!desktop || !enabled || working} onClick={() => void update.check()}><UiIcon name="refresh"/>{update.phase === "checking" ? t("检查中…") : t("检查更新")}</button>
    </header>
    <div className="settings-content"><section className="settings-section client-update-section" aria-label={t("客户端版本")}>
      <div className="update-version-row"><div className="update-version-label"><strong>{t("当前版本")}</strong><code>{version}</code></div>
        {desktop && <p className={`update-status${enabled && update.phase === "current" ? " is-current" : ""}`} role="status" aria-live="polite">{enabled ? labels[update.phase] : t("连接后检查更新")}</p>}
      </div>
      {!desktop ? <p className="update-help">{t("请在桌面客户端中检查和安装更新。")}</p> : <>
        {!enabled && <p className="update-help">{t("完成配对并连接中央后，可检查更新。")}</p>}
        {update.release.notice && <p className="update-help">{nativeText(update.release.notice)}</p>}
        {(update.release.version || update.release.ready) && <div className="update-release">
          <div className="update-release-heading"><h2>{update.release.version ? <>{t("新版本 ")}<code>{update.release.version}</code></> : t("更新包已就绪")}</h2><div className="settings-actions">
            {!update.release.ready && <button className="button-secondary" disabled={!enabled || working} onClick={() => void update.download()}>{update.phase === "error" ? t("重新下载") : t("下载更新")}</button>}
            {update.release.ready && <button className="button-secondary update-install-button" disabled={!enabled || busy || working} onClick={() => setConfirm(true)}>{t("安装并重启")}</button>}
          </div></div>
        </div>}
        {update.release.notes && <div className="update-notes">{update.release.notes}</div>}
        {update.phase === "downloading" && <div className="update-download-progress"><progress max="100" value={percentage} aria-label={t("更新下载进度")} /><small>{percentage === undefined ? `${((update.progress?.received ?? 0)/1048576).toFixed(1)} MB` : `${percentage}%`}</small></div>}
        {update.error && <p className="update-error" role="alert">{update.error}</p>}
        {busy && update.release.version && <p className="update-help">{t("有任务、文件操作、待核对结果或未发送草稿时，暂不能安装。完成后可在这里重启升级。")}</p>}
        {confirm && <div className="update-confirm" role="alertdialog" aria-label={t("确认安装更新")}>
          <p>{t("安装将关闭远舟和本机执行组件，完成后重新启动。配对信息、设置和已有对话会保留。")}</p>
          <div className="settings-actions"><button className="button-secondary" onClick={() => setConfirm(false)}>{t("稍后")}</button><button className="button-secondary update-install-button" disabled={busy || working} onClick={() => {setConfirm(false);void update.install();}}>{t("确认安装并重启")}</button></div>
        </div>}
      </>}
    </section></div>
  </div>;
}
