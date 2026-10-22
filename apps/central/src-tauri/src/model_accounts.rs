// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Native central accounts. Imported snapshots never acquire shared refresh tokens.
//! Input format follows pinned Codex login/src/auth/storage.rs and token_data.rs;
//! only the access_token/account_id pair used by the central broker is retained.
use crate::config::{Result, failure};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

const NAMESPACE: &str = "model-accounts-v1";
const MAX_SOURCE: usize = 1024 * 1024;
const MAX_ACCOUNTS: usize = 128;
#[path = "model_account_renewal.rs"]
pub mod renewal;
#[path = "model_shared_login.rs"]
pub mod shared;

/// Network configuration uses the same OS-owned profile as shared login.
pub(crate) fn codex_config_path() -> Result<std::path::PathBuf> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        Ok(profile::source()?.with_file_name("config.toml"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err(failure("MODEL_PROXY_SYSTEM_UNSUPPORTED"))
    }
}

#[cfg(all(test, windows))]
pub(crate) fn store_service_fixture(app_data: &Path) -> String {
    let bundle = Bundle {
        schema_version: 1,
        imported_at: now(),
        access_token: format!(
            "e30.{}.synthetic",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":4000000000}"#)
        ),
        account_id: "synthetic-service-account".into(),
        refresh_token: None,
    };
    let root = crate::config::resource_root(app_data, true).unwrap();
    let bytes = Zeroizing::new(serde_json::to_vec(&bundle).unwrap());
    platform_security::central_secret_store::create(&root, NAMESPACE, &bytes).unwrap()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredAccount {
    pub source: &'static str,
    pub provider: &'static str,
    pub account_hint: String,
    pub access_expires_at: Option<u64>,
    pub checked_at: u64,
    pub status: &'static str,
    pub remote_verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountReport {
    pub credential_source: &'static str,
    pub account_id: String,
    pub provider: &'static str,
    pub account_hint: String,
    pub imported_at: u64,
    pub checked_at: u64,
    pub access_expires_at: Option<u64>,
    pub status: &'static str,
    pub refresh_supported: bool,
    pub renewal_state: &'static str,
    pub renewal_error: Option<String>,
    pub next_retry_at: Option<u64>,
    pub remote_verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntry {
    pub account_id: String,
    pub report: Option<AccountReport>,
    pub failure: Option<crate::config::Failure>,
}

// Never derive Debug or expose this owned secret object as a command response.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    schema_version: u8,
    imported_at: u64,
    access_token: String,
    account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}
impl Drop for Bundle {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.account_id.zeroize();
        self.refresh_token.zeroize();
    }
}

/// Native service bootstrap only. This type intentionally cannot be serialized.
pub(crate) struct InternalCredential {
    bundle: Bundle,
}
impl InternalCredential {
    pub(crate) fn access_token(&self) -> &str {
        &self.bundle.access_token
    }
    pub(crate) fn account_id(&self) -> &str {
        &self.bundle.account_id
    }
    /// Central process memory only; caller must never persist/log/return this to IPC.
    pub(crate) fn as_broker_json(&self) -> Result<Zeroizing<Vec<u8>>> {
        #[derive(Serialize)]
        struct Tokens<'a> {
            access_token: &'a str,
            account_id: &'a str,
        }
        #[derive(Serialize)]
        struct Broker<'a> {
            tokens: Tokens<'a>,
        }
        serde_json::to_vec(&Broker {
            tokens: Tokens {
                access_token: self.access_token(),
                account_id: self.account_id(),
            },
        })
        .map(Zeroizing::new)
        .map_err(|_| failure("MODEL_ACCOUNT_ENCODING_FAILED"))
    }
}

