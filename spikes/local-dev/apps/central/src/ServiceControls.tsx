// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from 'react';
import { nativeAvailable, nativeCall } from './native';
import { acceptServiceSnapshot, getServiceContext, getServiceSnapshot, publicCode, readServiceSnapshot, serviceMessage, serviceTerminal, snapshotAdvanced, type ServiceContext, type ServiceSnapshot } from './service-client';

const labels: Record<ServiceSnapshot['state'], string> = { stopped: '已停止', starting: '正在启动', running: '正在运行', stopping: '正在停止', failed: '运行失败' };
const operationTerminal = (kind: 'start' | 'stop', value: ServiceSnapshot) => serviceTerminal(value) && (kind !== 'stop' || value.state !== 'running');
export function ServiceControls({ configRevision, accountId, disabled = false }: { configRevision: number | null; accountId: string; disabled?: boolean }) {
  const [snapshot, setSnapshot] = useState<ServiceSnapshot | null>(null);
  const [context, setContext] = useState<ServiceContext | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | ''>('');
  const [refreshing, setRefreshing] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [statusFresh, setStatusFresh] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const mounted = useRef(true), readLock = useRef(false), mutationLock = useRef(false);
  const latest = useRef<ServiceSnapshot | null>(null);
  const errorSource = useRef<'read' | 'mutation' | null>(null);
  const unresolved = useRef<{ baseline: ServiceSnapshot | null; kind: 'start' | 'stop' } | null>(null);
  function accept(incoming: ServiceSnapshot) {
    const selected = acceptServiceSnapshot(latest.current, incoming);
    latest.current = selected; setSnapshot(selected); setStatusFresh(true);
    const operation = unresolved.current;
    if (operation && snapshotAdvanced(operation.baseline, selected) && operationTerminal(operation.kind, selected)) {
      unresolved.current = null; setUncertain(false);
      setError(''); errorSource.current = null;
      setNotice(`已核对本机状态：${labels[selected.state]}。`);
    }
  }
  async function refresh(automatic = false) {
    if (!nativeAvailable || readLock.current) return;
    readLock.current = true; setRefreshing(true);
    if (!automatic) { setError(''); errorSource.current = null; }
    try {
      const [statusResult, contextResult] = await Promise.allSettled([getServiceSnapshot(), getServiceContext()]);
      if (!mounted.current) return;
      if (statusResult.status === 'fulfilled') accept(statusResult.value);
      if (contextResult.status === 'fulfilled') setContext(contextResult.value);
      if (statusResult.status === 'rejected') { setStatusFresh(false); throw statusResult.reason; }
      if (contextResult.status === 'rejected') { setContext(null); throw contextResult.reason; }
      if (errorSource.current === 'read') { setError(''); errorSource.current = null; }
    } catch (cause) { if (mounted.current) { setError(serviceMessage(cause)); errorSource.current = 'read'; } }
    finally { readLock.current = false; if (mounted.current) setRefreshing(false); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  const polling = !!busy || uncertain || snapshot?.state === 'starting' || snapshot?.state === 'running' || snapshot?.state === 'stopping';
  useEffect(() => {
    if (!nativeAvailable || !polling) return;
    const timer = window.setInterval(() => { void refresh(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [polling]);

  const pending = !!busy || uncertain;
  const stopped = snapshot?.state === 'stopped' || snapshot?.state === 'failed';
  const startReason = !nativeAvailable ? '请在中央管理 App 中启动本机服务。'
    : !context ? '正在等待本机启动条件，请刷新状态。'
      : !context.candidateStartAvailable ? '当前版本未开放验证服务启动入口。'
        : !snapshot || !statusFresh ? '当前服务状态未确认，请刷新状态。'
          : !configRevision ? '请先保存本机配置。'
            : context.configRevision !== configRevision ? '配置版本已变化，请重新读取本机配置。'
              : !accountId ? '请先选择已导入的中央模型账号。'
                : stopped && !snapshot.cleanupVerified ? '上次进程退出尚未确认，暂不能启动新的服务。'
                  : uncertain ? '上次操作结果待核对，请先刷新状态。' : '';
  const canStart = !disabled && !pending && !startReason && stopped && snapshot?.cleanupVerified;
  const canStop = !disabled && !pending && statusFresh && !!snapshot?.instanceId && (snapshot.state === 'starting' || snapshot.state === 'running' || (snapshot.state === 'failed' && !snapshot.cleanupVerified));
  async function mutate(kind: 'start' | 'stop') {
    if (mutationLock.current || (kind === 'start' ? !canStart : !canStop)) return;
    if (kind === 'start' && context?.needsAdmin && (!username.trim() || Array.from(password).length < 12)) {
      setError('首次启动请填写管理员名称和至少 12 个字符的密码。'); return;
    }
    mutationLock.current = true; setBusy(kind); setError(''); setNotice('');
    const baseline = latest.current;
    unresolved.current = { baseline, kind }; setUncertain(false);
    const args: Record<string, unknown> = kind === 'start'
      ? { requestId: crypto.randomUUID(), expectedRevision: configRevision, accountId,
          ...(context?.needsAdmin ? { adminUsername: username.trim(), adminPassword: password } : {}) }
      : { requestId: crypto.randomUUID(), expectedInstanceId: baseline?.instanceId };
    // Password exists only in this request, never in a draft or storage key.
    setPassword('');
    try {
      const value = readServiceSnapshot(await nativeCall<unknown>(kind === 'start' ? 'central_service_start' : 'central_service_stop', 60000, args));
      if (!mounted.current) return;
      accept(value);
      // A successful request can acknowledge starting/stopping before cleanup
      // finishes. Keep its reconciliation marker until polling sees a terminal.
      unresolved.current = operationTerminal(kind, latest.current ?? value) ? null : { baseline, kind };
      setUncertain(false);
      setNotice(`本机服务${labels[(latest.current ?? value).state]}。`);
    } catch (cause) {
      if (!mounted.current) return;
      const code = publicCode(cause);
      const reconciled = latest.current && snapshotAdvanced(baseline, latest.current) && operationTerminal(kind, latest.current);
      if (!reconciled && ['OPERATION_TIMEOUT', 'UI_PROTOCOL_INVALID', 'INTERNAL_ERROR'].includes(code)) {
        unresolved.current = { baseline, kind }; setUncertain(true);
        setNotice('结果暂未确认，将每 5 秒读取状态核对；不会重复提交启动。');
      } else { unresolved.current = null; setUncertain(false); }
      setError(serviceMessage(cause)); errorSource.current = 'mutation';
    } finally {
      args.adminPassword = undefined;
      mutationLock.current = false;
      if (mounted.current) { setBusy(''); void refresh(true); }
    }
  }
  return <section className="card inspection-panel" aria-busy={!!busy}>
    <div className="section-title"><div><h3>本机服务</h3><p className="field-hint">启动本机验证服务，检查中央端运行链路。</p></div><button className="button secondary" disabled={!nativeAvailable || refreshing} onClick={() => void refresh()}>{refreshing ? '正在读取…' : '刷新状态'}</button></div>
    <div className="inspection-config" aria-live="polite"><strong>{snapshot ? labels[snapshot.state] : nativeAvailable ? '状态待读取' : '浏览器预览'}</strong>
      {snapshot?.pid && <span>服务进程 {snapshot.pid}</span>}
      {snapshot && stopped && <span>{snapshot.cleanupVerified ? '已确认没有遗留服务进程' : '进程退出待确认'}</span>}
    </div>
    {snapshot?.state === 'starting' && <p className="field-hint" role="status">正在检查资源并启动服务，页面会自动更新结果。</p>}
    {snapshot?.state === 'stopping' && <p className="field-hint" role="status">正在关闭服务及模型进程，确认退出后才能重新启动。</p>}
    {snapshot?.forcedStop && <p className="field-hint">上次停止使用了强制回收；退出确认结果以上方状态为准。</p>}
    {snapshot?.deadlineAt && (snapshot.state === 'starting' || snapshot.state === 'stopping') && <p className="field-hint">当前操作时限：{new Date(snapshot.deadlineAt).toLocaleTimeString('zh-CN')}</p>}
    {context?.needsAdmin && stopped && <div className="resource-result"><strong>首次启动 · 设置中央管理员</strong><p>用于管理中央用户与设备。密码不会保存在页面草稿中。</p><div className="field-columns equal-columns">
      <label className="native-field">管理员名称<input value={username} maxLength={64} autoComplete="username" disabled={disabled || pending} onChange={event => setUsername(event.target.value)} /></label>
      <label className="native-field">管理员密码<input type="password" value={password} minLength={12} maxLength={256} autoComplete="new-password" placeholder="至少 12 个字符" disabled={disabled || pending} onChange={event => setPassword(event.target.value)} /></label>
    </div></div>}
    <div className="button-row"><button className="button primary" disabled={!canStart} onClick={() => void mutate('start')}>{busy === 'start' ? '启动请求处理中…' : '启动验证服务'}</button><button className="button secondary" disabled={!canStop} onClick={() => void mutate('stop')}>{busy === 'stop' ? '停止请求处理中…' : '停止服务'}</button></div>
    {startReason && !busy && snapshot?.state !== 'running' && <p className="field-hint">{startReason}</p>}
    <p className="field-hint">本入口用于开发验证，正式运行资格尚未完成。</p>
    {snapshot?.failureCode && <p className="management-error" role="alert">{serviceMessage(snapshot.failureCode)}</p>}
    {error && <p className="management-error" role="alert">{error}</p>}
    {notice && <p className={uncertain ? 'notice' : 'management-success'} role="status">{notice}</p>}
  </section>;
}
