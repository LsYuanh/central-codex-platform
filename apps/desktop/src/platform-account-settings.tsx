// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {invoke} from "@tauri-apps/api/core";
import {useEffect,useRef,useState} from "react";
import {deviceAuthorization,devicePairingError,type DeviceAccount} from "./platform-pairing-state";

const empty:DeviceAccount={authMode:"device-token-v1",loggedIn:false,paired:false};
type Disconnected={disconnected:boolean;localRemoved:boolean;remoteRevocationConfirmed:boolean};
async function call<T>(gateway:string,action:string,input:Record<string,unknown>={}):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([invoke<T>("platform_account",{gateway,action,input}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("PAIRING_RESULT_UNKNOWN")),45_000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
export function PlatformAccountSettings({gateway,disabled,onIdentity,onBoundary,onWorkingChange,onBundlePaired}:{gateway:string;disabled:boolean;onIdentity:(userId:string,deviceId:string)=>void;onBoundary:()=>void;onWorkingChange?:(working:boolean)=>void;onBundlePaired:(gateway:string,userId:string,deviceId:string)=>Promise<void>}){
  const [account,setAccount]=useState<DeviceAccount>(empty);
  const [code,setCode]=useState("");const [name,setName]=useState("我的电脑");const [ca,setCa]=useState("");
  const [working,setWorking]=useState(false);const [reading,setReading]=useState(true);const [ready,setReady]=useState(false);
  const [notice,setNotice]=useState("");const [error,setError]=useState("");const [statusError,setStatusError]=useState("");
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
    epoch.current+=1;setAccount(empty);setCode("");setCa("");setReady(false);setReading(true);setError("");setNotice("");setStatusError("");
    const first=window.setTimeout(()=>void refresh(),350);const timer=window.setInterval(()=>void refresh(),30_000);
    return()=>{epoch.current+=1;window.clearTimeout(first);window.clearInterval(timer);};
  },[gateway]);
  const run=async(action:"pair"|"pair-bundle"|"disconnect"|"set-ca",input:Record<string,unknown>={})=>{
    if(disabled||workingRef.current||refreshing.current)return;
    workingRef.current=true;const requestEpoch=++epoch.current;setWorking(true);workingCallbackRef.current?.(true);setError("");setNotice("");
    try{
      if(action==="pair"||action==="pair-bundle"||action==="disconnect")onBoundary();
      if(action==="pair"||action==="pair-bundle"){
        const value=await call<DeviceAccount>(gateway,action,input);if(requestEpoch!==epoch.current)return;
        setAccount(value);setReady(true);
        if(!value.paired||!value.user?.id||!value.deviceId||value.storageError)throw Error(value.storageError??"PAIRING_RESULT_UNKNOWN");
        if(action==="pair-bundle"){if(!value.gatewayUrl?.startsWith("wss://"))throw Error("PAIRING_RESULT_UNKNOWN");await onBundlePaired(value.gatewayUrl,value.user.id,value.deviceId);}else{identityRef.current(value.user.id,value.deviceId);setNotice("本机已授权。确认下方默认输出目录后，点击“保存并应用”开始连接。");}
      }else if(action==="disconnect"){
        const value=await call<Disconnected>(gateway,action,input);if(requestEpoch!==epoch.current)return;
        if(!value.localRemoved)throw Error("DEVICE_TOKEN_STORAGE_UNAVAILABLE");
        setAccount(empty);identityRef.current("","");
        setNotice(value.remoteRevocationConfirmed?"已取消本机配对，中央已撤销本设备授权，本机 Agent 已停止。":"已取消本机配对并停止 Agent；中央尚未确认撤销。请管理员在中央撤销本设备，重新使用需要新的配对码。");
      }else{
        await call(gateway,action,input);if(requestEpoch!==epoch.current)return;
        setNotice("中央 CA 设置已保存，连接会验证服务端证书和主机名。");
      }
    }catch(e){if(requestEpoch===epoch.current)setError(devicePairingError(e));}
    finally{
      workingRef.current=false;
      if(requestEpoch===epoch.current){setCode("");setWorking(false);workingCallbackRef.current?.(false);void refresh();}
    }
  };
  const state=deviceAuthorization(account);const locked=disabled||working||reading;
  return <div className="settings-card form-settings-card platform-account-card">
    <p className="runtime-config-notice" role="status">{!ready?reading?"正在读取本机配对状态…":"本机配对状态尚未确认。":state.notice}</p>
    {account.user&&<div className="settings-value-row"><span><strong>关联用户</strong></span><code>{account.user.username||account.user.id}</code></div>}
    {account.deviceId&&<details className="connection-details"><summary>设备详情</summary><div className="settings-value-row"><span><strong>设备标识</strong><small>用于区分本机安装身份</small></span><code>{account.deviceId}</code></div></details>}
    {ready&&state.problem&&<p className="settings-error" role="alert">{state.problem}</p>}
    {(!ready||state.canPair)&&<>
      <label className="settings-field"><span><strong>一体配对码</strong><small>粘贴中央管理员提供的完整配对码，自动配置地址和证书。</small></span><input aria-label="一体配对码" type="password" autoComplete="off" spellCheck={false} value={code} disabled={locked} onChange={e=>setCode(e.target.value)} maxLength={98304}/></label>
      <details><summary>旧版配对方式</summary><label className="settings-field"><span><strong>本机设备名称</strong></span><input aria-label="本机设备名称" value={name} disabled={locked||!ready||!state.canPair} onChange={e=>setName(e.target.value)} maxLength={128}/></label>
      <div className="settings-actions"><button type="button" disabled={locked||!ready||!state.canPair||!code.trim()||!name.trim()} onClick={()=>void run("pair",{code:code.trim(),name:name.trim()})}>使用旧版配对码</button></div></details>
      <div className="settings-actions"><button type="button" disabled={locked||!code.trim().startsWith("yzpair1.")} onClick={()=>void run("pair-bundle",{code:code.trim()})}>配对并连接</button></div>
    </>}
    {(state.hasLocalPairing||account.storageError)&&<div className="settings-actions"><button type="button" className="button-secondary" disabled={locked} onClick={()=>void run("disconnect")}>取消本机配对</button></div>}
    <p className="runtime-config-hint">设备由管理员在中央统一管理。取消本机配对会停止本机连接；重新使用需要管理员提供新的配对码。</p>
    <details><summary>高级：中央证书设置（旧版配对）</summary><p className="runtime-config-hint">使用系统信任的服务端证书时无需设置。内网自建 CA 请填写管理员提供的本机 PEM 公共证书路径，仅用于验证当前中央地址。</p><label className="settings-field"><span>CA 证书路径</span><input aria-label="中央 CA 证书路径" value={ca} disabled={locked} onChange={e=>setCa(e.target.value)}/></label><button type="button" disabled={locked} onClick={()=>void run("set-ca",{path:ca.trim()})}>保存证书设置</button></details>
    <div className="settings-actions"><button type="button" className="button-secondary" disabled={locked||reading} onClick={()=>void refresh()}>{reading?"正在读取状态…":"重新读取配对状态"}</button></div>
    {working&&<p role="status">正在处理…</p>}{notice&&<p className="runtime-config-notice" role="status">{notice}</p>}{statusError&&<p className="settings-error" role="status">{statusError}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}
  </div>;
}
