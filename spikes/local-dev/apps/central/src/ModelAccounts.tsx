// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from 'react';
import { nativeAvailable, nativeCall } from './native';
import { ManagedModelLogin } from './ManagedModelLogin';
import { readAccountEntries, readAccountReport, readDiscoveredAccount, serviceMessage, type AccountEntry, type DiscoveredAccount } from './service-client';

export function ModelAccounts({ selectedId, onSelect, disabled = false }: { selectedId: string; onSelect: (id: string) => void; disabled?: boolean }) {
  const [entries, setEntries] = useState<AccountEntry[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredAccount | null>(null);
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true), locked = useRef(false);
  const current = useRef({ selectedId, onSelect }); current.current = { selectedId, onSelect };
  async function refresh() {
    if (!nativeAvailable || locked.current) return;
    locked.current = true; setBusy('refresh'); setError('');
    try {
      const value = readAccountEntries(await nativeCall<unknown>('central_model_accounts_list', 60000));
      if (!mounted.current) return;
      setEntries(value); setLoaded(true);
      // Keep failed selections visible so their recovery instructions do not disappear.
      if (current.current.selectedId && !value.some(entry => entry.accountId === current.current.selectedId)) current.current.onSelect('');
    } catch (cause) { if (mounted.current) { setError(serviceMessage(cause)); setLoaded(false); } }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = setInterval(() => void refresh(), 30000); return () => clearInterval(timer); }, []);
  async function discover() {
    if (locked.current) return;
    locked.current = true; setBusy('discover'); setError(''); setNotice(''); setDiscovered(null);
    try {
      const value = readDiscoveredAccount(await nativeCall<unknown>('central_model_account_discover', 60000));
      if (mounted.current) setDiscovered(value);
    } catch (cause) { if (mounted.current) setError(serviceMessage(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  async function importAccount() {
    if (locked.current || discovered?.status !== 'available') return;
    locked.current = true; setBusy('import'); setError(''); setNotice('');
    try {
      const value = readAccountReport(await nativeCall<unknown>('central_model_account_import', 60000));
      if (!mounted.current) return;
      setEntries(previous => [...previous.filter(entry => entry.accountId !== value.accountId), { accountId: value.accountId, report: value }]);
      setLoaded(true); setDiscovered(null);
      if (value.status !== 'expired') current.current.onSelect(value.accountId);
      setNotice('登录已导入中央账号存储。远程模型尚未验证；到期后需要重新登录并导入。');
    } catch (cause) { if (mounted.current) { setError(serviceMessage(cause)); setDiscovered(null); setNotice('请先刷新账号列表核对结果，再决定是否重新检测和导入。'); } }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  async function linkExisting() {
    if (locked.current) return;
    locked.current = true; setBusy('link'); setError(''); setNotice('');
    try {
      const account = readAccountReport(await nativeCall('central_model_account_link', 60000));
      if (!mounted.current) return;
      setEntries(previous => [...previous.filter(e => e.accountId !== account.accountId), { accountId: account.accountId, report: account }]);
      setLoaded(true); current.current.onSelect(account.accountId);
      setNotice('已关联本机 Codex 登录，无需再次授权。启动中央服务后自动检查和续期；正在运行的服务需停止再启动以切换账号。');
    } catch (cause) { if (mounted.current) setError(serviceMessage(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  const selected = entries.find(entry => entry.accountId === selectedId);
  const blocked = disabled || !nativeAvailable || !!busy;
  return <section className="card inspection-panel" aria-busy={!!busy}>
    <div className="section-title"><div><h3>中央模型账号</h3><p className="field-hint">优先复用本机已有 Codex 登录，由中央后台负责续期。</p></div><button className="button secondary" disabled={!nativeAvailable || !!busy} onClick={() => void refresh()}>{busy === 'refresh' ? '正在刷新…' : '刷新账号'}</button></div>
    {!nativeAvailable && <p className="field-hint">浏览器预览无法访问账号，请在中央管理 App 中操作。</p>}
    <label className="native-field">用于启动的账号<select value={selectedId} disabled={blocked || !loaded} onChange={event => onSelect(event.target.value)}>
      <option value="">{loaded && !entries.length ? '尚未接入账号' : '选择中央模型账号'}</option>
      {selectedId && !selected && <option value={selectedId}>所选账号待核对</option>}
      {entries.map(entry => <option key={entry.accountId} value={entry.accountId} disabled={!entry.report || entry.report.status === 'expired' && (!entry.report.refreshSupported || entry.report.renewalState === 'reauth-required') || !!entry.failure}>{entry.report?.accountHint ?? '不可用账号'} · {entry.report?.credentialSource === 'codex-shared' ? '复用 Codex 登录' : entry.report?.refreshSupported ? '独立登录' : '旧登录副本'} · {entry.report?.status === 'imported' ? '有效' : entry.report?.status === 'expiry-unknown' ? '有效期未知' : entry.report?.status === 'expired' ? '已过期' : '校验失败'}</option>)}
    </select></label>
    {selected?.report && <div className="resource-result"><strong>{selected.report.accountHint}</strong><p>{selected.report.accessExpiresAt ? `登录有效期至 ${new Date(selected.report.accessExpiresAt).toLocaleString('zh-CN')}` : '此登录未提供可确认的有效期。'}</p><p>{selected.report.refreshSupported ? '中央服务运行时提前 24 小时自动续期；更新无需重启服务。' : '旧登录副本不自动续期；请点击下方“复用本机 Codex 登录”。'}</p>{selected.report.renewalState === 'retrying' && <p role="status">续期暂时失败，下次尝试：{selected.report.nextRetryAt ? new Date(selected.report.nextRetryAt).toLocaleString('zh-CN') : '稍后'}。</p>}{selected.report.renewalState === 'reauth-required' && <p className="management-error" role="alert">{selected.report.credentialSource === 'codex-shared' ? '请先在中央机重新登录 Codex，再点击“复用本机 Codex 登录”重试。' : '自动续期已停止，请重新完成中央专用登录。'}</p>}{selected.report.renewalError && <p className="field-hint">{serviceMessage({ code: selected.report.renewalError })}</p>}</div>}
    {selected?.failure && <p className="field-error" role="alert">{serviceMessage(selected.failure)}</p>}
    <div className="resource-result"><strong>复用本机 Codex 登录（推荐）</strong><p>直接使用中央机已有登录。中央后台负责续期，无需保持 Codex 桌面窗口打开。退出登录会影响此连接。</p><button className="button primary" disabled={blocked} onClick={() => void linkExisting()}>{busy === 'link' ? '正在关联…' : '复用本机 Codex 登录'}</button></div>
    <details><summary>其他登录方式</summary><ManagedModelLogin disabled={blocked} onComplete={account => { setEntries(previous => [...previous.filter(e => e.accountId !== account.accountId), { accountId: account.accountId, report: account }]); setLoaded(true); current.current.onSelect(account.accountId); setNotice('中央专用登录已保存并选中。下次启动中央服务时启用自动续期；正在运行的服务需先停止再启动以切换账号。'); }} />
    <div className="button-row"><button className="button secondary" disabled={blocked} onClick={() => void discover()}>{busy === 'discover' ? '正在检测…' : '检测本机 Codex 登录'}</button></div>
    {discovered && <div className="resource-result"><strong>{discovered.status === 'available' ? '找到本机登录' : '本机登录已过期'} · {discovered.accountHint}</strong><p>{discovered.status === 'available' ? '点击导入会在中央账号存储中保存此登录的副本。' : '请先在 Codex 重新登录，再重新检测。'}</p><button className="button primary" disabled={blocked || discovered.status !== 'available'} onClick={() => void importAccount()}>{busy === 'import' ? '正在导入…' : '导入此登录'}</button></div>}
    </details>
    {error && <p className="management-error" role="alert">{error}</p>}
    {notice && <p className="management-success" role="status">{notice}</p>}
  </section>;
}
