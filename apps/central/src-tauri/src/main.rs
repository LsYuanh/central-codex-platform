// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;
mod config;
mod diagnostics;
#[cfg(all(test, windows, debug_assertions))]
mod install_qa;
#[cfg(all(test, windows, debug_assertions))]
mod live_qa;
#[cfg(all(test, target_os = "macos", debug_assertions))]
mod macos_provision_qa;
mod model_accounts;
mod people;
#[cfg(all(test, windows, debug_assertions))]
mod people_ui_qa;
mod runtime_package;
mod runtime_updates;
mod service;
mod service_process;
mod tls;

#[cfg(any(test, all(target_os = "macos", debug_assertions)))]
fn retry_native_start<T>(
    attempts: usize,
    mut operation: impl FnMut() -> config::Result<T>,
) -> config::Result<T> {
    for attempt in 0..attempts.max(1) {
        match operation() {
            Err(error) if error.code == "OPERATION_BUSY" && attempt + 1 < attempts => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            result => return result,
        }
    }
    unreachable!()
}

#[cfg(test)]
mod native_start_tests {
    use super::*;

    #[test]
    fn retries_only_temporary_contention_and_stops_at_limit() {
        let mut calls = 0;
        assert_eq!(
            retry_native_start(3, || {
                calls += 1;
                if calls < 3 {
                    Err(config::failure("OPERATION_BUSY"))
                } else {
                    Ok(42)
                }
            })
            .unwrap(),
            42
        );
        assert_eq!(calls, 3);
        calls = 0;
        let result: config::Result<()> = retry_native_start(2, || {
            calls += 1;
            Err(config::failure("OPERATION_BUSY"))
        });
        assert_eq!(result.unwrap_err().code, "OPERATION_BUSY");
        assert_eq!(calls, 2);
        calls = 0;
        let result: config::Result<()> = retry_native_start(3, || {
            calls += 1;
            Err(config::failure("CONFIG_REVISION_CONFLICT"))
        });
        assert_eq!(result.unwrap_err().code, "CONFIG_REVISION_CONFLICT");
        assert_eq!(calls, 1);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CentralUiContext {
    data_directory: String,
    platform: &'static str,
    runtime_available: bool,
    reason: &'static str,
}

fn public_directory_text(path: &std::path::Path) -> config::Result<String> {
    let text = path
        .to_str()
        .ok_or_else(|| config::failure("CONFIG_STORAGE_UNSAFE"))?;
    #[cfg(windows)]
    {
        // resource_root returns a canonical path. Only standard DOS disk paths
        // have a compatible public spelling; UNC/device/volume aliases fail closed.
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        let bytes = text.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'\\'
            || text.contains(['\0', '?'])
        {
            return Err(config::failure("CONFIG_STORAGE_UNSAFE"));
        }
        Ok(text.to_owned())
    }
    #[cfg(not(windows))]
    {
        if !path.is_absolute() {
            return Err(config::failure("CONFIG_STORAGE_UNSAFE"));
        }
        Ok(text.to_owned())
    }
}

fn default_data_directory(app_data: &std::path::Path) -> config::Result<String> {
    // Only the native Known Folder enters this helper. Create/pin the application
    // metadata root if absent so MSIX virtualization is resolved even on first use.
    // Do not create central-data: strict ACLs/ownership remain Service's job.
    let physical = config::resource_root(app_data, true)?;
    public_directory_text(&physical.join("central-data"))
}

#[cfg(test)]
mod default_directory_tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn public_default_accepts_only_dos_spelling_of_canonical_disk_paths() {
        assert_eq!(
            public_directory_text(std::path::Path::new(r"\\?\C:\Users\synthetic\central-data"))
                .unwrap(),
            r"C:\Users\synthetic\central-data"
        );
        for path in [
            r"\\?\UNC\server\share",
            r"\\?\Volume{synthetic}\central-data",
            r"\\.\PhysicalDrive0",
            r"relative\central-data",
        ] {
            assert_eq!(
                public_directory_text(std::path::Path::new(path))
                    .err()
                    .unwrap()
                    .code,
                "CONFIG_STORAGE_UNSAFE"
            );
        }
    }
    #[test]
    fn fresh_default_resolves_metadata_root_without_creating_service_data() {
        let temporary = tempfile::tempdir().unwrap();
        let app_data = temporary.path().join("new-application");
        assert!(!app_data.exists());
        let directory = default_data_directory(&app_data).unwrap();
        let path = std::path::Path::new(&directory);
        assert!(app_data.is_dir());
        assert!(!path.exists());
        assert_eq!(
            path.file_name().and_then(|v| v.to_str()),
            Some("central-data")
        );
        assert_eq!(
            path.parent().unwrap().canonicalize().unwrap(),
            app_data.canonicalize().unwrap()
        );
        assert!(!app_data.join(".central-service.lock").exists());
        #[cfg(windows)]
        assert!(!directory.starts_with(r"\\?\"));
    }
    #[cfg(windows)]
    #[test]
    fn default_context_does_not_migrate_an_existing_saved_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let app_data = temporary.path().join("application");
        let selected = temporary
            .path()
            .join("explicitly-selected-data")
            .to_string_lossy()
            .into_owned();
        config::save(&app_data,"existing-directory-config".into(),0,serde_json::json!({"schemaVersion":1,"revision":0,"dataDirectory":selected,"listen":{"host":"127.0.0.1","port":14523},"clientUrl":"wss://central-test.invalid:14523/ws","tls":{"certificateId":"synthetic"},"runtimePackageId":"synthetic","limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},"shutdown":{"graceMs":1000,"forceMs":5000}})).unwrap();
        let default = default_data_directory(&app_data).unwrap();
        assert_ne!(default, selected);
        let saved = config::read(&app_data).unwrap().config.unwrap();
        assert_eq!(saved.data_directory, selected);
        assert_eq!(saved.revision, 1);
    }
}

/// Return a physical default for new configuration. This may initialize the
/// application's metadata root, never its service data or another app's credentials.
#[tauri::command]
async fn central_ui_context(app: tauri::AppHandle) -> config::Result<CentralUiContext> {
    let root = config_root(&app)?;
    let data_directory =
        tauri::async_runtime::spawn_blocking(move || default_data_directory(&root))
            .await
            .map_err(|_| config::failure("INTERNAL_ERROR"))??;
    Ok(CentralUiContext {
        data_directory,
        platform: match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            other => other,
        },
        runtime_available: false,
        reason: "可以导入本机账号与证书，并在开发版本中启动已校验的候选中央服务；正式运行包资格验收仍未完成。",
    })
}

fn config_root(app: &tauri::AppHandle) -> config::Result<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|_| config::failure("CONFIG_STORAGE_UNSAFE"))
}
#[tauri::command]
async fn central_config_read(app: tauri::AppHandle) -> config::Result<config::ReadResponse> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || config::read(&root))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
fn central_config_validate(config: serde_json::Value) -> config::Validation {
    config::validate(config)
}
#[tauri::command]
async fn central_config_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    request_id: String,
    expected_revision: u64,
    config: serde_json::Value,
) -> config::Result<config::SaveResponse> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        controller.save_config(&root, request_id, expected_revision, config)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_runtime_inspect(app: tauri::AppHandle) -> config::Result<config::Inspection> {
    let _scan = ResourceScan::acquire()?;
    let root = config_root(&app)?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| config::failure("RUNTIME_MISSING"))?;
    tauri::async_runtime::spawn_blocking(move || config::inspect_resources(&root, &resources))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
