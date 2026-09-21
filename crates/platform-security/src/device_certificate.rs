// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Device TLS keys are generated locally. Only the public SPKI leaves this process.
// Independent binary vault entries stay below Windows' 2560-byte credential limit
// and let the Agent renew certificates without writing desktop session tokens.
use base64::{Engine, engine::general_purpose::STANDARD};
use rsa::{
    RsaPrivateKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey},
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, pem::PemObject};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    pub pem: String,
    pub expires_at: u64,
    pub renew_after: u64,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn entry(
    namespace: &str,
    gateway: &str,
    device: &str,
    kind: &str,
) -> Result<keyring::Entry, String> {
    if device.is_empty() || device.len() > 128 {
        return Err("DEVICE_CERTIFICATE_REQUIRED".into());
    }
    let account = format!(
        "{:x}",
        Sha256::digest(format!("{}\n{device}", crate::origin(gateway)?))
    );
    keyring::Entry::new(&format!("{namespace}.device-tls-v1.{kind}"), &account)
        .map_err(|_| "系统凭据库不可用".into())
}

pub async fn generate_key() -> Result<(Zeroizing<Vec<u8>>, String), String> {
    tokio::task::spawn_blocking(|| {
        let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048)
            .map_err(|_| "设备 TLS 密钥生成失败")?;
        let public = key
            .to_public_key()
            .to_public_key_der()
            .map_err(|_| "设备 TLS 公钥编码失败")?;
        let private = key.to_pkcs8_der().map_err(|_| "设备 TLS 私钥编码失败")?;
        Ok((
            Zeroizing::new(private.as_bytes().to_vec()),
            STANDARD.encode(public.as_bytes()),
        ))
    })
    .await
    .map_err(|_| "设备 TLS 密钥生成失败")?
}

fn validate(c: &Certificate) -> Result<(), String> {
    if c.expires_at <= crate::now() || c.renew_after >= c.expires_at {
        return Err("DEVICE_CERTIFICATE_EXPIRED".into());
    }
    let certificate = CertificateDer::from_pem_slice(c.pem.as_bytes())
        .map_err(|_| "DEVICE_CERTIFICATE_INVALID")?;
    if format!("{:x}", Sha256::digest(certificate.as_ref()))
        != c.fingerprint.to_ascii_lowercase().replace(':', "")
    {
        return Err("DEVICE_CERTIFICATE_INVALID".into());
    }
    Ok(())
}

fn save(namespace: &str, gateway: &str, device: &str, c: &Certificate) -> Result<(), String> {
    let data = serde_json::to_vec(c).map_err(|_| "设备证书编码失败")?;
    if data.len() > 2560 {
        return Err("设备证书超出系统凭据库容量".into());
    }
    entry(namespace, gateway, device, "certificate")?
        .set_secret(&data)
        .map_err(|_| "设备证书保存失败".into())
}

pub fn load(namespace: &str, gateway: &str, device: &str) -> Result<Certificate, String> {
    let raw = entry(namespace, gateway, device, "certificate")?
        .get_secret()
        .map_err(|_| "DEVICE_CERTIFICATE_REQUIRED")?;
    serde_json::from_slice(&raw).map_err(|_| "DEVICE_CERTIFICATE_INVALID".into())
}

fn key_der(namespace: &str, gateway: &str, device: &str) -> Result<PrivateKeyDer<'static>, String> {
    let key = entry(namespace, gateway, device, "key")?
        .get_secret()
        .map_err(|_| "DEVICE_CERTIFICATE_REQUIRED")?;
    Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)))
}

pub fn store_pair(
    namespace: &str,
    gateway: &str,
    device: &str,
    key: &[u8],
    value: Value,
) -> Result<(), String> {
    let certificate: Certificate =
        serde_json::from_value(value).map_err(|_| "DEVICE_CERTIFICATE_REQUIRED")?;
    validate(&certificate)?;
    if key.len() > 2560 {
        return Err("设备私钥超出系统凭据库容量".into());
    }
    entry(namespace, gateway, device, "key")?
        .set_secret(key)
        .map_err(|_| "设备私钥保存失败")?;
    if let Err(error) = save(namespace, gateway, device, &certificate)
        .and_then(|_| tls_config(namespace, gateway, device, "").map(|_| ()))
    {
        let _ = remove(namespace, gateway, device);
        return Err(error);
    }
    Ok(())
}

