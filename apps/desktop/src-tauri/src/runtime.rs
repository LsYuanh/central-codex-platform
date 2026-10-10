// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{env, fs, io::Write, path::PathBuf, process::Child, time::Duration};
use tokio::sync::RwLock;
use url::Url;

use crate::{AttachmentIpc, attach_ipc, spawn_local_agent};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub gateway_url: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub device_id: String,
    pub workspace_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub saved: DesktopConfig,
    pub effective: DesktopConfig,
    pub ui_gateway_url: String,
    pub agent_gateway_url: String,
    pub overrides: Vec<String>,
    pub has_saved: bool,
    pub needs_setup: bool,
    pub running: bool,
    pub error: Option<String>,
}

pub struct AgentProcess {
    pub child: Child,
    pub ipc: AttachmentIpc,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct RuntimeInner {
    path: PathBuf,
    saved: DesktopConfig,
    effective: DesktopConfig,
    has_saved: bool,
    initial_setup_required: bool,
    suggested_workspace: PathBuf,
    pub process: Option<AgentProcess>,
    error: Option<String>,
}

pub struct DesktopRuntime(pub RwLock<RuntimeInner>);

pub fn normalize_gateway(raw: &str, agent: bool) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "请输入有效的中央网关地址")?;
    if !["ws", "wss"].contains(&url.scheme()) || url.host_str().is_none() {
        return Err("请输入 ws:// 或 wss:// 中央网关地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("网关地址不能包含密码、用户凭据或片段".into());
    }
    let expected = if agent { "/ws/agent" } else { "/ws" };
    if !["", "/", expected, &format!("{expected}/")].contains(&url.path()) {
        return Err(format!("网关路径应为 {expected}"));
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    for key in ["userId", "deviceId"] {
        let values: Vec<_> = pairs.iter().filter(|(k, _)| k == key).collect();
        if values.len() > 1 || values.iter().any(|(_, v)| v.trim().is_empty()) {
            return Err(format!("网关地址中的 {key} 无效或重复"));
        }
    }
    url.set_path(expected);
    url.set_query(None);
    let preserved: Vec<_> = pairs
        .into_iter()
        .filter(|(key, _)| key != "userId" && key != "deviceId")
        .collect();
    if !preserved.is_empty() {
        url.query_pairs_mut().extend_pairs(preserved);
    }
    Ok(url.to_string())
}

fn validate_identifier(label: &str, value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 || value.chars().any(char::is_control) {
        return Err(format!("请输入有效的{label}（1–128 个字符）"));
    }
    Ok(value.into())
}

pub fn ui_url(config: &DesktopConfig) -> String {
    let mut url = Url::parse(&config.gateway_url).expect("validated gateway");
    url.set_path("/ws");
    if url.scheme() == "wss" {
        url.set_query(None);
        url.query_pairs_mut()
            .append_pair("deviceId", &config.device_id);
    } else {
        url.query_pairs_mut()
            .append_pair("userId", &config.user_id)
            .append_pair("deviceId", &config.device_id);
    }
    url.to_string()
}

pub fn agent_url(config: &DesktopConfig) -> String {
    let mut url = Url::parse(&config.gateway_url).expect("validated gateway");
    url.set_path("/ws/agent");
    url.query_pairs_mut()
        .append_pair("deviceId", &config.device_id);
    url.to_string()
}

fn normalize_config(mut config: DesktopConfig) -> Result<DesktopConfig, String> {
    let parsed = Url::parse(config.gateway_url.trim()).map_err(|_| "请输入有效的中央网关地址")?;
    let legacy_user = parsed
        .query_pairs()
        .find(|(key, _)| key == "userId")
        .map(|(_, value)| value.into_owned());
    let legacy_device = parsed
        .query_pairs()
        .find(|(key, _)| key == "deviceId")
        .map(|(_, value)| value.into_owned());
    if config.user_id.trim().is_empty() {
        config.user_id = legacy_user.unwrap_or_default();
    }
    if config.device_id.trim().is_empty() {
        config.device_id = legacy_device.unwrap_or_default();
    }
    config.gateway_url = normalize_gateway(config.gateway_url.trim(), false)?;
    config.user_id = validate_identifier("用户 ID", &config.user_id)?;
    config.device_id = validate_identifier("设备 ID", &config.device_id)?;
    config.workspace_root = config.workspace_root.trim().into();
    Ok(config)
}

fn effective(saved: &DesktopConfig) -> Result<DesktopConfig, String> {
    resolve_overrides(
        saved,
        env::var("CODEXIA_GATEWAY_AGENT_URL").ok(),
        env::var("CODEXIA_WORKSPACE_ROOT").ok(),
    )
}

fn resolve_overrides(
    saved: &DesktopConfig,
    gateway_override: Option<String>,
    workspace_override: Option<String>,
) -> Result<DesktopConfig, String> {
    let gateway_identity_override = gateway_override
        .as_ref()
        .and_then(|value| Url::parse(value).ok())
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "deviceId")
                .map(|(_, value)| value.into_owned())
        });
    let gateway_url = if let Some(value) = gateway_override {
        let mut url =
            Url::parse(&normalize_gateway(&value, true)?).map_err(|error| error.to_string())?;
        url.set_path("/ws");
        normalize_gateway(url.as_str(), false)?
    } else {
        normalize_gateway(&saved.gateway_url, false)?
    };
    Ok(DesktopConfig {
        gateway_url,
        user_id: saved.user_id.clone(),
        device_id: gateway_identity_override.unwrap_or_else(|| saved.device_id.clone()),
        workspace_root: workspace_override.unwrap_or_else(|| saved.workspace_root.clone()),
    })
}

