// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};
use tauri::{Manager, ipc::Channel};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::Message;
pub static LAUNCH_CONTEXT: std::sync::OnceLock<(String, PathBuf)> = std::sync::OnceLock::new();

fn terminal_close_code(reason: &str) -> Option<&'static str> {
    // Return a known constant, never a server-supplied free-form close reason.
    const CODES: [&str; 7] = [
        "DEVICE_REVOKED",
        "AUTH_REQUIRED",
        "AUTH_MODE_UNSUPPORTED",
        "DEVICE_TOKEN_REQUIRED",
        "DEVICE_TOKEN_STORAGE_UNSAFE",
        "DEVICE_TOKEN_STORAGE_CORRUPT",
        "DEVICE_TOKEN_STORAGE_UNAVAILABLE",
    ];
    CODES.into_iter().find(|code| *code == reason)
}

fn close_event(code: Option<&'static str>) -> Value {
    match code {
        Some(code) => json!({"type":"close","code":code}),
        None => json!({"type":"close"}),
    }
}

pub struct PlatformState {
    pub namespace: String,
    pub directory: PathBuf,
    guard: Mutex<()>,
    sockets: Mutex<HashMap<String, NativeSocket>>,
}
struct NativeSocket {
    sender: mpsc::Sender<Option<String>>,
    task: tokio::task::JoinHandle<()>,
}
impl PlatformState {
    pub fn new(namespace: String, directory: PathBuf) -> Self {
        Self {
            namespace,
            directory,
            guard: Mutex::new(()),
            sockets: Mutex::new(HashMap::new()),
        }
    }
    pub fn ca(&self, gateway: &str) -> Result<String, String> {
        if let Some(path) = platform_security::device_token::bundled_ca_path(
            &self.directory,
            &self.namespace,
            gateway,
        )? {
            return path
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "中央证书路径无效".into());
        }
        let path = self.directory.join("platform-ca-v1.json");
        let map: Value = match std::fs::read(path) {
            Ok(raw) => serde_json::from_slice(&raw).map_err(|_| "中央证书配置损坏")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
            Err(_) => return Err("中央证书配置不可读".into()),
        };
        Ok(map[platform_security::origin(gateway)?]
            .as_str()
            .unwrap_or("")
            .into())
    }
    async fn close_sockets(&self) {
        let sockets = self
            .sockets
            .lock()
            .await
            .drain()
            .map(|(_, socket)| socket)
            .collect::<Vec<_>>();
        for socket in sockets {
            socket.task.abort();
            let _ = socket.task.await;
        }
    }
}
#[tauri::command]
pub async fn platform_account(
    state: tauri::State<'_, PlatformState>,
    runtime: tauri::State<'_, crate::runtime::DesktopRuntime>,
    gateway: String,
    action: String,
    input: Value,
) -> Result<Value, String> {
    let _guard = state.guard.lock().await;
    if action == "pair-bundle" {
        let bundle = platform_security::pairing_bundle::Bundle::decode(
            input["code"].as_str().unwrap_or(""),
        )?;
        if runtime
            .view()
            .await
            .overrides
            .iter()
            .any(|value| value == "CODEXIA_GATEWAY_AGENT_URL")
        {
            return Err("PAIR_GATEWAY_OVERRIDDEN".into());
        }
        state.close_sockets().await;
        runtime.0.write().await.process.take();
        let name = crate::runtime::computer_name()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "我的电脑".into());
        let c = platform_security::device_token::pair_bundle(
            &state.directory,
            &state.namespace,
            &bundle,
            &name,
        )
        .await?;
        let mut public = c.public();
        public["gatewayUrl"] = json!(bundle.gateway);
        public["remoteAvailable"] = json!(true);
        return Ok(public);
    }
    platform_security::origin(&gateway)?;
    let string = |name: &str| input[name].as_str().unwrap_or("");
    if action == "logout" || action == "disconnect" {
        state.close_sockets().await;
        runtime.0.write().await.process.take();
        // A damaged CA configuration must not prevent explicit local unpairing.
        // An unsuccessful remote request is reported as unconfirmed.
        let ca = state.ca(&gateway).unwrap_or_default();
        return platform_security::device_token::disconnect(
            &state.directory,
            &state.namespace,
            &gateway,
            &ca,
        )
        .await;
    }
    let ca = state.ca(&gateway)?;
    match action.as_str() {
        "set-ca" => {
            let path = string("path");
            platform_security::http(path)?;
            let target = state.directory.join("platform-ca-v1.json");
            let mut map: Value = if target.exists() {
                serde_json::from_slice(&std::fs::read(&target).map_err(|_| "证书配置读取失败")?)
                    .map_err(|_| "证书配置损坏")?
            } else {
                json!({})
            };
            map[platform_security::origin(&gateway)?] = json!(path);
            std::fs::create_dir_all(&state.directory).map_err(|_| "证书配置目录不可用")?;
            use std::io::Write;
            let mut file = tempfile::NamedTempFile::new_in(&state.directory)
                .map_err(|_| "证书配置保存失败")?;
            file.write_all(&serde_json::to_vec_pretty(&map).map_err(|_| "证书配置编码失败")?)
                .map_err(|_| "证书配置保存失败")?;
            file.as_file().sync_all().map_err(|_| "证书配置保存失败")?;
            file.persist(target).map_err(|_| "证书配置保存失败")?;
            Ok(json!({"saved":true}))
        }
        "status" => Ok(platform_security::device_token::status(
            &state.directory,
            &state.namespace,
            &gateway,
            &ca,
        )
        .await),
        "pair" => {
            state.close_sockets().await;
            runtime.0.write().await.process.take();
            let c = platform_security::device_token::pair(
                &state.directory,
                &state.namespace,
                &gateway,
                &ca,
                string("code"),
                string("name"),
            )
            .await?;
            let mut public = c.public();
            public["status"] = json!("active");
            public["remoteAvailable"] = json!(true);
            Ok(public)
        }
        _ => Err("不支持的平台账号操作".into()),
    }
}