pub fn remove(namespace: &str, gateway: &str, device: &str) -> Result<(), String> {
    if device.is_empty() {
        return Ok(());
    }
    for kind in ["key", "certificate"] {
        match entry(namespace, gateway, device, kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("设备凭据清理失败".into()),
        }
    }
    Ok(())
}

pub fn tls_config(
    namespace: &str,
    gateway: &str,
    device: &str,
    ca: &str,
) -> Result<rustls::ClientConfig, String> {
    let c = load(namespace, gateway, device)?;
    validate(&c)?;
    if c.error.as_deref().is_some_and(is_terminal) {
        return Err(c.error.unwrap());
    }
    let key = key_der(namespace, gateway, device)?;
    let certificate = CertificateDer::from_pem_slice(c.pem.as_bytes())
        .map_err(|_| "DEVICE_CERTIFICATE_INVALID")?;
    let mut roots = rustls::RootCertStore::empty();
    for certificate in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(certificate);
    }
    if let Some(ca) = crate::ca_bytes(ca)? {
        for certificate in CertificateDer::pem_slice_iter(&ca) {
            roots
                .add(certificate.map_err(|_| "CA 证书格式无效")?)
                .map_err(|_| "CA 证书格式无效")?;
        }
    }
    if roots.is_empty() {
        return Err("系统信任证书不可用，请配置中央 CA".into());
    }
    // Rustls loads the signing key into memory; native-tls PKCS8 import creates
    // persistent, process-counter-named Windows key containers and is not used.
    rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "TLS 初始化失败")?
    .with_root_certificates(roots)
    .with_client_auth_cert(vec![certificate], key)
    .map_err(|_| "DEVICE_CERTIFICATE_INVALID".into())
}

pub fn is_terminal(error: &str) -> bool {
    matches!(
        error,
        "DEVICE_CERTIFICATE_REQUIRED"
            | "DEVICE_CERTIFICATE_INVALID"
            | "DEVICE_CERTIFICATE_EXPIRED"
            | "DEVICE_REVOKED"
            | "DEVICE_AUTH_INVALID"
            | "AUTH_REQUIRED"
    )
}

pub fn record_error(namespace: &str, gateway: &str, device: &str, error: &str) {
    if is_terminal(error) && error != "AUTH_REQUIRED" {
        if let Ok(mut c) = load(namespace, gateway, device) {
            c.error = Some(error.into());
            let _ = save(namespace, gateway, device, &c);
        }
    }
}

pub fn public(namespace: &str, gateway: &str, device: &str) -> Value {
    match load(namespace, gateway, device) {
        Ok(c) => {
            let state = if c.expires_at <= crate::now() {
                "expired"
            } else if c.error.is_some() {
                "error"
            } else if c.renew_after <= crate::now() {
                "renewing"
            } else {
                "valid"
            };
            json!({"state":state,"expiresAt":c.expires_at,"renewAfter":c.renew_after,"fingerprint":c.fingerprint,"error":c.error})
        }
        Err(e) => json!({"state":"missing","error":e}),
    }
}

pub fn usable(namespace: &str, gateway: &str, device: &str) -> bool {
    load(namespace, gateway, device).is_ok_and(|c| {
        validate(&c).is_ok()
            && !c.error.as_deref().is_some_and(is_terminal)
            && entry(namespace, gateway, device, "key")
                .and_then(|e| {
                    e.get_secret()
                        .map_err(|_| "DEVICE_CERTIFICATE_REQUIRED".into())
                })
                .is_ok()
    })
}