fn start(config: &DesktopConfig) -> Result<AgentProcess, String> {
    let mut child = spawn_local_agent(config)?;
    match attach_ipc(&mut child) {
        Some(ipc) => Ok(AgentProcess { child, ipc }),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            Err("无法建立 Local Agent 本机通道".into())
        }
    }
}

impl DesktopRuntime {
    pub async fn stop_for_update(&self, expected: &DesktopConfig) -> Result<(), String> {
        let mut inner = self
            .0
            .try_write()
            .map_err(|_| "本机操作正在进行，请稍后安装")?;
        if &inner.effective != expected {
            return Err("配置已变更，请重新检查更新".into());
        }
        if let Some(process) = inner.process.as_ref() {
            tokio::time::timeout(
                Duration::from_secs(5),
                process.ipc.request("runtime/prepare_restart", json!({})),
            )
            .await
            .map_err(|_| "Local Agent 状态核对超时")??;
        }
        inner.process.take();
        Ok(())
    }

    pub async fn restore_after_update(&self) -> Result<(), String> {
        let mut inner = self.0.write().await;
        inner.process = Some(start(&inner.effective)?);
        Ok(())
    }

    pub fn new(path: PathBuf, suggested_workspace: PathBuf) -> Self {
        let key = local_device_key().unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
        let short_key = key.split('-').next().unwrap_or("device");
        let user_id = env::var(if cfg!(windows) { "USERNAME" } else { "USER" })
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("user-{short_key}"));
        let computer = computer_name()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "device".into());
        let computer = identifier_slug(&computer);
        let computer = if computer.is_empty() {
            "device".into()
        } else {
            computer
        };
        let default = DesktopConfig {
            // Pairing replaces this documentation-only address before any Agent starts.
            gateway_url: "wss://central.example:4510/ws".into(),
            user_id,
            device_id: format!("{computer}-{short_key}"),
            workspace_root: env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(PathBuf::from))
                .map(|p| p.join("../../tests/fixtures/workspace"))
                .filter(|p| cfg!(debug_assertions) && p.is_dir())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| suggested_workspace.to_string_lossy().into_owned()),
        };
        Self::with_options(path, default, suggested_workspace, true)
    }

    #[cfg(test)]
    fn with_default(path: PathBuf, default: DesktopConfig) -> Self {
        let suggested_workspace = PathBuf::from(&default.workspace_root);
        let initial_setup_required = default.workspace_root.is_empty();
        Self::with_options(path, default, suggested_workspace, initial_setup_required)
    }

    fn with_options(
        path: PathBuf,
        default: DesktopConfig,
        suggested_workspace: PathBuf,
        initial_setup_required: bool,
    ) -> Self {
        let loaded = match fs::read(&path) {
            Ok(data) => serde_json::from_slice::<DesktopConfig>(&data)
                .map_err(|e| e.to_string())
                .and_then(normalize_config)
                .map(Some)
                .map_err(|e| format!("配置文件读取失败：{e}；请修正并保存配置")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("配置文件读取失败：{e}")),
        };
        let has_saved = !matches!(loaded, Ok(None));
        let load_error = loaded.as_ref().err().cloned();
        let saved = loaded.ok().flatten().unwrap_or(default);
        let resolved = effective(&saved);
        let error = load_error.or_else(|| resolved.as_ref().err().cloned());
        let applied = resolved.unwrap_or_else(|_| saved.clone());
        // A broken saved configuration is visible and recoverable; never silently connect elsewhere.
        let needs_setup = !has_saved
            && (initial_setup_required
                || applied.workspace_root.is_empty()
                || applied.user_id.is_empty()
                || applied.device_id.is_empty());
        let process = if needs_setup || error.is_some() {
            None
        } else {
            Some(start(&applied))
        };
        let error = error.or_else(|| process.as_ref().and_then(|p| p.as_ref().err().cloned()));
        Self(RwLock::new(RuntimeInner {
            path,
            saved,
            effective: applied,
            has_saved,
            initial_setup_required,
            suggested_workspace,
            process: process.and_then(Result::ok),
            error,
        }))
    }

    pub async fn view(&self) -> ConfigView {
        self.0.write().await.view()
    }

    pub async fn apply(&self, candidate: DesktopConfig) -> Result<ConfigView, String> {
        let mut inner = tokio::time::timeout(Duration::from_secs(25), self.0.write())
            .await
            .map_err(|_| "本机操作尚未结束，请稍后应用配置")?;
        let candidate = normalize_config(candidate)?;
        if candidate.workspace_root.is_empty() {
            return Err("请选择默认输出目录".into());
        }
        let workspace = PathBuf::from(&candidate.workspace_root);
        if !workspace.exists() && workspace == inner.suggested_workspace {
            fs::create_dir_all(&workspace)
                .map_err(|error| format!("无法创建默认输出目录：{error}"))?;
        }
        let applied = effective(&candidate)?;
        // Validate before stopping a healthy process. Directory inspection is local desktop setup only.
        crate::validate_agent_config(&applied)?;
        if let Some(process) = inner.process.as_mut() {
            if process
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_none()
            {
                process
                    .ipc
                    .request("runtime/prepare_restart", json!({}))
                    .await?;
            }
        }
        let previous = inner.effective.clone();
        let had_process = inner.process.is_some();
        inner.process.take();
        let result = async {
            let process = start(&applied)?;
            let identity = process
                .ipc
                .request("attachment/identity", json!({}))
                .await?;
            let actual_root = identity["workspaceRoot"]
                .as_str()
                .ok_or("Local Agent 版本过旧，请重新构建客户端")?
                .to_string();
            fs::create_dir_all(inner.path.parent().ok_or("配置目录不可用")?)
                .map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(inner.path.parent().unwrap())
                .map_err(|e| e.to_string())?;
            file.write_all(&serde_json::to_vec_pretty(&candidate).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            file.as_file().sync_all().map_err(|e| e.to_string())?;
            file.persist(&inner.path)
                .map_err(|e| format!("保存配置失败：{e}"))?;
            Ok::<_, String>((process, actual_root))
        }
        .await;
        match result {
            Ok((process, actual_root)) => {
                inner.saved = candidate;
                inner.effective = DesktopConfig {
                    workspace_root: actual_root,
                    ..applied
                };
                inner.has_saved = true;
                inner.process = Some(process);
                inner.error = None;
                Ok(inner.view())
            }
            Err(error) => {
                if !had_process {
                    let message =
                        format!("配置未保存：{error}。Local Agent 未启动，请修正配置后重试");
                    inner.error = Some(message.clone());
                    return Err(message);
                }
                let rollback = start(&previous);
                let restored = match rollback {
                    Ok(process) => {
                        match process.ipc.request("attachment/identity", json!({})).await {
                            Ok(_) => {
                                inner.process = Some(process);
                                true
                            }
                            Err(_) => false,
                        }
                    }
                    Err(_) => false,
                };
                let message = format!(
                    "配置未保存：{error}。{}",
                    if restored {
                        "已恢复原 Agent，可重新连接或修正后重试"
                    } else {
                        "原 Agent 恢复失败，请修正配置后重试"
                    }
                );
                inner.error = Some(message.clone());
                Err(message)
            }
        }
    }
}

