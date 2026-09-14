// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

type Release = { current?: boolean; version?: string; notes?: string; ready?: boolean; notice?: string };
type Progress = { stage: "downloading" | "verifying"; received: number; total?: number };
type Phase = "idle" | "checking" | "available" | "current" | "downloading" | "verifying" | "ready" | "installing" | "error";
export function useClientUpdates(scope: string, enabled: boolean) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [release, setRelease] = useState<Release>({});
  const [error, setError] = useState("");
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
    } catch (e) { if (gen === generation.current) {setError(String(e));setPhase("error");} }
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
    } catch(e){if(gen === generation.current){setError(String(e));setPhase("error");}}
    finally{lock.current = false;}
  };
  const install = async () => {
    if(lock.current) return;
    lock.current=true; setPhase("installing");setError("");
    try {await invoke("desktop_update_install");}
    catch(e){setError(String(e));setPhase("error");setRelease(r=>({...r,ready:false}));}
    finally{lock.current=false;}
  };
  return {phase,release,error,progress,check,download,install};
}
export function ClientUpdatePanel({update, version, busy, enabled}: {
  update: ReturnType<typeof useClientUpdates>; version: string; busy: boolean; enabled: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const working = ["checking","downloading","verifying","installing"].includes(update.phase);
  const labels: Record<Phase,string> = {idle:"检查可用的新版本",checking:"正在检查更新…",available:"发现新版本",current:"已是最新版本",downloading:"正在下载更新…",verifying:"正在校验更新包…",ready:"更新已下载，可以安装",installing:"正在安装，即将重启…",error:"更新未完成"};
  const percentage = update.progress?.total ? Math.min(100, Math.floor(update.progress.received / update.progress.total * 100)) : undefined;
  return <section className="settings-section client-update-section">
    <div className="settings-section-heading"><h2>版本更新</h2><p>更新远舟客户端及本机执行组件。</p></div>
    <div className="settings-card form-settings-card">
      <div className="settings-value-row"><span><strong>当前版本</strong><small>远舟</small></span><code>{version}</code></div>
      {!isTauri() ? <p>请在桌面客户端中检查和安装更新。</p> : <>
        {!enabled && <p>完成配对并连接中央后，可检查更新。</p>}
        <p role="status" aria-live="polite">{labels[update.phase]}{update.release.version && ` · ${update.release.version}`}</p>
        {update.release.notice && <p>{update.release.notice}</p>}
        {update.release.notes && <div className="update-notes">{update.release.notes}</div>}
        {update.phase === "downloading" && <div><progress max="100" value={percentage} aria-label="更新下载进度" /><small>{percentage === undefined ? `${((update.progress?.received ?? 0)/1048576).toFixed(1)} MB` : `${percentage}%`}</small></div>}
        {update.error && <p className="update-error" role="alert">{update.error}</p>}
        {busy && update.release.version && <p>有任务、文件操作、待核对结果或未发送草稿时，暂不能安装。完成后可在这里重启升级。</p>}
        <div className="settings-actions">
          <button className="button-secondary" disabled={!enabled || working} onClick={() => void update.check()}>检查更新</button>
          {update.release.version && !update.release.ready && <button disabled={!enabled || working} onClick={() => void update.download()}>{update.phase === "error" ? "重新下载" : "下载更新"}</button>}
          {update.release.ready && <button disabled={!enabled || busy || working} onClick={() => setConfirm(true)}>安装并重启</button>}
        </div>
        {confirm && <div className="update-confirm" role="alertdialog" aria-label="确认安装更新">
          <p>安装将关闭远舟和本机执行组件，完成后重新启动。配对信息、设置和已有对话会保留。</p>
          <div className="settings-actions"><button className="button-secondary" onClick={() => setConfirm(false)}>稍后</button><button disabled={busy || working} onClick={() => {setConfirm(false);void update.install();}}>确认安装并重启</button></div>
        </div>}
      </>}
    </div>
  </section>;
}
