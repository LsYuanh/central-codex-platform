// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {invoke} from "@tauri-apps/api/core";
import {useEffect,useRef,useState} from "react";
import {deviceAuthorization,devicePairingError,type DeviceAccount} from "./platform-pairing-state";
import {UiIcon} from "./UiIcon";

const empty:DeviceAccount={authMode:"device-token-v1",loggedIn:false,paired:false};
type Disconnected={disconnected:boolean;localRemoved:boolean;remoteRevocationConfirmed:boolean};
async function call<T>(gateway:string,action:string,input:Record<string,unknown>={}):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([invoke<T>("platform_account",{gateway,action,input}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("PAIRING_RESULT_UNKNOWN")),45_000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
export function PlatformAccountSettings({gateway,disabled,onIdentity,onBoundary,onWorkingChange,onBundlePaired}:{gateway:string;disabled:boolean;onIdentity:(userId:string,deviceId:string)=>void;onBoundary:()=>void;onWorkingChange?:(working:boolean)=>void;onBundlePaired:(gateway:string,userId:string,deviceId:string)=>Promise<void>}){
  const [account,setAccount]=useState<DeviceAccount>(empty);
  const [code,setCode]=useState("");
  const [working,setWorking]=useState(false);const [reading,setReading]=useState(true);const [ready,setReady]=useState(false);
  const [notice,setNotice]=useState("");const [error,setError]=useState("");const [statusError,setStatusError]=useState("");
  const [detailsOpen,setDetailsOpen]=useState(false);
  const workingRef=useRef(false);const refreshing=useRef(false);const epoch=useRef(0);
  const identityRef=useRef(onIdentity);identityRef.current=onIdentity;
  const workingCallbackRef=useRef(onWorkingChange);workingCallbackRef.current=onWorkingChange;
  useEffect(()=>()=>workingCallbackRef.current?.(false),[]);
  const refresh=async()=>{
    if(workingRef.current||refreshing.current)return;
    if(!gateway.startsWith("wss://")){setAccount(empty);setReady(true);setReading(false);return;}
    refreshing.current=true;const requestEpoch=epoch.current;setReading(true);
    try{
      const value=await call<DeviceAccount>(gateway,"status");
      if(requestEpoch!==epoch.current)return;
      setAccount(value);setReady(true);setStatusError("");
      if(value.paired&&value.user?.id&&value.deviceId&&!value.authorizationError&&!value.storageError)identityRef.current(value.user.id,value.deviceId);
    }catch(e){if(requestEpoch===epoch.current){setReady(false);setStatusError("暂时无法确认本机配对状态。"+devicePairingError(e));}}
    finally{refreshing.current=false;if(requestEpoch===epoch.current)setReading(false);}
  };
  useEffect(()=>{
    epoch.current+=1;setAccount(empty);setCode("");setReady(false);setReading(true);setError("");setNotice("");setStatusError("");
    const first=window.setTimeout(()=>void refresh(),350);const timer=window.setInterval(()=>void refresh(),30_000);
    return()=>{epoch.current+=1;window.clearTimeout(first);window.clearInterval(timer);};
  },[gateway]);
  const run=async(action:"pair-bundle"|"disconnect",input:Record<string,unknown>={})=>{
    if(disabled||workingRef.current||refreshing.current)return;
    workingRef.current=true;const requestEpoch=++epoch.current;setWorking(true);workingCallbackRef.current?.(true);setError("");setNotice("");
    try{
      onBoundary();
      if(action==="pair-bundle"){
        const value=await call<DeviceAccount>(gateway,action,input);if(requestEpoch!==epoch.current)return;
        setAccount(value);setReady(true);
        if(!value.paired||!value.user?.id||!value.deviceId||value.storageError)throw Error(value.storageError??"PAIRING_RESULT_UNKNOWN");
        if(!value.gatewayUrl?.startsWith("wss://"))throw Error("PAIRING_RESULT_UNKNOWN");
        await onBundlePaired(value.gatewayUrl,value.user.id,value.deviceId);
      }else{
        const value=await call<Disconnected>(gateway,action,input);if(requestEpoch!==epoch.current)return;
        if(!value.localRemoved)throw Error("DEVICE_TOKEN_STORAGE_UNAVAILABLE");
        setAccount(empty);identityRef.current("","");
        setNotice(value.remoteRevocationConfirmed?"已取消本机配对，中央已撤销本设备授权，本机 Agent 已停止。":"已取消本机配对并停止 Agent；中央尚未确认撤销。请管理员在中央撤销本设备，重新使用需要新的配对码。");
      }
    }catch(e){if(requestEpoch===epoch.current)setError(devicePairingError(e));}
    finally{
      workingRef.current=false;
      if(requestEpoch===epoch.current){setCode("");setWorking(false);workingCallbackRef.current?.(false);void refresh();}
    }
  };
  const state=deviceAuthorization(account);const locked=disabled||working||reading;
  const statusLabel=!ready?reading?"读取中…":"待确认":state.valid?"已配对":account.storageError?"授权异常":account.authorizationError?"授权失效":state.hasLocalPairing?"待确认":"未配对";
  return <section className="platform-account-card" aria-label="设备配对">
    <div className="pairing-card-header">
      <div className="pairing-card-title"><h3>设备配对</h3><p className="pairing-summary"><span className={`pairing-status ${ready&&state.valid?"is-paired":""}`} role="status">{statusLabel}</span>{account.user&&<span className="pairing-user"> · {account.user.username||account.user.id}</span>}</p></div>
      <div className="pairing-card-actions"><button type="button" className="button-quiet pairing-refresh" aria-label={reading?"读取中…":"刷新状态"} disabled={locked} onClick={()=>void refresh()}><UiIcon name="refresh" />{reading?"读取中…":"刷新"}</button><button type="button" className="button-quiet pairing-details-toggle" aria-expanded={detailsOpen} aria-controls="pairing-connection-details" onClick={()=>setDetailsOpen(!detailsOpen)}>连接详情<UiIcon name="chevronDown"/></button></div>
    </div>
    {(!ready||!state.valid)&&<p className="pairing-description">{!ready?reading?"正在读取本机配对状态…":"暂时无法确认配对状态，请刷新重试。":state.notice}</p>}
    <div id="pairing-connection-details" hidden={!detailsOpen}>
    <dl className="pairing-info">
      <div><dt>处理分工</dt><dd>中央网关负责对话与任务处理；本机设备负责文件与命令执行。</dd></div>
      {account.user&&<div><dt>关联用户</dt><dd>{account.user.username||account.user.id}</dd></div>}
      <div><dt>中央地址</dt><dd>{gateway.startsWith("wss://")?<code>{gateway}</code>:"配对后自动设置"}</dd></div>
      {account.deviceId&&<div><dt>设备标识</dt><dd><code>{account.deviceId}</code></dd></div>}
    </dl>
    {(state.hasLocalPairing||account.storageError)&&<div className="pairing-card-footer">
      <p>取消后将断开本机连接，重新使用需要新的配对码。</p>
      <button type="button" className="button-danger" disabled={locked} onClick={()=>void run("disconnect")}>取消本机配对</button>
    </div>}
    </div>
    {ready&&state.problem&&<p className="settings-error" role="alert">{state.problem}</p>}
    {(!ready||state.canPair)&&<div className="pairing-form">
      <label htmlFor="device-pairing-code">一体配对码</label>
      <p id="device-pairing-help">粘贴管理员提供的完整配对码，自动配置中央地址和证书。</p>
      <div className="pairing-code-row">
        <input id="device-pairing-code" aria-label="一体配对码" aria-describedby="device-pairing-help" type="password" autoComplete="off" spellCheck={false} value={code} disabled={locked} onChange={e=>setCode(e.target.value)} maxLength={98304} placeholder="粘贴以 yzpair1. 开头的配对码" />
        <button type="button" disabled={locked||!code.trim().startsWith("yzpair1.")} onClick={()=>void run("pair-bundle",{code:code.trim()})}>{working?"正在配对…":"配对并连接"}</button>
      </div>
    </div>}
    {working&&<p className="runtime-config-notice" role="status">正在处理…</p>}{notice&&<p className="runtime-config-notice" role="status">{notice}</p>}{statusError&&<p className="settings-error" role="status">{statusError}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}
  </section>;
}
