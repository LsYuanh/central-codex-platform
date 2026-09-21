// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { useEffect, useRef, useState } from 'react';
import { nativeAvailable, nativeCall } from './native';
import { readAccountReport, serviceMessage, type AccountReport } from './service-client';

type Login = { loginId: string; state: 'pending' | 'completed'; verificationUrl: string; userCode: string; expiresAt: number; account: AccountReport | null };
function parse(value: unknown): Login {
  const v = value as Partial<Login> | null;
  if (!v || typeof v.loginId !== 'string' || !/^[a-f0-9]{32}$/.test(v.loginId) ||
    !['pending', 'completed'].includes(String(v.state)) || v.verificationUrl !== 'https://auth.openai.com/codex/device' ||
    typeof v.userCode !== 'string' || !v.userCode || v.userCode.length > 1024 || !Number.isSafeInteger(v.expiresAt)) throw { code: 'UI_PROTOCOL_INVALID' };
  const account = v.account == null ? null : readAccountReport(v.account);
  if ((v.state === 'completed') !== !!account) throw { code: 'UI_PROTOCOL_INVALID' };
  return { ...v, account } as Login;
}
export function ManagedModelLogin({ onComplete, disabled }: { onComplete: (account: AccountReport) => void; disabled: boolean }) {
  const [login, setLogin] = useState<Login | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true), current = useRef<Login | null>(null), callback = useRef(onComplete), locked = useRef(false);
  callback.current = onComplete;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const id = current.current?.loginId; if (id) void nativeCall('central_model_login_cancel', 25000, { loginId: id }).catch(() => {}); }; }, []);
  useEffect(() => {
    if (!login || login.state !== 'pending') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (stopped) return;
      try {
        if (Date.now() >= login!.expiresAt) throw { code: 'MODEL_LOGIN_EXPIRED' };
        const value = parse(await nativeCall('central_model_login_poll', 40000, { loginId: login!.loginId }));
        if (stopped || !mounted.current) return;
        if (value.account) { current.current = null; setLogin(null); callback.current(value.account); return; }
        timer = setTimeout(() => void poll(), 5000);
      } catch (cause) {
        if (!stopped && mounted.current) { setError(serviceMessage(cause)); setLogin(null); current.current = null; void nativeCall('central_model_login_cancel', 25000, { loginId: login!.loginId }).catch(() => {}); }
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login]);
  async function start() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { const value = parse(await nativeCall('central_model_login_start', 25000)); if (mounted.current) { current.current = value; setLogin(value); } else void nativeCall('central_model_login_cancel', 25000, { loginId: value.loginId }); }
    catch (cause) { if (mounted.current) setError(serviceMessage(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function cancel() {
    const id = current.current?.loginId; if (!id || locked.current) return;
    locked.current = true; setBusy(true);
    try { await nativeCall('central_model_login_cancel', 25000, { loginId: id }); if (mounted.current) { current.current = null; setLogin(null); setError(''); } }
    catch (cause) { if (mounted.current) setError(serviceMessage(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="resource-result">
    <strong>中央专用登录 · 自动续期</strong>
    <p>首次授权后，中央服务会在到期前自动续期。无需保持 Codex 程序运行。</p>
    <p>此登录由中央端独立管理；刷新令牌仅保存在中央原生凭据库。</p>
    {!login && <button className="button primary" disabled={!nativeAvailable || disabled || busy} onClick={() => void start()}>{busy ? '正在准备授权…' : '开始中央专用登录'}</button>}
    {login && <div role="status"><p>在浏览器打开 <a href={login.verificationUrl} target="_blank" rel="noreferrer" onClick={event => { if (nativeAvailable) { event.preventDefault(); void nativeCall('central_model_login_open').catch(cause => setError(serviceMessage(cause))); } }}>登录授权页面</a>，输入代码：</p><strong style={{ fontSize: '1.35rem', letterSpacing: '.12em' }}>{login.userCode}</strong><p>等待授权完成 · 有效期至 {new Date(login.expiresAt).toLocaleTimeString('zh-CN')}</p><button className="button secondary" disabled={busy} onClick={() => void cancel()}>取消授权</button></div>}
    {error && <p className="management-error" role="alert">{error}</p>}
  </div>;
}
