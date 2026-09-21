// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Public, preparatory configuration only: no credentials, service ownership or startup.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, TcpListener},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_STORE: u64 = 4 * 1024 * 1024;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    recoverable: bool,
    diagnostic_id: String,
}
pub type Result<T> = std::result::Result<T, Failure>;
pub fn failure(code: &'static str) -> Failure {
    let diagnostic_id = format!("central-{}-{}", std::process::id(), now());
    eprintln!("{diagnostic_id}: {code}");
    Failure {
        code,
        recoverable: !matches!(code, "CONFIG_STORAGE_FULL" | "RUNTIME_PLATFORM_MISMATCH"),
        diagnostic_id,
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "unsupported"
    }
}

macro_rules! dto { ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
    #[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all="camelCase", deny_unknown_fields)]
    pub struct $name { $(pub $field: $ty),* }
}; }
dto!(CentralConfig {
    schema_version: u64,
    revision: u64,
    data_directory: String,
    listen: Listen,
    client_url: String,
    tls: Tls,
    runtime_package_id: String,
    limits: Limits,
    shutdown: Shutdown
});
dto!(Listen {
    host: String,
    port: u64
});
dto!(Tls {
    certificate_id: String
});
dto!(Limits {
    max_workers: u64,
    per_user_turns: u64,
    total_turns: u64
});
dto!(Shutdown {
    grace_ms: u64,
    force_ms: u64
});
#[derive(Serialize)]
pub struct Issue {
    field: &'static str,
    code: &'static str,
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum Validation {
    Valid { ok: bool, config: CentralConfig },
    Invalid { ok: bool, issues: Vec<Issue> },
}
fn id(value: &str) -> bool {
    (1..=101).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn valid_directory(value: &str, windows: bool) -> bool {
    if value.is_empty() || value.len() > 4096 || value.chars().any(|c| c < ' ') {
        return false;
    }
    let parts: Vec<&str> = value
        .split(if windows {
            &['/', '\\'][..]
        } else {
            &['/'][..]
        })
        .collect();
    if parts.iter().any(|p| matches!(*p, "." | "..")) {
        return false;
    }
    if !windows {
        return value.starts_with('/') && parts.iter().any(|p| !p.is_empty());
    }
    let bytes = value.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !b"/\\".contains(&bytes[2])
        || value[2..].contains(':')
        || value.contains(['<', '>', '"', '|', '?', '*'])
    {
        return false;
    }
    let components: Vec<&str> = value[3..].split(['/', '\\']).collect();
    components.iter().any(|p| !p.is_empty())
        && components.iter().all(|p| {
            let base = p.split('.').next().unwrap_or("").to_uppercase();
            !p.ends_with(['.', ' '])
                && !["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
                && !(base
                    .strip_prefix("COM")
                    .or_else(|| base.strip_prefix("LPT"))
                    .is_some_and(|suffix| {
                        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"]
                            .contains(&suffix)
                    }))
        })
}
pub fn validate(value: Value) -> Validation {
    validate_for(value, cfg!(windows))
}
fn validate_for(value: Value, windows: bool) -> Validation {
    let config: CentralConfig = match serde_json::from_value(value) {
        Ok(c) => c,
        Err(_) => {
            return Validation::Invalid {
                ok: false,
                issues: vec![Issue {
                    field: "config",
                    code: "CONFIG_INVALID",
                }],
            };
        }
    };
    let mut issues = vec![];
    let mut bad = |field, code| issues.push(Issue { field, code });
    if config.schema_version != 1 {
        bad("schemaVersion", "CONFIG_VERSION_UNSUPPORTED");
    }
    if config.revision > SAFE_INTEGER {
        bad("revision", "CONFIG_INVALID");
    }
    if !valid_directory(&config.data_directory, windows) {
        bad("dataDirectory", "CONFIG_INVALID");
    }
    if config.listen.host.parse::<IpAddr>().is_err() {
        bad("listen.host", "CONFIG_INVALID");
    }
    if !(1024..=65535).contains(&config.listen.port) {
        bad("listen.port", "CONFIG_INVALID");
    }
    let valid_url = !config
        .client_url
        .chars()
        .any(|c| c <= ' ' || c == '\u{7f}' || c == '\\')
        && config.client_url.len() <= 2048
        && url::Url::parse(&config.client_url).is_ok_and(|u| {
            let host = u
                .host_str()
                .unwrap_or("")
                .trim_matches(['[', ']'])
                .to_lowercase();
            u.scheme() == "wss"
                && u.path() == "/ws"
                && u.query().is_none()
                && u.fragment().is_none()
                && u.username().is_empty()
                && u.password().is_none()
                && !host.is_empty()
                && !["localhost", "0.0.0.0", "::", "::1"].contains(&host.as_str())
                && !host.ends_with(".localhost")
                && !host.starts_with("127.")
                && !host.starts_with("::ffff:")
                && u.port_or_known_default().map(u64::from) == Some(config.listen.port)
        });
    if !valid_url {
        bad("clientUrl", "CONFIG_INVALID");
    }
    if !id(&config.tls.certificate_id) {
        bad("tls.certificateId", "CONFIG_INVALID");
    }
    if !id(&config.runtime_package_id) {
        bad("runtimePackageId", "CONFIG_INVALID");
    }
    if !(1..=128).contains(&config.limits.max_workers) {
        bad("limits.maxWorkers", "CONFIG_INVALID");
    }
    if !(1..=32).contains(&config.limits.per_user_turns)
        || config.limits.per_user_turns > config.limits.total_turns
    {
        bad("limits.perUserTurns", "CONFIG_INVALID");
    }
    if !(1..=128).contains(&config.limits.total_turns) {
        bad("limits.totalTurns", "CONFIG_INVALID");
    }
    if config.shutdown.grace_ms > 60000 {
        bad("shutdown.graceMs", "CONFIG_INVALID");
    }
    if !(1000..=15000).contains(&config.shutdown.force_ms) {
        bad("shutdown.forceMs", "CONFIG_INVALID");
    }
    if issues.is_empty() {
        Validation::Valid { ok: true, config }
    } else {
        Validation::Invalid { ok: false, issues }
    }
}
fn admitted(value: Value) -> Result<CentralConfig> {
    match validate(value) {
        Validation::Valid { config, .. } => Ok(config),
        Validation::Invalid { issues, .. } => Err(failure(issues[0].code)),
    }
}

// The receipt and config commit together. A crash cannot commit one without the other.
// No receipt eviction: an old request must never become a new write after restart.
dto!(Receipt {
    request_id: String,
    fingerprint: String,
    config: CentralConfig
});
dto!(Store { store_version: u64, config: CentralConfig, receipts: Vec<Receipt> });
#[derive(Serialize)]
pub struct ReadResponse {
    initialized: bool,
    pub(crate) config: Option<CentralConfig>,
}
#[derive(Serialize)]
pub struct SaveResponse {
    config: CentralConfig,
}

fn unsafe_storage<T>(_: T) -> Failure {
    failure("CONFIG_STORAGE_UNSAFE")
}
fn metadata_safe(meta: &fs::Metadata, directory: bool) -> Result<()> {
    if meta.file_type().is_symlink()
        || meta.is_dir() != directory
        || (!directory && !meta.is_file())
    {
        return Err(failure("CONFIG_STORAGE_UNSAFE"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(failure("CONFIG_STORAGE_UNSAFE"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !directory
            && (meta.nlink() != 1
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0)
        {
            return Err(failure("CONFIG_STORAGE_UNSAFE"));
        }
    }
    Ok(())
}
fn open_checked(path: &Path, directory: bool, exclusive: bool, create: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(exclusive).create(create);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        if directory {
            options.access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES);
        }
        options
            .custom_flags(
                FILE_FLAG_OPEN_REPARSE_POINT
                    | if directory {
                        FILE_FLAG_BACKUP_SEMANTICS
                    } else {
                        0
                    },
            )
            .share_mode(if exclusive { 0 } else { FILE_SHARE_READ });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    let file = options.open(path).map_err(|e| {
        if exclusive && e.raw_os_error() == Some(32) {
            failure("OPERATION_BUSY")
        } else {
            unsafe_storage(e)
        }
    })?;
    metadata_safe(&file.metadata().map_err(unsafe_storage)?, directory)?;
    #[cfg(windows)]
    if !directory {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::*;
        let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.nNumberOfLinks != 1
        {
            return Err(failure("CONFIG_STORAGE_UNSAFE"));
        }
    }
    if exclusive {
        file.try_lock().map_err(|_| failure("OPERATION_BUSY"))?;
    }
    Ok(file)
}
/// Windows ancestor handles deny mutation/delete sharing until the transaction
/// ends. The writable target retains deny-delete sharing for atomic replacement.
fn pin_directories(path: &Path, create: bool) -> Result<Option<Vec<File>>> {
    #[cfg(target_os = "macos")]
    {
        use platform_security::central_secret_store::{SecretStoreError, macos};
        return match macos::pin_directories(path, create, true) {
            Ok(pins) => Ok(Some(pins)),
            Err(SecretStoreError::NotFound) if !create => Ok(None),
            Err(error) => Err(unsafe_storage(error)),
        };
    }
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err(failure("CONFIG_STORAGE_UNSAFE"));
    }
    let mut pins = vec![];
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) => metadata_safe(&meta, true)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    fs::DirBuilder::new()
                        .mode(0o700)
                        .create(&current)
                        .map_err(unsafe_storage)?;
                }
                #[cfg(not(unix))]
                fs::create_dir(&current).map_err(unsafe_storage)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(unsafe_storage(e)),
        }
        if create && current == path {
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                use windows_sys::Win32::Storage::FileSystem::*;
                let pin = OpenOptions::new()
                    .read(true)
                    .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                    .open(&current)
                    .map_err(unsafe_storage)?;
                metadata_safe(&pin.metadata().map_err(unsafe_storage)?, true)?;
                pins.push(pin);
            }
            #[cfg(not(windows))]
            pins.push(open_checked(&current, true, false, false)?);
        } else {
            pins.push(open_checked(&current, true, false, false)?);
        }
    }
    Ok(Some(pins))
}
fn transaction(app_data: &Path, create: bool) -> Result<Option<(PathBuf, Vec<File>, File)>> {
    let directory = app_data.join("config");
    let Some(pins) = pin_directories(&directory, create)? else {
        return Ok(None);
    };
    let lock = open_checked(&directory.join("central.lock"), false, true, true)?;
    Ok(Some((directory, pins, lock)))
}
fn read_store(directory: &Path) -> Result<Option<Store>> {
    let path = directory.join("central-config.json");
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(unsafe_storage(e)),
        Ok(meta) => metadata_safe(&meta, false)?,
    }
    let file = open_checked(&path, false, false, false)?;
    let mut bytes = vec![];
    file.take(MAX_STORE + 1)
        .read_to_end(&mut bytes)
        .map_err(unsafe_storage)?;
    if bytes.len() as u64 > MAX_STORE {
        return Err(failure("CONFIG_STORAGE_UNSAFE"));
    }
    let store: Store = serde_json::from_slice(&bytes).map_err(unsafe_storage)?;
    if store.store_version != 1 {
        return Err(failure("CONFIG_VERSION_UNSUPPORTED"));
    }
    admitted(serde_json::to_value(&store.config).map_err(unsafe_storage)?)?;
    if store.config.revision == 0
        || store.receipts.len() != store.config.revision as usize
        || store.receipts.len() > 1024
    {
        return Err(failure("CONFIG_STORAGE_UNSAFE"));
    }
    let mut ids = std::collections::HashSet::new();
    for (i, receipt) in store.receipts.iter().enumerate() {
        if !id(&receipt.request_id)
            || !ids.insert(&receipt.request_id)
            || receipt.config.revision != (i + 1) as u64
            || receipt.fingerprint.len() != 64
            || !receipt.fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(failure("CONFIG_STORAGE_UNSAFE"));
        }
        admitted(serde_json::to_value(&receipt.config).map_err(unsafe_storage)?)?;
    }
    if store.receipts.last().map(|r| &r.config) != Some(&store.config) {
        return Err(failure("CONFIG_STORAGE_UNSAFE"));
    }
    Ok(Some(store))
}
pub fn read(app_data: &Path) -> Result<ReadResponse> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err(failure("RUNTIME_PLATFORM_MISMATCH"));
    }
    let config = match transaction(app_data, false)? {
        Some((directory, _pins, _lock)) => read_store(&directory)?.map(|s| s.config),
        None => None,
    };
    Ok(ReadResponse {
        initialized: config.is_some(),
        config,
    })
}
pub fn save(
    app_data: &Path,
    request_id: String,
    expected_revision: u64,
    value: Value,
) -> Result<SaveResponse> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err(failure("RUNTIME_PLATFORM_MISMATCH"));
    }
    if !id(&request_id) || expected_revision > SAFE_INTEGER {
        return Err(failure("CONFIG_INVALID"));
    }
    let mut config = admitted(value)?;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(expected_revision, &config)).map_err(unsafe_storage)?)
    );
    let (directory, _pins, _lock) =
        transaction(app_data, true)?.ok_or_else(|| failure("CONFIG_STORAGE_UNSAFE"))?;
    let previous = read_store(&directory)?;
    if let Some(receipt) = previous
        .as_ref()
        .and_then(|s| s.receipts.iter().find(|r| r.request_id == request_id))
    {
        if receipt.fingerprint != fingerprint {
            return Err(failure("CONFIG_REVISION_CONFLICT"));
        }
        return Ok(SaveResponse {
            config: receipt.config.clone(),
        });
    }
    let revision = previous.as_ref().map_or(0, |s| s.config.revision);
    if config.revision != expected_revision
        || revision != expected_revision
        || revision >= SAFE_INTEGER
    {
        return Err(failure("CONFIG_REVISION_CONFLICT"));
    }
    let mut receipts = previous.map_or_else(Vec::new, |s| s.receipts);
    if receipts.len() >= 1024 {
        return Err(failure("CONFIG_STORAGE_FULL"));
    }
    config.revision += 1;
    receipts.push(Receipt {
        request_id,
        fingerprint,
        config: config.clone(),
    });
    let bytes = serde_json::to_vec_pretty(&Store {
        store_version: 1,
        config: config.clone(),
        receipts,
    })
    .map_err(unsafe_storage)?;
    if bytes.len() as u64 > MAX_STORE {
        return Err(failure("CONFIG_STORAGE_FULL"));
    }
    let mut temporary = new_temporary(&directory)?;
    temporary.write_all(&bytes).map_err(unsafe_storage)?;
    temporary.as_file().sync_all().map_err(unsafe_storage)?;
    replace_temporary(temporary, &directory, &_pins)?;
    #[cfg(unix)]
    File::open(&directory)
        .and_then(|f| f.sync_all())
        .map_err(unsafe_storage)?;
    Ok(SaveResponse { config })
}

