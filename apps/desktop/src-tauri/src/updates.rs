// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Native application lifecycle only. No updater command is exposed as a model/device tool.
use crate::{
    platform::PlatformState,
    runtime::{DesktopConfig, DesktopRuntime},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{Manager, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;
use url::Url;

const MAX_PACKAGE: usize = 512 * 1024 * 1024;
#[derive(Default)]
pub struct UpdateState {
    inner: Mutex<Option<PendingUpdate>>,
    installing: AtomicBool,
    last_result: Mutex<Option<String>>,
}

fn attempt_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("client-update-attempt-v1.json"))
        .map_err(|_| "升级状态目录不可用".into())
}
// Persist only public metadata; neither bearer credentials nor installation leases are written.
fn save_attempt(app: &tauri::AppHandle, gateway: &str, version: &str) -> Result<(), String> {
    use std::io::Write;
    let path = attempt_path(app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "升级状态目录不可写")?;
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|_| "升级状态保存失败")?;
    file.write_all(
        json!({"gateway":gateway,"version":version})
            .to_string()
            .as_bytes(),
    )
    .map_err(|_| "升级状态保存失败")?;
    file.as_file().sync_all().map_err(|_| "升级状态保存失败")?;
    file.persist(path).map_err(|_| "升级状态保存失败")?;
    Ok(())
}
/// Run before starting the new Agent, releasing the previous install lease even after a failed installer.
pub async fn recover_attempt(app: &tauri::AppHandle) {
    let Ok(path) = attempt_path(app) else { return };
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    if bytes.len() > 4096 {
        return;
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let (Some(gateway), Some(version)) = (value["gateway"].as_str(), value["version"].as_str())
    else {
        return;
    };
    let platform = app.state::<PlatformState>();
    let release = async {
        let origin = platform_security::origin(gateway)?;
        let credential = platform_security::device_token::load(
            &platform.directory,
            &platform.namespace,
            gateway,
        )?;
        let client = platform_security::http(&platform.ca(gateway)?)?;
        client
            .post(format!("{origin}/client-updates/resume"))
            .bearer_auth(credential.bearer())
            .header("x-client-version", app.package_info().version.to_string())
            .send()
            .await
            .map_err(|_| "连接中央失败")?;
        Ok::<(), String>(())
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), release).await;
    *app.state::<UpdateState>().last_result.lock().await =
        Some(if app.package_info().version.to_string() == version {
            format!("已成功更新到 {version}")
        } else {
            format!(
                "上次更新未完成，当前仍为 {}；可以重新下载更新。",
                app.package_info().version
            )
        });
    let _ = std::fs::remove_file(path);
}
struct PendingUpdate {
    config: DesktopConfig,
    update: Update,
    bytes: Option<Vec<u8>>,
}
impl UpdateState {
    pub fn ensure_idle(&self) -> Result<(), String> {
        if self.installing.load(Ordering::SeqCst) {
            Err("正在安装更新，请等待客户端重启".into())
        } else {
            Ok(())
        }
    }
}
fn verify(bytes: &[u8], signature: &str, key: &str) -> Result<(), String> {
    let decode = |s: &str| {
        STANDARD
            .decode(s.trim())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or("更新签名格式无效")
    };
    let key = minisign_verify::PublicKey::decode(&decode(key)?).map_err(|_| "更新公钥无效")?;
    let signature =
        minisign_verify::Signature::decode(&decode(signature)?).map_err(|_| "更新签名无效")?;
    key.verify(bytes, &signature, true)
        .map_err(|_| "更新包签名校验失败，未安装任何内容".into())
}
fn validate_download(origin: &str, url: &Url) -> Result<(), String> {
    let expected = Url::parse(origin).map_err(|_| "中央地址无效")?;
    if url.origin() != expected.origin()
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/client-updates/files/")
    {
        return Err("更新包必须来自已配对的中央更新服务".into());
    }
    Ok(())
}
fn public(p: &PendingUpdate) -> Value {
    json!({"version":p.update.version,"notes":p.update.body,"ready":p.bytes.is_some()})
}
fn credentials(
    platform: &PlatformState,
    config: &DesktopConfig,
) -> Result<platform_security::device_token::Credential, String> {
    let c = platform_security::device_token::load(
        &platform.directory,
        &platform.namespace,
        &config.gateway_url,
    )?;
    if c.device_id != config.device_id || c.user.id != config.user_id {
        return Err("请先应用已配对的设备配置".into());
    }
    Ok(c)
}

