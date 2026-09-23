// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {useEffect, useState} from 'react';
import {nativeAvailable, nativeCall} from './native';
type Status={state:string;currentVersion:string;latestVersion:string|null;checkedAt:number|null;code:string|null};
const labels:Record<string,string>={idle:'等待自动检查',checking:'正在检查',downloading:'正在下载并校验',
  'waiting-for-package':'等待兼容运行包','waiting-for-idle':'等待任务结束',applying:'正在切换',
  'rolling-back':'正在恢复上一版','rolled-back':'已恢复上一版',updated:'更新已生效',
  'up-to-date':'已是最新兼容版本',failed:'检查或更新失败','activation-unconfirmed':'更新验证通过，开放连接尚未确认',unsupported:'此平台暂不支持自动更新'};
const reasons:Record<string,string>={UPDATE_CHANNEL_NOT_PUBLISHED:'更新通道尚未发布兼容运行包。',
  UPDATE_PREVIOUSLY_FAILED:'此运行包曾验证失败，等待后续修复版本。',UPDATE_NETWORK_UNAVAILABLE:'网络连接失败，稍后会自动重试。',
  SERVICE_UPDATE_UNSUPPORTED:'当前运行包不支持空闲切换，首次启用需要升级完整中央管理应用。',
  UPDATE_SIGNATURE_INVALID:'签名校验失败，已拒绝使用该运行包。'};
export function RuntimeUpdates(){
  const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState(false);
  useEffect(()=>{
    if(!nativeAvailable)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
    const read=async()=>{
      try{const value=await nativeCall<Status>('central_runtime_update_status');if(!disposed){setStatus(value);setError('');}}
      catch{if(!disposed)setError('无法读取更新状态，请稍后重试。');}
      finally{if(!disposed)timer=setTimeout(read,4000);}
    };
    void read();return()=>{disposed=true;clearTimeout(timer);};
  },[]);
  async function check(){
    setPending(true);setNotice('');
    try{await nativeCall('central_runtime_update_check');setNotice('已安排检查，将在 30 秒内开始。');}
    catch{setNotice('未能安排检查，请重试。');}finally{setPending(false);}
  }
  return <section className="card inspection-panel">
    <div className="section-title"><h2>App Server 更新</h2><button className="button secondary" disabled={!nativeAvailable||pending||status?.state==='unsupported'} onClick={()=>void check()}>{pending?'正在安排':'检查更新'}</button></div>
    <p className="section-description">每天检查官方稳定版，兼容验证通过后在任务结束时自动切换；保留上一版及必要的数据备份。</p>
    <p role="status">{!nativeAvailable?'请在中央管理应用中查看。':status?labels[status.state]??'状态暂不可用':error?'更新状态暂不可用':'正在读取更新状态…'}</p>
    {status&&<dl className="diagnostics-values"><div><dt>当前版本</dt><dd>{status.currentVersion}</dd></div><div><dt>官方稳定版</dt><dd>{status.latestVersion??'尚未检查'}</dd></div><div><dt>上次检查</dt><dd>{status.checkedAt?new Date(status.checkedAt).toLocaleString('zh-CN'):'尚未检查'}</dd></div></dl>}
    {status?.code&&<p className="field-hint">{reasons[status.code]??'更新未完成，现有版本会保留。'} <code>{status.code}</code></p>}
    {(error||notice)&&<p className="field-hint" role="status">{error||notice}</p>}
  </section>;
}
