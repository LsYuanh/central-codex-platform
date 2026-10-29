// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! A trusted operator hands this opaque code to the device. No network discovery,
//! TLS bypass, private key, model credential, or logging is involved.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

pub const PREFIX: &str = "yzpair1.";
pub const MAX_CODE: usize = 96 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    version: u8,
    pub gateway: String,
    pub ca_pem: String,
    pub token: String,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<crate::relay::Target>,
}
impl Drop for Bundle {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Bundle {
    pub fn new(
        gateway: String,
        ca_pem: String,
        token: String,
        expires_at: u64,
    ) -> Result<Self, String> {
        let value = Self {
            version: 1,
            gateway,
            ca_pem,
            token,
            expires_at,
            relay: None,
        };
        value.validate(now())?;
        Ok(value)
    }
    fn validate(&self, time: u64) -> Result<(), String> {
        let invalid = || "PAIR_BUNDLE_INVALID".to_string();
        if let Some(relay) = &self.relay {
            relay.validate().map_err(|_| invalid())?;
        }
        if self.version != 1
            || self.gateway.len() > 4096
            || self.token.len() < 32
            || self.token.len() > 256
            || !self
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(invalid());
        }
        let url = url::Url::parse(&self.gateway).map_err(|_| invalid())?;
        crate::origin(&self.gateway).map_err(|_| invalid())?;
        if url.path() != "/ws" || url.query().is_some() || url.fragment().is_some() {
            return Err(invalid());
        }
        if self.expires_at <= time {
            return Err("PAIR_BUNDLE_EXPIRED".into());
        }
        if self.expires_at > time.saturating_add(300_000) {
            return Err(invalid());
        }
        validate_ca(&self.ca_pem)?;
        Ok(())
    }
    pub fn encode(&self) -> Result<String, String> {
        self.validate(now())?;
        let bytes = Zeroizing::new(serde_json::to_vec(self).map_err(|_| "PAIR_BUNDLE_INVALID")?);
        let code = format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes.as_slice()));
        if code.len() > MAX_CODE {
            return Err("PAIR_BUNDLE_INVALID".into());
        }
        Ok(code)
    }
    pub fn decode(code: &str) -> Result<Self, String> {
        if code.len() > MAX_CODE {
            return Err("PAIR_BUNDLE_INVALID".into());
        }
        let bytes = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(
                    code.trim()
                        .strip_prefix(PREFIX)
                        .ok_or("PAIR_BUNDLE_INVALID")?,
                )
                .map_err(|_| "PAIR_BUNDLE_INVALID")?,
        );
        let value: Self = serde_json::from_slice(&bytes).map_err(|_| "PAIR_BUNDLE_INVALID")?;
        value.validate(now())?;
        Ok(value)
    }
}
pub fn validate_ca(pem: &str) -> Result<(), String> {
    if pem.is_empty() || pem.len() > 64 * 1024 {
        return Err("PAIR_BUNDLE_CA_INVALID".into());
    }
    let mut rest = pem.trim();
    let mut count = 0;
    while !rest.is_empty() {
        rest = rest
            .strip_prefix("-----BEGIN CERTIFICATE-----")
            .ok_or("PAIR_BUNDLE_CA_INVALID")?;
        let (body, tail) = rest
            .split_once("-----END CERTIFICATE-----")
            .ok_or("PAIR_BUNDLE_CA_INVALID")?;
        if body.is_empty()
            || !body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=\r\n \t".contains(&b))
        {
            return Err("PAIR_BUNDLE_CA_INVALID".into());
        }
        count += 1;
        if count > 16 {
            return Err("PAIR_BUNDLE_CA_INVALID".into());
        }
        rest = tail.trim();
    }
    if reqwest::Certificate::from_pem_bundle(pem.as_bytes())
        .map_err(|_| "PAIR_BUNDLE_CA_INVALID")?
        .len()
        != count
    {
        return Err("PAIR_BUNDLE_CA_INVALID".into());
    }
    Ok(())
}
pub fn http(pem: &str) -> Result<reqwest::Client, String> {
    validate_ca(pem)?;
    crate::transport::http(crate::transport::config(Some(pem.as_bytes()))?)
}