fn new_temporary(directory: &Path) -> Result<tempfile::NamedTempFile> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        tempfile::Builder::new()
            .make_in(directory, |path| {
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
                    .share_mode(0)
                    .open(path)
            })
            .map_err(unsafe_storage)
    }
    #[cfg(not(windows))]
    tempfile::NamedTempFile::new_in(directory).map_err(unsafe_storage)
}
fn replace_temporary(
    temporary: tempfile::NamedTempFile,
    directory: &Path,
    pins: &[File],
) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::*;
        // Rename through the already pinned directory handle, avoiding a second
        // path lookup while its deny-delete share protection stays held.
        let name: Vec<u16> = "central-config.json".encode_utf16().collect();
        let bytes = std::mem::size_of::<FILE_RENAME_INFO>() + name.len() * 2;
        let mut storage = vec![0u64; bytes.div_ceil(8)];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            (*info).Anonymous.ReplaceIfExists = true;
            (*info).RootDirectory = pins
                .last()
                .ok_or_else(|| failure("CONFIG_STORAGE_UNSAFE"))?
                .as_raw_handle();
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                std::ptr::addr_of_mut!((*info).FileName).cast(),
                name.len(),
            );
            #[repr(C)]
            struct IoStatus {
                status: usize,
                information: usize,
            }
            #[link(name = "ntdll")]
            unsafe extern "system" {
                fn NtSetInformationFile(
                    file: *mut std::ffi::c_void,
                    status: *mut IoStatus,
                    info: *mut std::ffi::c_void,
                    length: u32,
                    class: u32,
                ) -> i32;
            }
            let mut status = IoStatus {
                status: 0,
                information: 0,
            };
            let result = NtSetInformationFile(
                temporary.as_file().as_raw_handle(),
                &mut status,
                info.cast(),
                bytes as u32,
                10,
            );
            if result < 0 {
                return Err(unsafe_storage(result));
            }
        }
        temporary.as_file().sync_all().map_err(unsafe_storage)?;
        let _ = directory;
        // TempPath cleanup now addresses the absent old name, not the committed file.
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = pins;
        temporary
            .persist(directory.join("central-config.json"))
            .map_err(unsafe_storage)?;
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    platform: &'static str,
    config_revision: u64,
    inspected_at: u64,
    checks: Vec<Check>,
}
#[derive(Serialize)]
pub struct Check {
    component: &'static str,
    state: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<Failure>,
}
fn check(
    component: &'static str,
    state: &'static str,
    message: &'static str,
    code: Option<&'static str>,
) -> Check {
    Check {
        component,
        state,
        message,
        failure: code.map(failure),
    }
}
/// Only the native application's AppData root may be passed here. Windows can
/// virtualize this known folder when launched by an MSIX host. Reject reparse
/// ancestors first, then resolve while those directory handles remain pinned.
/// The secret store independently pins and checks the entire physical path.
pub fn resource_root(app_data: &Path, create: bool) -> Result<PathBuf> {
    let Some(_pins) = pin_directories(app_data, create)? else {
        return Ok(app_data.to_owned());
    };
    fs::canonicalize(app_data).map_err(|_| failure("CONFIG_STORAGE_UNSAFE"))
}

