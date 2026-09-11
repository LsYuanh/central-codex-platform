// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useCallback, useEffect, useRef, useState } from "react";
import { nativeAvailable, nativeCall } from "./native";
import { publicFailure, failureMessage, readConfigResponse, readInspection, type CentralConfig, type Inspection, type SaveRequest } from "./central-management";

/** Only read contention is retryable; an uncertain write must never enter here. */
export async function readConfigWithBusyRetry<T>(load: () => Promise<T>, active: () => boolean, pause: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))): Promise<T | undefined> {
  const delays = [100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    if (!active()) return undefined;
    try { return await load(); }
    catch (cause) {
      if (publicFailure(cause).code !== "OPERATION_BUSY" || attempt >= delays.length) throw cause;
      await pause(delays[attempt]);
    }
  }
}

export function useCentralManagement() {
  const [config, setConfig] = useState<CentralConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"read" | "save" | "inspect" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [pending, setPending] = useState<SaveRequest | null>(null);
  const [conflict, setConflict] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const read = useCallback(async () => {
    if (!nativeAvailable || lock.current) return;
    lock.current = true; setBusy("read"); setError(""); setMessage("");
    try {
      const result = await readConfigWithBusyRetry(async () => readConfigResponse(await nativeCall("central_config_read")), () => mounted.current);
      if (!result) return;
      if (mounted.current) { setConfig(result.config); setLoaded(true); setInspection(null); setConflict(false); }
    } catch (cause) { if (mounted.current) { setError(failureMessage(cause)); setLoaded(false); } }
    finally { lock.current = false; if (mounted.current) setBusy(null); }
  }, []);
  useEffect(() => { void read(); }, [read]);

  async function submit(request: SaveRequest) {
    if (!nativeAvailable || lock.current) return;
    lock.current = true; setBusy("save"); setError(""); setMessage(""); setInspection(null);
    try {
      const validation = await nativeCall<{ ok: boolean; issues?: { field: string; code: string }[] }>("central_config_validate", 10000, { config: request.config });
      if (validation.ok === false) throw { code: "CONFIG_INVALID", issues: validation.issues };
      if (validation.ok !== true) throw new Error("invalid validation response");
      const result = await nativeCall<{ config: CentralConfig }>("central_config_save", 15000, request);
      const verified = readConfigResponse({ initialized: true, config: result.config }).config!;
      // An idempotent receipt may describe an older revision. Read current disk
      // state before allowing another save, including after a timeout recovery.
      const current = readConfigResponse(await nativeCall("central_config_read")).config;
      if (!current || current.revision < verified.revision) throw new Error("unconfirmed config state");
      if (mounted.current) { setConfig(current); setLoaded(true); setPending(null); setConflict(false); setMessage(current.revision === verified.revision ? `配置已保存到本机，版本 ${verified.revision}。中央服务尚未启动。` : `本次保存已确认；已读取更新后的配置版本 ${current.revision}。请核对当前填写内容。`); }
    } catch (cause) {
      if (mounted.current) {
        const failure = publicFailure(cause);
        setError(failureMessage(cause));
        setPending(["OPERATION_TIMEOUT", "INTERNAL_ERROR", "OPERATION_BUSY"].includes(failure.code) ? request : null);
        setConflict(failure.code === "CONFIG_REVISION_CONFLICT");
      }
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  }
  async function save(value: CentralConfig) {
    if (!loaded || pending || conflict || lock.current) return;
    await submit({ requestId: crypto.randomUUID(), expectedRevision: config?.revision ?? 0, config: value });
  }
  async function inspect() {
    if (!nativeAvailable || !config || pending || conflict || lock.current) return;
    lock.current = true; setBusy("inspect"); setError(""); setMessage(""); setInspection(null);
    try {
      const result = readInspection(await nativeCall("central_runtime_inspect", 60000));
      if (result.configRevision !== config.revision) throw { code: "CONFIG_REVISION_CONFLICT" };
      if (mounted.current) setInspection(result);
    } catch (cause) { if (mounted.current) { setError(publicFailure(cause).code === "OPERATION_TIMEOUT" ? "检查在 60 秒内未完成。请稍后重试；本次检查不会修改配置或启动服务。" : failureMessage(cause)); setConflict(publicFailure(cause).code === "CONFIG_REVISION_CONFLICT"); } }
    finally { lock.current = false; if (mounted.current) setBusy(null); }
  }
  return { config, loaded, busy, error, message, inspection, pending, conflict, read, save, inspect, recover: () => pending ? submit(pending) : Promise.resolve() };
}
export type CentralManagement = ReturnType<typeof useCentralManagement>;
