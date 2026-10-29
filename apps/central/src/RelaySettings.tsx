// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {useEffect,useRef,useState} from 'react';
import {nativeAvailable,nativeCall} from './native';
type Status={configured:boolean;state:'disabled'|'waiting-service'|'connecting'|'connected'|'reconnecting'|'failed';error:string|null;relayUrl:string|null};
const labels:Record<Status['state'],string>={disabled:'未启用', 'waiting-service':'等待中央服务启动',connecting:'正在连接公网中继',connected:'公网中继已连接',reconnecting:'公网中继正在重连',failed:'公网中继连接失败'};
function message(cause:unknown){
  const code=(cause as {code?:string})?.code;
  if(code==='SERVICE_ALREADY_ACTIVE')return '请在中央服务停止且清理完成后修改中继配置。';
  if(code==='RELAY_CONFIG_INVALID')return '请检查 HTTPS 中继地址、接入密钥和 CA 证书。';
  if(code==='RELAY_NOT_READY')return '公网中继尚未连接，请检查网络与中继服务后重试。';
  if(code==='RELAY_STORAGE_FAILED')return '无法保存中继凭据，请检查中央应用资料目录和当前系统账号权限。';
  return '操作未能确认，请刷新状态后重试。';
}
export function RelaySettings(){
  const [status,setStatus]=useState<Status|null>(null),[url,setUrl]=useState(''),[token,setToken]=useState(''),[ca,setCa]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const mounted=useRef(false),lock=useRef(false),readLock=useRef(false);
  async function refresh(quiet=false){if(!nativeAvailable||readLock.current||lock.current)return;readLock.current=true;
    try{const value=await nativeCall<Status>('central_relay_status');if(mounted.current){setStatus(value);if(!quiet)setError('');}}
    catch{if(mounted.current&&!quiet)setError('无法读取公网中继状态，请重试。');}finally{readLock.current=false;}}
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>void refresh(true),3000);return()=>{mounted.current=false;clearInterval(timer);};},[]);
  async function save(enabled:boolean){if(lock.current)return;
    if(enabled){try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||token.trim().length<32)throw Error();}catch{setError('请填写有效的 HTTPS 中继地址和接入密钥。');return;}}
    lock.current=true;setBusy(true);setError('');setNotice('');
    try{const value=await nativeCall<Status>('central_relay_save',15000,{access:enabled?{url:url.trim(),token:token.trim(),caPem:ca.trim()}:null});if(mounted.current){setStatus(value);setToken('');setCa('');setNotice(enabled?'公网中继配置已保存，中央服务启动后自动连接。已配对的新客户端连接后会自动同步，无需重新配对。':'公网中继已关闭，局域网连接保持可用。');}}
    catch(cause){if(mounted.current)setError(message(cause));}finally{lock.current=false;if(mounted.current)setBusy(false);}}
  return <section className="card relay-settings" aria-labelledby="relay-heading">
    <div className="section-title"><h2 id="relay-heading">公网中继</h2><button className="button secondary" disabled={!nativeAvailable||busy} onClick={()=>void refresh()}>刷新状态</button></div>
    <p className="section-description">让外网客户端通过加密中继连接中央。客户端仍使用配对码，文件与命令仍由本机设备执行。</p>
    <p role="status" aria-atomic="true">{!nativeAvailable?'请在中央管理桌面 App 中配置。':status?labels[status.state]:error?'状态读取失败':'正在读取状态…'}{status?.relayUrl?` · ${status.relayUrl}`:''}</p>
    {status?.error&&<p className="field-error">连接尚未就绪，请检查中继服务、接入密钥和证书。中央局域网服务可独立使用。</p>}
    <details><summary>配置中继连接</summary><p className="field-hint">修改前先停止中央服务。接入密钥只保存在本机私有凭据库，不写入页面草稿。</p>
      <fieldset disabled={!nativeAvailable||busy}>
        <label className="native-field">中继地址<input type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://relay.example.com:38443/" autoComplete="off" /></label>
        <label className="native-field">中继接入密钥<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="new-password" /></label>
        <label className="native-field">中继 CA 证书（可选）<textarea value={ca} onChange={e=>setCa(e.target.value)} rows={3} autoComplete="off" /></label>
        <p className="field-hint">使用公共受信证书时留空；私有证书需填写 PEM 格式的 CA。</p>
        <div className="button-row"><button className="button primary" onClick={()=>void save(true)}>{busy?'正在保存…':'保存中继配置'}</button><button className="button secondary" disabled={!status?.configured} onClick={()=>void save(false)}>关闭公网中继</button></div>
      </fieldset>
    </details>
    {error&&<p className="field-error" role="alert">{error}</p>}{notice&&<p className="management-success" role="status">{notice}</p>}
  </section>;
}