#[tauri::command]
pub async fn desktop_update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, DesktopRuntime>,
    platform: tauri::State<'_, PlatformState>,
) -> Result<Value, String> {
    let mut pending = state.inner.try_lock().map_err(|_| "更新操作正在进行")?;
    state.ensure_idle()?;
    // RC has a separate identity and must never install a formal product package.
    if app.config().identifier != "com.centralcodex.localspike" {
        return Err("此隔离测试版本不接收正式更新".into());
    }
    let view = runtime.view().await;
    if view.needs_setup {
        return Err("请先完成客户端配对和设置".into());
    }
    let config = view.effective;
    let origin = platform_security::origin(&config.gateway_url)?;
    let c = credentials(&platform, &config)?;
    let ca = platform.ca(&config.gateway_url)?;
    // Construct the TLS builder before entering the plugin callback so errors remain explicit.
    let tls = platform_security::central_tls_config(&ca)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![
            Url::parse(&format!("{origin}/client-updates/latest.json"))
                .map_err(|_| "更新地址无效")?,
        ])
        .map_err(|_| "更新地址无效")?
        .header("Authorization", format!("Bearer {}", c.bearer()))
        .map_err(|_| "设备凭据无效")?
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .configure_client(move |builder| {
            builder
                .use_preconfigured_tls(tls.clone())
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
        })
        .build()
        .map_err(|_| "更新组件初始化失败")?;
    let update = tokio::time::timeout(Duration::from_secs(25), updater.check())
        .await
        .map_err(|_| "检查更新超时，请重试")?
        .map_err(|_| "检查更新失败：请检查中央连接、配对状态及更新服务是否已发布")?;
    match update {
        None => {
            *pending = None;
            Ok(json!({"current":true,"notice":state.last_result.lock().await.clone()}))
        }
        Some(update) => {
            validate_download(&origin, &update.download_url)?;
            if let Some(old) = pending.as_ref() {
                if old.config == config
                    && old.update.version == update.version
                    && old.update.signature == update.signature
                    && old.bytes.is_some()
                {
                    return Ok(public(old));
                }
            }
            let p = PendingUpdate {
                config,
                update,
                bytes: None,
            };
            let result = public(&p);
            *pending = Some(p);
            Ok(result)
        }
    }
}

#[tauri::command]
pub async fn desktop_update_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, DesktopRuntime>,
    platform: tauri::State<'_, PlatformState>,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let mut pending = state.inner.try_lock().map_err(|_| "更新操作正在进行")?;
    let p = pending.as_mut().ok_or("请先检查更新")?;
    if p.config != runtime.view().await.effective {
        *pending = None;
        return Err("配置已变更，请重新检查更新".into());
    }
    let c = credentials(&platform, &p.config)?;
    let client = platform_security::http_builder(&platform.ca(&p.config.gateway_url)?)?
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| "更新下载初始化失败")?;
    let mut response = client
        .get(p.update.download_url.clone())
        .bearer_auth(c.bearer())
        .send()
        .await
        .map_err(|_| "更新下载连接失败，可重试")?;
    if !response.status().is_success() {
        return Err("更新包不可用，请重新检查更新".into());
    }
    let total = response.content_length();
    if total.is_some_and(|n| n > MAX_PACKAGE as u64) {
        return Err("更新包超过 512 MiB 限制".into());
    }
    let mut bytes = Vec::new();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "下载中断或超时，可重新下载")?
    {
        if bytes.len() + chunk.len() > MAX_PACKAGE {
            return Err("更新包超过 512 MiB 限制".into());
        }
        bytes.extend_from_slice(&chunk);
        if last.elapsed() >= Duration::from_millis(150) {
            let _ =
                on_event.send(json!({"stage":"downloading","received":bytes.len(),"total":total}));
            last = std::time::Instant::now();
        }
    }
    if total.is_some_and(|n| n != bytes.len() as u64) {
        return Err("更新包下载不完整，请重试".into());
    }
    let _ = on_event.send(json!({"stage":"verifying","received":bytes.len(),"total":total}));
    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(Value::as_str)
        .ok_or("更新公钥未配置")?;
    verify(&bytes, &p.update.signature, key)?;
    p.bytes = Some(bytes);
    Ok(public(p))
}

