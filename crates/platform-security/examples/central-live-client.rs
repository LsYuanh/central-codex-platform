// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// QA-only native token pairing and authenticated UI transport. No token export.
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
};
use tokio_tungstenite::tungstenite::Message;
use zeroize::Zeroizing;

const LIMIT: usize = 1024 * 1024;
fn emit(value: Value) -> Result<(), &'static str> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{value}")
        .and_then(|_| stdout.flush())
        .map_err(|_| "QA_HELPER_OUTPUT_FAILED")
}
fn frame(reader: &mut impl BufRead) -> Result<Option<Value>, &'static str> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(LIMIT));
    loop {
        let chunk = reader.fill_buf().map_err(|_| "QA_HELPER_INPUT_FAILED")?;
        if chunk.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("QA_HELPER_INPUT_TRUNCATED")
            };
        }
        let newline = chunk.iter().position(|b| *b == b'\n');
        let count = newline.map_or(chunk.len(), |n| n + 1);
        if bytes.len() + count > LIMIT {
            return Err("QA_HELPER_INPUT_LIMIT");
        }
        bytes.extend_from_slice(&chunk[..count]);
        reader.consume(count);
        if newline.is_some() {
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "QA_HELPER_INPUT_INVALID");
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    gateway: String,
    ca_path: String,
    code: String,
    token_root: PathBuf,
    namespace: String,
}

async fn run() -> Result<(), &'static str> {
    let (sender, mut input) = tokio::sync::mpsc::channel(8);
    // A normal thread avoids a Tokio blocking stdin read keeping the runtime alive.
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            let next = frame(&mut stdin);
            let end = !matches!(next, Ok(Some(_)));
            if sender.blocking_send(next).is_err() || end {
                break;
            }
        }
    });
    let value = input
        .recv()
        .await
        .ok_or("QA_HELPER_BOOTSTRAP_REQUIRED")??
        .ok_or("QA_HELPER_BOOTSTRAP_REQUIRED")?;
    let mut bootstrap: Bootstrap =
        serde_json::from_value(value).map_err(|_| "QA_HELPER_BOOTSTRAP_INVALID")?;
    let code = Zeroizing::new(std::mem::take(&mut bootstrap.code));
    let url = url::Url::parse(&bootstrap.gateway).map_err(|_| "QA_HELPER_TARGET_INVALID")?;
    let formal = std::env::args().nth(1).as_deref() == Some("--formal-4510")
        && std::env::args().count() == 2;
    let target_valid = if formal {
        // The operator pins the exact formal endpoint separately from stdin.
        std::env::var("CENTRAL_FORMAL_GATEWAY")
            .ok()
            .and_then(|value| url::Url::parse(&value).ok())
            .is_some_and(|expected| expected == url)
            && url.port() == Some(4510)
    } else {
        matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
            && url.port().is_some_and(|p| p != 4510)
    };
    if bootstrap.namespace != "com.centralcodex.harnessqa.central-live"
        || !bootstrap.token_root.is_absolute()
        || url.scheme() != "wss"
        || !target_valid
        || url.path() != "/ws"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("QA_HELPER_TARGET_INVALID");
    }
    let credential = if code.starts_with(platform_security::pairing_bundle::PREFIX) {
        let bundle = platform_security::pairing_bundle::Bundle::decode(&code)
            .map_err(|_| "QA_HELPER_BUNDLE_INVALID")?;
        if bundle.gateway != bootstrap.gateway {
            return Err("QA_HELPER_TARGET_INVALID");
        }
        let credential = platform_security::device_token::pair_bundle(
            &bootstrap.token_root,
            &bootstrap.namespace,
            &bundle,
            "Central live QA bundled Local Agent",
        )
        .await
        .map_err(|_| "QA_HELPER_PAIR_FAILED")?;
        bootstrap.ca_path = platform_security::device_token::bundled_ca_path(
            &bootstrap.token_root,
            &bootstrap.namespace,
            &bootstrap.gateway,
        )
        .map_err(|_| "QA_HELPER_CA_FAILED")?
        .and_then(|p| p.to_str().map(str::to_owned))
        .ok_or("QA_HELPER_CA_FAILED")?;
        credential
    } else {
        platform_security::device_token::pair(
            &bootstrap.token_root,
            &bootstrap.namespace,
            &bootstrap.gateway,
            &bootstrap.ca_path,
            &code,
            "Central live QA Local Agent",
        )
        .await
        .map_err(|_| "QA_HELPER_PAIR_FAILED")?
    };
    drop(code);
    emit(json!({"kind":"paired","deviceId":credential.device_id,"caPath":bootstrap.ca_path}))?;
    drop(credential);
    let result=async {
        let mut socket=platform_security::device_token::agent_socket(&bootstrap.token_root,&bootstrap.namespace,&bootstrap.gateway,&bootstrap.ca_path).await.map_err(|_|"QA_HELPER_SOCKET_FAILED")?;
        emit(json!({"kind":"connected"}))?;
        loop {tokio::select! {
            command=input.recv()=>{
                let Some(Ok(Some(value)))=command else {let _=socket.close(None).await;break;};
                if value.get("kind").and_then(Value::as_str)==Some("send"){
                    let message=value.get("message").ok_or("QA_HELPER_INPUT_INVALID")?;
                    socket.send(Message::Text(message.to_string().into())).await.map_err(|_|"QA_HELPER_SOCKET_FAILED")?;
                }else if value.get("kind").and_then(Value::as_str)==Some("close"){let _=socket.close(None).await;break;}
                else{return Err("QA_HELPER_INPUT_INVALID");}
            }
            received=socket.next()=>match received {
                Some(Ok(Message::Text(text)))=>{
                    if text.len()>LIMIT{return Err("QA_HELPER_OUTPUT_LIMIT");}
                    let message:Value=serde_json::from_str(&text).map_err(|_|"QA_HELPER_MESSAGE_INVALID")?;
                    emit(json!({"kind":"message","message":message}))?;
                },
                Some(Ok(Message::Close(close)))=>{
                    let code=close.as_ref().map(|f|u16::from(f.code));
                    let reason=close.as_ref().map(|f|f.reason.as_ref()).filter(|s|matches!(*s,"DEVICE_REVOKED"|"AUTH_REQUIRED")).unwrap_or("QA_SOCKET_CLOSED");
                    emit(json!({"kind":"closed","code":code,"reason":reason}))?;break;
                },
                Some(Ok(Message::Ping(bytes)))=>{socket.send(Message::Pong(bytes)).await.map_err(|_|"QA_HELPER_SOCKET_FAILED")?;},
                Some(Ok(_))=>{},
                Some(Err(_))|None=>return Err("QA_HELPER_SOCKET_ENDED"),
            }
        }}
        Ok(())
    }.await;
    platform_security::device_token::remove(
        &bootstrap.token_root,
        &bootstrap.namespace,
        &bootstrap.gateway,
    )
    .map_err(|_| "QA_HELPER_TOKEN_CLEANUP_FAILED")?;
    emit(json!({"kind":"cleanup","localRemoved":true}))?;
    result
}
#[tokio::main]
async fn main() {
    if let Err(code) = run().await {
        eprintln!("{code}");
        std::process::exit(1);
    }
}