fn central_runtime_catalog() -> Vec<runtime_package::PublicPackage> {
    runtime_package::catalog()
}

#[tauri::command]
async fn central_package_inspect(
    app: tauri::AppHandle,
    package_id: String,
) -> config::Result<runtime_package::PackageInspection> {
    let _scan = ResourceScan::acquire()?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| config::failure("RUNTIME_MISSING"))?;
    tauri::async_runtime::spawn_blocking(move || runtime_package::inspect(&resources, &package_id))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))
}

#[tauri::command]
async fn central_tls_list(
    app: tauri::AppHandle,
    client_url: String,
) -> config::Result<Vec<tls::CertificateEntry>> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || tls::list(&root, &client_url))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

static RESOURCE_DIALOG_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static RESOURCE_SCAN_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
struct ResourceScan;
impl ResourceScan {
    fn acquire() -> config::Result<Self> {
        RESOURCE_SCAN_RUNNING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| config::failure("OPERATION_BUSY"))?;
        Ok(Self)
    }
}
impl Drop for ResourceScan {
    fn drop(&mut self) {
        RESOURCE_SCAN_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
struct ResourceDialog;
impl ResourceDialog {
    fn acquire() -> config::Result<Self> {
        RESOURCE_DIALOG_OPEN
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| config::failure("OPERATION_BUSY"))?;
        Ok(Self)
    }
}
impl Drop for ResourceDialog {
    fn drop(&mut self) {
        RESOURCE_DIALOG_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
async fn central_tls_import(
    app: tauri::AppHandle,
    client_url: String,
) -> config::Result<Option<tls::CertificateReport>> {
    let _dialog = ResourceDialog::acquire()?;
    let root = config_root(&app)?;
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("选择证书目录（server.pem、server-key.pem、ca.pem）")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let source = folder.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        tls::import_directory(&root, &source, &client_url).map(Some)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_tls_export_ca(
    app: tauri::AppHandle,
    certificate_id: String,
) -> config::Result<bool> {
    let _dialog = ResourceDialog::acquire()?;
    let root = config_root(&app)?;
    let pem = tauri::async_runtime::spawn_blocking(move || tls::public_ca(&root, &certificate_id))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))??;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("导出公共 CA（请选择新文件）")
        .set_file_name("central-ca.pem")
        .add_filter("PEM", &["pem"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let path = file.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        // No private material leaves the native store. Existing files are never overwritten.
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|_| config::failure("TLS_EXPORT_FAILED"))?;
        output
            .write_all(pem.as_bytes())
            .and_then(|_| output.sync_all())
            .map_err(|_| config::failure("TLS_EXPORT_FAILED"))?;
        Ok(true)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

/// Selecting a directory grants no filesystem or runtime capability to the UI.
#[tauri::command]
async fn central_choose_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("选择中央数据目录")
        .pick_folder()
        .await
        .map(|directory| directory.path().to_string_lossy().into_owned())
}

#[tauri::command]
async fn central_model_accounts_list(
    app: tauri::AppHandle,
) -> config::Result<Vec<model_accounts::AccountEntry>> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || model_accounts::list(&root))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_model_account_discover() -> config::Result<model_accounts::DiscoveredAccount> {
    tauri::async_runtime::spawn_blocking(model_accounts::discover_existing)
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_model_account_link(
    app: tauri::AppHandle,
) -> config::Result<model_accounts::AccountReport> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || model_accounts::shared::link_existing(&root))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_model_account_import(
    app: tauri::AppHandle,
) -> config::Result<model_accounts::AccountReport> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || model_accounts::import_existing(&root))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
fn central_service_status(
    state: tauri::State<'_, Arc<service::Service>>,
) -> service_process::Snapshot {
    state.snapshot()
}
#[tauri::command]
fn central_runtime_update_status(
    controller: tauri::State<'_, Arc<service::Service>>,
) -> runtime_updates::Status {
    controller.updates.status()
}
#[tauri::command]
fn central_runtime_update_check(controller: tauri::State<'_, Arc<service::Service>>) {
    controller.updates.request_check();
}
#[tauri::command]
async fn central_service_context(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
) -> config::Result<service::Context> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller.context(&root))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_service_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    request_id: String,
    expected_revision: u64,
    account_id: String,
    admin_username: Option<String>,
    admin_password: Option<String>,
) -> config::Result<service_process::Snapshot> {
    let admin_password = admin_password.map(zeroize::Zeroizing::new);
    let root = config_root(&app)?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| config::failure("RUNTIME_MISSING"))?;
    let controller = state.inner().clone();
    let request = service::StartRequest {
        request_id,
        expected_revision,
        account_id,
        admin_username,
        admin_password,
    };
    tauri::async_runtime::spawn_blocking(move || controller.start(&root, &resources, request))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_service_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    request_id: String,
    expected_instance_id: String,
) -> config::Result<service_process::Snapshot> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = controller.stop(&root, &request_id, &expected_instance_id);
        if result.is_ok() {
            manager.clear_session();
        }
        result
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_diagnostics_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
) -> config::Result<diagnostics::Report> {
    let root = config_root(&app)?;
    let app_version = app.package_info().version.to_string();
    let controller = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = diagnostics::build_report(&root, controller.snapshot());
        report.app_version = app_version;
        report
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))
}