pub async fn renew_if_due(
    namespace: &str,
    gateway: &str,
    ca: &str,
    device: &str,
) -> Result<bool, String> {
    let mut old = load(namespace, gateway, device)?;
    validate(&old)?;
    if old.error.as_deref().is_some_and(is_terminal) {
        return Err(old.error.unwrap());
    }
    if old.renew_after > crate::now() {
        return Ok(false);
    }
    let c = crate::load(namespace, gateway)?;
    if c.device_id != device {
        return Err("DEVICE_CERTIFICATE_REQUIRED".into());
    }
    let identity = tls_config(namespace, gateway, device, ca)?;
    let result = crate::post_client(
        crate::http_identity(ca, Some(identity))?,
        gateway,
        "/auth/device/renew",
        json!({"sessionId":c.session_id,"deviceId":device}),
        None,
    )
    .await;
    match result {
        Ok(value) => {
            let renewed: Certificate = serde_json::from_value(value["certificate"].clone())
                .map_err(|_| "DEVICE_CERTIFICATE_INVALID")?;
            validate(&renewed)?;
            if renewed.fingerprint == old.fingerprint && renewed.expires_at == old.expires_at {
                // The client clock can reach renewAfter just before the server.
                return Ok(false);
            }
            if renewed.expires_at <= old.expires_at {
                return Err("DEVICE_CERTIFICATE_INVALID".into());
            }
            save(namespace, gateway, device, &renewed)?;
            Ok(true)
        }
        Err(error) => {
            if error == "AUTH_REQUIRED" {
                return Err(error);
            }
            // Store only known bounded codes. Never persist upstream diagnostics.
            old.error = Some(if is_terminal(&error) {
                error.clone()
            } else {
                "DEVICE_CERTIFICATE_RENEW_UNAVAILABLE".into()
            });
            save(namespace, gateway, device, &old)?;
            Err(error)
        }
    }
}

// The Agent owns renewal. The desktop owns session refresh; neither rewrites the
// other's vault record. Renewal authorizes the existing connection's new lease.
pub async fn maintain(
    namespace: String,
    gateway: String,
    ca: String,
    device: String,
) -> Result<(), String> {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        match renew_if_due(&namespace, &gateway, &ca, &device).await {
            Ok(_) => {}
            Err(e) if is_terminal(&e) => {
                record_error(&namespace, &gateway, &device, &e);
                return Err(e);
            }
            Err(_) => {
                // Transient network errors retry while the previous certificate is valid.
                let remaining = load(&namespace, &gateway, &device)?
                    .expires_at
                    .saturating_sub(crate::now());
                tokio::time::sleep(Duration::from_millis(remaining.min(5000))).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, LineEnding};
    use rsa::traits::PublicKeyParts;

    #[tokio::test]
    async fn generated_private_key_fits_vault_and_matches_public_spki() {
        let (private, public) = generate_key().await.unwrap();
        assert!(private.len() <= 2560);
        let key = RsaPrivateKey::from_pkcs8_der(&private).unwrap();
        let public =
            rsa::RsaPublicKey::from_public_key_der(&STANDARD.decode(public).unwrap()).unwrap();
        assert_eq!(key.to_public_key(), public);
        assert_eq!(public.n().bits(), 2048);
        assert!(
            key.to_pkcs8_pem(LineEnding::LF)
                .unwrap()
                .starts_with("-----BEGIN PRIVATE KEY-----")
        );
    }

    #[test]
    fn expired_certificate_cannot_be_loaded_as_identity() {
        let certificate = Certificate {
            pem: String::new(),
            expires_at: crate::now().saturating_sub(1),
            renew_after: 0,
            fingerprint: String::new(),
            error: None,
        };
        assert_eq!(
            validate(&certificate).unwrap_err(),
            "DEVICE_CERTIFICATE_EXPIRED"
        );
        assert!(is_terminal("DEVICE_REVOKED"));
        assert!(!is_terminal("DEVICE_CERTIFICATE_RENEW_UNAVAILABLE"));
    }
}