pub fn inspect_resources(app_data: &Path, resources: &Path) -> Result<Inspection> {
    let mut inspection = inspect(app_data)?;
    let config = read(app_data)?
        .config
        .ok_or_else(|| failure("CONFIG_INVALID"))?;
    if config.revision != inspection.config_revision {
        return Err(failure("CONFIG_REVISION_CONFLICT"));
    }
    let package = crate::runtime_package::inspect(resources, &config.runtime_package_id);
    inspection.checks[0] = match package.status {
        "verified" => check(
            "package",
            "passed",
            "完整候选包的清单、文件和哈希已核验；可用于开发版验证服务，尚未获得正式发布资格。",
            None,
        ),
        "candidate-incomplete" => check(
            "package",
            "failed",
            "候选包文件哈希通过；仍缺少网关、正式 Windows Worker 和完整运行包验收。",
            Some("RUNTIME_MISSING"),
        ),
        "invalid" => check(
            "package",
            "failed",
            "运行包文件、路径或哈希不符合内置清单，请重新准备正确资源。",
            Some("RUNTIME_HASH_MISMATCH"),
        ),
        "unsupported" => check(
            "package",
            "failed",
            "候选包不支持当前平台或架构。",
            Some("RUNTIME_PLATFORM_MISMATCH"),
        ),
        _ => check(
            "package",
            "failed",
            "当前引用的候选运行包不存在，请在资源配置中检查文件。",
            Some("RUNTIME_MISSING"),
        ),
    };
    inspection.checks[3] = match crate::tls::inspect_stored(app_data, &config) {
        Ok(_) => check(
            "tls",
            "passed",
            "已从加密存储重读证书；证书链、有效期、客户端地址和私钥匹配校验通过。未检查吊销状态。",
            None,
        ),
        Err(_) => check(
            "tls",
            "failed",
            "证书无法加载或校验失败，请在首次配置中刷新证书列表查看原因。",
            Some("TLS_INVALID"),
        ),
    };
    Ok(inspection)
}

