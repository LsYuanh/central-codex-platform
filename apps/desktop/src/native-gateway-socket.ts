// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import { t, UiError } from "./i18n.ts";

import { invoke } from "./native-invoke";
import { Channel } from "@tauri-apps/api/core";
import {exactGatewayAuthCode,gatewayAuthCode} from "./gateway-auth-error";
import {centralTransportCode} from "./platform-pairing-state";

/** Only protocol frames cross IPC. TLS and bearer credentials stay in Rust. */
export class NativeGatewaySocket extends EventTarget {
  public readyState:number=WebSocket.CONNECTING;
  private readonly id=crypto.randomUUID();
  private closing=false;
  public failureError="";
  public constructor(){
    super();
    const channel=new Channel<{type:string;data?:string;code?:string}>();
    channel.onmessage=event=>{
      if(event.type==="open"){
        if(this.closing||this.readyState===WebSocket.CLOSED){void invoke("platform_ws_send",{connectionId:this.id,data:null}).catch(()=>undefined);return;}
        this.readyState=WebSocket.OPEN;this.dispatchEvent(new Event("open"));
      }else if(event.type==="message"&&this.readyState===WebSocket.OPEN)this.dispatchEvent(new MessageEvent("message",{data:event.data}));
      else if(event.type==="close")this.finish(exactGatewayAuthCode(event.code));
    };
    void invoke("platform_ws_open",{connectionId:this.id,onEvent:channel}).catch(error=>{if(this.readyState===WebSocket.CLOSED)return;this.failureError=gatewayAuthCode(error)??centralTransportCode(error)??t("中央连接或 TLS 证书校验失败");this.dispatchEvent(new Event("error"));this.finish();});
  }
  public send(data:string){
    if(this.readyState!==WebSocket.OPEN)throw new UiError("中央连接已关闭");
    void invoke("platform_ws_send",{connectionId:this.id,data}).catch(error=>{if(this.readyState===WebSocket.CLOSED)return;this.failureError=gatewayAuthCode(error)??t("中央连接已关闭");this.dispatchEvent(new Event("error"));this.close();});
  }
  public close(){this.closing=true;if(this.readyState===WebSocket.OPEN)void invoke("platform_ws_send",{connectionId:this.id,data:null}).catch(()=>undefined);this.finish();}
  private finish(code?:string){if(this.readyState===WebSocket.CLOSED)return;if(code)this.failureError=code;this.readyState=WebSocket.CLOSED;this.dispatchEvent(new Event("close"));}
}