#[tauri::command]
async fn central_diagnostics_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
) -> config::Result<bool> {
    let _dialog = ResourceDialog::acquire()?;
    let root = config_root(&app)?;
    let app_version = app.package_info().version.to_string();
    let controller = state.inner().clone();
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("保存诊断报告（请选择新文件）")
        .set_file_name("central-diagnostics.json")
        .add_filter("JSON", &["json"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let path = file.path().to_owned();
    // Sample after the user chooses a destination. The renderer supplies no
    // report payload, filesystem path, credentials, or commands to this IPC.
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = diagnostics::build_report(&root, controller.snapshot());
        report.app_version = app_version;
        diagnostics::write_report(&path, &report)?;
        Ok(true)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
) -> config::Result<people::Status> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.status(&controller, &root))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
    username: String,
    password: String,
) -> config::Result<people::Status> {
    let password = zeroize::Zeroizing::new(password);
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.login(
            &controller,
            &root,
            &expected_instance_id,
            username,
            password,
        )
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_logout(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
) -> config::Result<people::Status> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.logout(&controller, &root, &expected_instance_id)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
) -> config::Result<people::Inventory> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.list(&controller, &root, &expected_instance_id)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_create_user(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
    request_id: String,
    username: String,
) -> config::Result<people::MutationResult> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.mutate(
            &controller,
            &root,
            &expected_instance_id,
            &request_id,
            people::Mutation::CreateUser { username },
        )
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_disable_user(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
    request_id: String,
    user_id: String,
) -> config::Result<people::MutationResult> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.mutate(
            &controller,
            &root,
            &expected_instance_id,
            &request_id,
            people::Mutation::DisableUser { user_id },
        )
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_pair_code(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
    request_id: String,
    user_id: String,
) -> config::Result<people::MutationResult> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.mutate(
            &controller,
            &root,
            &expected_instance_id,
            &request_id,
            people::Mutation::PairCode { user_id },
        )
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