#[derive(Deserialize)]
struct Source {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    api_key: Option<serde::de::IgnoredAny>,
    tokens: Option<SourceTokens>,
}
#[derive(Deserialize)]
struct SourceTokens {
    access_token: String,
    account_id: Option<String>,
}
impl Drop for SourceTokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(account) = &mut self.account_id {
            account.zeroize();
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn valid_account_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(|c| c.is_control())
}
fn expires_at(token: &str) -> Result<Option<u64>> {
    if token.is_empty()
        || token.len() > 32768
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(failure("MODEL_ACCOUNT_FORMAT_INVALID"));
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(failure("MODEL_ACCOUNT_FORMAT_INVALID"));
    }
    let payload = Zeroizing::new(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|_| failure("MODEL_ACCOUNT_FORMAT_INVALID"))?,
    );
    #[derive(Deserialize)]
    struct Claims {
        exp: Option<i64>,
    }
    let claims: Claims =
        serde_json::from_slice(&payload).map_err(|_| failure("MODEL_ACCOUNT_FORMAT_INVALID"))?;
    match claims.exp {
        None => Ok(None),
        Some(value) => u64::try_from(value)
            .ok()
            .and_then(|value| value.checked_mul(1000))
            .filter(|value| *value <= 9_007_199_254_740_991)
            .map(Some)
            .ok_or_else(|| failure("MODEL_ACCOUNT_FORMAT_INVALID")),
    }
}
fn validate(bundle: &Bundle) -> Result<Option<u64>> {
    if bundle.schema_version != 1
        || bundle.imported_at > 9_007_199_254_740_991
        || !valid_account_id(&bundle.account_id)
    {
        return Err(failure("MODEL_ACCOUNT_FORMAT_INVALID"));
    }
    expires_at(&bundle.access_token)
}
fn parse_source(bytes: &[u8], imported_at: u64) -> Result<Bundle> {
    if bytes.is_empty() || bytes.len() > MAX_SOURCE {
        return Err(failure("MODEL_ACCOUNT_SOURCE_TOO_LARGE"));
    }
    let source: Source =
        serde_json::from_slice(bytes).map_err(|_| failure("MODEL_ACCOUNT_FORMAT_INVALID"))?;
    if source.api_key.is_some() || !matches!(source.auth_mode.as_deref(), None | Some("chatgpt")) {
        return Err(failure("MODEL_ACCOUNT_AUTH_MODE_UNSUPPORTED"));
    }
    let mut tokens = source
        .tokens
        .ok_or_else(|| failure("MODEL_ACCOUNT_FORMAT_INVALID"))?;
    let bundle = Bundle {
        schema_version: 1,
        imported_at,
        access_token: std::mem::take(&mut tokens.access_token),
        account_id: tokens
            .account_id
            .take()
            .ok_or_else(|| failure("MODEL_ACCOUNT_FORMAT_INVALID"))?,
        refresh_token: None,
    };
    validate(&bundle)?;
    Ok(bundle)
}
fn hint(bundle: &Bundle) -> String {
    let digest = Sha256::digest(bundle.account_id.as_bytes());
    format!(
        "account-{}",
        digest[..6]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
fn report(bundle: &Bundle, id: &str, checked_at: u64) -> Result<AccountReport> {
    let expires = validate(bundle)?;
    Ok(AccountReport {
        credential_source: if bundle.refresh_token.is_some() {
            "dedicated"
        } else {
            "snapshot"
        },
        account_id: id.to_owned(),
        provider: "chatgpt",
        account_hint: hint(bundle),
        imported_at: bundle.imported_at,
        checked_at,
        access_expires_at: expires,
        status: if expires.is_some_and(|expires| expires <= checked_at) {
            "expired"
        } else if expires.is_none() {
            "expiry-unknown"
        } else {
            "imported"
        },
        refresh_supported: bundle.refresh_token.is_some(),
        renewal_state: if bundle.refresh_token.is_some() {
            "ready"
        } else {
            "snapshot"
        },
        renewal_error: None,
        next_retry_at: None,
        remote_verified: false,
    })
}

#[cfg(windows)]
fn read_source(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    if let Err(error) = std::fs::symlink_metadata(path) {
        return Err(failure(if error.kind() == std::io::ErrorKind::NotFound {
            "MODEL_ACCOUNT_SOURCE_MISSING"
        } else {
            "MODEL_ACCOUNT_SOURCE_UNAVAILABLE"
        }));
    }
    use source_integrity::PrivateFileError;
    // No canonicalize(auth.json): it would erase evidence of a reparse ancestor.
    // The reader pins every physical ancestor and the same file handle, validates
    // source integrity ACLs and bounds the zeroizing read. MSIX aliases fail closed.
    source_integrity::read(path, MAX_SOURCE).map_err(|error| {
        failure(match error {
            PrivateFileError::Unavailable => "MODEL_ACCOUNT_SOURCE_UNAVAILABLE",
            PrivateFileError::TooLarge => "MODEL_ACCOUNT_SOURCE_TOO_LARGE",
            _ => "MODEL_ACCOUNT_SOURCE_UNSAFE",
        })
    })
}

#[cfg(windows)]
mod profile {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStringExt, path::PathBuf};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    }
    #[link(name = "userenv")]
    unsafe extern "system" {
        fn GetUserProfileDirectoryW(token: *mut c_void, buffer: *mut u16, size: *mut u32) -> i32;
    }
    pub(super) fn source() -> Result<PathBuf> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
            return Err(failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"));
        }
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = unsafe { GetUserProfileDirectoryW(token, buffer.as_mut_ptr(), &mut size) };
        unsafe {
            CloseHandle(token);
        }
        if ok == 0 || size as usize > buffer.len() {
            return Err(failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"));
        }
        let end = buffer
            .iter()
            .position(|c| *c == 0)
            .ok_or_else(|| failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"))?;
        let root = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..end]));
        if !root.is_absolute() {
            return Err(failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"));
        }
        // Fixed OS profile source. Renderer paths, CODEX_HOME and USERPROFILE
        // overrides never participate, and there is no search/fallback directory.
        Ok(root.join(".codex").join("auth.json"))
    }
}

