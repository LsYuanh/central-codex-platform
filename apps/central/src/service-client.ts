// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { nativeCall } from './native';
import { invoke } from '@tauri-apps/api/core';

export type ServiceMetrics = {
  sequence: number; observedAt: number; onlineDevices: number; activeTurns: number;
  workers: number; readyWorkers: number; startingWorkers: number; stoppingWorkers: number;
};

export type ServiceSnapshot = {
  generation: number; sequence: number; instanceId?: string | null;
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
  pid?: number | null; cleanupVerified: boolean; forcedStop: boolean;
  failureCode?: string | null; deadlineAt?: number | null;
  metrics?: ServiceMetrics | null;
  accountUpdatesSupported?: boolean;
};
export type ServiceContext = { candidateStartAvailable: boolean; needsAdmin: boolean; configRevision: number };
export type AccountReport = {
  credentialSource?: 'snapshot' | 'dedicated' | 'codex-shared';
  accountId: string; provider: 'chatgpt'; accountHint: string; importedAt: number; checkedAt: number;
  accessExpiresAt: number | null; status: 'imported' | 'expired' | 'expiry-unknown';
  refreshSupported: boolean; remoteVerified: false;
  renewalState?: 'snapshot' | 'ready' | 'retrying' | 'reauth-required';
  renewalError?: string | null; nextRetryAt?: number | null;
};
export type AccountEntry = { accountId: string; report?: AccountReport | null; failure?: { code: string } | null };
export type DiscoveredAccount = {
  source: 'local-codex'; provider: 'chatgpt'; accountHint: string; accessExpiresAt: number | null;
  checkedAt: number; status: 'available' | 'expired'; remoteVerified: false;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const optionalNumber = (value: unknown) => value === null || value === undefined || (typeof value === 'number' && Number.isFinite(value));
const invalid = () => ({ code: 'UI_PROTOCOL_INVALID' });
export function readServiceMetrics(value: unknown): ServiceMetrics {
  if (!record(value) || !integer(value.sequence) || value.sequence < 1 || !integer(value.observedAt) || value.observedAt < 1 ||
      !integer(value.onlineDevices) || value.onlineDevices > 100000 ||
      !['activeTurns', 'workers', 'readyWorkers', 'startingWorkers', 'stoppingWorkers'].every(key => integer(value[key]) && (value[key] as number) <= 128) ||
      (value.readyWorkers as number) > (value.workers as number)) throw invalid();
  return { sequence: value.sequence, observedAt: value.observedAt, onlineDevices: value.onlineDevices,
    activeTurns: value.activeTurns as number, workers: value.workers as number, readyWorkers: value.readyWorkers as number,
    startingWorkers: value.startingWorkers as number, stoppingWorkers: value.stoppingWorkers as number };
}
export function readServiceSnapshot(value: unknown): ServiceSnapshot {
  if (!record(value) || !integer(value.generation) || !integer(value.sequence) || !['stopped', 'starting', 'running', 'stopping', 'failed'].includes(String(value.state)) ||
      typeof value.cleanupVerified !== 'boolean' || typeof value.forcedStop !== 'boolean' || !optionalNumber(value.pid) || !optionalNumber(value.deadlineAt) ||
      (value.instanceId != null && typeof value.instanceId !== 'string') || (value.failureCode != null && typeof value.failureCode !== 'string')) throw invalid();
  const metrics = value.metrics == null ? null : readServiceMetrics(value.metrics);
  if (metrics && (value.state !== 'running' || !value.instanceId)) throw invalid();
  return { generation: value.generation, sequence: value.sequence, instanceId: value.instanceId as string | null | undefined,
    accountUpdatesSupported: value.accountUpdatesSupported === true,
    state: value.state as ServiceSnapshot['state'], pid: value.pid as number | null | undefined,
    cleanupVerified: value.cleanupVerified, forcedStop: value.forcedStop,
    failureCode: value.failureCode as string | null | undefined, deadlineAt: value.deadlineAt as number | null | undefined, metrics };
}
export function readServiceContext(value: unknown): ServiceContext {
  if (!record(value) || typeof value.candidateStartAvailable !== 'boolean' || typeof value.needsAdmin !== 'boolean' || !integer(value.configRevision)) throw invalid();
  return value as ServiceContext;
}
export function acceptServiceSnapshot(previous: ServiceSnapshot | null, incoming: ServiceSnapshot) {
  if (!previous || incoming.generation > previous.generation || (incoming.generation === previous.generation && incoming.sequence >= previous.sequence)) return incoming;
  return previous;
}
export function snapshotAdvanced(previous: ServiceSnapshot | null, incoming: ServiceSnapshot) {
  return !previous || incoming.generation > previous.generation || (incoming.generation === previous.generation && incoming.sequence > previous.sequence);
}
export function serviceTerminal(snapshot: ServiceSnapshot) { return ['stopped', 'running', 'failed'].includes(snapshot.state); }
export function readAccountReport(value: unknown): AccountReport {
  if (!record(value) || typeof value.accountId !== 'string' || !value.accountId || value.provider !== 'chatgpt' || typeof value.accountHint !== 'string' ||
      !integer(value.importedAt) || !integer(value.checkedAt) || !optionalNumber(value.accessExpiresAt) ||
      !['imported', 'expired', 'expiry-unknown'].includes(String(value.status)) || typeof value.refreshSupported !== 'boolean' || value.remoteVerified !== false ||
      (value.credentialSource != null && !['snapshot', 'dedicated', 'codex-shared'].includes(String(value.credentialSource))) ||
      (value.renewalState != null && !['snapshot', 'ready', 'retrying', 'reauth-required'].includes(String(value.renewalState))) ||
      (value.renewalError != null && typeof value.renewalError !== 'string') || !optionalNumber(value.nextRetryAt)) throw invalid();
  return value as AccountReport;
}
export function readAccountEntries(value: unknown): AccountEntry[] {
  if (!Array.isArray(value)) throw invalid();
  const ids = new Set<string>();
  return value.map(entry => {
    if (!record(entry) || typeof entry.accountId !== 'string' || ids.has(entry.accountId) || (entry.failure != null && (!record(entry.failure) || typeof entry.failure.code !== 'string'))) throw invalid();
    ids.add(entry.accountId);
    const report = entry.report == null ? null : readAccountReport(entry.report);
    if (report && report.accountId !== entry.accountId) throw invalid();
    return { accountId: entry.accountId, report, failure: entry.failure as AccountEntry['failure'] };
  });
}
export function readDiscoveredAccount(value: unknown): DiscoveredAccount {
  if (!record(value) || value.source !== 'local-codex' || value.provider !== 'chatgpt' || typeof value.accountHint !== 'string' ||
      !integer(value.checkedAt) || !optionalNumber(value.accessExpiresAt) || !['available', 'expired'].includes(String(value.status)) || value.remoteVerified !== false) throw invalid();
  return value as DiscoveredAccount;
}
const errors: Record<string, string> = {
  MODEL_PROXY_CONFIG_INVALID: '本机 Codex 代理配置格式无效，请检查 config.toml 中的 features.respect_system_proxy。修正后重新启动中央服务。',
  MODEL_PROXY_CONFIG_UNAVAILABLE: '无法读取本机 Codex 配置，请检查中央系统用户的配置文件访问权限。',
  MODEL_PROXY_URL_INVALID: '中央代理地址无效，请检查代理地址、协议和端口，再重新启动中央服务。',
  MODEL_PROXY_SYSTEM_UNAVAILABLE: '无法读取中央系统代理，请稍后重试。',
  MODEL_PROXY_SYSTEM_UNSUPPORTED: '当前代理使用了暂不支持的协议或规则。中央目前支持静态 HTTP/HTTPS 代理，不支持 PAC、仅 SOCKS 或特殊主机排除规则。',
  MODEL_SHARED_ACCOUNT_CHANGED: '本机 Codex 已切换账号，已停止更新此连接的凭据。请重新点击“复用本机 Codex 登录”，再停止并启动中央服务。',
  MODEL_SHARED_SOURCE_CHANGED: '登录在检查期间发生变化，将重新读取并核对。',
  MODEL_SHARED_RELOGIN_REQUIRED: 'Codex 登录已失效，请在中央机重新登录 Codex，再点击“复用本机 Codex 登录”。',
  MODEL_SHARED_EXPIRY_UNKNOWN: '无法确认本机登录有效期，请在中央机重新登录 Codex。',
  MODEL_SHARED_PROCESS_FAILED: 'Codex 认证进程无法完成检查，请核对中央运行包与网络后重试。',
  MODEL_SHARED_PROTOCOL_INVALID: 'Codex 认证接口响应不兼容，请检查中央运行包。',
  MODEL_SHARED_TIMEOUT: 'Codex 认证检查超时，后台将有限重试。',
  MODEL_SHARED_CANCELLED: '中央服务正在停止，已取消登录检查。',
  MODEL_SHARED_REFRESH_FAILED: 'Codex 未完成续期，请检查中央网络；后台将有限重试。',
  MODEL_LOGIN_BROWSER_FAILED: '无法打开浏览器，请手动访问 https://auth.openai.com/codex/device 完成授权。',
  MODEL_LOGIN_BUSY: '已有登录授权正在进行，请完成或取消后重试。',
  MODEL_LOGIN_EXPIRED: '登录授权已结束或超时，请重新开始中央专用登录。',
  MODEL_LOGIN_UNAVAILABLE: '暂时无法进行设备授权，请检查网络及账号是否允许设备代码登录，然后重试。',
  MODEL_LOGIN_RESPONSE_INVALID: '登录服务返回了无法识别的结果，请重新授权。',
  MODEL_RENEWAL_NETWORK: '续期暂时无法连接服务，将按退避间隔有限重试。',
  MODEL_RENEWAL_UNCERTAIN: '上次续期结果无法确认，请重新授权中央专用登录。',
  MODEL_RENEWAL_REAUTH_REQUIRED: '中央登录无法继续续期，请重新授权。',
  MODEL_RENEWAL_ACCOUNT_MISMATCH: '续期返回的账号不匹配，请重新授权。',
  MODEL_RENEWAL_RESPONSE_INVALID: '续期响应无效，请重新授权。',
  MODEL_RENEWAL_STORAGE_FAILED: '新凭据保存失败，请检查中央存储后重新授权。',
  MODEL_RENEWAL_BUSY: '正在更新中央登录，请稍后刷新状态。',
  SERVICE_ACCOUNT_UPDATE_UNSUPPORTED: '当前运行包不支持热更新模型凭据，请更新中央运行包。',
  MODEL_ACCOUNT_SOURCE_MISSING: '未找到本机 Codex 登录，请先在这台电脑登录，再重新检测。',
  MODEL_ACCOUNT_SOURCE_UNAVAILABLE: '暂时无法读取本机登录，请稍后重新检测。',
  MODEL_ACCOUNT_SOURCE_UNSAFE: '本机登录文件或路径未通过安全检查，未导入账号。',
  MODEL_ACCOUNT_SOURCE_TOO_LARGE: '本机登录文件超出允许大小，未导入账号。',
  MODEL_ACCOUNT_PROFILE_UNAVAILABLE: '无法确定当前系统用户的登录目录。',
  MODEL_ACCOUNT_FORMAT_INVALID: '登录内容格式不兼容，请重新登录 Codex 后再检测。',
  MODEL_ACCOUNT_AUTH_MODE_UNSUPPORTED: '当前仅支持导入本机 ChatGPT 登录。',
  MODEL_ACCOUNT_EXPIRED: '此登录已过期，请在 Codex 中重新登录，再显式导入。',
  MODEL_ACCOUNT_STORAGE_UNSAFE: '账号存储无法安全访问，请检查本机目录权限。',
  MODEL_ACCOUNT_STORAGE_INVALID: '已保存账号校验失败，请重新导入有效登录。',
  MODEL_ACCOUNT_CAPACITY: '已达到当前账号数量上限。',
  MODEL_ACCOUNT_PLATFORM_UNSUPPORTED: '当前系统暂不支持原生账号导入。',
  MODEL_ACCOUNT_ENCODING_FAILED: '账号导入失败，请刷新列表核对结果。',
  CONFIG_INVALID: '请先完成并保存本机配置。',
  CONFIG_REVISION_CONFLICT: '本机配置已变化，请读取最新配置后再启动。',
  CONFIG_STORAGE_UNSAFE: '本机配置暂时无法安全读取。',
  ADMIN_AUTH_REQUIRED: '首次启动需要设置中央管理员账号和密码。',
  ADMIN_PASSWORD_INVALID: '管理员密码至少需要 12 个字符。',
  ADMIN_USERNAME_INVALID: '管理员名称格式不正确，请检查后重试。',
  RUNTIME_MISSING: '尚未找到已固定的完整服务资源，请先检查运行包。',
  RUNTIME_HASH_MISMATCH: '服务资源校验失败，请检查完整运行包。',
  RUNTIME_UNKNOWN_PACKAGE: '所选运行包不在应用内置清单中。',
  RUNTIME_PLATFORM_MISMATCH: '此服务候选不支持当前系统。',
  SERVICE_CANDIDATE_DISABLED: '此版本未开放验证服务启动入口。',
  PACKAGE_NOT_QUALIFIED: '此运行包尚未完成正式验收，仅开发版提供验证入口。',
  SERVICE_ALREADY_ACTIVE: '服务已在启动或运行，请刷新状态。',
  SERVICE_DATA_UNSAFE: '数据目录无法独占使用，或含有未经初始化的数据。请选用新的专用目录。',
  SERVICE_REQUEST_CONFLICT: '操作编号对应的参数发生变化，请刷新状态后重新操作。',
  RECONCILE_REQUIRED: '这是上次应用会话的操作，请核对当前状态后发起新操作。',
  SERVICE_JOURNAL_UNSAFE: '操作记录无法安全读取，暂不能变更服务。',
  SERVICE_JOURNAL_FULL: '操作记录已达当前容量上限，需要维护后才能继续启停。',
  SERVICE_APP_CLOSING: '中央管理正在退出，请等待服务关闭。',
  SERVICE_START_TIMEOUT: '服务启动超时，正在核对进程清理结果。',
  SERVICE_STOP_TIMEOUT: '服务未在期限内正常停止，已尝试强制回收。',
  SERVICE_UNEXPECTED_EXIT: '服务意外退出，请检查配置和运行包后重试。',
  SERVICE_ADMIN_ALREADY_CONFIGURED: '此数据目录已初始化管理员，请刷新状态后重试。',
  SERVICE_INSTANCE_MISMATCH: '服务实例已变化，请刷新状态后再操作。',
  SERVICE_CLEANUP_UNVERIFIED: '上次进程退出尚未确认，暂不能启动新的服务。',
  SHUTDOWN_INCOMPLETE: '服务退出尚未完全确认，请继续核对状态。',
  PORT_IN_USE: '监听端口已被占用，请检查连接配置。',
  TLS_INVALID: '服务器证书不可用，请重新检查证书。',
  OPERATION_BUSY: '已有操作正在进行，请核对当前状态。',
  OPERATION_TIMEOUT: '操作结果暂未确认，正在读取本机状态核对。',
  UI_PROTOCOL_INVALID: '应用与本机服务接口不兼容，无法确认操作结果。',
};
export function publicCode(cause: unknown) { return record(cause) && typeof cause.code === 'string' ? cause.code : 'INTERNAL_ERROR'; }
export function serviceMessage(cause: unknown) { return errors[typeof cause === 'string' ? cause : publicCode(cause)] ?? '操作未完成，请刷新本机状态核对。'; }
export async function getServiceSnapshot() { return readServiceSnapshot(await nativeCall<unknown>('central_service_status', 60000)); }
// Keep ownership of the real IPC promise after a UI timeout, including across
// overview remounts. A timeout must not open a second outstanding metrics read.
let metricsRead: Promise<ServiceSnapshot> | null = null;
export function getMetricsSnapshot() {
  if (!metricsRead) {
    metricsRead = invoke<unknown>('central_service_status').then(readServiceSnapshot).finally(() => { metricsRead = null; });
  }
  return metricsRead;
}
export async function getServiceContext() {
  // The overview also reads configuration on mount. Retry only a read that lost
  // that short native file lock; mutations are never automatically replayed.
  for (let attempt = 0; ; attempt++) {
    try { return readServiceContext(await nativeCall<unknown>('central_service_context', 10000)); }
    catch (cause) {
      if (publicCode(cause) !== 'OPERATION_BUSY' || attempt >= 3) throw cause;
      await new Promise(resolve => window.setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
