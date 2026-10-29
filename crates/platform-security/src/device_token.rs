// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Default device authentication. No keyring, client key, certificate or refresh token.
// Windows files contain current-user DPAPI ciphertext; Unix files rely on 0700/0600.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

pub const AUTH_MODE: &str = "device-token-v1";
pub const REQUIRED: &str = "DEVICE_TOKEN_REQUIRED";
const UNSAFE: &str = "DEVICE_TOKEN_STORAGE_UNSAFE";
const CORRUPT: &str = "DEVICE_TOKEN_STORAGE_CORRUPT";
const UNAVAILABLE: &str = "DEVICE_TOKEN_STORAGE_UNAVAILABLE";
const LIMIT: u64 = 96 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credential {
    version: u8,
    namespace: String,
    origin: String,
    device_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ca_pem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<crate::relay::Target>,
    pub device_id: String,
    pub device_key: String,
    pub user: User,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct User {
    pub id: String,
    pub username: String,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.device_token.zeroize();
    }
}
impl Credential {
    pub async fn http(&self, gateway: &str, ca: &str) -> Result<crate::relay::HttpClient, String> {
        let config = match self.ca_pem.as_deref() {
            Some(pem) => crate::transport::config(Some(pem.as_bytes()))?,
            None => crate::central_tls_config(ca)?,
        };
        crate::relay::HttpClient::new(
            gateway,
            self.relay.as_ref(),
            crate::transport::http_builder(config),
        )
        .await
    }
    pub async fn post(
        &self,
        gateway: &str,
        ca: &str,
        route: &str,
        body: Value,
    ) -> Result<Value, String> {
        let client = self.http(gateway, ca).await?;
        crate::post_client(
            client.client.clone(),
            gateway,
            route,
            body,
            Some(self.bearer()),
        )
        .await
    }
    pub async fn socket(&self, gateway: &str, ca: &str) -> Result<crate::Socket, String> {
        crate::socket_routed(gateway, ca, self.bearer(), None, self.relay.as_ref()).await
    }
    pub fn bearer(&self) -> &str {
        &self.device_token
    }
    pub fn public(&self) -> Value {
        json!({"authMode":AUTH_MODE,"paired":true,"loggedIn":true,"user":{"id":self.user.id,"username":self.user.username},"deviceId":self.device_id,"deviceKey":self.device_key,"connectionMode":if self.relay.is_some(){"relay"}else{"lan"}})
    }
}
pub fn is_terminal(error: &str) -> bool {
    matches!(
        error,
        "DEVICE_REVOKED"
            | "AUTH_REQUIRED"
            | "AUTH_MODE_UNSUPPORTED"
            | REQUIRED
            | UNSAFE
            | CORRUPT
            | UNAVAILABLE
    )
}
fn identity(namespace: &str, gateway: &str) -> Result<(String, String), String> {
    if namespace.is_empty()
        || namespace.len() > 128
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err(UNSAFE.into());
    }
    let origin = crate::origin(gateway)?;
    let key = format!("{:x}", Sha256::digest(format!("{namespace}\n{origin}")));
    Ok((origin, key))
}
pub fn directory_from_env() -> Result<PathBuf, String> {
    std::env::var_os("YUAN_PLATFORM_DATA_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| UNAVAILABLE.into())
}
fn check_ancestors(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(UNSAFE.into());
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        // A canonical Windows path starts with a verbatim prefix such as \\?\C:.
        // It is not a complete filesystem path until RootDir is appended.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err(UNSAFE.into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(UNSAFE.into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err(UNAVAILABLE.into()),
        }
    }
    Ok(())
}
fn locations(
    app: &Path,
    namespace: &str,
    gateway: &str,
    create: bool,
) -> Result<(PathBuf, String), String> {
    let (_, key) = identity(namespace, gateway)?;
    check_ancestors(app)?;
    if create {
        fs::create_dir_all(app).map_err(|_| UNAVAILABLE)?;
    }
    let folder = app.join("device-auth-v1");
    match fs::symlink_metadata(&folder) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Err(REQUIRED.into());
            }
            secure::create_directory(&folder)?;
        }
        Err(_) => return Err(UNAVAILABLE.into()),
    }
    check_ancestors(&folder)?;
    secure::check_directory(&folder)?;
    Ok((
        folder.join(format!("{key}.bin")),
        format!("{namespace}\n{}", crate::origin(gateway)?),
    ))
}
fn validate(c: &Credential, namespace: &str, gateway: &str) -> Result<(), String> {
    if let Some(relay) = &c.relay {
        relay.validate().map_err(|_| CORRUPT)?;
    }
    if let Some(ca) = &c.ca_pem {
        crate::pairing_bundle::validate_ca(ca).map_err(|_| CORRUPT)?;
    }
    if c.version != 1
        || c.namespace != namespace
        || c.origin != crate::origin(gateway)?
        || c.device_id.is_empty()
        || c.device_id.len() > 128
        || c.user.id.is_empty()
        || c.user.id.len() > 128
        || c.user.username.is_empty()
        || c.user.username.len() > 128
        || c.device_key.len() != 64
        || !c
            .device_key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !c.device_token.starts_with("ydt1.")
        || c.device_token.len() < 64
        || c.device_token.len() > 256
        || !c
            .device_token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(CORRUPT.into());
    }
    Ok(())
}
pub fn load(app: &Path, namespace: &str, gateway: &str) -> Result<Credential, String> {
    let (path, entropy) = locations(app, namespace, gateway, false)?;
    let file = secure::open_read(&path)?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > LIMIT {
        return Err(CORRUPT.into());
    }
    let plaintext = secure::decode(&bytes, &entropy)?;
    let c: Credential = serde_json::from_slice(&plaintext).map_err(|_| CORRUPT)?;
    validate(&c, namespace, gateway)?;
    Ok(c)
}
fn store(app: &Path, namespace: &str, gateway: &str, c: &Credential) -> Result<(), String> {
    validate(c, namespace, gateway)?;
    let (path, entropy) = locations(app, namespace, gateway, true)?;
    if path.exists() {
        let _ = secure::open_read(&path)?;
    }
    let raw = Zeroizing::new(serde_json::to_vec(c).map_err(|_| CORRUPT)?);
    let encoded = secure::encode(&raw, &entropy)?;
    if encoded.len() as u64 > LIMIT {
        return Err(CORRUPT.into());
    }
    let mut suffix = [0u8; 16];
    getrandom::fill(&mut suffix).map_err(|_| UNAVAILABLE)?;
    let temp = path.with_extension(format!("{:x}.tmp", Sha256::digest(suffix)));
    let outcome = (|| {
        let mut file = secure::create_file(&temp)?;
        file.write_all(&encoded).map_err(|_| UNAVAILABLE)?;
        file.sync_all().map_err(|_| UNAVAILABLE)?;
        secure::check_directory(path.parent().ok_or(UNSAFE)?)?;
        if path.exists() {
            let _ = secure::open_read(&path)?;
        }
        fs::rename(&temp, &path).map_err(|_| UNAVAILABLE)?;
        // Rename is the commit point. All fallible permission/format checks precede
        // it so a reported save failure leaves the previous identity in place.
        Ok(())
    })();
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}
pub fn remove(app: &Path, namespace: &str, gateway: &str) -> Result<(), String> {
    let (path, _) = match locations(app, namespace, gateway, false) {
        Ok(v) => v,
        Err(e) if e == REQUIRED => return Ok(()),
        Err(e) => return Err(e),
    };
    match secure::open_read(&path) {
        Ok(_) => fs::remove_file(path).map_err(|_| UNAVAILABLE.into()),
        Err(e) if e == REQUIRED => Ok(()),
        Err(e) => Err(e),
    }
}
pub async fn pair(
    app: &Path,
    namespace: &str,
    gateway: &str,
    ca: &str,
    code: &str,
    name: &str,
) -> Result<Credential, String> {
    pair_inner(app, namespace, gateway, ca, code, name, None, None).await
}
pub async fn pair_bundle(
    app: &Path,
    namespace: &str,
    bundle: &crate::pairing_bundle::Bundle,
    name: &str,
) -> Result<Credential, String> {
    pair_inner(
        app,
        namespace,
        &bundle.gateway,
        "",
        &bundle.token,
        name,
        Some(&bundle.ca_pem),
        bundle.relay.as_ref(),
    )
    .await
}
async fn pair_inner(
    app: &Path,
    namespace: &str,
    gateway: &str,
    ca: &str,
    code: &str,
    name: &str,
    bundled_ca: Option<&str>,
    relay: Option<&crate::relay::Target>,
) -> Result<Credential, String> {
    // Validate/create the private location before consuming the single-use code.
    let _ = locations(app, namespace, gateway, true)?;
    let previous = match load(app, namespace, gateway) {
        Ok(c) => Some(c),
        Err(e) if e == REQUIRED => None,
        Err(e) => return Err(e),
    };
    if code.trim().is_empty() || code.len() > 256 || name.trim().is_empty() || name.len() > 256 {
        return Err("PAIR_INPUT_INVALID".into());
    }
    let config = match bundled_ca {
        Some(pem) => crate::transport::config(Some(pem.as_bytes()))?,
        None => crate::central_tls_config(ca)?,
    };
    let client =
        crate::relay::HttpClient::new(gateway, relay, crate::transport::http_builder(config))
            .await?;
    let value = crate::post_client(
        client.clone(),
        gateway,
        "/auth/device/pair",
        json!({"code":code.trim(),"name":name.trim()}),
        None,
    )
    .await?;
    if value["authMode"] != AUTH_MODE {
        return Err("AUTH_MODE_UNSUPPORTED".into());
    }
    let string = |key: &str| {
        value[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| CORRUPT.to_string())
    };
    let c = Credential {
        version: 1,
        namespace: namespace.into(),
        origin: crate::origin(gateway)?,
        device_token: string("deviceToken")?,
        ca_pem: bundled_ca.map(str::to_owned),
        relay: relay.cloned(),
        device_id: string("deviceId")?,
        device_key: string("deviceKey")?,
        user: serde_json::from_value(value["user"].clone()).map_err(|_| CORRUPT)?,
    };
    validate(&c, namespace, gateway)?;
    if let Err(e) = store(app, namespace, gateway, &c) {
        let _ = crate::post_client(
            client.clone(),
            gateway,
            "/auth/device/disconnect",
            json!({}),
            Some(c.bearer()),
        )
        .await;
        return Err(e);
    }
    if let Some(previous) = previous {
        let previous_client = previous.http(gateway, ca).await;
        if let Ok(previous_client) = previous_client {
            let _ = crate::post_client(
                previous_client.client.clone(),
                gateway,
                "/auth/device/disconnect",
                json!({}),
                Some(previous.bearer()),
            )
            .await;
        }
    }
    Ok(c)
}