#[cfg(target_os = "macos")]
fn read_source(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    use platform_security::central_secret_store::{SecretStoreError, macos};
    macos::read_private(path, MAX_SOURCE).map_err(|e| {
        failure(match e {
            SecretStoreError::NotFound => "MODEL_ACCOUNT_SOURCE_MISSING",
            SecretStoreError::TooLarge => "MODEL_ACCOUNT_SOURCE_TOO_LARGE",
            _ => "MODEL_ACCOUNT_SOURCE_UNSAFE",
        })
    })
}

#[cfg(target_os = "macos")]
mod profile {
    use super::*;
    use std::{ffi::CStr, os::unix::ffi::OsStrExt, path::PathBuf};
    pub(super) fn source() -> Result<PathBuf> {
        let mut info: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; 65536];
        if unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut info,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        } != 0
            || result.is_null()
            || info.pw_dir.is_null()
        {
            return Err(failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"));
        }
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(
            unsafe { CStr::from_ptr(info.pw_dir) }.to_bytes(),
        ));
        if !home.is_absolute() {
            return Err(failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"));
        }
        Ok(home.join(".codex/auth.json"))
    }
}

pub fn discover_existing() -> Result<DiscoveredAccount> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let checked_at = now();
        let bundle = parse_source(&read_source(&profile::source()?)?, checked_at)?;
        let expires = validate(&bundle)?;
        Ok(DiscoveredAccount {
            source: "local-codex",
            provider: "chatgpt",
            account_hint: hint(&bundle),
            access_expires_at: expires,
            checked_at,
            status: if expires.is_some_and(|expiry| expiry <= checked_at) {
                "expired"
            } else {
                "available"
            },
            remote_verified: false,
        })
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err(failure("MODEL_ACCOUNT_PLATFORM_UNSUPPORTED"))
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn import_source(app_data: &Path, source: &Path) -> Result<AccountReport> {
    let checked_at = now();
    let bundle = parse_source(&read_source(source)?, checked_at)?;
    if validate(&bundle)?.is_some_and(|expires| expires <= checked_at) {
        return Err(failure("MODEL_ACCOUNT_EXPIRED"));
    }
    let resource_root = crate::config::resource_root(app_data, true)?;
    let ids = platform_security::central_secret_store::list(&resource_root, NAMESPACE)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
    if ids.len() >= MAX_ACCOUNTS {
        return Err(failure("MODEL_ACCOUNT_CAPACITY"));
    }
    let payload = Zeroizing::new(
        serde_json::to_vec(&bundle).map_err(|_| failure("MODEL_ACCOUNT_ENCODING_FAILED"))?,
    );
    let id = platform_security::central_secret_store::create(&resource_root, NAMESPACE, &payload)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
    report(&bundle, &id, checked_at)
}

/// The only production import entry point takes native AppData, never a source path.
pub fn import_existing(app_data: &Path) -> Result<AccountReport> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        import_source(app_data, &profile::source()?)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app_data;
        Err(failure("MODEL_ACCOUNT_PLATFORM_UNSUPPORTED"))
    }
}

fn load_base(app_data: &Path, id: &str) -> Result<Bundle> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let root = crate::config::resource_root(app_data, false)?;
        let bytes = platform_security::central_secret_store::load(&root, NAMESPACE, id)
            .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
        if shared::has_reference_schema(&bytes) {
            return shared::resolve_reference(&bytes);
        }
        let bundle: Bundle =
            serde_json::from_slice(&bytes).map_err(|_| failure("MODEL_ACCOUNT_STORAGE_INVALID"))?;
        validate(&bundle)?;
        Ok(bundle)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app_data, id);
        Err(failure("MODEL_ACCOUNT_PLATFORM_UNSUPPORTED"))
    }
}
pub fn selected(app_data: &Path, id: &str) -> Result<AccountReport> {
    renewal::account_report(app_data, id)
}
pub fn list(app_data: &Path) -> Result<Vec<AccountEntry>> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let root = crate::config::resource_root(app_data, false)?;
        let ids = platform_security::central_secret_store::list(&root, NAMESPACE)
            .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
        if ids.len() > MAX_ACCOUNTS {
            return Err(failure("MODEL_ACCOUNT_CAPACITY"));
        }
        Ok(ids
            .into_iter()
            .map(|id| match selected(app_data, &id) {
                Ok(report) => AccountEntry {
                    account_id: id,
                    report: Some(report),
                    failure: None,
                },
                Err(error) => AccountEntry {
                    account_id: id,
                    report: None,
                    failure: Some(error),
                },
            })
            .collect())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app_data;
        Err(failure("MODEL_ACCOUNT_PLATFORM_UNSUPPORTED"))
    }
}
pub(crate) fn load_internal(app_data: &Path, id: &str) -> Result<InternalCredential> {
    let bundle = renewal::current_bundle(app_data, id)?;
    if validate(&bundle)?.is_some_and(|expires| expires <= now()) {
        return Err(failure("MODEL_ACCOUNT_EXPIRED"));
    }
    Ok(InternalCredential { bundle })
}