#[tauri::command]
async fn central_people_revoke_device(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<service::Service>>,
    people: tauri::State<'_, Arc<people::People>>,
    expected_instance_id: String,
    request_id: String,
    device_id: String,
) -> config::Result<people::MutationResult> {
    let root = config_root(&app)?;
    let controller = state.inner().clone();
    let manager = people.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.mutate(
            &controller,
            &root,
            &expected_instance_id,
            &request_id,
            people::Mutation::RevokeDevice { device_id },
        )
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}

static APP_EXIT_ALLOWED: AtomicBool = AtomicBool::new(false);
#[tauri::command]
async fn central_model_login_open() -> config::Result<()> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("rundll32.exe")
                .args([
                    "url.dll,FileProtocolHandler",
                    "https://auth.openai.com/codex/device",
                ])
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|_| config::failure("MODEL_LOGIN_BROWSER_FAILED"))?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("/usr/bin/open")
                .arg("https://auth.openai.com/codex/device")
                .spawn()
                .map_err(|_| config::failure("MODEL_LOGIN_BROWSER_FAILED"))?;
        }
        Ok(())
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_model_login_start() -> config::Result<model_accounts::renewal::LoginStatus> {
    tauri::async_runtime::spawn_blocking(model_accounts::renewal::login_start)
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_model_login_poll(
    app: tauri::AppHandle,
    login_id: String,
) -> config::Result<model_accounts::renewal::LoginStatus> {
    let root = config_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        model_accounts::renewal::login_poll(&root, &login_id)
    })
    .await
    .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
#[tauri::command]
async fn central_model_login_cancel(login_id: String) -> config::Result<()> {
    tauri::async_runtime::spawn_blocking(move || model_accounts::renewal::login_cancel(&login_id))
        .await
        .map_err(|_| config::failure("INTERNAL_ERROR"))?
}
static APP_EXIT_STARTED: AtomicBool = AtomicBool::new(false);
fn begin_app_shutdown(app: &tauri::AppHandle) {
    if APP_EXIT_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let controller = app.state::<Arc<service::Service>>().inner().clone();
    controller.begin_shutdown();
    app.state::<Arc<people::People>>().clear_session();
    let app = app.clone();
    std::thread::spawn(move || {
        let clean = controller.shutdown();
        APP_EXIT_ALLOWED.store(true, Ordering::SeqCst);
        app.exit(if clean { 0 } else { 1 });
    });
}