impl RuntimeInner {
    fn view(&mut self) -> ConfigView {
        let needs_setup = !self.has_saved
            && (self.initial_setup_required
                || self.effective.workspace_root.is_empty()
                || self.effective.user_id.is_empty()
                || self.effective.device_id.is_empty());
        let running = self
            .process
            .as_mut()
            .is_some_and(|p| matches!(p.child.try_wait(), Ok(None)));
        let overrides = [
            "CODEXIA_GATEWAY_AGENT_URL",
            "CODEXIA_WORKSPACE_ROOT",
            "CODEXIA_LOCAL_AGENT_PATH",
        ]
        .into_iter()
        .filter(|key| env::var_os(key).is_some())
        .map(str::to_string)
        .collect();
        ConfigView {
            saved: self.saved.clone(),
            effective: self.effective.clone(),
            ui_gateway_url: normalize_config(self.effective.clone())
                .map(|config| ui_url(&config))
                .unwrap_or_default(),
            agent_gateway_url: normalize_gateway(&self.effective.gateway_url, false)
                .map(|gateway_url| {
                    agent_url(&DesktopConfig {
                        gateway_url,
                        ..self.effective.clone()
                    })
                })
                .unwrap_or_default(),
            overrides,
            has_saved: self.has_saved,
            needs_setup,
            running,
            error: self.error.clone().or_else(|| {
                (!running && !needs_setup)
                    .then(|| "Local Agent 未运行，请应用配置以重新启动".into())
            }),
        }
    }
}