pub fn inspect(app_data: &Path) -> Result<Inspection> {
    let config = read(app_data)?
        .config
        .ok_or_else(|| failure("CONFIG_INVALID"))?;
    let mut checks = vec![
        check(
            "package",
            "not-checked",
            "尚未接入受信运行包目录与哈希校验。",
            Some("RUNTIME_MISSING"),
        ),
        check(
            "system",
            if platform() == "unsupported" {
                "failed"
            } else {
                "passed"
            },
            "已识别当前操作系统；运行包兼容性仍待检查。",
            if platform() == "unsupported" {
                Some("RUNTIME_PLATFORM_MISMATCH")
            } else {
                None
            },
        ),
    ];
    let address = std::net::SocketAddr::new(
        config
            .listen
            .host
            .parse()
            .map_err(|_| failure("CONFIG_INVALID"))?,
        config.listen.port as u16,
    );
    checks.push(match TcpListener::bind(address) {
        Ok(listener) => {
            drop(listener);
            check(
                "port",
                "passed",
                "监听地址与端口当前可绑定，检查后已释放；启动时需重新检查。",
                None,
            )
        }
        Err(e) => check(
            "port",
            "failed",
            "监听地址无法绑定，请检查本机地址、端口占用或系统权限。",
            Some(if e.kind() == std::io::ErrorKind::AddrInUse {
                "PORT_IN_USE"
            } else {
                "CONFIG_INVALID"
            }),
        ),
    });
    checks.push(check(
        "tls",
        "not-checked",
        "证书存储与有效性校验尚未接入。",
        Some("TLS_INVALID"),
    ));
    let data = Path::new(&config.data_directory);
    checks.push(match pin_directories(data, false) {
        Err(_) => check(
            "directory",
            "failed",
            "目录或已有父目录不可安全访问，请选择普通本机目录。",
            Some("CONFIG_STORAGE_UNSAFE"),
        ),
        Ok(None) => check(
            "directory",
            "not-checked",
            "目录尚未创建；已有父目录通过链接检查，权限和空间仍待检查。",
            None,
        ),
        Ok(Some(_pins)) => match fs::symlink_metadata(data) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => check(
                "directory",
                "not-checked",
                "目录尚未创建；已有父目录通过链接检查，权限和空间仍待检查。",
                None,
            ),
            Ok(meta) if meta.is_dir() => match fs::read_dir(data).map(|mut entries| entries.next())
            {
                Ok(None) => check(
                    "directory",
                    "not-checked",
                    "目录为空且通过链接检查；所有者、权限和空间仍待检查。",
                    None,
                ),
                Ok(Some(Ok(_))) => check(
                    "directory",
                    "failed",
                    "数据目录已有内容，需要兼容检查或显式迁移。",
                    Some("DATA_MIGRATION_REQUIRED"),
                ),
                _ => check(
                    "directory",
                    "failed",
                    "无法检查数据目录内容。",
                    Some("CONFIG_STORAGE_UNSAFE"),
                ),
            },
            _ => check(
                "directory",
                "failed",
                "数据目录不可用。",
                Some("CONFIG_STORAGE_UNSAFE"),
            ),
        },
    });
    checks.push(check(
        "isolation",
        "not-checked",
        "正式 Worker 隔离与生命周期管理尚未接通，服务启动保持禁用。",
        Some("WORKER_ISOLATION_UNSUPPORTED"),
    ));
    Ok(Inspection {
        platform: platform(),
        config_revision: config.revision,
        inspected_at: now(),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn value(directory: &Path, revision: u64) -> Value {
        serde_json::json!({
            "schemaVersion":1,"revision":revision,"dataDirectory":directory.to_string_lossy(),
            "listen":{"host":"127.0.0.1","port":45410},"clientUrl":"wss://central.example.internal:45410/ws",
            "tls":{"certificateId":"local-ca-1"},"runtimePackageId":"qualified-package",
            "limits":{"maxWorkers":8,"perUserTurns":2,"totalTurns":8},"shutdown":{"graceMs":10000,"forceMs":5000}
        })
    }
    #[test]
    fn saves_reloads_without_creating_data_directory_and_retries_across_reload() {
        let temp = fixture();
        let root = temp.path().join("app");
        let data = temp.path().join("data");
        assert!(!read(&root).unwrap().initialized);
        assert!(!root.exists());
        let input = value(&data, 0);
        let saved = save(&root, "save-1".into(), 0, input.clone()).unwrap();
        assert_eq!(saved.config.revision, 1);
        assert!(!data.exists());
        assert_eq!(read(&root).unwrap().config, Some(saved.config.clone()));
        assert_eq!(
            save(&root, "save-1".into(), 0, input).unwrap().config,
            saved.config
        );
        let saved2 = save(&root, "save-2".into(), 1, value(&data, 1)).unwrap();
        assert_eq!(saved2.config.revision, 2);
        assert_eq!(
            save(&root, "save-1".into(), 0, value(&data, 0))
                .unwrap()
                .config
                .revision,
            1
        );
        assert_eq!(read(&root).unwrap().config.unwrap().revision, 2);
    }
    #[test]
    fn rejects_stale_revision_and_reused_id_with_different_payload() {
        let temp = fixture();
        let root = temp.path().join("app");
        let input = value(&temp.path().join("data"), 0);
        save(&root, "same".into(), 0, input.clone()).unwrap();
        assert_eq!(
            save(&root, "stale".into(), 0, input.clone())
                .err()
                .unwrap()
                .code,
            "CONFIG_REVISION_CONFLICT"
        );
        let mut changed = input;
        changed["limits"]["maxWorkers"] = 9.into();
        assert_eq!(
            save(&root, "same".into(), 0, changed).err().unwrap().code,
            "CONFIG_REVISION_CONFLICT"
        );
        assert_eq!(read(&root).unwrap().config.unwrap().revision, 1);
    }
    #[test]
    fn corrupt_store_is_never_overwritten() {
        let temp = fixture();
        let root = temp.path().join("app");
        let input = value(&temp.path().join("data"), 0);
        save(&root, "first".into(), 0, input.clone()).unwrap();
        let path = root.join("config/central-config.json");
        fs::write(&path, b"CORRUPT").unwrap();
        assert_eq!(read(&root).err().unwrap().code, "CONFIG_STORAGE_UNSAFE");
        assert_eq!(
            save(&root, "second".into(), 0, input).err().unwrap().code,
            "CONFIG_STORAGE_UNSAFE"
        );
        assert_eq!(fs::read(path).unwrap(), b"CORRUPT");
    }
    #[test]
    fn lock_contention_has_bounded_busy_result() {
        let temp = fixture();
        let root = temp.path().join("app");
        let (_dir, _pins, _lock) = transaction(&root, true).unwrap().unwrap();
        assert_eq!(read(&root).err().unwrap().code, "OPERATION_BUSY");
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "config::tests::subprocess_lock_entry"])
            .env("CENTRAL_CONFIG_LOCK_TEST_ROOT", &root)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
    }
    #[test]
    fn subprocess_lock_entry() {
        if let Some(root) = std::env::var_os("CENTRAL_CONFIG_LOCK_TEST_ROOT") {
            assert_eq!(read(Path::new(&root)).err().unwrap().code, "OPERATION_BUSY");
        }
    }
    #[test]
    fn failed_atomic_replace_preserves_previous_config() {
        let temp = fixture();
        let root = temp.path().join("app");
        let input = value(&temp.path().join("data"), 0);
        save(&root, "first".into(), 0, input).unwrap();
        let before = fs::read(root.join("config/central-config.json")).unwrap();
        let (directory, pins, _lock) = transaction(&root, true).unwrap().unwrap();
        let _guard =
            open_checked(&directory.join("central-config.json"), false, false, false).unwrap();
        let mut temporary = new_temporary(&directory).unwrap();
        temporary.write_all(b"replacement that must fail").unwrap();
        temporary.as_file().sync_all().unwrap();
        // POSIX open handles do not prevent rename. Remove only this synthetic
        // temporary name to inject a failed commit while preserving the target.
        #[cfg(unix)]
        fs::remove_file(temporary.path()).unwrap();
        assert!(replace_temporary(temporary, &directory, &pins).is_err());
        assert_eq!(
            fs::read(directory.join("central-config.json")).unwrap(),
            before
        );
    }
    #[test]
    fn missing_chain_is_not_a_complete_pin() {
        let temp = fixture();
        assert!(
            pin_directories(&temp.path().join("missing/child"), false)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn linked_file_is_rejected() {
        let temp = fixture();
        let root = temp.path().join("app");
        save(
            &root,
            "first".into(),
            0,
            value(&temp.path().join("data"), 0),
        )
        .unwrap();
        fs::hard_link(
            root.join("config/central-config.json"),
            temp.path().join("alias"),
        )
        .unwrap();
        assert_eq!(read(&root).err().unwrap().code, "CONFIG_STORAGE_UNSAFE");
    }
    #[cfg(windows)]
    #[test]
    fn rejects_junction_ancestor_without_writing_target() {
        let temp = fixture();
        let target = temp.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = temp.path().join("junction");
        assert!(
            std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .unwrap()
                .status
                .success()
        );
        let result = save(
            &link,
            "first".into(),
            0,
            value(&temp.path().join("data"), 0),
        );
        assert_eq!(result.err().unwrap().code, "CONFIG_STORAGE_UNSAFE");
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        fs::remove_dir(link).unwrap();
    }
    #[test]
    fn native_validation_rejects_unknown_fields_and_path_url_aliases() {
        let base = value(Path::new(r"C:\Central\data"), 0);
        assert!(matches!(
            validate_for(base.clone(), true),
            Validation::Valid { .. }
        ));
        for path in [
            r"C:\",
            r"C:\data\..\private",
            r"C:\data\NUL.txt",
            r"C:\data\a:stream",
            r"\\server\share",
            r"C:\data\COM¹",
            r"C:\data\trailing.",
        ] {
            let mut v = base.clone();
            v["dataDirectory"] = path.into();
            assert!(
                matches!(validate_for(v, true), Validation::Invalid { .. }),
                "{path}"
            );
        }
        for url in [
            "ws://central:45410/ws",
            "wss://localhost:45410/ws",
            "wss://central:4510/ws",
            "wss://central:45410/ws?x=y",
            "wss://user:password@central:45410/ws",
            "wss://central:45410/ ws",
        ] {
            let mut v = base.clone();
            v["clientUrl"] = url.into();
            assert!(matches!(validate_for(v, true), Validation::Invalid { .. }));
        }
        let mut v = base.clone();
        v["secret"] = "NEVER_ALLOWED".into();
        assert!(matches!(validate_for(v, true), Validation::Invalid { .. }));
        let mut v = base;
        v["limits"]["extra"] = true.into();
        assert!(matches!(validate_for(v, true), Validation::Invalid { .. }));
    }
    #[test]
    fn inspection_reports_partial_evidence_and_releases_bound_port() {
        let temp = fixture();
        let root = temp.path().join("app");
        let data = temp.path().join("data");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut input = value(&data, 0);
        input["listen"]["port"] = port.into();
        input["clientUrl"] = format!("wss://central.example.internal:{port}/ws").into();
        save(&root, "first".into(), 0, input).unwrap();
        let occupied = inspect(&root).unwrap();
        assert_eq!(occupied.checks.len(), 6);
        assert_eq!(
            occupied
                .checks
                .iter()
                .find(|c| c.component == "port")
                .unwrap()
                .state,
            "failed"
        );
        drop(listener);
        let inspected = inspect(&root).unwrap();
        assert_eq!(inspected.config_revision, 1);
        assert_eq!(
            inspected
                .checks
                .iter()
                .find(|c| c.component == "port")
                .unwrap()
                .state,
            "passed"
        );
        assert_eq!(
            inspected
                .checks
                .iter()
                .find(|c| c.component == "directory")
                .unwrap()
                .state,
            "not-checked"
        );
        assert_eq!(
            inspected
                .checks
                .iter()
                .filter(|c| ["package", "tls", "isolation"].contains(&c.component)
                    && c.state == "not-checked")
                .count(),
            3
        );
        assert!(!data.exists());
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
        fs::create_dir(&data).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(data.join("existing"), b"preserve").unwrap();
        assert_eq!(
            inspect(&root)
                .unwrap()
                .checks
                .iter()
                .find(|c| c.component == "directory")
                .unwrap()
                .failure
                .as_ref()
                .unwrap()
                .code,
            "DATA_MIGRATION_REQUIRED"
        );
    }
}