/// Materialize only the public CA from the atomically stored device credential.
/// The immutable content-addressed file is used by the UI socket and Local Agent.
pub fn bundled_ca_path(
    app: &Path,
    namespace: &str,
    gateway: &str,
) -> Result<Option<PathBuf>, String> {
    let credential = match load(app, namespace, gateway) {
        Ok(value) => value,
        Err(e) if e == REQUIRED => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(pem) = credential.ca_pem.as_deref() else {
        return Ok(None);
    };
    let (record, _) = locations(app, namespace, gateway, false)?;
    let path = record
        .parent()
        .ok_or(UNSAFE)?
        .join(format!("ca-{:x}.pem", Sha256::digest(pem.as_bytes())));
    match secure::open_read(&path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(65537)
                .read_to_end(&mut bytes)
                .map_err(|_| UNAVAILABLE)?;
            if bytes != pem.as_bytes() {
                return Err(UNSAFE.into());
            }
        }
        Err(e) if e == REQUIRED => {
            let mut random = [0u8; 16];
            getrandom::fill(&mut random).map_err(|_| UNAVAILABLE)?;
            let temp = path.with_extension(format!("{:x}.tmp", Sha256::digest(random)));
            let result = (|| {
                let mut file = secure::create_file(&temp)?;
                file.write_all(pem.as_bytes()).map_err(|_| UNAVAILABLE)?;
                file.sync_all().map_err(|_| UNAVAILABLE)?;
                drop(file);
                fs::rename(&temp, &path).map_err(|_| UNAVAILABLE)?;
                Ok::<(), String>(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temp);
            }
            result?;
        }
        Err(e) => return Err(e),
    }
    Ok(Some(path))
}
pub async fn status(app: &Path, namespace: &str, gateway: &str, ca: &str) -> Value {
    let c = match load(app, namespace, gateway) {
        Ok(c) => c,
        Err(e) => {
            return json!({"authMode":AUTH_MODE,"paired":false,"loggedIn":false,"status":if e==REQUIRED{"missing"}else{"local-error"},"storageError":if e==REQUIRED {None}else{Some(e)}});
        }
    };
    let mut public = c.public();
    match c.post(gateway, ca, "/auth/device/status", json!({})).await {
        Ok(remote) => {
            if remote["authMode"] != AUTH_MODE
                || remote["deviceId"] != c.device_id
                || remote["deviceKey"] != c.device_key
                || remote["user"]["id"] != c.user.id
            {
                public["authorizationError"] = json!("AUTH_MODE_UNSUPPORTED");
            }
            public["remoteAvailable"] = json!(true);
            public["status"] = json!(if public["authorizationError"].is_null() {
                "active"
            } else {
                "revoked"
            });
        }
        Err(e) if is_terminal(&e) => {
            public["authorizationError"] = json!(e);
            public["remoteAvailable"] = json!(true);
            public["status"] = json!("revoked");
        }
        Err(e) => {
            public["remoteAvailable"] = json!(false);
            public["connectionError"] = json!(e);
            public["status"] = json!("offline");
        }
    }
    public
}
pub async fn disconnect(
    app: &Path,
    namespace: &str,
    gateway: &str,
    ca: &str,
) -> Result<Value, String> {
    let c = match load(app, namespace, gateway) {
        Ok(c) => c,
        Err(e) if e == CORRUPT => {
            // Explicit local cancellation can remove a corrupt but still safely
            // owned file; unsafe permissions/links remain a repair error.
            remove(app, namespace, gateway)?;
            return Ok(
                json!({"disconnected":true,"localRemoved":true,"remoteRevocationConfirmed":false}),
            );
        }
        Err(e) if e == REQUIRED => {
            return Ok(
                json!({"disconnected":true,"localRemoved":true,"remoteRevocationConfirmed":false}),
            );
        }
        Err(e) => return Err(e),
    };
    let remote = c
        .post(gateway, ca, "/auth/device/disconnect", json!({}))
        .await;
    remove(app, namespace, gateway)?;
    Ok(
        json!({"disconnected":true,"localRemoved":true,"remoteRevocationConfirmed":remote.is_ok()||remote.as_ref().err().is_some_and(|e|e=="DEVICE_REVOKED")}),
    )
}
pub async fn agent_socket(
    app: &Path,
    namespace: &str,
    gateway: &str,
    ca: &str,
) -> Result<crate::Socket, String> {
    let c = load(app, namespace, gateway)?;
    c.socket(gateway, ca).await
}

#[cfg(unix)]
mod secure {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    fn check(meta: &fs::Metadata, directory: bool) -> Result<(), String> {
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
            || meta.file_type().is_symlink()
            || if directory {
                !meta.is_dir()
            } else {
                !meta.is_file() || meta.nlink() != 1
            }
        {
            return Err(UNSAFE.into());
        }
        Ok(())
    }
    pub fn create_directory(path: &Path) -> Result<(), String> {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(UNAVAILABLE.into()),
        };
        check_directory(path)
    }
    pub fn check_directory(path: &Path) -> Result<(), String> {
        check(&fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?, true)
    }
    pub fn open_read(path: &Path) -> Result<File, String> {
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    REQUIRED
                } else {
                    UNSAFE
                }
            })?;
        check(&file.metadata().map_err(|_| UNAVAILABLE)?, false)?;
        Ok(file)
    }
    pub fn create_file(path: &Path) -> Result<File, String> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| UNAVAILABLE.into())
    }
    pub fn encode(raw: &[u8], _: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        Ok(Zeroizing::new(raw.to_vec()))
    }
    pub fn decode(raw: &[u8], _: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        Ok(Zeroizing::new(raw.to_vec()))
    }
}

