// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! References the OS user's original Codex login. Only the packaged Codex
//! authentication process rotates it; neither gateway nor Workers see refresh tokens.
use super::*;
use crate::runtime_package::PreparedServicePackage;
use std::{
    collections::HashMap,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    schema_version: u8,
    source: String,
    account_id: String,
    imported_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaHeader {
    schema_version: u8,
}
pub(super) fn has_reference_schema(bytes: &[u8]) -> bool {
    serde_json::from_slice::<SchemaHeader>(bytes).is_ok_and(|header| header.schema_version == 2)
}
fn reference(bytes: &[u8]) -> Result<Reference> {
    let value: Reference =
        serde_json::from_slice(bytes).map_err(|_| failure("MODEL_ACCOUNT_STORAGE_INVALID"))?;
    if value.schema_version != 2
        || value.source != "codex-home"
        || !valid_account_id(&value.account_id)
    {
        return Err(failure("MODEL_ACCOUNT_STORAGE_INVALID"));
    }
    Ok(value)
}
pub(super) fn resolve_reference(bytes: &[u8]) -> Result<Bundle> {
    resolve_at(&reference(bytes)?, &profile::source()?)
}
fn resolve_at(link: &Reference, source: &Path) -> Result<Bundle> {
    let bundle = parse_source(&read_source(source)?, link.imported_at)?;
    if bundle.account_id != link.account_id {
        return Err(failure("MODEL_SHARED_ACCOUNT_CHANGED"));
    }
    Ok(bundle)
}
pub fn is_link(root: &Path, id: &str) -> Result<bool> {
    let root = crate::config::resource_root(root, false)?;
    let bytes = platform_security::central_secret_store::load(&root, NAMESPACE, id)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
    Ok(has_reference_schema(&bytes))
}
pub fn link_existing(root: &Path) -> Result<AccountReport> {
    let bundle = parse_source(&read_source(&profile::source()?)?, now())?;
    let root = crate::config::resource_root(root, true)?;
    let ids = platform_security::central_secret_store::list(&root, NAMESPACE)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
    for id in &ids {
        let bytes = platform_security::central_secret_store::load(&root, NAMESPACE, id)
            .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
        if let Ok(link) = serde_json::from_slice::<Reference>(&bytes) {
            if link.schema_version == 2
                && link.source == "codex-home"
                && link.account_id == bundle.account_id
            {
                clear_state(id);
                return selected(&root, id);
            }
        }
    }
    if ids.len() >= MAX_ACCOUNTS {
        return Err(failure("MODEL_ACCOUNT_CAPACITY"));
    }
    let bytes = serde_json::to_vec(&Reference {
        schema_version: 2,
        source: "codex-home".into(),
        account_id: bundle.account_id.clone(),
        imported_at: now(),
    })
    .map_err(|_| failure("MODEL_ACCOUNT_ENCODING_FAILED"))?;
    let id = platform_security::central_secret_store::create(&root, NAMESPACE, &bytes)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
    selected(&root, &id)
}

#[derive(Clone, Default)]
struct Status {
    digest: String,
    failures: u32,
    next: u64,
    error: Option<&'static str>,
    terminal: bool,
}
static STATUS: OnceLock<Mutex<HashMap<String, Status>>> = OnceLock::new();
static GATE: Mutex<()> = Mutex::new(());
fn statuses() -> &'static Mutex<HashMap<String, Status>> {
    STATUS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn clear_state(id: &str) {
    if let Ok(mut states) = statuses().lock() {
        states.remove(id);
    }
}
pub(super) fn decorate(id: &str, report: &mut AccountReport) {
    report.credential_source = "codex-shared";
    report.refresh_supported = true;
    report.renewal_state = "ready";
    if let Some(state) = statuses().lock().ok().and_then(|s| s.get(id).cloned()) {
        report.renewal_state = if state.terminal {
            "reauth-required"
        } else if state.error.is_some() {
            "retrying"
        } else {
            "ready"
        };
        report.renewal_error = state.error.map(str::to_owned);
        report.next_retry_at = state.error.filter(|_| !state.terminal).map(|_| state.next);
    }
}
pub fn renew(
    root: &Path,
    id: &str,
    package: &PreparedServicePackage,
    cancel: &AtomicBool,
    startup: bool,
) -> Result<()> {
    let _gate = GATE.try_lock().map_err(|_| failure("MODEL_RENEWAL_BUSY"))?;
    let source = profile::source()?;
    let home = source
        .parent()
        .ok_or_else(|| failure("MODEL_ACCOUNT_PROFILE_UNAVAILABLE"))?;
    // Lock shared by all central profiles using this OS login. Codex itself also
    // reloads the current auth before refreshing, including desktop-written changes.
    let _lock = platform_security::central_secret_store::lock_runtime_root(
        &home.join("central-auth-owner-v1"),
    )
    .map_err(|_| failure("MODEL_RENEWAL_BUSY"))?;
    let current = load_base(root, id)?;
    let clock = now();
    let digest = format!("{:x}", Sha256::digest(current.access_token.as_bytes()));
    let mut state = statuses()
        .lock()
        .map_err(|_| failure("MODEL_RENEWAL_BUSY"))?
        .get(id)
        .cloned()
        .unwrap_or_default();
    if state.digest != digest {
        state = Status {
            digest: digest.clone(),
            ..Default::default()
        };
    }
    if state.terminal {
        return Err(failure("MODEL_SHARED_RELOGIN_REQUIRED"));
    }
    if state.next > clock {
        return Ok(());
    }
    let expiry = validate(&current)?.ok_or_else(|| failure("MODEL_SHARED_EXPIRY_UNKNOWN"))?;
    let refresh = expiry <= clock + 24 * 60 * 60 * 1000;
    if !startup && !refresh {
        clear_state(id);
        return Ok(());
    }
    let result = authenticate(
        &package.app_server,
        home,
        cancel,
        refresh,
        Duration::from_secs(30),
    )
    .and_then(|token| {
        let updated = load_base(root, id)?;
        // Codex must have durably stored the same access token before it is
        // exposed to the gateway. Also catches account switching during refresh.
        if updated.access_token != *token || updated.account_id != current.account_id {
            return Err(failure("MODEL_SHARED_SOURCE_CHANGED"));
        }
        let exp = validate(&updated)?.ok_or_else(|| failure("MODEL_SHARED_EXPIRY_UNKNOWN"))?;
        if exp <= now() + 60_000 || refresh && updated.access_token == current.access_token {
            return Err(failure("MODEL_SHARED_REFRESH_FAILED"));
        }
        Ok((
            format!("{:x}", Sha256::digest(updated.access_token.as_bytes())),
            exp,
        ))
    });
    match result {
        Ok((digest, exp)) => {
            state = Status {
                digest,
                next: exp - (24 * 60 * 60 * 1000).min(exp.saturating_sub(now()) / 2),
                ..Default::default()
            };
            statuses()
                .lock()
                .map_err(|_| failure("MODEL_RENEWAL_BUSY"))?
                .insert(id.into(), state);
            Ok(())
        }
        Err(error) => {
            if error.code == "MODEL_SHARED_CANCELLED" {
                return Err(error);
            }
            state.failures += 1;
            state.error = Some(error.code);
            state.terminal = matches!(
                error.code,
                "MODEL_SHARED_RELOGIN_REQUIRED"
                    | "MODEL_SHARED_ACCOUNT_CHANGED"
                    | "MODEL_SHARED_PROTOCOL_INVALID"
            ) || state.failures > 6;
            state.next = clock + (30u64 << state.failures.min(6)).min(1800) * 1000;
            statuses()
                .lock()
                .map_err(|_| failure("MODEL_RENEWAL_BUSY"))?
                .insert(id.into(), state);
            Err(error)
        }
    }
}

/// One bounded, owned authentication process per check. No thread/turn/command
/// RPC can enter this channel. Closing stdin and kill+wait reap it on every path.
fn authenticate(
    binary: &Path,
    home: &Path,
    cancel: &AtomicBool,
    refresh: bool,
    deadline: Duration,
) -> Result<Zeroizing<String>> {
    authenticate_args(binary, &[], home, cancel, refresh, deadline)
}
fn authenticate_args(
    binary: &Path,
    prefix: &[String],
    home: &Path,
    cancel: &AtomicBool,
    refresh: bool,
    deadline: Duration,
) -> Result<Zeroizing<String>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| failure("MODEL_SHARED_PROCESS_FAILED"))?;
    runtime.block_on(async {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        use std::process::Stdio;
        if cancel.load(Ordering::SeqCst) { return Err(failure("MODEL_SHARED_CANCELLED")); }
        let mut command = tokio::process::Command::new(binary);
        command.args(prefix);
        command.args(["--listen", "stdio://", "-c", "model_provider=\"openai\"", "-c", "cli_auth_credentials_store=\"file\"",
            "-c", "approval_policy=\"never\"", "-c", "sandbox_mode=\"read-only\"", "-c", "features.plugins=false",
            "-c", "features.remote_control=false"])
            .current_dir(home).env_clear().env("CODEX_HOME", home)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        // No API-key/auth/provider overrides from the parent. Preserve only OS
        // support and explicit transport trust/proxy settings needed to log in.
        for name in ["SystemRoot","WINDIR","SystemDrive","TEMP","TMP","TMPDIR","HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","NO_PROXY","SSL_CERT_FILE","CODEX_CA_CERTIFICATE"] {
            if let Some(value) = std::env::var_os(name) { command.env(name, value); }
        }
        if let Some(user_home) = home.parent() {
            command.env("HOME", user_home).env("USERPROFILE", user_home);
        }
        #[cfg(windows)] { command.creation_flags(0x08000000); }
        #[cfg(unix)] { command.process_group(0); }
        let mut child = command.spawn().map_err(|_| failure("MODEL_SHARED_PROCESS_FAILED"))?;
        let mut input = child.stdin.take().ok_or_else(|| failure("MODEL_SHARED_PROCESS_FAILED"))?;
        let mut output = BufReader::new(child.stdout.take().ok_or_else(|| failure("MODEL_SHARED_PROCESS_FAILED"))?);
        let exchange = async {
            input.write_all(b"{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"yuanzhou_auth\",\"version\":\"1\"}}}\n").await.map_err(|_| failure("MODEL_SHARED_PROCESS_FAILED"))?;
            let mut stage = 1;
            for _ in 0..64 {
                let mut line = Zeroizing::new(Vec::new());
                (&mut output).take(65537).read_until(b'\n', &mut line).await.map_err(|_| failure("MODEL_SHARED_PROCESS_FAILED"))?;
                if line.is_empty() { return Err(failure("MODEL_SHARED_PROCESS_FAILED")); }
                if line.len() > 65536 || !line.ends_with(b"\n") { return Err(failure("MODEL_SHARED_PROTOCOL_INVALID")); }
                let frame: Frame = serde_json::from_slice(&line).map_err(|_| failure("MODEL_SHARED_PROTOCOL_INVALID"))?;
                if frame.method.is_some() {
                    if frame.id.is_some() { return Err(failure("MODEL_SHARED_PROTOCOL_INVALID")); }
                    continue; // Notifications are discarded, never shown as model output.
                }
                if frame.id != Some(stage) || frame.error.is_some() { return Err(failure("MODEL_SHARED_PROTOCOL_INVALID")); }
                if stage == 1 {
                    if frame.result.is_none() { return Err(failure("MODEL_SHARED_PROTOCOL_INVALID")); }
                    input.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n").await.map_err(|_| failure("MODEL_SHARED_PROCESS_FAILED"))?;
                    let request = format!("{{\"id\":2,\"method\":\"getAuthStatus\",\"params\":{{\"includeToken\":true,\"refreshToken\":{refresh}}}}}\n");
                    input.write_all(request.as_bytes()).await.map_err(|_| failure("MODEL_SHARED_PROCESS_FAILED"))?;
                    stage = 2;
                } else {
                    let mut result = frame.result.ok_or_else(|| failure("MODEL_SHARED_PROTOCOL_INVALID"))?;
                    if result.auth_method.as_deref() != Some("chatgpt") { return Err(failure("MODEL_SHARED_RELOGIN_REQUIRED")); }
                    return result.auth_token.take().map(Zeroizing::new)
                        .filter(|s| !s.is_empty() && s.len() <= 32768)
                        .ok_or_else(|| failure("MODEL_SHARED_RELOGIN_REQUIRED"));
                }
            }
            Err(failure("MODEL_SHARED_PROTOCOL_INVALID"))
        };
        let cancelled = async {
            loop {
                if cancel.load(Ordering::SeqCst) { break; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let result = tokio::select! {
            result = tokio::time::timeout(deadline, exchange) => result.unwrap_or_else(|_| Err(failure("MODEL_SHARED_TIMEOUT"))),
            _ = cancelled => Err(failure("MODEL_SHARED_CANCELLED")),
        };
        drop(input);
        // Give EOF a brief chance; force and reap if the server stays alive.
        if tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        result
    })
}
#[derive(Deserialize)]
struct Frame {
    id: Option<u64>,
    method: Option<String>,
    result: Option<AuthResult>,
    error: Option<serde::de::IgnoredAny>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthResult {
    auth_method: Option<String>,
    auth_token: Option<String>,
}
impl Drop for AuthResult {
    fn drop(&mut self) {
        self.auth_token.zeroize();
    }
}

#[cfg(test)]
#[path = "model_shared_login_tests.rs"]
mod tests;