fn identifier_slug(value: &str) -> String {
    let slug = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    slug.trim_matches('-')
        .to_owned()
        .chars()
        .take(64)
        .collect::<String>()
}

#[cfg(windows)]
pub(crate) fn computer_name() -> Option<String> {
    use windows_sys::Win32::System::WindowsProgramming::GetComputerNameW;
    let mut buffer = [0u16; 256];
    let mut length = buffer.len() as u32;
    let succeeded = unsafe { GetComputerNameW(buffer.as_mut_ptr(), &mut length) };
    (succeeded != 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
}

#[cfg(not(windows))]
pub(crate) fn computer_name() -> Option<String> {
    unsafe extern "C" {
        fn gethostname(name: *mut std::ffi::c_char, len: usize) -> std::ffi::c_int;
    }
    let mut buffer = [0u8; 256];
    let succeeded = unsafe { gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
    if !succeeded {
        return None;
    }
    let length = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    std::str::from_utf8(&buffer[..length])
        .ok()
        .map(str::to_owned)
}

fn local_device_key() -> Result<String, String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|path| PathBuf::from(path).join(".local/share")))
        .ok_or("本机应用数据目录不可用")?;
    let directory = base.join("Codexia");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join("device-id-v1");
    if !path.exists() {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file
                .write_all(uuid::Uuid::new_v4().to_string().as_bytes())
                .map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let value = fs::read_to_string(path).map_err(|error| error.to_string())?;
    uuid::Uuid::parse_str(value.trim()).map_err(|error| error.to_string())?;
    Ok(value.trim().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_and_identity_stay_together() {
        let gateway_url = normalize_gateway(" ws://central.example:4510/ ", false).unwrap();
        let config = DesktopConfig {
            gateway_url,
            user_id: "alice".into(),
            device_id: "workstation-a".into(),
            workspace_root: "unused".into(),
        };
        assert_eq!(
            ui_url(&config),
            "ws://central.example:4510/ws?userId=alice&deviceId=workstation-a"
        );
        assert_eq!(
            agent_url(&config),
            "ws://central.example:4510/ws/agent?deviceId=workstation-a"
        );
        let config = DesktopConfig {
            gateway_url: normalize_gateway("ws://localhost:4510/ws", false).unwrap(),
            device_id: "custom".into(),
            ..config
        };
        assert_eq!(
            agent_url(&config),
            "ws://localhost:4510/ws/agent?deviceId=custom"
        );
    }

    #[test]
    fn migrates_legacy_url_identity_into_explicit_fields() {
        let migrated = normalize_config(DesktopConfig {
            gateway_url:
                "ws://localhost:4510/ws?token=kept&userId=%E7%94%A8%E6%88%B7&deviceId=pc-1".into(),
            user_id: String::new(),
            device_id: String::new(),
            workspace_root: " workspace ".into(),
        })
        .unwrap();
        assert_eq!(migrated.gateway_url, "ws://localhost:4510/ws?token=kept");
        assert_eq!(migrated.user_id, "用户");
        assert_eq!(migrated.device_id, "pc-1");
        assert_eq!(migrated.workspace_root, "workspace");
        assert!(
            normalize_config(DesktopConfig {
                user_id: " ".into(),
                ..migrated
            })
            .is_err()
        );
    }
    #[test]
    fn rejects_misleading_endpoints() {
        for url in [
            "file:///tmp",
            "http://localhost:4510/ws",
            "ws://user:secret@localhost/ws",
            "ws://localhost/ws#fragment",
            "ws://localhost/ws/agent",
            "ws://localhost/ws?deviceId=a&deviceId=b",
            "ws://localhost/ws?deviceId=",
        ] {
            assert!(normalize_gateway(url, false).is_err(), "{url}");
        }
    }

    #[test]
    fn environment_overrides_both_routes_and_preserves_user() {
        let saved = DesktopConfig {
            gateway_url: "ws://old:4510/ws".into(),
            user_id: "alice".into(),
            device_id: "original".into(),
            workspace_root: "original".into(),
        };
        let resolved = resolve_overrides(
            &saved,
            Some("ws://new:4510/ws/agent?deviceId=development".into()),
            Some("override".into()),
        )
        .unwrap();
        assert_eq!(resolved.gateway_url, "ws://new:4510/ws");
        assert_eq!(resolved.user_id, "alice");
        assert_eq!(resolved.device_id, "development");
        assert_eq!(
            agent_url(&resolved),
            "ws://new:4510/ws/agent?deviceId=development"
        );
        assert_eq!(resolved.workspace_root, "override");
        assert_eq!(saved.workspace_root, "original");
    }

    #[tokio::test]
    async fn first_configuration_does_not_start_agent_or_create_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("runtime.json");
        let workspace = temp.path().join("workspace");
        // Initial setup must remain passive even when the suggested fields are complete.
        let runtime = DesktopRuntime::with_options(
            config_path.clone(),
            DesktopConfig {
                gateway_url: "wss://central.example:4510/ws".into(),
                user_id: "test-user".into(),
                device_id: "test-device".into(),
                workspace_root: workspace.to_string_lossy().into_owned(),
            },
            workspace.clone(),
            true,
        );
        let view = runtime.view().await;
        assert!(view.needs_setup && !view.running && !view.has_saved);
        assert!(!config_path.exists() && !workspace.exists());
    }

    #[tokio::test]
    #[ignore = "requires built Local Agent via CODEXIA_LOCAL_AGENT_PATH; launches a distinct test device"]
    async fn runtime_process_integration() {
        assert!(env::var_os("CODEXIA_LOCAL_AGENT_PATH").is_some());
        assert!(env::var_os("CODEXIA_GATEWAY_AGENT_URL").is_none());
        assert!(env::var_os("CODEXIA_WORKSPACE_ROOT").is_none());
        let temp = tempfile::tempdir().unwrap();
        let root_a = temp.path().join("workspace-a");
        let root_b = temp.path().join("workspace-b");
        fs::create_dir_all(&root_a).unwrap();
        fs::create_dir_all(&root_b).unwrap();
        let suggested_root = temp.path().join("Documents").join("YuanZhou Workspace");
        let suggested_path = temp.path().join("suggested-runtime.json");
        let suggested_runtime = DesktopRuntime::with_options(
            suggested_path.clone(),
            DesktopConfig {
                gateway_url: "ws://central.example:4510/ws".into(),
                user_id: "automatic-user".into(),
                device_id: format!("automatic-device-{}", std::process::id()),
                workspace_root: suggested_root.to_string_lossy().into_owned(),
            },
            suggested_root.clone(),
            true,
        );
        let suggested = suggested_runtime.view().await;
        assert!(suggested.needs_setup && !suggested.running && !suggested.has_saved);
        assert!(!suggested_root.exists() && !suggested_path.exists());
        let suggested = suggested_runtime.apply(suggested.saved).await.unwrap();
        assert!(suggested.running && suggested.has_saved && !suggested.needs_setup);
        assert!(suggested_root.is_dir() && suggested_path.is_file());
        drop(suggested_runtime);
        let path = temp.path().join("desktop-runtime-v1.json");
        let config = DesktopConfig {
            gateway_url: "ws://central.example:4510/ws".into(),
            user_id: "runtime-smoke".into(),
            device_id: format!("runtime-smoke-{}", std::process::id()),
            workspace_root: root_a.to_string_lossy().into_owned(),
        };
        let runtime = DesktopRuntime::with_default(
            path.clone(),
            DesktopConfig {
                workspace_root: String::new(),
                ..config.clone()
            },
        );
        let fresh = runtime.view().await;
        assert!(fresh.needs_setup);
        assert!(!fresh.running && !fresh.has_saved);
        assert!(fresh.error.is_none());
        assert!(!path.exists());
        assert!(runtime.apply(fresh.saved).await.is_err());
        assert!(!path.exists());
        let configured = runtime.apply(config.clone()).await.unwrap();
        assert!(!configured.needs_setup && configured.running && configured.has_saved);
        let (pid_a, identity_a) = {
            let inner = runtime.0.read().await;
            let process = inner.process.as_ref().unwrap();
            (
                process.child.id(),
                process
                    .ipc
                    .request("attachment/identity", json!({}))
                    .await
                    .unwrap(),
            )
        };
        let bad = DesktopConfig {
            workspace_root: temp.path().join("missing").to_string_lossy().into_owned(),
            ..config.clone()
        };
        assert!(runtime.apply(bad).await.is_err());
        assert_eq!(
            runtime.0.read().await.process.as_ref().unwrap().child.id(),
            pid_a
        );
        let config_b = DesktopConfig {
            workspace_root: root_b.to_string_lossy().into_owned(),
            ..config.clone()
        };
        let transfer = {
            let inner = runtime.0.read().await;
            inner
                .process
                .as_ref()
                .unwrap()
                .ipc
                .request("attachment/import_begin", json!({}))
                .await
                .unwrap()
        };
        assert!(
            runtime
                .apply(config_b.clone())
                .await
                .err()
                .unwrap()
                .contains("AGENT_BUSY")
        );
        {
            let inner = runtime.0.read().await;
            inner
                .process
                .as_ref()
                .unwrap()
                .ipc
                .request(
                    "file/close_transfer",
                    json!({"transferId":transfer["transferId"]}),
                )
                .await
                .unwrap();
        }
        let applied = runtime.apply(config_b.clone()).await.unwrap();
        assert!(applied.running);
        assert!(applied.effective.workspace_root.ends_with("workspace-b"));
        {
            let inner = runtime.0.read().await;
            let process = inner.process.as_ref().unwrap();
            assert_ne!(process.child.id(), pid_a);
            let identity_b = process
                .ipc
                .request("attachment/identity", json!({}))
                .await
                .unwrap();
            assert_eq!(identity_a["deviceId"], identity_b["deviceId"]);
            assert_eq!(identity_a["deviceKey"], identity_b["deviceKey"]);
        }
        assert_eq!(
            serde_json::from_slice::<DesktopConfig>(&fs::read(&path).unwrap()).unwrap(),
            config_b
        );
        // Force an atomic-save failure after the new Agent has started.
        let blocked = temp.path().join("blocked-config");
        fs::create_dir(&blocked).unwrap();
        runtime.0.write().await.path = blocked;
        assert!(
            runtime
                .apply(config.clone())
                .await
                .err()
                .unwrap()
                .contains("已恢复原 Agent")
        );
        assert!(
            runtime
                .view()
                .await
                .effective
                .workspace_root
                .ends_with("workspace-b")
        );
        runtime.0.write().await.path = path.clone();
        // A dead child must also be recoverable through the same button.
        {
            let mut inner = runtime.0.write().await;
            let process = inner.process.as_mut().unwrap();
            process.child.kill().unwrap();
            process.child.wait().unwrap();
        }
        assert!(runtime.apply(config_b.clone()).await.unwrap().running);
        drop(runtime);
        let reopened = DesktopRuntime::new(path, temp.path().join("suggested-workspace"));
        let view = reopened.view().await;
        assert!(view.running);
        assert!(view.has_saved);
        assert_eq!(view.saved, config_b);
        reopened.stop_for_update(&view.effective).await.unwrap();
        assert!(!reopened.view().await.running);
        reopened.restore_after_update().await.unwrap();
        assert!(reopened.view().await.running);
        assert_eq!(reopened.view().await.saved, config_b);
        {
            let inner = reopened.0.read().await;
            inner
                .process
                .as_ref()
                .unwrap()
                .ipc
                .request("attachment/identity", json!({}))
                .await
                .unwrap();
        }
        drop(reopened);
        println!(
            "RUNTIME_PROCESS_SMOKE_OK: switch, identity, busy rejection, atomic persistence, rollback, dead-child recovery, restart"
        );
    }
}
