// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { invoke } from '@tauri-apps/api/core';
import { readServiceMetrics, type ServiceMetrics, type ServiceSnapshot } from './service-client';

export type DiagnosticsReport = {
  schemaVersion: 1; generatedAt: number; appVersion: string; platform: 'windows' | 'macos' | 'other';
  configuration: {
    status: 'available' | 'missing' | 'unavailable'; revision: number | null;
    limits: { maxWorkers: number; perUserTurns: number; totalTurns: number } | null;
    shutdown: { graceMs: number; forceMs: number } | null;
    runtimeSelected: boolean; certificateSelected: boolean; errorCode: string | null;
  };
  service: {
    state: ServiceSnapshot['state']; generation: number; sequence: number; observedAt: number;
    cleanupVerified: boolean; forcedStop: boolean; failureCode: string | null;
    metricsStatus: 'fresh' | 'missing' | 'stale' | 'inactive'; metrics: ServiceMetrics | null;
  };
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const invalid = () => ({ code: 'UI_PROTOCOL_INVALID' });
// Every error displayed or included in the preview is a fixed public identifier.
const errorMessages: Record<string, string> = {
  INTERNAL_ERROR: '本机操作未完成，请重新采集诊断信息。',
  OPERATION_BUSY: '本机另一个操作尚未结束，请稍后重试。',
  UI_PROTOCOL_INVALID: '诊断接口返回的内容不兼容，请检查应用版本。',
  CONFIG_INVALID: '本机配置不完整，请打开本机配置核对并保存。',
  CONFIG_VERSION_UNSUPPORTED: '配置格式与应用版本不兼容，请核对应用和配置版本。',
  CONFIG_STORAGE_UNSAFE: '本机配置未通过安全检查，请检查配置存储权限。',
  CONFIG_STORAGE_INVALID: '本机配置内容无法读取，请检查本机配置。',
  CONFIG_STORAGE_FULL: '本机配置存储已满，请检查可用空间。',
  SERVICE_START_TIMEOUT: '服务启动超时，请核对运行包、配置和进程清理结果。',
  SERVICE_STOP_TIMEOUT: '服务未能按期停止，请核对强制退出和清理结果。',
  SERVICE_UNEXPECTED_EXIT: '服务意外退出，请核对配置和运行包，再重新启动。',
  SERVICE_CLEANUP_UNVERIFIED: '进程退出尚未确认，请先核对清理结果。',
  SERVICE_APP_CLOSING: '应用正在退出，请等待本机服务清理。',
  SERVICE_METRICS_INVALID: '运行统计未通过校验，请检查应用与运行包版本。',
  SERVICE_PROTOCOL_INVALID: '服务协议未通过校验，请检查完整运行包。',
  SERVICE_CONTROL_CLOSED: '服务控制通道已关闭，请核对服务状态。',
  SERVICE_SPAWN_FAILED: '服务进程启动失败，请检查本机配置和运行包。',
  SERVICE_STATE_FAILED: '服务状态无法确认，请刷新报告后核对。',
  SERVICE_ALREADY_ACTIVE: '服务已启动或正在启动，请刷新报告核对。',
  SERVICE_GENERATION_LIMIT: '本次会话的服务启动次数已达上限，请正常退出应用后重新打开。',
  SERVICE_ACTOR_UNAVAILABLE: '本机服务管理不可用，请正常退出应用后重新打开。',
  SERVICE_SPEC_INVALID: '启动配置未通过校验，请核对本机配置。',
  SERVICE_BOOTSTRAP_INVALID: '服务初始化配置未通过校验，请核对运行包。',
  SERVICE_ENV_INVALID: '服务启动环境未通过校验，请核对运行包。',
  SERVICE_FORCED_STOP: '服务已强制退出，请确认进程清理后再启动。',
  SERVICE_GATEWAY_FAILED: '中央网关运行失败，请核对配置与运行包。',
  SERVICE_EXIT_FAILED: '服务退出时发生错误，请确认进程清理状态。',
  SERVICE_DESCENDANTS_REMAINED: '服务退出后仍检测到子进程，请先确认清理完成。',
  SERVICE_CLEANUP_UNCONFIRMED: '服务进程清理尚未确认，请核对状态后再启动。',
  SERVICE_PLATFORM_UNSUPPORTED: '当前系统暂不支持此服务启动方式。',
  SERVICE_RANDOM_FAILED: '无法生成服务实例信息，请重新启动应用后重试。',
  SERVICE_NATIVE_HANDLE_FAILED: '本机进程控制初始化失败，请核对系统权限后重试。',
  SERVICE_PIPE_FAILED: '本机服务通信通道创建失败，请重新启动应用后重试。',
  SERVICE_JOB_ATTACH_FAILED: '服务进程托管失败，请核对系统权限和进程清理状态。',
  SERVICE_JOB_FAILED: '本机进程托管初始化失败，请核对系统权限后重试。',
  SERVICE_RESUME_FAILED: '服务进程无法继续启动，请确认清理状态后重试。',
  SERVICE_WRITER_FAILED: '服务控制通道写入失败，请核对进程清理状态。',
  SERVICE_CONTROL_FRAME_LIMIT: '服务控制消息超出允许大小，请核对运行包版本。',
  SERVICE_BOOTSTRAP_WRITE_FAILED: '服务初始化配置发送失败，请确认清理状态后重试。',
  SERVICE_DATA_UNSAFE: '服务数据目录无法安全访问，请检查专用目录。',
  SERVICE_JOURNAL_UNSAFE: '服务操作记录无法安全读取，请检查本机存储。',
  SHUTDOWN_INCOMPLETE: '服务退出尚未完全确认，请继续核对状态。',
  PORT_IN_USE: '监听端口已被占用，请打开本机配置检查端口。',
  TLS_INVALID: '服务证书不可用，请打开本机配置重新检查证书。',
  RUNTIME_MISSING: '服务运行包缺失，请检查完整运行包。',
  RUNTIME_HASH_MISMATCH: '运行包校验失败，请检查完整运行包。',
  RUNTIME_PLATFORM_MISMATCH: '所选运行包不支持当前系统，请核对运行包。',
  DIAGNOSTICS_EXPORT_FAILED: '诊断文件未能保存，请重新选择可写位置。',
  DIAGNOSTICS_TARGET_EXISTS: '目标文件已存在，请选择新的文件名。已有文件未覆盖。',
  DIAGNOSTICS_EXPORT_UNSAFE: '所选保存位置未通过安全检查，请选择新的本机 JSON 文件。',
};
function safeCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid();
  return Object.hasOwn(errorMessages, value) ? value : 'INTERNAL_ERROR';
}
export function diagnosticsMessage(value: unknown): string {
  const code = typeof value === 'string' ? value : record(value) ? value.code : null;
  return typeof code === 'string' && Object.hasOwn(errorMessages, code) ? errorMessages[code] : errorMessages.INTERNAL_ERROR;
}
export function readDiagnosticsReport(value: unknown): DiagnosticsReport {
  if (!record(value) || value.schemaVersion !== 1 || !integer(value.generatedAt, 1) || typeof value.appVersion !== 'string' ||
      !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value.appVersion) || !['windows', 'macos', 'other'].includes(String(value.platform)) ||
      !record(value.configuration) || !record(value.service)) throw invalid();
  const c = value.configuration, s = value.service;
  if (!['available', 'missing', 'unavailable'].includes(String(c.status)) || typeof c.runtimeSelected !== 'boolean' || typeof c.certificateSelected !== 'boolean') throw invalid();
  let limits: DiagnosticsReport['configuration']['limits'] = null, shutdown: DiagnosticsReport['configuration']['shutdown'] = null;
  const errorCode = safeCode(c.errorCode), failureCode = safeCode(s.failureCode);
  if (c.status === 'available') {
    if (!integer(c.revision, 1) || !record(c.limits) || !record(c.shutdown) || errorCode !== null ||
        !integer(c.limits.maxWorkers, 1, 128) || !integer(c.limits.perUserTurns, 1, 32) || !integer(c.limits.totalTurns, 1, 128) || c.limits.perUserTurns > c.limits.totalTurns ||
        !integer(c.shutdown.graceMs, 0, 60000) || !integer(c.shutdown.forceMs, 1000, 15000)) throw invalid();
    limits = { maxWorkers: c.limits.maxWorkers, perUserTurns: c.limits.perUserTurns, totalTurns: c.limits.totalTurns };
    shutdown = { graceMs: c.shutdown.graceMs, forceMs: c.shutdown.forceMs };
  } else if (c.revision !== null || c.limits !== null || c.shutdown !== null || c.runtimeSelected || c.certificateSelected ||
      (c.status === 'missing' && errorCode !== null) || (c.status === 'unavailable' && errorCode === null)) throw invalid();
  if (!['stopped', 'starting', 'running', 'stopping', 'failed'].includes(String(s.state)) || !integer(s.generation) || !integer(s.sequence) || !integer(s.observedAt, 1) ||
      s.observedAt > value.generatedAt || typeof s.cleanupVerified !== 'boolean' || typeof s.forcedStop !== 'boolean' ||
      !['fresh', 'missing', 'stale', 'inactive'].includes(String(s.metricsStatus))) throw invalid();
  const metrics = s.metrics === null ? null : readServiceMetrics(s.metrics);
  if (s.state !== 'running') {
    if (s.metricsStatus !== 'inactive' || metrics !== null) throw invalid();
  } else if (s.metricsStatus === 'inactive' || (s.metricsStatus === 'fresh') !== (metrics !== null)) throw invalid();
  if (metrics && (s.failureCode !== null || s.cleanupVerified || s.forcedStop || metrics.observedAt > value.generatedAt || value.generatedAt - metrics.observedAt > 10000)) throw invalid();
  return { schemaVersion: 1, generatedAt: value.generatedAt, appVersion: value.appVersion, platform: value.platform as DiagnosticsReport['platform'],
    configuration: { status: c.status as DiagnosticsReport['configuration']['status'], revision: c.revision as number | null,
      limits, shutdown, runtimeSelected: c.runtimeSelected, certificateSelected: c.certificateSelected, errorCode },
    service: { state: s.state as ServiceSnapshot['state'], generation: s.generation, sequence: s.sequence, observedAt: s.observedAt,
      cleanupVerified: s.cleanupVerified, forcedStop: s.forcedStop, failureCode, metricsStatus: s.metricsStatus as DiagnosticsReport['service']['metricsStatus'], metrics } };
}