#[cfg(windows)]
pub(crate) mod secure {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE, LocalFree},
        Security::{Authorization::*, Cryptography::*, *},
        Storage::FileSystem::*,
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(self.0) };
            }
        }
    }
    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }
    fn wide_path(path: &Path) -> Result<Vec<u16>, String> {
        // The Win32 calls below do not inherit Rust std's long-path conversion.
        // Preserve UTF-16 exactly and add extended syntax only to absolute paths;
        // wide() also handles SDDL strings and must not do this transformation.
        if !path.is_absolute() {
            return Err(UNSAFE.into());
        }
        let raw = path
            .as_os_str()
            .encode_wide()
            .map(|c| if c == b'/' as u16 { b'\\' as u16 } else { c })
            .collect::<Vec<_>>();
        let mut out = if raw.starts_with(&[92, 92, 63, 92]) {
            raw
        } else if raw.starts_with(&[92, 92]) {
            let mut extended = "\\\\?\\UNC\\".encode_utf16().collect::<Vec<_>>();
            extended.extend_from_slice(&raw[2..]);
            extended
        } else {
            let mut extended = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
            extended.extend_from_slice(&raw);
            extended
        };
        out.push(0);
        Ok(out)
    }
    pub(crate) fn user_sid() -> Result<Vec<u8>, String> {
        unsafe {
            let mut token = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(UNAVAILABLE.into());
            }
            let mut bytes = 0;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut bytes);
            let mut data =
                vec![0usize; (bytes as usize + size_of::<usize>() - 1) / size_of::<usize>()];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                data.as_mut_ptr().cast(),
                bytes,
                &mut bytes,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(UNAVAILABLE.into());
            }
            let sid = (*(data.as_ptr().cast::<TOKEN_USER>())).User.Sid;
            if IsValidSid(sid) == 0 {
                return Err(UNSAFE.into());
            }
            Ok(std::slice::from_raw_parts(sid.cast::<u8>(), GetLengthSid(sid) as usize).to_vec())
        }
    }
    fn descriptor() -> Result<Local, String> {
        unsafe {
            let sid = user_sid()?;
            let mut text = null_mut();
            if ConvertSidToStringSidW(sid.as_ptr() as _, &mut text) == 0 {
                return Err(UNAVAILABLE.into());
            }
            let _text = Local(text.cast());
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16(std::slice::from_raw_parts(text, len))
                .map_err(|_| UNAVAILABLE)?;
            let sddl = wide(std::ffi::OsStr::new(&format!(
                "O:{text}D:P(A;;FA;;;{text})"
            )));
            let mut descriptor = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            ) == 0
            {
                return Err(UNAVAILABLE.into());
            }
            Ok(Local(descriptor))
        }
    }
    fn check(file: &File, directory: bool) -> Result<(), String> {
        unsafe {
            let handle = file.as_raw_handle();
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            if GetFileInformationByHandle(handle, &mut info) == 0 {
                return Err(UNAVAILABLE.into());
            }
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
                || (!directory && info.nNumberOfLinks != 1)
            {
                return Err(UNSAFE.into());
            }
            let sid = user_sid()?;
            let mut owner = null_mut();
            let mut acl = null_mut();
            let mut sd = null_mut();
            if GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut sd,
            ) != 0
            {
                return Err(UNAVAILABLE.into());
            }
            let _sd = Local(sd);
            let mut control = 0;
            let mut revision = 0;
            if owner.is_null()
                || acl.is_null()
                || EqualSid(owner, sid.as_ptr() as _) == 0
                || GetSecurityDescriptorControl(sd, &mut control, &mut revision) == 0
                || control & SE_DACL_PROTECTED == 0
            {
                return Err(UNSAFE.into());
            }
            let mut size: ACL_SIZE_INFORMATION = std::mem::zeroed();
            if GetAclInformation(
                acl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) == 0
                || size.AceCount != 1
            {
                return Err(UNSAFE.into());
            }
            let mut ace = null_mut();
            if GetAce(acl, 0, &mut ace) == 0 {
                return Err(UNSAFE.into());
            }
            let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            if ace.Header.AceType != 0
                || ace.Header.AceFlags != 0
                || ace.Mask & FILE_ALL_ACCESS != FILE_ALL_ACCESS
                || EqualSid((&ace.SidStart as *const u32) as _, sid.as_ptr() as _) == 0
            {
                return Err(UNSAFE.into());
            }
            Ok(())
        }
    }
    fn open(path: &Path, directory: bool, create: bool) -> Result<File, String> {
        unsafe {
            let descriptor = if create { Some(descriptor()?) } else { None };
            let security = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.as_ref().map_or(null_mut(), |d| d.0),
                bInheritHandle: 0,
            };
            let handle = CreateFileW(
                wide_path(path)?.as_ptr(),
                if create {
                    0x40000000 | 0x80000000
                } else {
                    0x80000000
                },
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                if create { &security } else { null() },
                if create { CREATE_NEW } else { OPEN_EXISTING },
                FILE_FLAG_OPEN_REPARSE_POINT
                    | if directory {
                        FILE_FLAG_BACKUP_SEMANTICS
                    } else {
                        0
                    },
                null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return Err(
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                        REQUIRED
                    } else {
                        UNAVAILABLE
                    }
                    .into(),
                );
            }
            let file = File::from_raw_handle(handle);
            check(&file, directory)?;
            Ok(file)
        }
    }
    pub fn create_directory(path: &Path) -> Result<(), String> {
        unsafe {
            let descriptor = descriptor()?;
            let security = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: 0,
            };
            if CreateDirectoryW(wide_path(path)?.as_ptr(), &security) == 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(UNAVAILABLE.into());
            }
            check_directory(path)
        }
    }
    pub fn check_directory(path: &Path) -> Result<(), String> {
        open(path, true, false).map(|_| ())
    }
    pub fn open_read(path: &Path) -> Result<File, String> {
        open(path, false, false)
    }
    pub fn create_file(path: &Path) -> Result<File, String> {
        open(path, false, true)
    }
    fn crypt(raw: &[u8], entropy: &str, protect: bool) -> Result<Zeroizing<Vec<u8>>, String> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: raw.len() as u32,
                pbData: raw.as_ptr() as _,
            };
            let entropy = CRYPT_INTEGER_BLOB {
                cbData: entropy.len() as u32,
                pbData: entropy.as_ptr() as _,
            };
            let mut output: CRYPT_INTEGER_BLOB = std::mem::zeroed();
            let ok = if protect {
                CryptProtectData(
                    &input,
                    null(),
                    &entropy,
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    null_mut(),
                    &entropy,
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 {
                return Err(if protect { UNAVAILABLE } else { CORRUPT }.into());
            }
            let _memory = Local(output.pbData.cast());
            let raw = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
            let result = Zeroizing::new(raw.to_vec());
            raw.zeroize();
            Ok(result)
        }
    }
    pub fn encode(raw: &[u8], entropy: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        crypt(raw, entropy, true)
    }
    pub fn decode(raw: &[u8], entropy: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        crypt(raw, entropy, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn token_storage_roundtrip_is_origin_bound_and_has_no_public_secret() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().canonicalize().unwrap();
        assert_storage_roundtrip(&app);
    }
    #[cfg(windows)]
    #[test]
    fn token_storage_supports_normal_absolute_paths_beyond_max_path() {
        use std::os::windows::ffi::OsStrExt;
        let temp = tempfile::tempdir().unwrap();
        let mut app = temp.path().join("设备凭据路径验收");
        assert!(
            !app.as_os_str()
                .encode_wide()
                .collect::<Vec<_>>()
                .starts_with(&[92, 92, 63, 92])
        );
        while app.as_os_str().encode_wide().count() < 320 {
            app.push("nested-private-storage");
        }
        fs::create_dir_all(&app).unwrap();
        assert_storage_roundtrip(&app);
    }
    fn assert_storage_roundtrip(app: &Path) {
        let ns = "com.centralcodex.harnessqa.token-test";
        let gateway = "wss://127.0.0.1:4529/ws";
        let c = Credential {
            version: 1,
            namespace: ns.into(),
            origin: crate::origin(gateway).unwrap(),
            device_token: format!("ydt1.{}.{}", "a".repeat(36), "b".repeat(43)),
            ca_pem: None,
            relay: None,
            device_id: "device-test".into(),
            device_key: "c".repeat(64),
            user: User {
                id: "user-test".into(),
                username: "qa".into(),
            },
        };
        locations(&app, ns, gateway, true)
            .expect("create and validate private credential directory");
        store(&app, ns, gateway, &c).unwrap();
        let loaded = load(&app, ns, gateway).unwrap();
        assert_eq!(loaded.bearer(), c.bearer());
        assert!(!loaded.public().to_string().contains(c.bearer()));
        assert_eq!(
            load(&app, ns, "wss://127.0.0.1:4530/ws").err().unwrap(),
            REQUIRED
        );
        let (file, _) = locations(&app, ns, gateway, false).unwrap();
        #[cfg(windows)]
        assert!(!String::from_utf8_lossy(&fs::read(&file).unwrap()).contains(c.bearer()));
        let link = file.with_extension("hardlink");
        fs::hard_link(&file, &link).unwrap();
        assert_eq!(load(&app, ns, gateway).err().unwrap(), UNSAFE);
        fs::remove_file(link).unwrap();
        remove(&app, ns, gateway).unwrap();
        assert_eq!(load(&app, ns, gateway).err().unwrap(), REQUIRED);
    }
    #[cfg(unix)]
    #[test]
    fn token_storage_rejects_readable_or_linked_directory() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().canonicalize().unwrap();
        let private = app.join("device-auth-v1");
        secure::create_directory(&private).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            locations(
                &app,
                "com.centralcodex.harnessqa.test",
                "wss://localhost:4529/ws",
                false
            )
            .err()
            .unwrap(),
            UNSAFE
        );
        fs::remove_dir(&private).unwrap();
        let actual = app.join("actual");
        secure::create_directory(&actual).unwrap();
        symlink(actual, &private).unwrap();
        assert_eq!(
            locations(
                &app,
                "com.centralcodex.harnessqa.test",
                "wss://localhost:4529/ws",
                false
            )
            .err()
            .unwrap(),
            UNSAFE
        );
    }
}
