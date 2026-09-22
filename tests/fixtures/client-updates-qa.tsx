// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ClientUpdatePanel,useClientUpdates} from "../../apps/desktop/src/client-updates";
import "../../apps/desktop/src/styles.css";
const test=window as any;
test.isTauri=true;
test.updateFixture={checkFail:false,downloadFail:false,current:false,calls:[]};
test.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any)=>{
  const f=test.updateFixture;f.calls.push(command);
  if(command==="desktop_update_check"){if(f.checkFail)throw Error("检查更新超时，请重试");return f.current?{current:true}:{version:"0.2.0",notes:"新增版本更新\n保留设置、配对和已有对话"};}
  if(command==="desktop_update_download"){
    args.onEvent.onmessage({stage:"downloading",received:2097152,total:f.unknownTotal?undefined:4194304});
    await new Promise(r=>setTimeout(r,f.downloadDelay??200));
    args.onEvent.onmessage({stage:"verifying",received:4194304,total:4194304});
    await new Promise(r=>setTimeout(r,f.verifyDelay??200));
    if(f.downloadFail)throw Error("更新包签名校验失败，未安装任何内容");
    return{version:"0.2.0",notes:"新增版本更新",ready:true};
  }
  if(command==="desktop_update_install")throw Error("还有对话或本机操作正在进行，请结束后再安装");
}};
function Fixture(){const[enabled,setEnabled]=useState(true);const update=useClientUpdates("test",enabled);const[busy,setBusy]=useState(false);test.setUpdateBusy=setBusy;test.setUpdateEnabled=setEnabled;
  return <main className="settings-page" style={{background:"var(--canvas)"}}><ClientUpdatePanel update={update} version="0.1.0" busy={busy} enabled={enabled}/></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