#[derive(serde::Serialize)]
pub struct InstallError {
    message: String,
    ready: bool,
}
impl From<&str> for InstallError {
    fn from(message: &str) -> Self {
        Self {
            message: message.into(),
            ready: false,
        }
    }
}

#[tauri::command]
pub async fn desktop_update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, DesktopRuntime>,
    platform: tauri::State<'_, PlatformState>,
) -> Result<(), InstallError> {
    let _account = platform
        .guard
        .try_lock()
        .map_err(|_| "配对或账号操作正在进行，请稍后安装")?;
    let mut pending = state.inner.try_lock().map_err(|_| "更新操作正在进行")?;
    let p = pending.as_mut().ok_or("请先下载更新")?;
    if p.bytes.is_none() {
        return Err("请先下载更新".into());
    }
    state.installing.store(true, Ordering::SeqCst);
    let result: Result<(), String> = async {
        let config = runtime.view().await.effective;
        if p.config != config {
            return Err("配置已变更，请重新检查更新".into());
        }
        let c = credentials(&platform, &config)?;
        let origin = platform_security::origin(&config.gateway_url)?;
        let client = platform_security::http(&platform.ca(&config.gateway_url)?)?;
        let response = client
            .post(format!("{origin}/client-updates/prepare"))
            .header("x-update-version", &p.update.version)
            .bearer_auth(c.bearer())
            .send()
            .await
            .map_err(|_| "无法核对中央任务状态，请重试")?;
        if response.status().as_u16() == 409 {
            let body = response.json::<Value>().await.unwrap_or(Value::Null);
            let message = match body["reason"].as_str() {
                Some("active-turn") => "还有对话正在运行，请结束后重试安装",
                Some("device-operation") => "本机操作正在进行，请完成后重试安装",
                Some("command-running") => "本机命令仍在运行，请结束后重试安装",
                Some("command-state-unknown") => "暂时无法确认本机命令是否结束，请稍后重试安装",
                Some("agent-unavailable") => "本机执行组件未连接，请连接后重试安装",
                Some("install-lease") => "已有安装准备正在进行，请稍后重试安装",
                _ => "还有对话或本机操作正在进行，请结束后再安装",
            };
            return Err(message.into());
        }
        if !response.status().is_success() {
            return Err("中央尚未允许升级，请检查连接和配对状态".into());
        }
        let lease: Value = response.json().await.map_err(|_| "中央升级状态无效")?;
        let token = lease["token"]
            .as_str()
            .filter(|s| s.len() == 36)
            .ok_or("中央升级状态无效")?;
        let stop = match save_attempt(&app, &config.gateway_url, &p.update.version) {
            Ok(()) => runtime.stop_for_update(&config).await,
            Err(error) => Err(error),
        };
        if let Err(error) = stop {
            if let Ok(path) = attempt_path(&app) {
                let _ = std::fs::remove_file(path);
            }
            let _ = client
                .post(format!("{origin}/client-updates/release"))
                .bearer_auth(c.bearer())
                .header("x-update-lease", token)
                .send()
                .await;
            return Err(error);
        }
        // Agent has been joined before the updater can exit(0) on Windows.
        let update = p.update.clone();
        let bytes = p.bytes.take().unwrap();
        let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
        let _ = client
            .post(format!("{origin}/client-updates/release"))
            .bearer_auth(c.bearer())
            .header("x-update-lease", token)
            .send()
            .await;
        match installed {
            Ok(Ok(())) => {
                app.restart();
            }
            _ => {
                let recovered = runtime.restore_after_update().await;
                Err(format!(
                    "安装更新失败，请重新下载或使用安装包修复。{}",
                    if recovered.is_ok() {
                        "已恢复 Local Agent。"
                    } else {
                        "Local Agent 恢复失败，请重启客户端。"
                    }
                ))
            }
        }
    }
    .await;
    state.installing.store(false, Ordering::SeqCst);
    // Only native state knows whether the verified download was consumed.
    // A refused preflight must not make the UI download the same package again.
    result.map_err(|message| InstallError {
        message,
        ready: p.bytes.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires tests/smoke/client-updates-native-smoke.mjs HTTPS fixture"]
    async fn native_https_signature_acceptance() {
        let origin = std::env::var("UPDATE_QA_ORIGIN").unwrap();
        let ca = std::env::var("UPDATE_QA_CA").unwrap();
        let signature =
            std::fs::read_to_string(std::env::var("UPDATE_QA_SIGNATURE").unwrap()).unwrap();
        let payload = std::fs::read(std::env::var("UPDATE_QA_PAYLOAD").unwrap()).unwrap();
        // Public, pre-signed harmless fixture: tests never need the release private key.
        let key = include_str!("../../../../tests/fixtures/update-payload.pub").trim();
        assert!(verify(&payload, signature.trim(), key).is_ok());
        assert!(verify(b"tampered", signature.trim(), key).is_err());
        let tls = platform_security::central_tls_config(&ca).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), json!({"pubkey":key}));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().pubkey(key).build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .endpoints(vec![
                Url::parse(&format!("{origin}/client-updates/latest.json")).unwrap(),
            ])
            .unwrap()
            .header("Authorization", "Bearer fixture-token")
            .unwrap()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .configure_client(move |builder| {
                builder
                    .use_preconfigured_tls(tls.clone())
                    .redirect(reqwest::redirect::Policy::none())
                    .https_only(true)
            })
            .build()
            .unwrap();
        let update = updater.check().await.unwrap().unwrap();
        assert_eq!(update.version, "0.2.0");
        validate_download(&origin, &update.download_url).unwrap();
        let client = platform_security::http(&ca).unwrap();
        let response = client
            .get(update.download_url.clone())
            .bearer_auth("fixture-token")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let bytes = response.bytes().await.unwrap();
        assert_eq!(bytes.as_ref(), payload.as_slice());
        verify(&bytes, &update.signature, key).unwrap();
        // The plugin must reject unchanged/older versions and avoid following redirects.
        for (route, present) in [("current", false), ("older", false)] {
            let tls = platform_security::central_tls_config(&ca).unwrap();
            let result = app
                .updater_builder()
                .pubkey(key)
                .endpoints(vec![Url::parse(&format!("{origin}/{route}")).unwrap()])
                .unwrap()
                .no_proxy()
                .configure_client(move |builder| {
                    builder
                        .use_preconfigured_tls(tls.clone())
                        .redirect(reqwest::redirect::Policy::none())
                })
                .build()
                .unwrap()
                .check()
                .await
                .unwrap();
            assert_eq!(result.is_some(), present);
        }
        let tls = platform_security::central_tls_config(&ca).unwrap();
        let redirect = app
            .updater_builder()
            .endpoints(vec![Url::parse(&format!("{origin}/redirect")).unwrap()])
            .unwrap()
            .no_proxy()
            .configure_client(move |builder| {
                builder
                    .use_preconfigured_tls(tls.clone())
                    .redirect(reqwest::redirect::Policy::none())
            })
            .build()
            .unwrap()
            .check()
            .await;
        assert!(redirect.is_err());
        println!("NATIVE_UPDATE_TLS_SIGNATURE_OK");
    }
    #[test]
    fn rejects_cross_origin_and_unsigned_downloads() {
        let origin = "https://central.example:4510";
        assert!(
            validate_download(
                origin,
                &Url::parse("https://central.example:4510/client-updates/files/a.exe").unwrap()
            )
            .is_ok()
        );
        for bad in [
            "http://central.example:4510/client-updates/files/a.exe",
            "https://elsewhere.example/client-updates/files/a.exe",
            "https://central.example:4510/auth/device/status",
            "https://user@central.example:4510/client-updates/files/a.exe",
        ] {
            assert!(validate_download(origin, &Url::parse(bad).unwrap()).is_err());
        }
        assert!(verify(b"corrupt", "bad", "bad").is_err());
    }
}
