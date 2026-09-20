// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::ChildStdin,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::Manager;
mod platform;
mod runtime;
mod updates;
mod window_frame;
use runtime::{DesktopConfig, DesktopRuntime};
use std::{
    env,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

struct AttachmentIpc {
    input: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
}

#[tauri::command]
async fn attachment_request(
    state: tauri::State<'_, DesktopRuntime>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if ![
        "file/stat",
        "file/read_image",
        "file/read_chunk",
        "file/reveal",
        "attachment/preview",
        "attachment/output_preview",
        "attachment/import_begin",
        "attachment/identity",
        "attachment/import_chunk",
        "attachment/import_commit",
        "file/close_transfer",
    ]
    .contains(&method.as_str())
    {
        return Err("不支持的本机附件操作".into());
    }
    let runtime = state.0.read().await;
    let process = runtime
        .process
        .as_ref()
        .ok_or("Local Agent 未启动，请在设置中应用配置")?;
    process.ipc.request(&method, params).await
}

impl AttachmentIpc {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let ipc = self;
        let id = ipc.next_id.fetch_add(1, Ordering::Relaxed);
        let line = format!("{}\n", json!({"id":id,"method":method,"params":params}));
        if line.len() > 1024 * 1024 {
            return Err("附件 IPC 帧超过 1 MiB".into());
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        ipc.pending.lock().unwrap().insert(id, tx);
        let write = ipc.input.lock().unwrap().write_all(line.as_bytes());
        if let Err(e) = write {
            ipc.pending.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(20), rx).await;
        ipc.pending.lock().unwrap().remove(&id);
        let response = result
            .map_err(|_| "本机附件处理超时，可重试读取")?
            .map_err(|_| "Local Agent 已断开")?;
        if response["ok"] == true {
            Ok(response["result"].clone())
        } else {
            Err(response["error"]
                .as_str()
                .unwrap_or("附件处理失败")
                .to_owned())
        }
    }
}

#[tauri::command]
async fn desktop_config(
    state: tauri::State<'_, DesktopRuntime>,
) -> Result<runtime::ConfigView, String> {
    let mut view = state.view().await;
    if view.running {
        match attachment_request(state, "attachment/identity".into(), json!({})).await {
            Ok(identity) => {
                if let Some(root) = identity["workspaceRoot"].as_str() {
                    view.effective.workspace_root = root.into();
                }
            }
            Err(error) => {
                view.error = Some(format!("Local Agent 通道不可用：{error}；请重新应用配置"))
            }
        }
    }
    Ok(view)
}

#[tauri::command]
async fn apply_desktop_config(
    updates: tauri::State<'_, updates::UpdateState>,
    state: tauri::State<'_, DesktopRuntime>,
    config: DesktopConfig,
) -> Result<runtime::ConfigView, String> {
    updates.ensure_idle()?;
    state.apply(config).await
}

#[tauri::command]
async fn select_workspace_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("选择默认输出目录")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn select_attachment_paths() -> Vec<String> {
    rfd::AsyncFileDialog::new()
        .set_title("添加图片或文件")
        .pick_files()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|file| file.path().to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
async fn attachment_device_id(state: tauri::State<'_, DesktopRuntime>) -> Result<String, String> {
    let identity = attachment_request(state, "attachment/identity".into(), json!({})).await?;
    identity["deviceId"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Local Agent 设备身份不可用".into())
}

fn attach_ipc(child: &mut Child) -> Option<AttachmentIpc> {
    let input = child.stdin.take()?;
    let output = child.stdout.take()?;
    let pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let replies = pending.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else {
                break;
            };
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = value["id"].as_u64() {
                    if let Some(tx) = replies.lock().unwrap().remove(&id) {
                        let _ = tx.send(value);
                    }
                }
            }
        }
        replies.lock().unwrap().clear();
    });
    Some(AttachmentIpc {
        input: Mutex::new(input),
        pending,
        next_id: AtomicU64::new(1),
    })
}