fn main() {
    #[cfg(target_os = "macos")]
    service_process::guardian_main_if_requested();
    let app = tauri::Builder::default()
        .manage(Arc::new(service::Service::new()))
        .manage(Arc::new(people::People::new()))
        .invoke_handler(tauri::generate_handler![
            central_ui_context,
            central_choose_directory,
            central_config_read,
            central_config_validate,
            central_config_save,
            central_runtime_inspect,
            central_runtime_catalog,
            central_package_inspect,
            central_tls_list,
            central_tls_import,
            central_tls_export_ca,
            central_model_accounts_list,
            central_model_account_discover,
            central_model_account_import,
            central_model_account_link,
            central_model_login_start,
            central_model_login_poll,
            central_model_login_cancel,
            central_model_login_open,
            central_service_status,
            central_runtime_update_status,
            central_runtime_update_check,
            central_service_context,
            central_service_start,
            central_service_stop,
            central_diagnostics_read,
            central_diagnostics_export,
            central_people_status,
            central_people_login,
            central_people_logout,
            central_people_list,
            central_people_create_user,
            central_people_disable_user,
            central_people_pair_code,
            central_people_revoke_device
        ])
        .build(tauri::generate_context!())
        .expect("无法启动中央管理应用");
    if let Ok(root) = config_root(app.handle()) {
        if let Ok(resources) = app.path().resource_dir() {
            let weak = Arc::downgrade(app.state::<Arc<service::Service>>().inner());
            let update_root = root.clone();
            std::thread::spawn(move || {
                let mut next_check = std::time::Instant::now();
                loop {
                    if APP_EXIT_STARTED.load(Ordering::SeqCst) {
                        break;
                    }
                    let Some(controller) = weak.upgrade() else {
                        break;
                    };
                    if std::time::Instant::now() >= next_check || controller.updates.take_request()
                    {
                        let result = controller.updates.check(&update_root);
                        next_check = std::time::Instant::now()
                            + std::time::Duration::from_secs(if result.is_ok() {
                                86400
                            } else {
                                3600
                            });
                    }
                    if let Err(error) = controller.apply_pending_update(&update_root, &resources) {
                        if error.code != "OPERATION_BUSY"
                            && !matches!(
                                controller.updates.status().state,
                                "rolled-back" | "activation-unconfirmed"
                            )
                        {
                            if let Ok(mut candidate) = controller.updates.candidate.lock() {
                                *candidate = None;
                            }
                            controller.updates.set("failed", Some(error.code));
                        }
                    }
                    drop(controller);
                    std::thread::sleep(std::time::Duration::from_secs(30));
                }
            });
        }
        let weak = Arc::downgrade(app.state::<Arc<service::Service>>().inner());
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                let Some(controller) = weak.upgrade() else {
                    break;
                };
                if APP_EXIT_STARTED.load(Ordering::SeqCst) {
                    break;
                }
                let _ = controller.renew_account(&root);
            }
        });
    }
    // Local developer/deployment launch convenience. Uses the same saved config,
    // native credential store and service gates as the UI; no secret argv/env.
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() == 3 && args[1] == "--start-account" {
            let account_id = args[2].clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // UI startup reads may briefly hold the configuration lock.
                // Keep one idempotency key across bounded contention retries.
                let request_id = format!(
                    "native-launch-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                );
                let result = retry_native_start(50, || -> config::Result<()> {
                    let root = config_root(&handle)?;
                    let saved = config::read(&root)?
                        .config
                        .ok_or_else(|| config::failure("CONFIG_INVALID"))?;
                    let resources = handle
                        .path()
                        .resource_dir()
                        .map_err(|_| config::failure("RUNTIME_MISSING"))?;
                    handle.state::<Arc<service::Service>>().start(
                        &root,
                        &resources,
                        service::StartRequest {
                            request_id: request_id.clone(),
                            expected_revision: saved.revision,
                            account_id: account_id.clone(),
                            admin_username: None,
                            admin_password: None,
                        },
                    )?;
                    Ok(())
                });
                if let Err(error) = result {
                    eprintln!("Native startup: {}", error.code);
                }
            });
        }
    }
    app.run(|app, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && !APP_EXIT_ALLOWED.load(Ordering::SeqCst) => {
            api.prevent_close();
            begin_app_shutdown(app);
        }
        tauri::RunEvent::ExitRequested { api, .. } if !APP_EXIT_ALLOWED.load(Ordering::SeqCst) => {
            api.prevent_exit();
            begin_app_shutdown(app);
        }
        _ => {}
    });
}