#[tauri::command]
pub async fn platform_ws_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PlatformState>,
    runtime: tauri::State<'_, crate::runtime::DesktopRuntime>,
    connection_id: String,
    on_event: Channel<Value>,
) -> Result<(), String> {
    if connection_id.len() > 128 {
        return Err("连接标识无效".into());
    }
    let _guard = state.guard.lock().await;
    let config = runtime.view().await.effective;
    let ca = state.ca(&config.gateway_url)?;
    let c = platform_security::device_token::load(
        &state.directory,
        &state.namespace,
        &config.gateway_url,
    )?;
    if c.device_id != config.device_id || c.user.id != config.user_id {
        return Err("请应用中央配对获得的用户与设备配置".into());
    }
    let url = crate::runtime::ui_url(&config);
    let socket = platform_security::socket(&url, &ca, c.bearer()).await?;
    let mut sockets = state.sockets.lock().await;
    if sockets.len() >= 4 || sockets.contains_key(&connection_id) {
        return Err("已有中央连接，请先关闭".into());
    }
    let (tx, mut rx) = mpsc::channel::<Option<String>>(64);
    on_event
        .send(json!({"type":"open"}))
        .map_err(|_| "页面通道已关闭")?;
    let task_connection_id = connection_id.clone();
    let task = tokio::spawn(async move {
        let (mut sink, mut source) = socket.split();
        let mut close_code = None;
        loop {
            tokio::select! {
                item=source.next()=>match item{
                    Some(Ok(Message::Text(text)))=>{if on_event.send(json!({"type":"message","data":text.as_str()})).is_err(){break;}},
                    Some(Ok(Message::Ping(bytes)))=>{if sink.send(Message::Pong(bytes)).await.is_err(){break;}},
                    Some(Ok(Message::Close(frame)))=>{
                        close_code=frame.as_ref().and_then(|frame|terminal_close_code(frame.reason.as_str()));
                        break;
                    },
                    None|Some(Err(_))=>break,
                    _=>{}
                },
                outgoing=rx.recv()=>match outgoing{Some(Some(text))=>if sink.send(Message::Text(text.into())).await.is_err(){break;},_=>break}
            }
        }
        app.state::<PlatformState>()
            .sockets
            .lock()
            .await
            .remove(&task_connection_id);
        // Deliver terminal authentication state even if the transport cannot
        // complete its close handshake. The renderer must stop automatic retry.
        let _ = on_event.send(close_event(close_code));
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sink.close()).await;
    });
    sockets.insert(connection_id, NativeSocket { sender: tx, task });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_close_preserves_only_exact_safe_codes() {
        assert_eq!(
            close_event(terminal_close_code("DEVICE_REVOKED")),
            json!({"type":"close","code":"DEVICE_REVOKED"})
        );
        assert_eq!(terminal_close_code("AUTH_REQUIRED"), Some("AUTH_REQUIRED"));
        assert_eq!(
            terminal_close_code("DEVICE_TOKEN_STORAGE_UNSAFE"),
            Some("DEVICE_TOKEN_STORAGE_UNSAFE")
        );
        for raw in [
            "DEVICE_REVOKED bearer=private",
            "AUTH_REQUIRED\nprivate",
            "ydt1.private",
            "transport unavailable",
            "",
        ] {
            assert_eq!(
                close_event(terminal_close_code(raw)),
                json!({"type":"close"})
            );
        }
    }
}
#[tauri::command]
pub async fn platform_ws_send(
    state: tauri::State<'_, PlatformState>,
    connection_id: String,
    data: Option<String>,
) -> Result<(), String> {
    if data.as_ref().is_some_and(|s| s.len() > 1024 * 1024) {
        return Err("中央请求过大".into());
    }
    let tx = state
        .sockets
        .lock()
        .await
        .get(&connection_id)
        .map(|socket| socket.sender.clone())
        .ok_or("中央连接已关闭")?;
    tx.try_send(data).map_err(|_| "中央连接拥塞或已关闭".into())
}