fn local_agent_executable() -> PathBuf {
    let executable = env::var_os("CODEXIA_LOCAL_AGENT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(PathBuf::from))
                .unwrap_or_default()
                .join(if cfg!(windows) {
                    "local-agent.exe"
                } else {
                    "local-agent"
                })
        });
    executable
}

fn validate_agent_config(config: &DesktopConfig) -> Result<(), String> {
    let executable = local_agent_executable();
    if !executable.is_file() {
        return Err(format!("executable not found at {}", executable.display()));
    }

    let workspace = PathBuf::from(&config.workspace_root);
    if !workspace.is_absolute()
        || config.workspace_root.starts_with("\\\\")
        || config.workspace_root.starts_with("//")
    {
        return Err("请选择本机绝对目录，不支持网络共享路径".into());
    }
    if !workspace.is_dir() {
        return Err(format!("workspace not found at {}", workspace.display()));
    }

    runtime::normalize_gateway(&config.gateway_url, false)?;
    Ok(())
}

fn spawn_local_agent(config: &DesktopConfig) -> Result<Child, String> {
    validate_agent_config(config)?;
    let executable = local_agent_executable();
    let workspace = PathBuf::from(&config.workspace_root);
    let gateway = runtime::agent_url(config);
    let workspace_text = workspace.to_string_lossy().into_owned();
    let mut command = Command::new(executable);
    if config.gateway_url.starts_with("wss://") {
        let (namespace, directory) = platform::LAUNCH_CONTEXT.get().ok_or("平台应用标识不可用")?;
        let c = platform_security::device_token::load(directory, namespace, &config.gateway_url)?;
        if c.device_id != config.device_id || c.user.id != config.user_id {
            return Err("请先用中央配对码配对并应用设备身份".into());
        }
        command.env("YUAN_PLATFORM_NAMESPACE", &namespace);
        command.env("YUAN_PLATFORM_DATA_DIR", directory);
        let ca = platform::PlatformState::new(namespace.clone(), directory.clone())
            .ca(&config.gateway_url)?;
        command.env("YUAN_PLATFORM_CA", ca);
    }
    command
        .args([
            "--workspace-root",
            workspace_text.as_str(),
            "--gateway-url",
            gateway.as_str(),
            "--allow-insecure-lan",
            "--attachment-stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .setup(|app| {
            let namespace = app.config().identifier.clone();
            let directory = app.path().app_config_dir()?;
            let _ = platform::LAUNCH_CONTEXT.set((namespace.clone(), directory.clone()));
            app.manage(platform::PlatformState::new(namespace, directory));
            tauri::async_runtime::block_on(updates::recover_attempt(app.handle()));
            let suggested_workspace = app
                .path()
                .document_dir()
                .or_else(|_| app.path().home_dir().map(|path| path.join("Documents")))?
                .join("YuanZhou Workspace");
            app.manage(DesktopRuntime::new(
                app.path().app_config_dir()?.join("desktop-runtime-v1.json"),
                suggested_workspace,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_frame::set_window_caption_color,
            attachment_request,
            select_attachment_paths,
            attachment_device_id,
            desktop_config,
            apply_desktop_config,
            select_workspace_directory,
            platform::platform_account,
            platform::platform_ws_open,
            platform::platform_ws_send,
            updates::desktop_update_check,
            updates::desktop_update_download,
            updates::desktop_update_install
        ])
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .app_handle()
                    .state::<updates::UpdateState>()
                    .ensure_idle()
                    .is_err()
                {
                    api.prevent_close();
                    return;
                }
                let _ = window.hide();
                // macOS normally keeps an app alive after its last window closes.
                // This single-window client owns its Agent for the entire app lifetime.
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop Spike")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                if app.state::<updates::UpdateState>().ensure_idle().is_err() {
                    api.prevent_exit();
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                // Includes the application menu / Cmd+Q path, which does not close
                // each window first. Wait for any configuration change before cleanup.
                if let Some(state) = app.try_state::<DesktopRuntime>() {
                    tauri::async_runtime::block_on(async {
                        state.0.write().await.process.take();
                    });
                }
            }
        });
}
