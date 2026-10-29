// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { nativeAvailable } from './native';
import { PEOPLE_INVENTORY_TTL, peopleCode, peopleInventoryFresh, peopleList, peopleLogin, peopleLogout, peopleMessage, peopleMutation, peopleOutcomeUnknown, peopleSessionValid, peopleStatus, type Mutation, type Pairing, type PeopleInventory, type PeopleStatus } from './people-client';

type Confirmation = { kind: 'disable_user' | 'revoke_device'; id: string; name: string; userId: string };
type DisplayPair = Pairing & { userId: string; username: string; instanceId: string; deviceIds: string[] };
type UnknownOperation = { kind: Mutation; target: string; requestId: string };
const serviceLabels = { stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', failed: '运行失败' };
const dateLabel = (value: number | null) => value == null ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false });

export function PeopleManagement({ onGoOverview }: { onGoOverview?: () => void }) {
  const [status, setStatus] = useState<PeopleStatus | null>(null);
  const [inventory, setInventory] = useState<PeopleInventory | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [pair, setPair] = useState<DisplayPair | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [unknown, setUnknown] = useState<UnknownOperation | null>(null);
  const mounted = useRef(false), locked = useRef(false), generation = useRef(0);
  const dialog = useRef<HTMLElement | null>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);
  const current = useRef({ status, inventory, loadedAt, pair, unknown });
  current.current = { status, inventory, loadedAt, pair, unknown };

  function clearPrivateDisplay() {
    current.current.inventory = null; current.current.loadedAt = 0; current.current.pair = null;
    setPassword(''); setPair(null); setConfirmation(null); setInventory(null); setLoadedAt(0); setSelectedUser('');
  }
  function acceptStatus(next: PeopleStatus) {
    const previous = current.current.status;
    if (previous?.instanceId !== next.instanceId || !next.authenticated || next.serviceState !== 'running' || (next.expiresAt ?? 0) <= Date.now()) {
      clearPrivateDisplay();
      if (previous?.instanceId !== next.instanceId) setUnknown(null);
    }
    current.current.status = next;
    setStatus(next);
  }
  function acceptInventory(next: PeopleInventory) {
    const observedAt = Date.now();
    current.current.inventory = next; current.current.loadedAt = observedAt;
    setInventory(next); setLoadedAt(observedAt); setClock(observedAt);
    const display = current.current.pair;
    if (display && (!next.users.some(user => user.id === display.userId && !user.disabled) || next.devices.some(device => device.userId === display.userId && !display.deviceIds.includes(device.id)))) {
      setPair(null);
      setNotice('用户或设备清单已变化，配对码已从页面隐藏。请核对设备；清单变化不能确认这枚配对码是否已被使用。');
    }
    const pending = current.current.unknown;
    if (pending && ((pending.kind === 'create_user' && next.users.some(user => user.username === pending.target)) || (pending.kind === 'disable_user' && next.users.some(user => user.id === pending.target && user.disabled)) || (pending.kind === 'revoke_device' && next.devices.some(device => device.id === pending.target && device.revoked)))) {
      setUnknown(null); setNotice('刷新已观察到目标状态。请根据当前清单核对结果。');
    }
    setSelectedUser(previous => next.users.some(user => user.id === previous && !user.disabled) ? previous : '');
    setConfirmation(previous => previous && (previous.kind === 'disable_user'
      ? next.users.some(user => user.id === previous.id && !user.disabled)
      : next.devices.some(device => device.id === previous.id && !device.revoked)) ? previous : null);
  }
  function handleFailure(cause: unknown) {
    setError(peopleMessage(cause));
    if (['ADMIN_AUTH_REQUIRED', 'AUTH_REQUIRED', 'SERVICE_INSTANCE_MISMATCH', 'SERVICE_NOT_RUNNING', 'PEOPLE_SERVICE_UNAVAILABLE', 'PEOPLE_TARGET_NOT_LOCAL', 'PEOPLE_TARGET_UNSAFE', 'PEOPLE_TLS_INVALID'].includes(peopleCode(cause))) {
      clearPrivateDisplay();
      setStatus(previous => previous ? { ...previous, authenticated: false, admin: null, expiresAt: null } : null);
    }
  }
  function openConfirmation(value: Confirmation, trigger: HTMLButtonElement) {
    confirmationTrigger.current = trigger;
    setConfirmation(value);
  }
  async function refresh(quiet = false) {
    if (!nativeAvailable || locked.current || !mounted.current) return;
    locked.current = true;
    const ticket = generation.current;
    setReading(true);
    if (!quiet) setError('');
    try {
      const next = await peopleStatus();
      if (!mounted.current || ticket !== generation.current) return;
      acceptStatus(next);
      if (next.authenticated && next.instanceId && next.serviceState === 'running' && (next.expiresAt ?? 0) > Date.now()) {
        const list = await peopleList(next.instanceId);
        if (!mounted.current || ticket !== generation.current || current.current.status?.instanceId !== list.instanceId) return;
        acceptInventory(list);
      }
      if (mounted.current && !quiet) setError('');
    } catch (cause) { if (mounted.current && ticket === generation.current) handleFailure(cause); }
    finally { locked.current = false; if (mounted.current) setReading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    // StrictMode's probe cleanup cancels this before issuing a native request.
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && current.current.status?.authenticated) void refresh(true);
    }, 5000);
    const visibility = () => { if (document.visibilityState === 'visible' && current.current.status?.authenticated) void refresh(true); };
    document.addEventListener('visibilitychange', visibility);
    return () => { mounted.current = false; generation.current++; clearTimeout(initial); clearInterval(timer); document.removeEventListener('visibilitychange', visibility); current.current.pair = null; };
  }, []);
  useEffect(() => {
    if (!confirmation) return;
    const previous = confirmationTrigger.current;
    dialog.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setConfirmation(null); }
      if (event.key !== 'Tab' || !dialog.current) return;
      const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0], last = buttons.at(-1);
      const active = buttons.indexOf(document.activeElement as HTMLButtonElement);
      // Polling can disable the confirmation button while it has focus. Keep
      // Tab inside the dialog even if the browser moves focus to the document.
      if (active < 0 || (event.shiftKey && active === 0) || (!event.shiftKey && active === buttons.length - 1)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected && !previous.disabled) previous.focus(); confirmationTrigger.current = null; };
  }, [confirmation]);
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now(); setClock(now);
      if (current.current.pair && current.current.pair.expiresAt <= now) { setPair(null); setNotice('配对码已过期，已从页面清除。需要时请重新生成。'); }
      if (current.current.status?.authenticated && (current.current.status.expiresAt ?? 0) <= now) {
        clearPrivateDisplay(); setStatus(previous => previous ? { ...previous, authenticated: false, admin: null, expiresAt: null } : null);
        setError('管理员会话已到期，请重新登录。');
      } else if (current.current.loadedAt && now - current.current.loadedAt > PEOPLE_INVENTORY_TTL) {
        setPair(null); setConfirmation(null); setInventory(null); setLoadedAt(0);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    const instance = current.current.status?.instanceId;
    if (locked.current || !instance || !username.trim() || !password) return;
    const submitted = password;
    setPassword(''); locked.current = true; setBusy('login'); setError(''); setNotice('');
    const ticket = generation.current;
    try {
      const next = await peopleLogin(instance, username.trim(), submitted);
      if (!mounted.current || ticket !== generation.current) return;
      acceptStatus(next);
      if (next.instanceId === instance && next.authenticated) {
        // The dedicated login successfully replaces prior native-admin scope
        // sessions. Merely clearing local authentication is not that evidence.
        setUnknown(null); setBusy('refresh');
        const list = await peopleList(instance);
        if (mounted.current && ticket === generation.current && current.current.status?.instanceId === instance && (current.current.status.expiresAt ?? 0) > Date.now()) acceptInventory(list);
      }
    } catch (cause) { if (mounted.current && ticket === generation.current) { handleFailure(cause); if (peopleCode(cause) === 'ADMIN_AUTH_REQUIRED') setError('管理员用户名或密码无效，或该账号已被停用。请核对后重新登录。'); } }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  async function logout() {
    const instance = current.current.status?.instanceId;
    if (locked.current || !instance) return;
    locked.current = true; setBusy('logout'); setError(''); clearPrivateDisplay(); generation.current++;
    try { const next = await peopleLogout(instance); if (next.authenticated) throw { code: 'PEOPLE_PROTOCOL_INVALID' }; if (mounted.current) { acceptStatus(next); setUnknown(null); setNotice('管理员已退出，页面中的配对码已清除。'); } }
    catch (cause) { if (mounted.current) handleFailure(cause); }
    finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  const fresh = peopleInventoryFresh(status, inventory, loadedAt, clock);
  const authenticated = peopleSessionValid(status, clock);
  const blocked = !authenticated || !fresh || !!busy || !!unknown;
  async function mutate(kind: Mutation, target: string) {
    const state = current.current.status;
    if (locked.current || !state?.instanceId || !peopleInventoryFresh(state, current.current.inventory, current.current.loadedAt, Date.now()) || current.current.unknown) return;
    let requestId: string;
    try { requestId = crypto.randomUUID(); } catch { setError('无法创建操作编号，请重新打开中央管理 App。'); return; }
    locked.current = true; setBusy(kind); setError(''); setNotice(''); setConfirmation(null);
    const ticket = generation.current, instance = state.instanceId;
    let confirmed = false;
    if (kind === 'pair_code') setPair(null);
    try {
      const result = await peopleMutation(kind, instance, requestId, kind === 'create_user' ? { username: target } : kind === 'revoke_device' ? { deviceId: target } : kind === 'pair_code' ? { userId: target } : { userId: target });
      if (!mounted.current || ticket !== generation.current || current.current.status?.instanceId !== instance || !current.current.status.authenticated || (current.current.status.expiresAt ?? 0) <= Date.now()) return;
      if ((kind === 'create_user' && (!result.user || result.user.username !== target || result.user.loginMode !== 'pairing-only')) || (kind === 'disable_user' && !result.disabled) || (kind === 'revoke_device' && !result.revoked)) throw { code: 'PEOPLE_PROTOCOL_INVALID' };
      if (kind === 'pair_code') {
        if (!result.pairing || result.pairing.expiresAt <= Date.now()) throw { code: 'PEOPLE_PROTOCOL_INVALID' };
        setPair({ ...result.pairing, expiresAt: Math.min(result.pairing.expiresAt, Date.now() + result.pairing.expiresIn * 1000), instanceId: instance, userId: target, username: current.current.inventory?.users.find(user => user.id === target)?.username ?? target, deviceIds: current.current.inventory?.devices.filter(device => device.userId === target).map(device => device.id) ?? [] });
        setNotice('新配对码已生成。该用户之前未使用的配对码已失效。');
      } else {
        if (kind === 'create_user') setNewUsername('');
        if (kind === 'disable_user' && current.current.pair?.userId === target) setPair(null);
        setNotice(kind === 'create_user' ? '配对专用用户已创建。选中用户后可生成设备配对码。' : kind === 'disable_user' ? '用户已停用，历史记录保留。请刷新核对设备连接与任务终态。' : '设备已撤销，历史记录保留。再次使用需重新配对。');
      }
      confirmed = true;
      setBusy('refresh');
      const list = await peopleList(instance);
      if (mounted.current && ticket === generation.current) acceptInventory(list);
    } catch (cause) {
      if (mounted.current && ticket === generation.current) {
        handleFailure(cause);
        if (!confirmed && peopleOutcomeUnknown(cause)) { setUnknown({ kind, target, requestId }); setPair(null); }
      }
    } finally { locked.current = false; if (mounted.current) setBusy(''); }
  }
  async function copyPair() {
    const display = current.current.pair;
    if (!display || display.expiresAt <= Date.now() || !fresh || !authenticated) return;
    try { await navigator.clipboard.writeText(display.connectionCode ?? display.code); if (mounted.current) setNotice('配对码已复制。请交给目标用户；剪贴板不会随页面退出自动清除。'); }
    catch { if (mounted.current) setError('复制失败，可手动选择配对码复制。'); }
  }
  const selected = inventory?.users.find(user => user.id === selectedUser);
  const countdown = pair ? Math.max(0, Math.ceil((pair.expiresAt - clock) / 1000)) : 0;

  if (!nativeAvailable) return <section className="card empty-state"><h2>请在中央管理 App 中管理用户</h2><p>浏览器预览无法连接原生管理员会话。启动中央管理 App 后，可查看真实服务的用户和设备。</p>{onGoOverview && <button className="button secondary" onClick={onGoOverview}>返回运行概览</button>}</section>;
  return <div className="people-management">
    <section className="card inspection-panel">
      <div className="section-title"><div><h3>管理员会话</h3><p className="field-hint">中央服务：{status ? serviceLabels[status.serviceState] : '尚未读取'}{authenticated && status?.admin ? ` · ${status.admin.username}` : ''}</p></div><div className="button-row"><button className="button secondary" disabled={!!busy || reading} onClick={() => void refresh()}>{reading || busy === 'refresh' ? '正在刷新…' : '刷新状态与清单'}</button>{authenticated && <button className="button secondary" disabled={!!busy || reading} onClick={() => void logout()}>{busy === 'logout' ? '正在退出…' : '退出管理员'}</button>}</div></div>
      {status?.serviceState !== 'running' && <div className="resource-result"><strong>服务运行后才能管理用户与设备</strong><p>请到运行概览检查并启动中央服务，再刷新此页面。</p>{onGoOverview && <button className="button secondary" onClick={onGoOverview}>前往运行概览</button>}</div>}
      {status?.serviceState === 'running' && !authenticated && <form className="people-login" onSubmit={event => void login(event)}><div className="field-columns equal-columns"><label className="native-field">管理员用户名<input autoComplete="username" value={username} maxLength={64} disabled={!!busy} onChange={event => setUsername(event.target.value)} required /></label><label className="native-field">管理员密码<input type="password" autoComplete="current-password" value={password} maxLength={256} disabled={!!busy} onChange={event => setPassword(event.target.value)} required /></label></div><p className="field-hint">使用首次启动时创建的平台管理员。密码提交后立即清空；会话令牌仅由原生层保存。</p><button className="button primary" disabled={!!busy || reading || !username.trim() || !password}>{busy === 'login' ? '正在登录…' : '登录管理员'}</button></form>}
      {authenticated && <p className="field-hint">会话有效期至 {dateLabel(status?.expiresAt ?? null)} · 页面可见时每 5 秒刷新。{fresh ? `最近核对 ${dateLabel(loadedAt)}` : '清单尚未更新或已过期，请刷新后操作。'}</p>}
      {error && <p className="management-error" role="alert">{error}</p>}
      {unknown && <div className="management-error" role="alert"><strong>操作结果未知，已暂停继续修改</strong><p>请刷新核对目标状态。发码结果无法从用户或设备数量确认；请退出管理员并重新登录，再核对是否需要生成新码。</p><p>请求编号：{unknown.requestId}</p></div>}
      {notice && <p className="management-success" role="status">{notice}</p>}
    </section>
    {authenticated && <>
      <section className="card inspection-panel"><div className="section-title"><div><h3>用户</h3><p className="field-hint">新建配对专用用户，无平台密码。客户端通过设备配对接入。</p></div><span className="badge neutral">{inventory?.users.length ?? '—'} 位用户</span></div>
        <form className="people-create button-row" onSubmit={event => { event.preventDefault(); void mutate('create_user', newUsername.trim().toLowerCase()); }}><label className="native-field">新用户名<input value={newUsername} minLength={3} maxLength={64} pattern="[a-z0-9][a-z0-9._-]{2,63}" placeholder="例如 alice" required disabled={blocked} onChange={event => setNewUsername(event.target.value)} /></label><button className="button secondary" disabled={blocked || reading || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(newUsername.trim())}>{busy === 'create_user' ? '正在创建…' : '创建配对专用用户'}</button></form><p className="field-hint">3–64 位小写字母、数字、点、下划线或连字符。</p>
        <div className="people-table-scroll"><table className="people-table"><caption className="visually-hidden">用户清单</caption><thead><tr><th>用户名 / ID</th><th>角色</th><th>登录方式</th><th>状态</th><th>操作</th></tr></thead><tbody>{inventory?.users.map(user => <tr key={user.id}><td><strong>{user.username}</strong><small>{user.id}</small></td><td>{user.role === 'admin' ? '管理员' : '用户'}</td><td>{user.loginMode === 'pairing-only' ? '配对专用，无密码' : '平台密码'}</td><td>{user.disabled ? '已停用' : '可用'}</td><td><div className="button-row"><button className="button secondary" disabled={blocked || user.disabled || user.role === 'admin'} onClick={() => { setSelectedUser(user.id); setPair(null); }}>选择并配对</button><button className="button secondary" disabled={blocked || user.disabled || user.id === status?.admin?.id} onClick={event => openConfirmation({ kind: 'disable_user', id: user.id, name: user.username, userId: user.id }, event.currentTarget)}>停用</button></div></td></tr>)}</tbody></table></div>{!inventory && <p className="field-hint">用户清单不可用，请刷新。</p>}{inventory && !inventory.users.length && <p className="field-hint">尚无用户。</p>}
      </section>
      <section className="card inspection-panel"><div className="section-title"><div><h3>设备配对码</h3><p className="field-hint">一体配对码有效期为 5 分钟。客户端粘贴后自动配置中央地址和证书，无需单独导入 CA。</p></div></div><label className="native-field">目标用户<select disabled={blocked} value={selectedUser} onChange={event => { setSelectedUser(event.target.value); setPair(null); }}><option value="">请选择可用用户</option>{inventory?.users.filter(user => !user.disabled && user.role === 'user').map(user => <option key={user.id} value={user.id}>{user.username}</option>)}</select></label><p className="field-hint">统一配对后优先连接局域网，不可达时自动使用中央已配置的公网中继。</p><p className="field-hint">重新发码会使该用户之前未使用的配对码失效。退出页面或管理员会话会隐藏当前码。</p><button className="button primary" disabled={blocked || reading || !selected || selected.disabled} onClick={() => void mutate('pair_code', selectedUser)}>{busy === 'pair_code' ? '正在生成…' : pair ? '重新生成配对码' : '生成配对码'}</button>
        {pair && countdown > 0 && fresh && <div className="resource-result people-pair"><strong>{pair.username} 的配对码 · 剩余 {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</strong><textarea aria-label="一体配对码" readOnly rows={3} value={pair.connectionCode ?? pair.code} /><button className="button secondary" onClick={() => void copyPair()}>复制配对码</button><p>使用情况需要与目标设备核对；页面倒计时不代表配对码尚未被消费。</p></div>}
      </section>
      <section className="card inspection-panel"><div className="section-title"><div><h3>设备</h3><p className="field-hint">撤销后设备连接失效，再次使用需要重新配对；历史记录保留。</p></div><span className="badge neutral">{inventory?.devices.length ?? '—'} 台设备</span></div><div className="people-table-scroll"><table className="people-table"><caption className="visually-hidden">设备清单</caption><thead><tr><th>设备 / ID</th><th>所属用户</th><th>连接</th><th>创建时间</th><th>最近活动</th><th>状态 / 操作</th></tr></thead><tbody>{inventory?.devices.map(device => <tr key={device.id}><td><strong>{device.name}</strong><small>{device.id}</small></td><td>{inventory.users.find(user => user.id === device.userId)?.username ?? device.userId}</td><td>{device.online ? '在线' : '离线'}</td><td>{dateLabel(device.createdAt)}</td><td>{dateLabel(device.lastSeenAt)}</td><td>{device.revoked ? '已撤销' : <button className="button secondary" disabled={blocked} onClick={event => openConfirmation({ kind: 'revoke_device', id: device.id, name: device.name, userId: device.userId }, event.currentTarget)}>撤销设备</button>}</td></tr>)}</tbody></table></div>{!inventory && <p className="field-hint">设备清单不可用，请刷新。</p>}{inventory && !inventory.devices.length && <p className="field-hint">尚无设备，生成配对码后在目标客户端完成配对。</p>}</section>
    </>}
    {confirmation && authenticated && fresh && <div className="people-confirm-backdrop"><section ref={dialog} className="card people-confirm" role="alertdialog" aria-modal="true" aria-labelledby="people-confirm-title" aria-describedby="people-confirm-description"><h3 id="people-confirm-title">{confirmation.kind === 'disable_user' ? '确认停用用户' : '确认撤销设备'}：{confirmation.name}</h3><p id="people-confirm-description">{confirmation.kind === 'disable_user' ? '该用户将无法继续接入，已有会话和设备连接将失效，活动任务可能被中断。历史记录保留，本页面暂不支持重新启用。' : '此设备将失去访问权限，连接和活动操作可能中断。历史记录保留；再次使用必须重新配对。'}</p><p className="field-hint">目标 ID：{confirmation.id}</p>{reading && <p className="field-hint" role="status">正在核对清单，请稍候确认。取消仍可使用。</p>}<div className="button-row"><button className="button secondary" onClick={() => setConfirmation(null)}>取消</button><button className="button primary" disabled={blocked || reading} onClick={() => void mutate(confirmation.kind, confirmation.id)}>{confirmation.kind === 'disable_user' ? '确认停用此用户' : '确认撤销此设备'}</button></div></section></div>}
  </div>;
}
