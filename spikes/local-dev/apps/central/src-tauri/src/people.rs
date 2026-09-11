// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Fixed native management routes for the currently owned gateway. No IPC tokens.
use crate::{
    config::{Result, failure},
    service::{ManagementTarget, Service},
    service_process::{Snapshot, State},
};
use reqwest::{
    Url,
    blocking::{Body, Client},
    header::{AUTHORIZATION, HeaderValue},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Read, Write},
    net::{IpAddr, SocketAddr, TcpListener},
    path::Path,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const MAX_RESPONSE: usize = 2 * 1024 * 1024;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoginMode {
    #[default]
    Password,
    PairingOnly,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub role: Role,
    pub disabled: bool,
    #[serde(default)]
    pub login_mode: LoginMode,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub last_seen_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMode {
    DeviceTokenV1,
    LegacyMtlsV1,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicDevice {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub revoked: bool,
    pub created_at: u64,
    pub auth_mode: AuthMode,
    pub online: bool,
    pub last_seen_at: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub instance_id: Option<String>,
    pub service_state: State,
    pub authenticated: bool,
    pub admin: Option<PublicUser>,
    pub expires_at: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub instance_id: String,
    pub users: Vec<PublicUser>,
    pub devices: Vec<PublicDevice>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub auth_mode: AuthMode,
    pub code: String,
    pub expires_at: u64,
    pub expires_in: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_code: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub instance_id: String,
    pub request_id: String,
    pub user: Option<PublicUser>,
    pub pairing: Option<Pairing>,
    pub disabled: bool,
    pub revoked: bool,
}
pub enum Mutation {
    CreateUser { username: String },
    DisableUser { user_id: String },
    PairCode { user_id: String },
    RevokeDevice { device_id: String },
}

// Deserialization immediately gives each secret a wiping owner; no serde Value tree.
struct Secret(Zeroizing<String>);
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(d).map(|s| Self(Zeroizing::new(s)))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    access_token: Secret,
    refresh_token: Secret,
    access_expires_at: u64,
    session_id: String,
    user: PublicUser,
    auth_mode: Option<String>,
    device_id: Option<String>,
}
struct Session {
    instance_id: String,
    access: Secret,
    refresh: Secret,
    expires_at: u64,
    admin: PublicUser,
}
#[derive(Default)]
pub struct People {
    session: Mutex<Option<Session>>,
    clear_requested: AtomicBool,
}
struct SessionGuard<'a> {
    guard: Option<MutexGuard<'a, Option<Session>>>,
    owner: &'a People,
    service: &'a Service,
}
impl std::ops::Deref for SessionGuard<'_> {
    type Target = Option<Session>;
    fn deref(&self) -> &Self::Target {
        self.guard.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for SessionGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard.as_mut().unwrap()
    }
}
impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        sync_session(self.guard.as_mut().unwrap(), &self.service.snapshot());
        if self.owner.clear_requested.load(Ordering::SeqCst) {
            **self.guard.as_mut().unwrap() = None;
        }
        drop(self.guard.take());
        // Close the race with a clear request arriving immediately before unlock.
        if self.owner.clear_requested.load(Ordering::SeqCst) {
            self.owner.clear_session();
        }
    }
}
struct SecretBody(Zeroizing<Vec<u8>>);
impl Write for SecretBody {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > 16 * 1024 {
            return Err(std::io::Error::other("PEOPLE_REQUEST_INVALID"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[derive(Deserialize)]
struct Envelope<T> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Users {
    users: Vec<PublicUser>,
}
#[derive(Deserialize)]
struct Devices {
    devices: Vec<PublicDevice>,
}
#[derive(Deserialize)]
struct Disabled {
    disabled: bool,
}
#[derive(Deserialize)]
struct Revoked {
    revoked: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoggedOut {
    logged_out: bool,
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn identifier(value: &str) -> bool {
    bounded(value, 128)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn valid_user(user: &PublicUser) -> bool {
    identifier(&user.id) && bounded(&user.username, 64)
}
fn token(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn accept_login(value: LoginResponse, instance: &str) -> Result<Session> {
    if value.user.role != Role::Admin
        || value.user.disabled
        || value.auth_mode.is_some()
        || value.device_id.is_some()
    {
        return Err(failure("ADMIN_ROLE_REQUIRED"));
    }
    let refresh = value.refresh_token.0.split_once('.');
    if !valid_user(&value.user)
        || !token(&value.access_token.0)
        || !identifier(&value.session_id)
        || value.session_id.starts_with("device")
        || !refresh.is_some_and(|(id, secret)| id == value.session_id && token(secret))
        || value.access_expires_at <= now()
        || value.access_expires_at > now().saturating_add(24 * 60 * 60 * 1000)
    {
        return Err(failure("PEOPLE_PROTOCOL_INVALID"));
    }
    Ok(Session {
        instance_id: instance.into(),
        access: value.access_token,
        refresh: value.refresh_token,
        expires_at: value.access_expires_at,
        admin: value.user,
    })
}
fn checked(service: &Service, expected: &str) -> Result<Snapshot> {
    let snapshot = service.snapshot();
    if snapshot.state != State::Running {
        return Err(failure("SERVICE_NOT_RUNNING"));
    }
    if snapshot.instance_id.as_deref() != Some(expected) {
        return Err(failure("SERVICE_INSTANCE_MISMATCH"));
    }
    Ok(snapshot)
}
fn sync_session(session: &mut Option<Session>, snapshot: &Snapshot) {
    if snapshot.state != State::Running
        || session
            .as_ref()
            .is_some_and(|s| snapshot.instance_id.as_deref() != Some(&s.instance_id))
    {
        *session = None;
    }
}
fn public_status(session: &Option<Session>, snapshot: Snapshot) -> Status {
    Status {
        instance_id: snapshot.instance_id,
        service_state: snapshot.state,
        authenticated: session.is_some(),
        admin: session.as_ref().map(|s| s.admin.clone()),
        expires_at: session.as_ref().map(|s| s.expires_at),
    }
}

/// Only a native saved target enters here. IP literals bypass DNS resolution, so
/// wildcard listeners must first prove that their literal address is local.
fn endpoint(config: &crate::config::CentralConfig) -> Result<(Url, String, SocketAddr)> {
    let mut url = Url::parse(&config.client_url).map_err(|_| failure("PEOPLE_TARGET_UNSAFE"))?;
    if url.scheme() != "wss"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(config.listen.port as u16)
        || !(1..=65535).contains(&config.listen.port)
    {
        return Err(failure("PEOPLE_TARGET_UNSAFE"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| failure("PEOPLE_TARGET_UNSAFE"))?
        .trim_matches(['[', ']'])
        .to_owned();
    let listen: IpAddr = config
        .listen
        .host
        .parse()
        .map_err(|_| failure("PEOPLE_TARGET_UNSAFE"))?;
    let dial = if let Ok(ip) = host.parse::<IpAddr>() {
        if ip.is_unspecified() || ip.is_multicast() || ip.is_ipv4() != listen.is_ipv4() {
            return Err(failure("PEOPLE_TARGET_UNSAFE"));
        }
        if listen.is_unspecified() {
            let socket =
                TcpListener::bind((ip, 0)).map_err(|_| failure("PEOPLE_TARGET_NOT_LOCAL"))?;
            drop(socket);
        } else if ip != listen {
            return Err(failure("PEOPLE_TARGET_UNSAFE"));
        }
        ip
    } else if listen.is_unspecified() {
        if listen.is_ipv4() {
            IpAddr::from([127, 0, 0, 1])
        } else {
            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        }
    } else {
        listen
    };
    url.set_scheme("https")
        .map_err(|_| failure("PEOPLE_TARGET_UNSAFE"))?;
    url.set_port(Some(config.listen.port as u16))
        .map_err(|_| failure("PEOPLE_TARGET_UNSAFE"))?;
    url.set_path("/");
    Ok((url, host, SocketAddr::new(dial, config.listen.port as u16)))
}
struct Transport {
    client: Client,
    base: Url,
    instance: String,
    gateway: String,
    ca_pem: String,
}
fn instance_header(headers: &reqwest::header::HeaderMap, expected: &str) -> bool {
    headers.get_all("x-central-service-instance").iter().count() == 1
        && headers
            .get("x-central-service-instance")
            .and_then(|h| h.to_str().ok())
            == Some(expected)
}
impl Transport {
    fn new(target: ManagementTarget) -> Result<Self> {
        let (base, host, address) = endpoint(&target.config)?;
        let certificates = reqwest::Certificate::from_pem_bundle(target.ca_pem.as_bytes())
            .map_err(|_| failure("PEOPLE_TLS_INVALID"))?;
        if certificates.is_empty() {
            return Err(failure("PEOPLE_TLS_INVALID"));
        }
        let mut builder = Client::builder()
            .use_rustls_tls()
            .tls_built_in_root_certs(false)
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(15))
            .http1_only()
            .pool_max_idle_per_host(0)
            .resolve(&host, address);
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
        Ok(Self {
            client: builder.build().map_err(|_| failure("PEOPLE_TLS_INVALID"))?,
            base,
            instance: target.instance_id,
            gateway: target.config.client_url,
            ca_pem: target.ca_pem,
        })
    }
    fn post<T: for<'de> Deserialize<'de>>(
        &self,
        service: &Service,
        route: &'static str,
        body: &impl Serialize,
        access: Option<&str>,
        change: bool,
    ) -> Result<T> {
        checked(service, &self.instance)?;
        let uncertain = || {
            failure(if change {
                "OUTCOME_UNKNOWN"
            } else {
                "PEOPLE_NETWORK_FAILED"
            })
        };
        let mut writer = SecretBody(Zeroizing::new(Vec::with_capacity(16 * 1024)));
        serde_json::to_writer(&mut writer, body).map_err(|_| failure("PEOPLE_REQUEST_INVALID"))?;
        let bytes = writer.0;
        let length = bytes.len() as u64;
        let mut url = self.base.clone();
        url.set_path(route);
        let mut request = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .body(Body::sized(Cursor::new(bytes), length));
        if let Some(access) = access {
            let raw = Zeroizing::new(format!("Bearer {access}"));
            let mut header =
                HeaderValue::from_str(&raw).map_err(|_| failure("PEOPLE_PROTOCOL_INVALID"))?;
            header.set_sensitive(true);
            request = request.header(AUTHORIZATION, header);
        }
        let mut response = request.send().map_err(|_| uncertain())?;
        if !instance_header(response.headers(), &self.instance) {
            return Err(uncertain());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE as u64)
        {
            return Err(uncertain());
        }
        let success = response.status().is_success();
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_RESPONSE));
        let mut chunk = Zeroizing::new([0u8; 8192]);
        loop {
            let count = response.read(&mut *chunk).map_err(|_| uncertain())?;
            if count == 0 {
                break;
            }
            if bytes.len() + count > MAX_RESPONSE {
                return Err(uncertain());
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        if checked(service, &self.instance).is_err() {
            return Err(uncertain());
        }
        let envelope: Envelope<T> = serde_json::from_slice(&bytes).map_err(|_| uncertain())?;
        if !success || !envelope.ok {
            return Err(failure(match envelope.error.as_deref() {
                Some("AUTH_REQUIRED" | "REFRESH_REUSED" | "INVALID_LOGIN") => "ADMIN_AUTH_REQUIRED",
                Some("RATE_LIMITED") => "RATE_LIMITED",
                Some("SESSION_LIMIT") => "SESSION_LIMIT",
                Some("REQUEST_ID_CONFLICT") => "REQUEST_ID_CONFLICT",
                Some("REQUEST_EXPIRED") => "REQUEST_EXPIRED",
                Some("INVALID_OR_EXISTING_ACCOUNT") => "INVALID_OR_EXISTING_ACCOUNT",
                Some("NOT_FOUND") => "NOT_FOUND",
                Some("INVALID_INPUT") => "PEOPLE_REQUEST_INVALID",
                _ => {
                    if change {
                        "OUTCOME_UNKNOWN"
                    } else {
                        "PEOPLE_PROTOCOL_INVALID"
                    }
                }
            }));
        }
        envelope.data.ok_or_else(uncertain)
    }
}
impl People {
    pub fn new() -> Self {
        Self::default()
    }
    /// Nonblocking stop/close invalidation. An active bounded operation wipes its
    /// session on completion, including a login that arrives after this call.
    pub fn clear_session(&self) {
        self.clear_requested.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.session.try_lock() {
            *guard = None;
            self.clear_requested.store(false, Ordering::SeqCst);
        }
    }
    fn lock<'a>(&'a self, service: &'a Service) -> Result<SessionGuard<'a>> {
        let mut guard = self
            .session
            .try_lock()
            .map_err(|_| failure("OPERATION_BUSY"))?;
        sync_session(&mut guard, &service.snapshot());
        if self.clear_requested.swap(false, Ordering::SeqCst) {
            *guard = None;
        }
        Ok(SessionGuard {
            guard: Some(guard),
            owner: self,
            service,
        })
    }
    fn authorize(
        &self,
        service: &Service,
        app_data: &Path,
        expected: &str,
        session: &mut Option<Session>,
    ) -> Result<Transport> {
        let transport = Transport::new(service.management_target(app_data, expected)?)?;
        if session.as_ref().is_none_or(|s| s.instance_id != expected) {
            *session = None;
            return Err(failure("ADMIN_AUTH_REQUIRED"));
        }
        if session.as_ref().unwrap().expires_at <= now().saturating_add(5000) {
            // Rotation is consumed once. Any uncertain outcome discards both local
            // credentials; the old refresh token is never retried.
            let old = session.take().unwrap();
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Refresh<'a> {
                refresh_token: &'a str,
            }
            let response = transport.post(
                service,
                "/auth/refresh",
                &Refresh {
                    refresh_token: &old.refresh.0,
                },
                None,
                true,
            )?;
            *session = Some(accept_login(response, expected)?);
        }
        Ok(transport)
    }
    pub fn status(&self, service: &Service, app_data: &Path) -> Result<Status> {
        let mut session = self.lock(service)?;
        if let Some(expected) = session.as_ref().map(|s| s.instance_id.clone()) {
            self.authorize(service, app_data, &expected, &mut session)?;
        }
        let snapshot = service.snapshot();
        sync_session(&mut session, &snapshot);
        Ok(public_status(&session, snapshot))
    }
    pub fn login(
        &self,
        service: &Service,
        app_data: &Path,
        expected: &str,
        username: String,
        password: Zeroizing<String>,
    ) -> Result<Status> {
        let mut session = self.lock(service)?;
        *session = None;
        if !bounded(&username, 64) || !bounded(&password, 256) {
            return Err(failure("PEOPLE_REQUEST_INVALID"));
        }
        let transport = Transport::new(service.management_target(app_data, expected)?)?;
        #[derive(Serialize)]
        struct Credentials<'a> {
            username: &'a str,
            password: &'a str,
        }
        let response = transport.post(
            service,
            "/auth/admin/login",
            &Credentials {
                username: &username,
                password: &password,
            },
            None,
            true,
        )?;
        *session = Some(accept_login(response, expected)?);
        let snapshot = checked(service, expected)?;
        Ok(public_status(&session, snapshot))
    }
    pub fn logout(&self, service: &Service, app_data: &Path, expected: &str) -> Result<Status> {
        let mut session = self.lock(service)?;
        let result = (|| {
            let transport = self.authorize(service, app_data, expected, &mut session)?;
            let value: LoggedOut = transport.post(
                service,
                "/auth/logout",
                &serde_json::json!({}),
                Some(&session.as_ref().unwrap().access.0),
                true,
            )?;
            if !value.logged_out {
                return Err(failure("OUTCOME_UNKNOWN"));
            }
            Ok(())
        })();
        *session = None;
        result?;
        Ok(public_status(&session, service.snapshot()))
    }
    pub fn list(&self, service: &Service, app_data: &Path, expected: &str) -> Result<Inventory> {
        let mut session = self.lock(service)?;
        let result = (|| {
            let transport = self.authorize(service, app_data, expected, &mut session)?;
            let access = &session.as_ref().unwrap().access.0;
            let users: Users = transport.post(
                service,
                "/auth/admin/users",
                &serde_json::json!({}),
                Some(access),
                false,
            )?;
            let devices: Devices = transport.post(
                service,
                "/auth/admin/devices",
                &serde_json::json!({}),
                Some(access),
                false,
            )?;
            if users.users.len() > 10000
                || devices.devices.len() > 10000
                || users.users.iter().any(|u| !valid_user(u))
                || devices.devices.iter().any(|d| {
                    !identifier(&d.id) || !identifier(&d.user_id) || !bounded(&d.name, 128)
                })
            {
                return Err(failure("PEOPLE_PROTOCOL_INVALID"));
            }
            Ok(Inventory {
                instance_id: expected.into(),
                users: users.users,
                devices: devices.devices,
            })
        })();
        if result.as_ref().is_err_and(|e| {
            matches!(
                e.code,
                "ADMIN_AUTH_REQUIRED" | "PEOPLE_PROTOCOL_INVALID" | "OUTCOME_UNKNOWN"
            )
        }) {
            *session = None;
        }
        result
    }
    pub fn mutate(
        &self,
        service: &Service,
        app_data: &Path,
        expected: &str,
        request_id: &str,
        mutation: Mutation,
    ) -> Result<MutationResult> {
        let mut session = self.lock(service)?;
        if !identifier(request_id) {
            return Err(failure("PEOPLE_REQUEST_INVALID"));
        }
        let result = (|| {
            let transport = self.authorize(service, app_data, expected, &mut session)?;
            let access = Some(session.as_ref().unwrap().access.0.as_str());
            let mut result = MutationResult {
                instance_id: expected.into(),
                request_id: request_id.into(),
                user: None,
                pairing: None,
                disabled: false,
                revoked: false,
            };
            match mutation {
                Mutation::CreateUser { username } => {
                    if !bounded(&username, 64) {
                        return Err(failure("PEOPLE_REQUEST_INVALID"));
                    }
                    let user: PublicUser = transport.post(
                        service,
                        "/auth/admin/user/create-pairing",
                        &serde_json::json!({"requestId":request_id,"username":username}),
                        access,
                        true,
                    )?;
                    if !valid_user(&user)
                        || user.role != Role::User
                        || user.disabled
                        || !matches!(user.login_mode, LoginMode::PairingOnly)
                    {
                        return Err(failure("OUTCOME_UNKNOWN"));
                    }
                    result.user = Some(user);
                }
                Mutation::DisableUser { user_id } => {
                    if !identifier(&user_id) {
                        return Err(failure("PEOPLE_REQUEST_INVALID"));
                    }
                    let value: Disabled = transport.post(
                        service,
                        "/auth/admin/user/disable",
                        &serde_json::json!({"requestId":request_id,"userId":user_id}),
                        access,
                        true,
                    )?;
                    if !value.disabled {
                        return Err(failure("OUTCOME_UNKNOWN"));
                    }
                    result.disabled = true;
                }
                Mutation::PairCode { user_id } => {
                    if !identifier(&user_id) {
                        return Err(failure("PEOPLE_REQUEST_INVALID"));
                    }
                    let mut value: Pairing = transport.post(
                        service,
                        "/auth/admin/pair-code",
                        &serde_json::json!({"requestId":request_id,"userId":user_id}),
                        access,
                        true,
                    )?;
                    if !matches!(value.auth_mode, AuthMode::DeviceTokenV1)
                        || !token(&value.code)
                        || value.expires_in > 300
                        || value.expires_at <= now()
                        || value.expires_at > now() + 300_000
                    {
                        return Err(failure("OUTCOME_UNKNOWN"));
                    }
                    value.connection_code = Some(
                        platform_security::pairing_bundle::Bundle::new(
                            transport.gateway.clone(),
                            transport.ca_pem.clone(),
                            value.code.clone(),
                            value.expires_at,
                        )
                        .and_then(|bundle| bundle.encode())
                        .map_err(|_| failure("OUTCOME_UNKNOWN"))?,
                    );
                    result.pairing = Some(value);
                }
                Mutation::RevokeDevice { device_id } => {
                    if !identifier(&device_id) {
                        return Err(failure("PEOPLE_REQUEST_INVALID"));
                    }
                    let value: Revoked = transport.post(
                        service,
                        "/auth/device/revoke",
                        &serde_json::json!({"requestId":request_id,"deviceId":device_id}),
                        access,
                        true,
                    )?;
                    if !value.revoked {
                        return Err(failure("OUTCOME_UNKNOWN"));
                    }
                    result.revoked = true;
                }
            }
            Ok(result)
        })();
        if result.as_ref().is_err_and(|e| {
            matches!(
                e.code,
                "ADMIN_AUTH_REQUIRED" | "PEOPLE_PROTOCOL_INVALID" | "OUTCOME_UNKNOWN"
            )
        }) {
            *session = None;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instance_header_requires_one_exact_native_instance() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(!instance_header(&headers, "expected"));
        headers.insert(
            "x-central-service-instance",
            HeaderValue::from_static("other"),
        );
        assert!(!instance_header(&headers, "expected"));
        headers.insert(
            "x-central-service-instance",
            HeaderValue::from_static("expected"),
        );
        assert!(instance_header(&headers, "expected"));
        headers.append(
            "x-central-service-instance",
            HeaderValue::from_static("expected"),
        );
        assert!(!instance_header(&headers, "expected"));
    }
    #[cfg(all(windows, debug_assertions))]
    #[test]
    #[ignore = "real native-owned gateway management over TLS; isolated synthetic account/admin/device only"]
    fn native_owned_gateway_people_tls_auth_mutations_and_refresh_qa() {
        use crate::{model_accounts, service::StartRequest, tls};
        use std::time::Instant;
        let resources = std::path::PathBuf::from(
            std::env::var_os("CENTRAL_SERVICE_QA_RESOURCES")
                .expect("CENTRAL_SERVICE_QA_RESOURCES required"),
        );
        assert!(resources.is_absolute());
        let catalog: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../harness/central-service-catalog.json"
        ))
        .unwrap();
        let package = catalog["packages"][0]["id"].as_str().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("application");
        let certificate = tls::store_service_fixture(&app_data);
        let account = model_accounts::store_service_fixture(&app_data);
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = serde_json::json!({"schemaVersion":1,"revision":0,"dataDirectory":temp.path().join("gateway-data").to_string_lossy(),"listen":{"host":"127.0.0.1","port":port},"clientUrl":format!("wss://central-test.invalid:{port}/ws"),"tls":{"certificateId":certificate},"runtimePackageId":package,"limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},"shutdown":{"graceMs":1000,"forceMs":5000}});
        let service = Service::new();
        struct Cleanup<'a>(&'a Service);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                self.0.shutdown();
            }
        }
        let _cleanup = Cleanup(&service);
        service
            .save_config(&app_data, "people-config".into(), 0, config)
            .unwrap();
        const PASSWORD: &str = "SYNTHETIC-people-admin-passphrase-39";
        let start = service
            .start(
                &app_data,
                &resources,
                StartRequest {
                    request_id: "people-start".into(),
                    expected_revision: 1,
                    account_id: account,
                    admin_username: Some("synthetic-admin".into()),
                    admin_password: Some(Zeroizing::new(PASSWORD.into())),
                },
            )
            .unwrap();
        let instance = start.instance_id.unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while service.snapshot().state != State::Running {
            let state = service.snapshot();
            assert_ne!(state.state, State::Failed, "{:?}", state.failure_code);
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(25));
        }
        let people = People::new();
        assert!(!people.status(&service, &app_data).unwrap().authenticated);
        assert_eq!(
            people
                .login(
                    &service,
                    &app_data,
                    &instance,
                    "synthetic-admin".into(),
                    Zeroizing::new("SYNTHETIC-wrong-password".into())
                )
                .err()
                .unwrap()
                .code,
            "ADMIN_AUTH_REQUIRED"
        );
        assert!(
            people
                .login(
                    &service,
                    &app_data,
                    &instance,
                    "synthetic-admin".into(),
                    Zeroizing::new(PASSWORD.into())
                )
                .unwrap()
                .authenticated
        );
        assert_eq!(
            people
                .list(&service, &app_data, &instance)
                .unwrap()
                .users
                .len(),
            1
        );
        // Removing all trust roots must fail the TLS exchange with the same server.
        let mut untrusted =
            Transport::new(service.management_target(&app_data, &instance).unwrap()).unwrap();
        untrusted.client = Client::builder()
            .use_rustls_tls()
            .tls_built_in_root_certs(false)
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(5))
            .resolve(
                "central-test.invalid",
                SocketAddr::from(([127, 0, 0, 1], port)),
            )
            .build()
            .unwrap();
        assert_eq!(
            untrusted
                .post::<Users>(
                    &service,
                    "/auth/admin/users",
                    &serde_json::json!({}),
                    None,
                    false
                )
                .err()
                .unwrap()
                .code,
            "PEOPLE_NETWORK_FAILED"
        );
        let create = || Mutation::CreateUser {
            username: "synthetic-member".into(),
        };
        let user = people
            .mutate(&service, &app_data, &instance, "people-create", create())
            .unwrap()
            .user
            .unwrap();
        let repeat = people
            .mutate(&service, &app_data, &instance, "people-create", create())
            .unwrap()
            .user
            .unwrap();
        assert_eq!(user.id, repeat.id);
        assert_eq!(
            people
                .mutate(
                    &service,
                    &app_data,
                    &instance,
                    "people-create",
                    Mutation::CreateUser {
                        username: "different-member".into()
                    }
                )
                .err()
                .unwrap()
                .code,
            "REQUEST_ID_CONFLICT"
        );
        let pairing = people
            .mutate(
                &service,
                &app_data,
                &instance,
                "people-pair",
                Mutation::PairCode {
                    user_id: user.id.clone(),
                },
            )
            .unwrap()
            .pairing
            .unwrap();
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Paired {
            device_id: String,
            device_token: Secret,
            device_key: Secret,
        }
        let transport =
            Transport::new(service.management_target(&app_data, &instance).unwrap()).unwrap();
        // Only this native test calls public pairing; product management has no such command.
        let paired: Paired = transport
            .post(
                &service,
                "/auth/device/pair",
                &serde_json::json!({"code":pairing.code,"name":"synthetic-device"}),
                None,
                true,
            )
            .unwrap();
        assert!(paired.device_token.0.starts_with("ydt1."));
        assert_eq!(paired.device_key.0.len(), 64);
        let inventory = people.list(&service, &app_data, &instance).unwrap();
        assert!(
            inventory
                .devices
                .iter()
                .any(|d| d.id == paired.device_id && !d.revoked)
        );
        let public = serde_json::to_string(&inventory).unwrap();
        assert!(!public.contains(paired.device_token.0.as_str()));
        assert!(!public.contains(paired.device_key.0.as_str()));
        people
            .mutate(
                &service,
                &app_data,
                &instance,
                "people-revoke",
                Mutation::RevokeDevice {
                    device_id: paired.device_id.clone(),
                },
            )
            .unwrap();
        people
            .mutate(
                &service,
                &app_data,
                &instance,
                "people-disable",
                Mutation::DisableUser {
                    user_id: user.id.clone(),
                },
            )
            .unwrap();
        let inventory = people.list(&service, &app_data, &instance).unwrap();
        assert!(
            inventory
                .devices
                .iter()
                .any(|d| d.id == paired.device_id && d.revoked)
        );
        assert!(
            inventory
                .users
                .iter()
                .any(|u| u.id == user.id && u.disabled)
        );
        // Exercise real rotation, then deliberately consume the next token outside
        // People: refresh rejection must clear native auth without a second send.
        people.session.lock().unwrap().as_mut().unwrap().expires_at = 0;
        assert!(people.status(&service, &app_data).unwrap().authenticated);
        let refresh = Zeroizing::new(
            people
                .session
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .refresh
                .0
                .to_string(),
        );
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Refresh<'a> {
            refresh_token: &'a str,
        }
        let _discarded: LoginResponse = transport
            .post(
                &service,
                "/auth/refresh",
                &Refresh {
                    refresh_token: &refresh,
                },
                None,
                true,
            )
            .unwrap();
        people.session.lock().unwrap().as_mut().unwrap().expires_at = 0;
        assert_eq!(
            people.status(&service, &app_data).err().unwrap().code,
            "ADMIN_AUTH_REQUIRED"
        );
        assert!(people.session.lock().unwrap().is_none());
        assert!(
            people
                .login(
                    &service,
                    &app_data,
                    &instance,
                    "synthetic-admin".into(),
                    Zeroizing::new(PASSWORD.into())
                )
                .unwrap()
                .authenticated
        );
        assert!(
            !people
                .logout(&service, &app_data, &instance)
                .unwrap()
                .authenticated
        );
        service.stop(&app_data, "people-stop", &instance).unwrap();
        assert!(service.shutdown());
        assert!(!people.status(&service, &app_data).unwrap().authenticated);
        println!(
            "PEOPLE_SYNTHETIC_QA: TLS-only, admin-login, users/devices, receipts, pair, revoke, disable, refresh, spent-refresh-clear, logout, stopped-clear passed"
        );
    }
    fn synthetic_session(instance: &str) -> Session {
        Session {
            instance_id: instance.into(),
            access: Secret(Zeroizing::new("SYNTHETIC_ACCESS".into())),
            refresh: Secret(Zeroizing::new("SYNTHETIC_REFRESH".into())),
            expires_at: now() + 10000,
            admin: PublicUser {
                id: "synthetic-user".into(),
                username: "synthetic-admin".into(),
                role: Role::Admin,
                disabled: false,
                login_mode: LoginMode::Password,
                online: false,
                last_seen_at: None,
            },
        }
    }
    #[test]
    fn changed_instance_clears_session_and_public_status_has_no_tokens() {
        let service = Service::new();
        let mut snapshot = service.snapshot();
        snapshot.state = State::Running;
        snapshot.instance_id = Some("instance-a".into());
        let mut session = Some(synthetic_session("instance-a"));
        sync_session(&mut session, &snapshot);
        assert!(session.is_some());
        let public = serde_json::to_string(&public_status(&session, snapshot.clone())).unwrap();
        assert!(!public.contains("SYNTHETIC_ACCESS"));
        assert!(!public.contains("SYNTHETIC_REFRESH"));
        snapshot.instance_id = Some("instance-b".into());
        sync_session(&mut session, &snapshot);
        assert!(session.is_none());
    }
    #[test]
    fn stop_clear_during_pending_operation_is_not_lost_and_cannot_keep_late_login() {
        let service = Service::new();
        let people = People::new();
        let mut guard = people.lock(&service).unwrap();
        people.clear_session();
        assert!(people.clear_requested.load(Ordering::SeqCst));
        *guard = Some(synthetic_session("late-instance"));
        drop(guard);
        assert!(!people.clear_requested.load(Ordering::SeqCst));
        assert!(people.session.try_lock().unwrap().is_none());
    }
    #[test]
    fn request_secret_writer_rejects_limit_before_reallocation() {
        let mut writer = SecretBody(Zeroizing::new(Vec::with_capacity(16 * 1024)));
        let capacity = writer.0.capacity();
        writer.write_all(&vec![b'a'; 16 * 1024]).unwrap();
        assert!(writer.write_all(b"x").is_err());
        assert_eq!(writer.0.len(), 16 * 1024);
        assert_eq!(writer.0.capacity(), capacity);
    }
    fn config(host: &str, url: &str) -> crate::config::CentralConfig {
        serde_json::from_value(serde_json::json!({"schemaVersion":1,"revision":1,"dataDirectory":"C:\\synthetic","listen":{"host":host,"port":4510},"clientUrl":url,"tls":{"certificateId":"synthetic"},"runtimePackageId":"synthetic","limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},"shutdown":{"graceMs":1,"forceMs":1000}})).unwrap()
    }
    #[test]
    fn binds_dns_to_saved_listener_and_accepts_only_local_literal_for_wildcard() {
        let (_, host, address) =
            endpoint(&config("0.0.0.0", "wss://central-test.invalid:4510/ws")).unwrap();
        assert_eq!(host, "central-test.invalid");
        assert_eq!(address, SocketAddr::from(([127, 0, 0, 1], 4510)));
        assert!(endpoint(&config("0.0.0.0", "wss://127.0.0.1:4510/ws")).is_ok());
        assert!(endpoint(&config("0.0.0.0", "wss://192.0.2.123:4510/ws")).is_err());
        assert!(endpoint(&config("127.0.0.1", "wss://192.0.2.123:4510/ws")).is_err());
        assert!(endpoint(&config("127.0.0.1", "wss://localhost:4511/ws")).is_err());
        assert!(endpoint(&config("127.0.0.1", "wss://user@localhost:4510/ws")).is_err());
    }
    #[test]
    fn device_and_nonadmin_login_never_create_native_admin_session() {
        for role in ["user", "admin"] {
            let value = serde_json::json!({"accessToken":"ydt1.synthetic","refreshToken":"synthetic","accessExpiresAt":now()+10000,"sessionId":"device:synthetic","user":{"id":"u","username":"x","role":role,"disabled":false},"authMode":"device-token-v1"});
            assert!(accept_login(serde_json::from_value(value).unwrap(), "instance").is_err());
        }
    }
    #[test]
    fn public_device_dto_never_serializes_backend_secrets() {
        let value:PublicDevice=serde_json::from_value(serde_json::json!({"id":"id","userId":"u","name":"name","revoked":false,"createdAt":1,"authMode":"device-token-v1","online":false,"lastSeenAt":null,"deviceKey":"SECRET_DEVICE_KEY","tokenHash":"SECRET_HASH","salt":"SECRET_SALT"})).unwrap();
        let output = serde_json::to_string(&value).unwrap();
        assert!(!output.contains("SECRET"));
        assert!(!output.contains("deviceKey"));
    }
    #[test]
    fn operation_gate_is_nonblocking_and_stopped_service_has_no_auth() {
        let people = People::new();
        let service = Service::new();
        let guard = people.lock(&service).unwrap();
        assert_eq!(people.lock(&service).err().unwrap().code, "OPERATION_BUSY");
        drop(guard);
        let directory = tempfile::tempdir().unwrap();
        let status = people.status(&service, directory.path()).unwrap();
        assert!(!status.authenticated);
        assert!(status.admin.is_none());
    }
}
