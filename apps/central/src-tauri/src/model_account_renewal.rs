// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Central-owned OAuth sessions only. No shared auth.json writes, Worker refresh
//! tokens, configurable issuer, renderer token DTO, or model request replay.
use super::*;
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::{
    io::Read,
    sync::{Mutex, OnceLock},
    time::Duration,
};

const ISSUER: &str = "https://auth.openai.com";
// Pinned Codex login protocol: upstream 3d2ee51c, login/src/auth/manager.rs.
const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const JOURNAL: &str = "model-renewals-v1";
const LEAD: u64 = 24 * 60 * 60 * 1000;
const MAX_RETRIES: u32 = 6;
static GATE: Mutex<()> = Mutex::new(());
static LOGIN: OnceLock<Mutex<Option<Login>>> = OnceLock::new();

struct Authority {
    client: Client,
    issuer: String,
}
impl Authority {
    fn production() -> Result<Self> {
        Self::new(ISSUER)
    }
    fn new(issuer: &str) -> Result<Self> {
        Ok(Self {
            client: crate::model_proxy::resolve()?
                .client(Client::builder())?
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .user_agent("YuanZhou-Central/1")
                .build()
                .map_err(|_| failure("MODEL_RENEWAL_NETWORK"))?,
            issuer: issuer.into(),
        })
    }
    fn post(&self, route: &str, body: Value, form: bool) -> Result<(u16, Value)> {
        let builder = self.client.post(format!("{}{route}", self.issuer));
        let request = if form {
            builder.form(&body)
        } else {
            builder.json(&body)
        };
        let response = request.send().map_err(|e| {
            failure(if e.is_connect() {
                "MODEL_RENEWAL_NETWORK"
            } else {
                "MODEL_RENEWAL_UNCERTAIN"
            })
        })?;
        let status = response.status().as_u16();
        let mut bytes = Zeroizing::new(Vec::new());
        response
            .take(128 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| failure("MODEL_RENEWAL_UNCERTAIN"))?;
        if bytes.len() > 128 * 1024 {
            return Err(failure("MODEL_RENEWAL_RESPONSE_INVALID"));
        }
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok((status, value))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    account_record_id: String,
    sequence: u64,
    phase: String,
    error: Option<String>,
    next_retry_at: Option<u64>,
    failures: u32,
    bundle: Bundle,
}
fn latest(root: &Path, id: &str) -> Result<Record> {
    let base = load_base(root, id)?;
    let account = base.account_id.clone();
    let managed = base.refresh_token.is_some();
    let mut result = Record {
        account_record_id: id.into(),
        sequence: 0,
        phase: "ready".into(),
        error: None,
        next_retry_at: None,
        failures: 0,
        bundle: base,
    };
    if !managed {
        return Ok(result);
    }
    let root = crate::config::resource_root(root, false)?;
    let mut sequences = std::collections::HashSet::new();
    for record_id in platform_security::central_secret_store::list(&root, JOURNAL)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?
    {
        let bytes = platform_security::central_secret_store::load(&root, JOURNAL, &record_id)
            .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?;
        let record: Record =
            serde_json::from_slice(&bytes).map_err(|_| failure("MODEL_ACCOUNT_STORAGE_INVALID"))?;
        if record.account_record_id != id {
            continue;
        }
        validate(&record.bundle)?;
        if record.bundle.account_id != account
            || record.bundle.refresh_token.is_none()
            || record.sequence == 0
            || !matches!(
                record.phase.as_str(),
                "ready" | "attempt" | "retry" | "reauth"
            )
        {
            return Err(failure("MODEL_ACCOUNT_STORAGE_INVALID"));
        }
        if !sequences.insert(record.sequence) {
            return Err(failure("MODEL_ACCOUNT_STORAGE_INVALID"));
        }
        if record.sequence > result.sequence {
            result = record;
        }
    }
    Ok(result)
}
fn append(root: &Path, record: &mut Record) -> Result<()> {
    record.sequence = record
        .sequence
        .checked_add(1)
        .ok_or_else(|| failure("MODEL_ACCOUNT_CAPACITY"))?;
    let bytes = Zeroizing::new(
        serde_json::to_vec(record).map_err(|_| failure("MODEL_ACCOUNT_ENCODING_FAILED"))?,
    );
    platform_security::central_secret_store::create(root, JOURNAL, &bytes)
        .map_err(|_| failure("MODEL_RENEWAL_STORAGE_FAILED"))?;
    Ok(())
}
pub(super) fn current_bundle(root: &Path, id: &str) -> Result<Bundle> {
    Ok(latest(root, id)?.bundle)
}
pub(super) fn account_report(root: &Path, id: &str) -> Result<AccountReport> {
    let state = latest(root, id)?;
    let mut result = report(&state.bundle, id, now())?;
    if shared::is_link(root, id)? {
        shared::decorate(id, &mut result);
        return Ok(result);
    }
    if result.refresh_supported {
        result.renewal_state = match state.phase.as_str() {
            "ready" => "ready",
            "retry" => "retrying",
            _ => "reauth-required",
        };
        result.renewal_error = if state.phase == "attempt" {
            Some("MODEL_RENEWAL_UNCERTAIN".into())
        } else {
            state.error
        };
        result.next_retry_at = state.next_retry_at;
    }
    Ok(result)
}
fn claims(token: &str) -> Result<Value> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(failure("MODEL_RENEWAL_RESPONSE_INVALID"));
    }
    let bytes = Zeroizing::new(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|_| failure("MODEL_RENEWAL_RESPONSE_INVALID"))?,
    );
    serde_json::from_slice(&bytes).map_err(|_| failure("MODEL_RENEWAL_RESPONSE_INVALID"))
}
fn token_bundle(value: &Value, previous: Option<&Bundle>, clock: u64) -> Result<Bundle> {
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 32768)
        .ok_or_else(|| failure("MODEL_RENEWAL_RESPONSE_INVALID"))?;
    let access_claims = claims(access)?;
    let id_claims = value
        .get("id_token")
        .and_then(Value::as_str)
        .map(claims)
        .transpose()?;
    let account = access_claims
        .pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
        .and_then(Value::as_str)
        .or_else(|| {
            id_claims
                .as_ref()
                .and_then(|c| c.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id"))
                .and_then(Value::as_str)
        })
        .ok_or_else(|| failure("MODEL_RENEWAL_ACCOUNT_MISMATCH"))?;
    if previous.is_some_and(|b| b.account_id != account) {
        return Err(failure("MODEL_RENEWAL_ACCOUNT_MISMATCH"));
    }
    if id_claims
        .as_ref()
        .and_then(|c| c.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id"))
        .and_then(Value::as_str)
        .is_some_and(|id| id != account)
    {
        return Err(failure("MODEL_RENEWAL_ACCOUNT_MISMATCH"));
    }
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .or_else(|| previous.and_then(|b| b.refresh_token.as_deref()))
        .filter(|s| !s.is_empty() && s.len() <= 32768 && !s.chars().any(char::is_control))
        .ok_or_else(|| failure("MODEL_RENEWAL_RESPONSE_INVALID"))?;
    let bundle = Bundle {
        schema_version: 1,
        imported_at: previous.map_or(clock, |b| b.imported_at),
        access_token: access.into(),
        account_id: account.into(),
        refresh_token: Some(refresh.into()),
    };
    if validate(&bundle)?.is_none_or(|exp| exp <= clock + 60_000) {
        return Err(failure("MODEL_RENEWAL_RESPONSE_INVALID"));
    }
    Ok(bundle)
}
/// A durable attempt precedes rotation. If the process dies after authority
/// rotation, the old refresh token is never blindly reused on restart.
pub fn renew(root: &Path, id: &str) -> Result<bool> {
    renew_with(root, id, &Authority::production()?, now())
}
fn renew_with(root: &Path, id: &str, authority: &Authority, clock: u64) -> Result<bool> {
    let _guard = GATE.try_lock().map_err(|_| failure("MODEL_RENEWAL_BUSY"))?;
    let root = crate::config::resource_root(root, false)?;
    let _lock = platform_security::central_secret_store::lock_runtime_root(
        &root.join("model-renewal-lock"),
    )
    .map_err(|_| failure("MODEL_RENEWAL_BUSY"))?;
    let mut current = latest(&root, id)?;
    if current.bundle.refresh_token.is_none() {
        return Ok(false);
    }
    if matches!(current.phase.as_str(), "attempt" | "reauth") {
        return Err(failure("MODEL_RENEWAL_REAUTH_REQUIRED"));
    }
    if expires_at(&current.bundle.access_token)?.is_some_and(|exp| exp > clock + LEAD)
        || current.next_retry_at.is_some_and(|next| next > clock)
    {
        return Ok(false);
    }
    current.phase = "attempt".into();
    current.error = None;
    current.next_retry_at = None;
    append(&root, &mut current)?;
    let response = authority.post("/oauth/token", json!({"client_id":CLIENT_ID,"grant_type":"refresh_token","refresh_token":current.bundle.refresh_token}), false);
    let result = match response {
        Ok((200, value)) => token_bundle(&value, Some(&current.bundle), clock),
        Ok((429 | 502 | 503 | 504, _)) => Err(failure("MODEL_RENEWAL_NETWORK")),
        Ok((400 | 401 | 403, _)) => Err(failure("MODEL_RENEWAL_REAUTH_REQUIRED")),
        Ok(_) => Err(failure("MODEL_RENEWAL_UNCERTAIN")),
        Err(error) => Err(error),
    };
    match result {
        Ok(bundle) => {
            let expiry = expires_at(&bundle.access_token)?
                .ok_or_else(|| failure("MODEL_RENEWAL_RESPONSE_INVALID"))?;
            // Short-lived tokens renew halfway through their remaining lifetime,
            // instead of rotating again on every 30-second supervisor tick.
            current.next_retry_at = Some(expiry - LEAD.min((expiry - clock) / 2));
            current.bundle = bundle;
            current.phase = "ready".into();
            current.failures = 0;
            // The rotated token must be durable before the gateway can use it.
            append(&root, &mut current)?;
            Ok(true)
        }
        Err(error) => {
            current.failures = current.failures.saturating_add(1);
            let retry = error.code == "MODEL_RENEWAL_NETWORK" && current.failures <= MAX_RETRIES;
            current.phase = if retry { "retry" } else { "reauth" }.into();
            current.error = Some(error.code.into());
            current.next_retry_at =
                retry.then(|| clock + (30u64 << current.failures.min(6)).min(1800) * 1000);
            append(&root, &mut current)?;
            Err(error)
        }
    }
}

struct Login {
    id: String,
    device_id: Zeroizing<String>,
    code: String,
    expires: u64,
    next_poll: u64,
    interval: u64,
    completed_id: Option<String>,
    failed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub login_id: String,
    pub state: &'static str,
    pub verification_url: &'static str,
    pub user_code: String,
    pub expires_at: u64,
    pub account: Option<AccountReport>,
}
fn login_state(login: &Login, account: Option<AccountReport>) -> LoginStatus {
    LoginStatus {
        login_id: login.id.clone(),
        state: if account.is_some() {
            "completed"
        } else {
            "pending"
        },
        verification_url: "https://auth.openai.com/codex/device",
        user_code: login.code.clone(),
        expires_at: login.expires,
        account,
    }
}
pub fn login_start() -> Result<LoginStatus> {
    login_start_with(&Authority::production()?)
}
fn login_start_with(authority: &Authority) -> Result<LoginStatus> {
    let mut slot = LOGIN
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| failure("MODEL_LOGIN_BUSY"))?;
    if slot
        .as_ref()
        .is_some_and(|l| l.expires > now() && l.completed_id.is_none() && !l.failed)
    {
        return Err(failure("MODEL_LOGIN_BUSY"));
    }
    let (status, value) = authority.post(
        "/api/accounts/deviceauth/usercode",
        json!({"client_id":CLIENT_ID}),
        false,
    )?;
    if status != 200 {
        return Err(failure("MODEL_LOGIN_UNAVAILABLE"));
    }
    let get = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
    };
    let device = get("device_auth_id").ok_or_else(|| failure("MODEL_LOGIN_RESPONSE_INVALID"))?;
    let code = get("user_code")
        .or_else(|| get("usercode"))
        .ok_or_else(|| failure("MODEL_LOGIN_RESPONSE_INVALID"))?;
    let interval = value
        .get("interval")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(5)
        .clamp(5, 60);
    let id = crate::service_process::random_control_id().map_err(failure)?;
    let login = Login {
        id,
        device_id: Zeroizing::new(device.into()),
        code: code.into(),
        expires: now() + 900_000,
        next_poll: now() + interval * 1000,
        interval,
        completed_id: None,
        failed: false,
    };
    let result = login_state(&login, None);
    *slot = Some(login);
    Ok(result)
}
pub fn login_cancel(id: &str) -> Result<()> {
    let mut slot = LOGIN
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| failure("MODEL_LOGIN_BUSY"))?;
    if slot.as_ref().is_some_and(|l| l.id == id) {
        *slot = None;
    }
    Ok(())
}
pub fn login_poll(root: &Path, id: &str) -> Result<LoginStatus> {
    login_poll_with(root, id, &Authority::production()?)
}
fn login_poll_with(root: &Path, id: &str, authority: &Authority) -> Result<LoginStatus> {
    let mut slot = LOGIN
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| failure("MODEL_LOGIN_BUSY"))?;
    let login = slot
        .as_mut()
        .filter(|l| l.id == id)
        .ok_or_else(|| failure("MODEL_LOGIN_EXPIRED"))?;
    if let Some(id) = &login.completed_id {
        return Ok(login_state(login, Some(account_report(root, id)?)));
    }
    if login.expires <= now() || login.failed {
        return Err(failure("MODEL_LOGIN_EXPIRED"));
    }
    if login.next_poll > now() {
        return Ok(login_state(login, None));
    }
    login.next_poll = now() + login.interval * 1000;
    let (status, value) = authority.post(
        "/api/accounts/deviceauth/token",
        json!({"device_auth_id":login.device_id.as_str(),"user_code":login.code}),
        false,
    )?;
    if matches!(status, 403 | 404 | 429) {
        return Ok(login_state(login, None));
    }
    login.failed = true; // An authorization code must never be exchanged twice.
    if status != 200 {
        return Err(failure("MODEL_LOGIN_UNAVAILABLE"));
    }
    let get = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| failure("MODEL_LOGIN_RESPONSE_INVALID"))
    };
    let (status,tokens)=authority.post("/oauth/token",json!({"grant_type":"authorization_code","client_id":CLIENT_ID,
        "code":get("authorization_code")?,"code_verifier":get("code_verifier")?,"redirect_uri":"https://auth.openai.com/deviceauth/callback"}),true)?;
    if status != 200 {
        return Err(failure("MODEL_LOGIN_UNAVAILABLE"));
    }
    let bundle = token_bundle(&tokens, None, now())?;
    let id = save_login(root, &bundle)?;
    login.completed_id = Some(id.clone());
    login.device_id.zeroize();
    Ok(login_state(login, Some(account_report(root, &id)?)))
}
fn save_login(root: &Path, bundle: &Bundle) -> Result<String> {
    let root = crate::config::resource_root(root, true)?;
    if platform_security::central_secret_store::list(&root, NAMESPACE)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))?
        .len()
        >= MAX_ACCOUNTS
    {
        return Err(failure("MODEL_ACCOUNT_CAPACITY"));
    }
    let bytes = Zeroizing::new(
        serde_json::to_vec(bundle).map_err(|_| failure("MODEL_ACCOUNT_ENCODING_FAILED"))?,
    );
    platform_security::central_secret_store::create(&root, NAMESPACE, &bytes)
        .map_err(|_| failure("MODEL_ACCOUNT_STORAGE_UNSAFE"))
}

#[cfg(test)]
#[path = "model_account_renewal_tests.rs"]
mod tests;