type Flight<T> = { promise: Promise<T>; startedAt: number };
export function createDiagnosticsFlight<T>(run: () => Promise<T>, now: () => number = Date.now) {
  let current: Flight<T> | null = null;
  return {
    current: () => current,
    start() {
      if (!current) {
        const flight = { startedAt: now(), promise: Promise.resolve().then(run).finally(() => { if (current === flight) current = null; }) };
        current = flight;
      }
      return current;
    },
  };
}
const readFlight = createDiagnosticsFlight(() => invoke<unknown>('central_diagnostics_read').then(readDiagnosticsReport));
const exportFlight = createDiagnosticsFlight(() => invoke<unknown>('central_diagnostics_export').then(value => {
  if (typeof value !== 'boolean') throw invalid();
  return value;
}));
export type DiagnosticsState = {
  report: DiagnosticsReport | null; reading: boolean; readPending: boolean; readError: string;
  exportPending: boolean; exportStatus: 'idle' | 'saving' | 'timeout' | 'saved' | 'cancelled' | 'failed'; exportMessage: string;
};
export const initialDiagnosticsState = (): DiagnosticsState => ({ report: null, reading: false, readPending: false, readError: '', exportPending: false, exportStatus: 'idle', exportMessage: '' });
// Actual promises are shared across views. A UI timeout cannot release the lock
// or open another save dialog. This observer owns only its display and timers.
export function createDiagnosticsSession(options: {
  update: (value: DiagnosticsState) => void;
  read?: ReturnType<typeof createDiagnosticsFlight<DiagnosticsReport>>;
  export?: ReturnType<typeof createDiagnosticsFlight<boolean>>;
  now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}) {
  const read = options.read ?? readFlight, save = options.export ?? exportFlight, now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  let active = true, state = initialDiagnosticsState();
  let readTimer: ReturnType<typeof setTimeout> | undefined, saveTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => { if (active) options.update({ ...state }); };
  const observeExport = (flight: Flight<boolean>) => {
    if (!active || state.exportPending) return;
    state = { ...state, exportPending: true, exportStatus: 'saving', exportMessage: '请在本机保存窗口选择 JSON 文件位置。' }; publish();
    saveTimer = setTimer(() => {
      if (!active) return;
      state = { ...state, exportStatus: 'timeout', exportMessage: '导出等待超过 120 秒，结果尚未确认。请处理已打开的保存窗口；当前请求结束前不会再次导出。' }; publish();
    }, Math.max(0, 120000 - (now() - flight.startedAt)));
    void flight.promise.then(saved => {
      if (!active) return;
      state = { ...state, exportStatus: saved ? 'saved' : 'cancelled', exportMessage: saved ? '诊断 JSON 已保存到所选位置。导出时已重新采集，时间可能与下方预览不同。' : '已取消导出，没有保存诊断文件。' };
    }).catch(cause => {
      if (!active) return;
      state = { ...state, exportStatus: 'failed', exportMessage: diagnosticsMessage(cause) };
    }).finally(() => { clearTimer(saveTimer); if (active) { state = { ...state, exportPending: false }; publish(); } });
  };
  const existingExport = save.current();
  if (existingExport) observeExport(existingExport);
  return {
    refresh() {
      if (!active || state.readPending) return;
      const flight = read.start(); let timedOut = false;
      state = { ...state, reading: true, readPending: true, readError: '' }; publish();
      readTimer = setTimer(() => {
        timedOut = true;
        if (!active) return;
        state = { ...state, reading: false, readError: '读取诊断超过 10 秒，当前请求尚未结束。已有报告保留原采集时间，请稍后重试。' }; publish();
      }, Math.max(0, 10000 - (now() - flight.startedAt)));
      void flight.promise.then(report => {
        if (!active || timedOut) return;
        state = { ...state, report, readError: '' };
      }).catch(cause => { if (active && !timedOut) state = { ...state, readError: diagnosticsMessage(cause) }; })
        .finally(() => { clearTimer(readTimer); if (active) { state = { ...state, reading: false, readPending: false }; publish(); } });
    },
    export() { if (active && !state.exportPending) observeExport(save.start()); },
    dispose() { active = false; clearTimer(readTimer); clearTimer(saveTimer); },
  };
}
