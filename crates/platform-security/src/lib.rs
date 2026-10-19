// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
    tungstenite::client::IntoClientRequest,
};
use url::Url;
#[cfg(windows)]
pub mod central_private_file;
pub mod central_secret_store;
pub mod device_certificate;
pub mod device_token;
pub mod pairing_bundle;
mod transport;

pub type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub refresh_token: String,
    pub access_token: String,
    pub access_expires_at: u64,
    pub session_id: String,
    pub user: Value,
    pub device_id: String,
    pub device_key: String,
    pub signing_seed: String,
}

// Namespace isolates QA application identifiers and gateway origins. No file fallback.
pub fn entry(namespace: &str, gateway: &str) -> Result<keyring::Entry, String> {
    let origin = origin(gateway)?;
    let account = format!("{:x}", Sha256::digest(origin.as_bytes()));
    keyring::Entry::new(&format!("{namespace}.platform-v1"), &account)
        .map_err(|_| "系统凭据库不可用".into())
}
pub fn load(namespace: &str, gateway: &str) -> Result<Credential, String> {
    let raw = entry(namespace, gateway)?
        .get_password()
        .map_err(|_| "请先登录平台账号".to_string())?;
    serde_json::from_str(&raw).map_err(|_| "登录凭据损坏，请重新登录".into())
}
pub fn save(namespace: &str, gateway: &str, credential: &Credential) -> Result<(), String> {
    entry(namespace, gateway)?
        .set_password(&serde_json::to_string(credential).map_err(|_| "凭据编码失败")?)
        .map_err(|_| "系统凭据库保存失败".into())
}
pub fn origin(gateway: &str) -> Result<String, String> {
    let u = Url::parse(gateway).map_err(|_| "网关地址无效")?;
    if u.scheme() != "wss"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("平台登录必须使用 wss:// 加密网关".into());
    }
    let mut u = u;
    u.set_scheme("https").map_err(|_| "网关地址无效")?;
    u.set_path("");
    u.set_query(None);
    Ok(u.to_string().trim_end_matches('/').to_string())
}
pub(crate) fn ca_bytes(path: &str) -> Result<Option<Vec<u8>>, String> {
    if path.is_empty() {
        return Ok(None);
    }
    let data = std::fs::read(Path::new(path)).map_err(|_| "无法读取指定中央 CA 证书")?;
    if data.len() > 64 * 1024 {
        return Err("CA 证书过大".into());
    }
    Ok(Some(data))
}
pub fn http(ca_path: &str) -> Result<reqwest::Client, String> {
    http_identity(ca_path, None)
}

/// Reuse the paired central CA for native lifecycle clients (including updates).
pub fn http_builder(ca_path: &str) -> Result<reqwest::ClientBuilder, String> {
    Ok(transport::http_builder(transport::config(
        ca_bytes(ca_path)?.as_deref(),
    )?))
}