// Fixed-source integrity reader adapted from the reviewed private-store reader.
// It preserves source read grants; the destination store remains strictly private.
#[cfg(windows)]
mod source_integrity {
    use std::{
        ffi::c_void,
        fmt,
        fs::File,
        io::Read,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
        path::Path,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{INVALID_HANDLE_VALUE, LocalFree},
        Security::{Authorization::*, *},
        Storage::FileSystem::*,
    };
    use zeroize::Zeroizing;

    pub const MAX_PRIVATE_FILE_BYTES: usize = 16 * 1024 * 1024;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum PrivateFileError {
        UnsafePath,
        Unavailable,
        UnsafeFile,
        UnsafeAcl,
        TooLarge,
        Changed,
    }
    impl fmt::Display for PrivateFileError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(match self {
                Self::UnsafePath => "CENTRAL_PRIVATE_PATH_UNSAFE",
                Self::Unavailable => "CENTRAL_PRIVATE_FILE_UNAVAILABLE",
                Self::UnsafeFile => "CENTRAL_PRIVATE_FILE_UNSAFE",
                Self::UnsafeAcl => "CENTRAL_PRIVATE_ACL_UNSAFE",
                Self::TooLarge => "CENTRAL_PRIVATE_FILE_TOO_LARGE",
                Self::Changed => "CENTRAL_PRIVATE_FILE_CHANGED",
            })
        }
    }
    impl std::error::Error for PrivateFileError {}
    type Result<T> = std::result::Result<T, PrivateFileError>;
    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
    }

    // Parse raw UTF-16 rather than Path::components, which normalizes away `.`.
    fn components(path: &Path) -> Result<(Vec<u16>, Vec<Vec<u16>>)> {
        let mut raw: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .map(|c| if c == 47 { 92 } else { c })
            .collect();
        if raw.starts_with(&[92, 92, 63, 92]) {
            raw.drain(..4);
        }
        if raw.len() < 4
            || raw.len() > 32000
            || !((65..=90).contains(&raw[0]) || (97..=122).contains(&raw[0]))
            || raw[1..3] != [58, 92]
        {
            return Err(PrivateFileError::UnsafePath);
        }
        let parts: Vec<Vec<u16>> = raw[3..].split(|c| *c == 92).map(<[u16]>::to_vec).collect();
        if parts.len() > 128 {
            return Err(PrivateFileError::UnsafePath);
        }
        for part in &parts {
            if part.is_empty()
                || part == &[46]
                || part == &[46, 46]
                || matches!(part.last(), Some(32 | 46))
                || part
                    .iter()
                    .any(|c| *c < 32 || [34, 42, 58, 60, 62, 63, 124].contains(c))
            {
                return Err(PrivateFileError::UnsafePath);
            }
            let base: String = String::from_utf16_lossy(part)
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase();
            if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&base.as_str())
                || (base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9'))
            {
                return Err(PrivateFileError::UnsafePath);
            }
        }
        Ok((raw[..3].to_vec(), parts))
    }
    fn wide(path: &[u16]) -> Vec<u16> {
        path.iter().copied().chain(Some(0)).collect()
    }
    fn open(path: &[u16], directory: bool, check_acl: bool) -> Result<File> {
        // Omitting WRITE/DELETE sharing refuses pre-existing mutation handles and
        // prevents opening new ones while the complete ancestor chain is held.
        // FILE_LIST_DIRECTORY counts as data access for sharing checks; metadata-only
        // handles do not exclude later directory mutation handles on Windows.
        let handle = unsafe {
            CreateFileW(
                wide(path).as_ptr(),
                if directory {
                    FILE_LIST_DIRECTORY
                        | FILE_READ_ATTRIBUTES
                        | if check_acl { READ_CONTROL } else { 0 }
                } else {
                    0x80000000
                },
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(PrivateFileError::Unavailable);
        }
        // SAFETY: the non-inheritable CreateFile handle has a single owner.
        let file = unsafe { File::from_raw_handle(handle) };
        information(&file, directory)?;
        Ok(file)
    }
    fn information(file: &File, directory: bool) -> Result<BY_HANDLE_FILE_INFORMATION> {
        let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
        if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
            || unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
        {
            return Err(PrivateFileError::Unavailable);
        }
        if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
            || (!directory && info.nNumberOfLinks != 1)
        {
            return Err(PrivateFileError::UnsafeFile);
        }
        Ok(info)
    }
    fn final_path(file: &File) -> Result<Vec<u16>> {
        let mut buffer = vec![0u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                VOLUME_NAME_GUID,
            )
        } as usize;
        if length == 0 || length >= buffer.len() {
            return Err(PrivateFileError::Unavailable);
        }
        buffer.truncate(length);
        Ok(buffer)
    }
    fn path_equal(a: &[u16], b: &[u16]) -> bool {
        let fold = |v: &u16| if (65..=90).contains(v) { *v + 32 } else { *v };
        a.iter().map(fold).eq(b.iter().map(fold))
    }
    fn is_volume_root(path: &[u16]) -> bool {
        // Reject SUBST mappings to a subdirectory: its hidden upper ancestors would
        // otherwise not be in our pinned chain. Native GUID syntax is 49 UTF-16 units.
        path.len() == 49
            && path.starts_with(&"\\\\?\\Volume{".encode_utf16().collect::<Vec<_>>())
            && path[47..] == [125, 92]
    }
    fn bounded_ace_sid(ace: &[u8]) -> Result<&[u8]> {
        // Ordinary allow ACE prefix is 8 bytes; SID header is a further 8 bytes.
        // Validate count and extent before asking any native API to dereference SID.
        if ace.len() < 16 || ace[9] > 15 {
            return Err(PrivateFileError::UnsafeAcl);
        }
        let end = 16 + usize::from(ace[9]) * 4;
        ace.get(8..end).ok_or(PrivateFileError::UnsafeAcl)
    }
    fn private_acl(file: &File, user: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let mut owner = null_mut();
            let mut acl = null_mut();
            let mut sd = null_mut();
            if GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut sd,
            ) != 0
            {
                return Err(PrivateFileError::Unavailable);
            }
            let _sd = Local(sd);
            let mut control = 0;
            let mut revision = 0;
            if owner.is_null()
                || IsValidSid(owner) == 0
                || acl.is_null()
                || IsValidAcl(acl) == 0
                || (EqualSid(owner, user.as_ptr() as _) == 0
                    && IsWellKnownSid(owner, WinLocalSystemSid) == 0)
                || GetSecurityDescriptorControl(sd, &mut control, &mut revision) == 0
            {
                return Err(PrivateFileError::UnsafeAcl);
            }
            let mut size = std::mem::zeroed::<ACL_SIZE_INFORMATION>();
            if GetAclInformation(
                acl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) == 0
                || size.AceCount == 0
            {
                return Err(PrivateFileError::UnsafeAcl);
            }
            for index in 0..size.AceCount {
                let mut raw = null_mut();
                if GetAce(acl, index, &mut raw) == 0 || raw.is_null() {
                    return Err(PrivateFileError::UnsafeAcl);
                }
                let header = &*raw.cast::<ACE_HEADER>();
                if header.AceType != 0
                    || header.AceSize < 16
                    || u32::from(header.AceFlags)
                        & !(OBJECT_INHERIT_ACE
                            | CONTAINER_INHERIT_ACE
                            | NO_PROPAGATE_INHERIT_ACE
                            | INHERIT_ONLY_ACE
                            | INHERITED_ACE)
                        != 0
                {
                    return Err(PrivateFileError::UnsafeAcl);
                }
                // IsValidAcl/GetAce establish the ACE extent in this system-owned SD.
                let ace = std::slice::from_raw_parts(raw.cast::<u8>(), header.AceSize as usize);
                let sid = bounded_ace_sid(ace)?.as_ptr() as *mut c_void;
                if IsValidSid(sid) == 0 {
                    return Err(PrivateFileError::UnsafeAcl);
                }
                let trusted = EqualSid(sid, user.as_ptr() as _) != 0
                    || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                    || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0;
                let mask = u32::from_le_bytes(
                    ace[4..8]
                        .try_into()
                        .map_err(|_| PrivateFileError::UnsafeAcl)?,
                );
                // Existing read grants are preserved, never broadened. Unknown
                // principals may only read/execute/synchronize, including inherited
                // grants. All data/attribute/EA writes, DELETE/DELETE_CHILD,
                // WRITE_DAC/WRITE_OWNER and unknown rights remain denied.
                const READ_ONLY: u32 = 0x1200a9 | 0x80000000 | 0x20000000;
                if !trusted && mask & !READ_ONLY != 0 {
                    return Err(PrivateFileError::UnsafeAcl);
                }
            }
            let length = GetSecurityDescriptorLength(sd) as usize;
            if length == 0 || length > 1024 * 1024 {
                return Err(PrivateFileError::UnsafeAcl);
            }
            Ok(std::slice::from_raw_parts(sd.cast::<u8>(), length).to_vec())
        }
    }
    fn identity(info: &BY_HANDLE_FILE_INFORMATION) -> (u32, u32, u32, u32, u32, u32, u32) {
        (
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.nFileSizeHigh,
            info.nFileSizeLow,
            info.ftLastWriteTime.dwHighDateTime,
            info.ftLastWriteTime.dwLowDateTime,
        )
    }

    /// Read from the same validated handle, retaining pinned ancestor handles until
    /// the final ACL/identity check. Returns zeroizing bytes; never includes paths,
    /// security descriptors, OS diagnostics or file contents in an error.
    pub(super) fn read(path: &Path, max_bytes: usize) -> Result<Zeroizing<Vec<u8>>> {
        read_inner(path, max_bytes, || {})
    }
    fn read_inner(
        path: &Path,
        max_bytes: usize,
        before_read: impl FnOnce(),
    ) -> Result<Zeroizing<Vec<u8>>> {
        if max_bytes == 0 || max_bytes > MAX_PRIVATE_FILE_BYTES {
            return Err(PrivateFileError::TooLarge);
        }
        let (root, parts) = components(path)?;
        let user = user_sid().map_err(|_| PrivateFileError::Unavailable)?;
        const DRIVE_FIXED: u32 = 3;
        if unsafe { GetDriveTypeW(wide(&root).as_ptr()) } != DRIVE_FIXED {
            return Err(PrivateFileError::UnsafePath);
        }
        let root_file = open(&root, true, parts.len() == 1)?;
        let mut current_path = final_path(&root_file)?;
        // Bind each opened handle to the original volume GUID before inspecting or
        // reading its data; a remapped drive cannot substitute a different object.
        // Use the caller's drive syntax for opens (Windows policy may deny volume
        // device aliases), then compare the handle's GUID path to this pinned path.
        if !is_volume_root(&current_path) {
            return Err(PrivateFileError::UnsafePath);
        }
        let mut open_path = "\\\\?\\"
            .encode_utf16()
            .chain(root.iter().copied())
            .collect::<Vec<_>>();
        let mut ancestors = vec![(root_file, current_path.clone())];
        for (index, part) in parts[..parts.len() - 1].iter().enumerate() {
            if current_path.last() != Some(&92) {
                current_path.push(92);
            }
            current_path.extend(part);
            if open_path.last() != Some(&92) {
                open_path.push(92);
            }
            open_path.extend(part);
            let file = open(&open_path, true, index + 2 == parts.len())?;
            if !path_equal(&final_path(&file)?, &current_path) {
                return Err(PrivateFileError::Changed);
            }
            ancestors.push((file, current_path.clone()));
        }
        let parent_acl = private_acl(
            &ancestors.last().ok_or(PrivateFileError::UnsafePath)?.0,
            &user,
        )?;
        if current_path.last() != Some(&92) {
            current_path.push(92);
        }
        current_path.extend(parts.last().ok_or(PrivateFileError::UnsafePath)?);
        if open_path.last() != Some(&92) {
            open_path.push(92);
        }
        open_path.extend(parts.last().ok_or(PrivateFileError::UnsafePath)?);
        let mut file = open(&open_path, false, true)?;
        if !path_equal(&final_path(&file)?, &current_path) {
            return Err(PrivateFileError::Changed);
        }
        let file_acl = private_acl(&file, &user)?;
        let before = information(&file, false)?;
        let length = ((before.nFileSizeHigh as u64) << 32) | before.nFileSizeLow as u64;
        if length > max_bytes as u64 {
            return Err(PrivateFileError::TooLarge);
        }
        before_read();
        // Never grow a secret-bearing Vec: reallocations would leave the former
        // allocation outside Zeroizing's reach. Check EOF in a separate wiped byte.
        let mut bytes = Zeroizing::new(vec![0; length as usize]);
        file.read_exact(&mut bytes)
            .map_err(|_| PrivateFileError::Changed)?;
        let mut extra = Zeroizing::new([0u8; 1]);
        if file
            .read(extra.as_mut())
            .map_err(|_| PrivateFileError::Unavailable)?
            != 0
        {
            return Err(PrivateFileError::Changed);
        }
        if private_acl(&file, &user)? != file_acl {
            return Err(PrivateFileError::Changed);
        }
        if identity(&before) != identity(&information(&file, false)?)
            || bytes.len() as u64 != length
            || !path_equal(&final_path(&file)?, &current_path)
        {
            return Err(PrivateFileError::Changed);
        }
        for (directory, expected) in &ancestors {
            information(directory, true)?;
            if !path_equal(&final_path(directory)?, expected) {
                return Err(PrivateFileError::Changed);
            }
        }
        if private_acl(
            &ancestors.last().ok_or(PrivateFileError::UnsafePath)?.0,
            &user,
        )? != parent_acl
        {
            return Err(PrivateFileError::Changed);
        }
        Ok(bytes)
    }

    fn user_sid() -> Result<Vec<u8>> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(PrivateFileError::Unavailable);
            }
            let mut length = 0;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length);
            if length == 0 || length > 1024 * 1024 {
                CloseHandle(token);
                return Err(PrivateFileError::Unavailable);
            }
            let mut buffer =
                vec![0usize; (length as usize + size_of::<usize>() - 1) / size_of::<usize>()];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(PrivateFileError::Unavailable);
            }
            let sid = (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid;
            if IsValidSid(sid) == 0 {
                return Err(PrivateFileError::UnsafeAcl);
            }
            Ok(std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize).to_vec())
        }
    }

    // Only synthetic tests call this; source import never changes any DACL.
    #[cfg(test)]
    pub(super) fn set_fixture_acl(path: &Path, extra: &str) {
        fixture_acl(path, extra, false);
    }
    #[cfg(test)]
    pub(super) fn protect_fixture_root(path: &Path) {
        fixture_acl(path, "", true);
    }
    #[cfg(test)]
    fn fixture_acl(path: &Path, extra: &str, protected: bool) {
        unsafe {
            let sid = user_sid().unwrap();
            let mut text = null_mut();
            assert_ne!(ConvertSidToStringSidW(sid.as_ptr() as _, &mut text), 0);
            let _text = Local(text.cast());
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let sid = String::from_utf16(std::slice::from_raw_parts(text, len)).unwrap();
            let sddl: Vec<u16> = format!("D:(A;OICI;FA;;;{sid}){extra}")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut sd = null_mut();
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut sd,
                    null_mut()
                ),
                0
            );
            let _sd = Local(sd);
            let mut acl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            assert_ne!(
                GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted),
                0
            );
            let mut path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            assert_eq!(
                SetNamedSecurityInfoW(
                    path.as_mut_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION
                        | if protected {
                            PROTECTED_DACL_SECURITY_INFORMATION
                        } else {
                            UNPROTECTED_DACL_SECURITY_INFORMATION
                        },
                    null_mut(),
                    null_mut(),
                    acl,
                    null_mut()
                ),
                0
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    #[ignore = "explicitly authorized current-user login metadata discovery; never prints credential contents"]
    fn discover_current_user_login_metadata_qa() {
        let report = discover_existing().unwrap();
        println!("{}", serde_json::to_string(&report).unwrap());
    }
    fn jwt(exp: Option<u64>) -> String {
        let payload = exp
            .map(|exp| serde_json::json!({"exp":exp}))
            .unwrap_or_else(|| serde_json::json!({}));
        format!(
            "e30.{}.synthetic",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&payload).unwrap())
        )
    }
    fn source(exp: Option<u64>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,
            "tokens":{"access_token":jwt(exp),"account_id":"synthetic-private-account",
            "refresh_token":"SYNTHETIC_REFRESH_NEVER_IMPORT","id_token":"SYNTHETIC_ID_NEVER_IMPORT"},
            "email":"private.synthetic@example.invalid"})).unwrap()
    }
    #[test]
    fn retains_only_broker_pair_and_public_report_never_contains_source_secrets() {
        let bundle = parse_source(&source(Some(4_000_000_000)), 17).unwrap();
        let public = serde_json::to_string(&report(&bundle, "opaque-id", 18).unwrap()).unwrap();
        for secret in [
            "synthetic-private-account",
            "SYNTHETIC_REFRESH",
            "SYNTHETIC_ID",
            "example.invalid",
            &bundle.access_token,
        ] {
            assert!(!public.contains(secret));
        }
        let stored = serde_json::to_value(&bundle).unwrap();
        assert_eq!(stored.as_object().unwrap().len(), 4);
        let credential = InternalCredential { bundle };
        let json = credential.as_broker_json().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert_eq!(value["tokens"].as_object().unwrap().len(), 2);
        assert_eq!(value["tokens"]["account_id"], "synthetic-private-account");
    }
    #[test]
    fn reports_expiry_as_unverified_and_unknown_without_claiming_remote_access() {
        let bundle = parse_source(&source(Some(100)), 1).unwrap();
        let public = report(&bundle, "id", 100_000).unwrap();
        assert_eq!(public.status, "expired");
        assert!(!public.remote_verified);
        assert!(!public.refresh_supported);
        let unknown = parse_source(&source(None), 1).unwrap();
        assert_eq!(report(&unknown, "id", 1).unwrap().status, "expiry-unknown");
    }
    #[test]
    fn rejects_unsupported_modes_malformed_tokens_and_ambiguous_fields() {
        for value in [
            serde_json::json!({"auth_mode":"apikey","OPENAI_API_KEY":"SYNTHETIC"}),
            serde_json::json!({"tokens":{"access_token":"bad","account_id":"a"}}),
            serde_json::json!({"tokens":{"access_token":jwt(Some(10)),"account_id":"\n"}}),
            serde_json::json!({"tokens":{"access_token":jwt(Some(10)),"account_id":null}}),
        ] {
            assert!(parse_source(&serde_json::to_vec(&value).unwrap(), 1).is_err());
        }
        assert!(parse_source(&vec![b' '; MAX_SOURCE + 1], 1).is_err());
        assert!(expires_at("e30.e30.signature.extra").is_err());
    }
    #[cfg(windows)]
    fn private_source(root: &Path) -> std::path::PathBuf {
        // Reuse the private store's native DACL creator only for a fresh synthetic
        // fixture. This record is intentionally test data, never a real credential.
        let id = platform_security::central_secret_store::create(
            root,
            "model-source-test",
            b"synthetic-seed",
        )
        .unwrap();
        let path = root
            .join("central-secrets/model-source-test")
            .join(format!("{id}.dpapi"));
        std::fs::write(&path, source(Some(4_000_000_000))).unwrap();
        path
    }
    #[cfg(windows)]
    #[test]
    fn native_import_dpapi_roundtrip_and_corrupt_entry_does_not_hide_healthy_account() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let source = private_source(&root);
        let app_data = root.join("application");
        let entry = import_source(&app_data, &source).unwrap();
        assert_eq!(entry.account_id.len(), 32);
        let credential = load_internal(&app_data, &entry.account_id).unwrap();
        assert_eq!(credential.account_id(), "synthetic-private-account");
        let storage = crate::config::resource_root(&app_data, false).unwrap();
        let bytes = std::fs::read(
            storage
                .join("central-secrets")
                .join(NAMESPACE)
                .join(format!("{}.dpapi", entry.account_id)),
        )
        .unwrap();
        assert!(
            !bytes
                .windows(credential.access_token().len())
                .any(|window| window == credential.access_token().as_bytes())
        );
        let bad = platform_security::central_secret_store::create(
            &storage,
            NAMESPACE,
            b"corrupt synthetic json",
        )
        .unwrap();
        let entries = list(&app_data).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(
            entries
                .iter()
                .any(|entry| entry.account_id == bad && entry.failure.is_some())
        );
        assert!(entries.iter().any(|entry| entry.report.is_some()));
    }
    #[cfg(windows)]
    #[test]
    fn native_source_allows_inherited_readers_but_rejects_untrusted_writes() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        // TEMP may intentionally grant sandbox groups writes. Isolate this new
        // synthetic parent before testing inherited read-only source permissions.
        source_integrity::protect_fixture_root(&root);
        let source_directory = root.join(".codex");
        std::fs::create_dir(&source_directory).unwrap();
        source_integrity::set_fixture_acl(&source_directory, "(A;OICI;0x1200a9;;;WD)");
        let file = source_directory.join("auth.json");
        std::fs::write(&file, source(Some(4_000_000_000))).unwrap();
        assert!(
            read_source(&file).is_ok(),
            "existing inherited read access is not broadened by import"
        );
        let report = import_source(&root.join("application"), &file).unwrap();
        assert_eq!(report.status, "imported");
        source_integrity::set_fixture_acl(&source_directory, "(A;OICI;FW;;;WD)");
        assert_eq!(
            read_source(&file).err().unwrap().code,
            "MODEL_ACCOUNT_SOURCE_UNSAFE"
        );
    }
    #[cfg(windows)]
    #[test]
    fn native_source_rejects_hardlinks_expired_tokens_and_junctions() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let source_path = private_source(&root);
        std::fs::write(&source_path, source(Some(1))).unwrap();
        assert_eq!(
            import_source(&root.join("application"), &source_path)
                .err()
                .unwrap()
                .code,
            "MODEL_ACCOUNT_EXPIRED"
        );
        assert!(!root.join("application").exists());
        std::fs::hard_link(&source_path, root.join("hardlink.json")).unwrap();
        assert_eq!(
            read_source(&source_path).err().unwrap().code,
            "MODEL_ACCOUNT_SOURCE_UNSAFE"
        );
        std::fs::remove_file(root.join("hardlink.json")).unwrap();
        assert!(read_source(&source_path).is_ok());
        let alias = root.join("source-alias");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&alias)
            .arg(source_path.parent().unwrap())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            read_source(&alias.join(source_path.file_name().unwrap()))
                .err()
                .unwrap()
                .code,
            "MODEL_ACCOUNT_SOURCE_UNSAFE"
        );
        std::fs::remove_dir(alias).unwrap();
    }
}
