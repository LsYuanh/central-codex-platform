// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Windows-only optional runtime selection. Runs before Tauri creates any windows.
use serde::Deserialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const RUNTIME_DIRECTORY: &str = "WebView2Fixed";
const ENABLED_MARKER: &str = "webview2-component.enabled";

#[derive(Debug, PartialEq)]
pub enum RuntimeChoice {
    System,
    Private { path: PathBuf, version: String },
}

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    version: String,
    architecture: String,
    #[serde(rename = "cabSha256")]
    cab_sha256: String,
}

fn regular_path(path: &Path, directory: bool) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| format!("独立 WebView2 组件缺少文件或无法读取：{}", path.display()))?;
    if metadata.file_attributes() & 0x400 != 0
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(format!("独立 WebView2 组件路径无效：{}", path.display()));
    }
    Ok(())
}

pub fn select_runtime(executable_directory: &Path) -> Result<RuntimeChoice, String> {
    let runtime = executable_directory.join(RUNTIME_DIRECTORY);
    // A marker makes a removed/corrupt component diagnosable instead of silently
    // returning to the system runtime that the user explicitly wanted to avoid.
    if !runtime.try_exists().map_err(|e| e.to_string())?
        && !executable_directory.join(ENABLED_MARKER).exists()
    {
        return Ok(RuntimeChoice::System);
    }
    regular_path(&runtime, true)?;
    let manifest_path = runtime.join("yuan-zhou-runtime.json");
    regular_path(&manifest_path, false)?;
    if fs::metadata(&manifest_path)
        .map_err(|e| e.to_string())?
        .len()
        > 4096
    {
        return Err("独立 WebView2 组件清单过大，请重新安装组件".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(manifest_path).map_err(|e| e.to_string())?)
            .map_err(|_| "独立 WebView2 组件清单损坏，请重新安装组件".to_string())?;
    let parts: Vec<_> = manifest.version.split('.').collect();
    if manifest.schema != 1
        || manifest.architecture != "x64"
        || parts.len() != 4
        || parts.iter().any(|part| part.parse::<u16>().is_err())
        || manifest.cab_sha256.len() != 64
        || !manifest.cab_sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("独立 WebView2 组件版本或架构信息无效，请重新安装组件".into());
    }
    for file in [
        "msedgewebview2.exe",
        "msedge.dll",
        "icudtl.dat",
        "resources.pak",
    ] {
        regular_path(&runtime.join(file), false)?;
    }
    Ok(RuntimeChoice::Private {
        path: runtime,
        version: manifest.version,
    })
}

/// Must be called once, at the beginning of main before threads are created.
pub fn configure() -> Result<RuntimeChoice, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe.parent().ok_or("无法定位远舟安装目录")?;
    let choice = select_runtime(parent)?;
    // SAFETY: main calls this before building Tauri, starting Tokio, or spawning
    // any application threads. Only the current process environment is changed.
    unsafe {
        match &choice {
            RuntimeChoice::System => std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"),
            RuntimeChoice::Private { path, .. } => {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", path);
            }
        }
    }
    Ok(choice)
}

pub fn log(identifier: &str, message: &str) -> Option<PathBuf> {
    let directory = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(identifier);
    fs::create_dir_all(&directory).ok()?;
    let path = directory.join("startup.log");
    // Keep diagnostics bounded. No credentials, settings, or message contents.
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 64 * 1024) {
        fs::write(&path, b"").ok()?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    writeln!(file, "{now} {message}").ok()?;
    Some(path)
}

pub fn report_failure(identifier: &str, error: &str) {
    let log_path = log(identifier, &format!("STARTUP_FAILED {error}"));
    let location = log_path
        .map(|p| format!("\n\n诊断日志：{}", p.display()))
        .unwrap_or_default();
    // rfd uses native Windows dialogs; this remains usable when WebView fails.
    rfd::MessageDialog::new()
        .set_title("远舟启动失败")
        .set_level(rfd::MessageLevel::Error)
        .set_description(format!(
            "无法启动远舟窗口。\n\n{error}\n\n请运行远舟独立 WebView2 组件安装包进行安装或修复。客户端小包会保留已有组件，不包含运行时文件。若仍失败，请提供诊断日志。{location}"
        ))
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(base: &Path) -> PathBuf {
        let directory = base.join(RUNTIME_DIRECTORY);
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("yuan-zhou-runtime.json"), serde_json::json!({
            "schema": 1, "version": "153.0.4234.48", "architecture": "x64", "cabSha256": "a".repeat(64)
        }).to_string()).unwrap();
        for file in [
            "msedgewebview2.exe",
            "msedge.dll",
            "icudtl.dat",
            "resources.pak",
        ] {
            fs::write(directory.join(file), b"fixture").unwrap();
        }
        directory
    }

    #[test]
    fn fresh_install_uses_system_and_selected_component_uses_private() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(select_runtime(temp.path()).unwrap(), RuntimeChoice::System);
        let path = fixture(temp.path());
        assert_eq!(
            select_runtime(temp.path()).unwrap(),
            RuntimeChoice::Private {
                path,
                version: "153.0.4234.48".into()
            }
        );
    }

    #[test]
    fn incomplete_component_does_not_silently_fall_back() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(ENABLED_MARKER), "1").unwrap();
        assert!(select_runtime(temp.path()).is_err());
        let directory = fixture(temp.path());
        fs::remove_file(directory.join("msedge.dll")).unwrap();
        assert!(select_runtime(temp.path()).is_err());
    }

    #[test]
    fn invalid_manifest_is_rejected_and_staging_is_not_selected() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("WebView2Fixed.stage")).unwrap();
        assert_eq!(select_runtime(temp.path()).unwrap(), RuntimeChoice::System);
        let directory = fixture(temp.path());
        fs::write(directory.join("yuan-zhou-runtime.json"), "{}").unwrap();
        assert!(select_runtime(temp.path()).is_err());
    }
}
