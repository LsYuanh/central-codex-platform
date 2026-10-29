// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
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
    pub(crate) guard: Mutex<()>,
    sockets: Mutex<HashMap<String, NativeSocket>>,
    page: AtomicU64,
}
struct NativeSocket {
    page: u64,
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
            page: AtomicU64::new(0),
        }
    }
    // A WebView reload discards JS callbacks without closing Rust-owned sockets.
    // Advance synchronously so even a handshake in flight cannot outlive its page.
    pub fn begin_page(&self) -> u64 {
        self.page.fetch_add(1, Ordering::SeqCst) + 1
    }
    fn require_page(&self, page: u64) -> Result<(), String> {
        if self.page.load(Ordering::SeqCst) == page {
            Ok(())
        } else {
            Err("CENTRAL_PAGE_CHANGED".into())
        }
    }
    pub async fn close_before_page(&self, page: u64) {
        let _guard = self.guard.lock().await;
        self.close_stale_sockets(page).await;
    }
    async fn close_stale_sockets(&self, page: u64) {
        let stale = {
            let mut sockets = self.sockets.lock().await;
            let ids: Vec<_> = sockets
                .iter()
                .filter(|(_, socket)| socket.page < page)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| sockets.remove(&id))
                .collect::<Vec<_>>()
        };
        for socket in stale {
            socket.task.abort();
            let _ = socket.task.await;
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
    updates: tauri::State<'_, crate::updates::UpdateState>,
    state: tauri::State<'_, PlatformState>,
    runtime: tauri::State<'_, crate::runtime::DesktopRuntime>,
    gateway: String,
    action: String,
    input: Value,
) -> Result<Value, String> {
    updates.ensure_idle()?;
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
    let page = state.page.load(Ordering::SeqCst);
    let _guard = state.guard.lock().await;
    state.require_page(page)?;
    state.close_stale_sockets(page).await;
    {
        let sockets = state.sockets.lock().await;
        if sockets.len() >= 4 || sockets.contains_key(&connection_id) {
            return Err("CENTRAL_CONNECTION_LIMIT".into());
        }
    }
    let config = runtime.view().await.effective;
    let ca = state.ca(&config.gateway_url)?;
    let c = platform_security::device_token::load(
        &state.directory,
        &state.namespace,
        &config.gateway_url,
    )?;
    if c.device_id != config.device_id || c.user.id != config.user_id {
        return Err("CENTRAL_IDENTITY_MISMATCH".into());
    }
    let url = crate::runtime::ui_url(&config);
    let socket = c.socket(&url, &ca).await?;
    state.require_page(page)?;
    let mut sockets = state.sockets.lock().await;
    let (tx, mut rx) = mpsc::channel::<Option<String>>(64);
    on_event
        .send(json!({"type":"open"}))
        .map_err(|_| "CENTRAL_PAGE_CHANGED")?;
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
    sockets.insert(
        connection_id,
        NativeSocket {
            page,
            sender: tx,
            task,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn page_reload_cleans_old_sockets_and_rejects_inflight_handshakes() {
        let state = PlatformState::new("test".into(), PathBuf::new());
        let old_page = state.page.load(Ordering::SeqCst);
        let mut receivers = Vec::new();
        for i in 0..4 {
            let (sender, receiver) = mpsc::channel(1);
            receivers.push(receiver);
            state.sockets.lock().await.insert(
                i.to_string(),
                NativeSocket {
                    page: old_page,
                    sender,
                    task: tokio::spawn(std::future::pending()),
                },
            );
        }
        let page = state.begin_page();
        assert_eq!(
            state.require_page(old_page).unwrap_err(),
            "CENTRAL_PAGE_CHANGED"
        );
        let (sender, mut current_receiver) = mpsc::channel(1);
        state.sockets.lock().await.insert(
            "current".into(),
            NativeSocket {
                page,
                sender,
                task: tokio::spawn(std::future::pending()),
            },
        );
        // A delayed page-load cleanup must not remove a new page's connection.
        state.close_before_page(page).await;
        assert_eq!(state.sockets.lock().await.len(), 1);
        for mut receiver in receivers {
            assert!(receiver.recv().await.is_none());
        }
        assert!(state.require_page(page).is_ok());
        assert!(matches!(
            current_receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        state.close_before_page(page).await;
        assert_eq!(state.sockets.lock().await.len(), 1);
        state.close_before_page(state.begin_page()).await;
        assert!(current_receiver.recv().await.is_none());
        assert!(state.sockets.lock().await.is_empty());
    }
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
    updates: tauri::State<'_, crate::updates::UpdateState>,
    state: tauri::State<'_, PlatformState>,
    connection_id: String,
    data: Option<String>,
) -> Result<(), String> {
    updates.ensure_idle()?;
    let tx = state
        .sockets
        .lock()
        .await
        .get(&connection_id)
        .map(|socket| socket.sender.clone())
        .ok_or("中央连接已关闭")?;
    tx.send(data).await.map_err(|_| "中央连接已关闭".into())
}