pub fn central_tls_config(ca_path: &str) -> Result<rustls::ClientConfig, String> {
    transport::config(ca_bytes(ca_path)?.as_deref())
}
pub(crate) fn http_identity(
    ca_path: &str,
    identity: Option<rustls::ClientConfig>,
) -> Result<reqwest::Client, String> {
    let config = match identity {
        Some(config) => config,
        None => transport::config(ca_bytes(ca_path)?.as_deref())?,
    };
    transport::http(config)
}
pub async fn post(
    gateway: &str,
    ca: &str,
    route: &str,
    body: Value,
    access: Option<&str>,
) -> Result<Value, String> {
    post_client(http(ca)?, gateway, route, body, access).await
}
pub(crate) async fn post_client(
    client: reqwest::Client,
    gateway: &str,
    route: &str,
    body: Value,
    access: Option<&str>,
) -> Result<Value, String> {
    if !route.starts_with("/auth/") {
        return Err("不支持的平台接口".into());
    }
    let mut request = client
        .post(format!("{}{route}", origin(gateway)?))
        .json(&body);
    if let Some(access) = access {
        request = request.bearer_auth(access);
    }
    let mut response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            "CENTRAL_CONNECTION_TIMEOUT"
        } else {
            transport::error_code(&e)
        }
        .to_string()
    })?;
    if response.content_length().is_some_and(|n| n > 1024 * 1024) {
        return Err("中央响应过大".into());
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| "中央响应读取失败")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("中央响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "中央登录响应格式错误")?;
    if value["ok"] != true {
        return Err(value["error"]
            .as_str()
            .filter(|code| {
                !code.is_empty()
                    && code.len() <= 80
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            })
            .unwrap_or("平台请求失败")
            .to_string());
    }
    Ok(value["data"].clone())
}
fn update(c: &mut Credential, value: Value) -> Result<(), String> {
    c.access_token = value["accessToken"]
        .as_str()
        .ok_or("登录响应缺少令牌")?
        .into();
    c.refresh_token = value["refreshToken"]
        .as_str()
        .ok_or("登录响应缺少刷新令牌")?
        .into();
    c.session_id = value["sessionId"]
        .as_str()
        .ok_or("登录响应缺少会话")?
        .into();
    c.access_expires_at = value["accessExpiresAt"]
        .as_u64()
        .ok_or("登录响应缺少期限")?;
    c.user = value["user"].clone();
    Ok(())
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub async fn login(
    namespace: &str,
    gateway: &str,
    ca: &str,
    username: &str,
    password: &str,
) -> Result<Credential, String> {
    let mut c = load(namespace, gateway).unwrap_or_default();
    let value = post(
        gateway,
        ca,
        "/auth/login",
        json!({"username":username,"password":password}),
        None,
    )
    .await?;
    if !c.user.is_null() && c.user["id"] != value["user"]["id"] {
        device_certificate::remove(namespace, gateway, &c.device_id)?;
        c = Credential::default();
    }
    update(&mut c, value)?;
    if !c.device_id.is_empty() {
        let devices = post(
            gateway,
            ca,
            "/auth/devices",
            json!({}),
            Some(&c.access_token),
        )
        .await?;
        let valid = devices["devices"].as_array().is_some_and(|list| {
            list.iter()
                .any(|d| d["id"] == c.device_id && d["revoked"] == false)
        });
        if !valid {
            device_certificate::remove(namespace, gateway, &c.device_id)?;
            c.device_id.clear();
            c.device_key.clear();
            c.signing_seed.clear();
        }
    }
    save(namespace, gateway, &c)?;
    Ok(c)
}
pub async fn current(namespace: &str, gateway: &str, ca: &str) -> Result<Credential, String> {
    let mut c = load(namespace, gateway)?;
    let mut refresh = c.access_expires_at < now() + 30_000;
    if !refresh {
        match post(gateway, ca, "/auth/me", json!({}), Some(&c.access_token)).await {
            Ok(_) => {}
            Err(e) if e == "AUTH_REQUIRED" => refresh = true,
            Err(e) => return Err(e),
        }
    }
    if refresh {
        let value = post(
            gateway,
            ca,
            "/auth/refresh",
            json!({"refreshToken":c.refresh_token}),
            None,
        )
        .await?;
        update(&mut c, value)?;
        save(namespace, gateway, &c)?;
    }
    Ok(c)
}
pub async fn pair(
    namespace: &str,
    gateway: &str,
    ca: &str,
    name: &str,
) -> Result<Credential, String> {
    let mut c = current(namespace, gateway, ca).await?;
    let (tls_key, tls_public) = device_certificate::generate_key().await?;
    let code = post(
        gateway,
        ca,
        "/auth/pair-code",
        json!({}),
        Some(&c.access_token),
    )
    .await?;
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|_| "设备密钥生成失败")?;
    let signing = SigningKey::from_bytes(&seed);
    let public = signing.verifying_key().to_bytes();
    let paired = post(
        gateway,
        ca,
        "/auth/pair",
        json!({"code":code["code"],"name":name,"publicKey":STANDARD.encode(public),"tlsPublicKey":tls_public}),
        Some(&c.access_token),
    )
    .await?;
    let previous_device = c.device_id.clone();
    c.device_id = paired["deviceId"].as_str().ok_or("配对响应无效")?.into();
    c.device_key = format!("{:x}", Sha256::digest(public));
    if paired["deviceKey"] != c.device_key {
        return Err("配对公钥摘要不一致".into());
    }
    c.signing_seed = STANDARD.encode(seed);
    device_certificate::store_pair(
        namespace,
        gateway,
        &c.device_id,
        &tls_key,
        paired["certificate"].clone(),
    )?;
    if let Err(e) = save(namespace, gateway, &c) {
        let _ = device_certificate::remove(namespace, gateway, &c.device_id);
        return Err(e);
    }
    if !previous_device.is_empty() && previous_device != c.device_id {
        device_certificate::remove(namespace, gateway, &previous_device)?;
    }
    Ok(c)
}
pub async fn socket(url: &str, ca: &str, bearer: &str) -> Result<Socket, String> {
    socket_identity(url, ca, bearer, None).await
}
async fn socket_identity(
    url: &str,
    ca: &str,
    bearer: &str,
    identity: Option<rustls::ClientConfig>,
) -> Result<Socket, String> {
    origin(url)?;
    let mut request = url.into_client_request().map_err(|_| "网关地址无效")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {bearer}")
            .parse()
            .map_err(|_| "认证头无效")?,
    );
    let config = match identity {
        Some(config) => config,
        None => transport::config(ca_bytes(ca)?.as_deref())?,
    };
    let connector = Connector::Rustls(std::sync::Arc::new(config));
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        connect_async_tls_with_config(
            request,
            Some(
                tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(None)
                    .max_frame_size(None),
            ),
            false,
            Some(connector),
        ),
    )
    .await
    .map_err(|_| "CENTRAL_CONNECTION_TIMEOUT")?
    .map_err(|error| {
        if let tokio_tungstenite::tungstenite::Error::Http(ref response) = error {
            if let Some(code) = response
                .headers()
                .get("X-Yuan-Auth-Error")
                .and_then(|v| v.to_str().ok())
            {
                if matches!(
                    code,
                    "AUTH_REQUIRED"
                        | "AUTH_MODE_UNSUPPORTED"
                        | "DEVICE_CERTIFICATE_REQUIRED"
                        | "DEVICE_CERTIFICATE_INVALID"
                        | "DEVICE_CERTIFICATE_EXPIRED"
                        | "DEVICE_REVOKED"
                ) {
                    return code.to_string();
                }
            }
        }
        transport::error_code(&error).to_string()
    })?;
    Ok(socket)
}
pub async fn agent_socket(namespace: &str, gateway: &str, ca: &str) -> Result<Socket, String> {
    let result = agent_socket_inner(namespace, gateway, ca).await;
    if let Err(ref error) = result {
        if let Ok(c) = load(namespace, gateway) {
            device_certificate::record_error(namespace, gateway, &c.device_id, error);
        }
    }
    result
}
async fn agent_socket_inner(namespace: &str, gateway: &str, ca: &str) -> Result<Socket, String> {
    // Agent never refreshes: desktop is the sole refresh-token writer.
    let c = load(namespace, gateway)?;
    if let Err(e) = device_certificate::renew_if_due(namespace, gateway, ca, &c.device_id).await {
        if device_certificate::is_terminal(&e) {
            return Err(e);
        }
    }
    let identity = device_certificate::tls_config(namespace, gateway, &c.device_id, ca)?;
    let challenge = post(
        gateway,
        ca,
        "/auth/device/challenge",
        json!({"sessionId":c.session_id,"deviceId":c.device_id}),
        None,
    )
    .await?;
    let nonce = challenge["nonce"].as_str().ok_or("设备挑战无效")?;
    let message = format!(
        "yuan-zhou-device-v1\n{}\n{}\n{nonce}",
        c.session_id, c.device_id
    );
    if challenge["message"] != message {
        return Err("设备挑战上下文无效".into());
    }
    let seed: [u8; 32] = STANDARD
        .decode(&c.signing_seed)
        .map_err(|_| "设备密钥无效")?
        .try_into()
        .map_err(|_| "设备密钥无效")?;
    let signature = SigningKey::from_bytes(&seed).sign(message.as_bytes());
    let result = post(
        gateway,
        ca,
        "/auth/device/prove",
        json!({"nonce":nonce,"signature":STANDARD.encode(signature.to_bytes())}),
        None,
    )
    .await?;
    socket_identity(
        gateway,
        ca,
        result["ticket"].as_str().ok_or("设备认证响应无效")?,
        Some(identity),
    )
    .await
}
