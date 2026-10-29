// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Test-only TLS relay. All listeners bind loopback ephemeral ports.
use anyhow::Result;
use iroh::{Endpoint, RelayMode, endpoint::presets, tls::CaTlsConfig};
use iroh_relay::server::{CertConfig, RelayConfig, Server, ServerConfig, TlsConfig};
use peer_transport::PROBE_ALPN;
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use std::{net::Ipv4Addr, sync::Arc};
pub struct LocalRelay {
    pub server: Server,
    pub url: iroh::RelayUrl,
    certificate: CertificateDer<'static>,
    #[allow(dead_code)] // Used only by the opt-in native harness acceptance test.
    pub certificate_pem: String,
}

impl LocalRelay {
    pub async fn start() -> Result<Self> {
        Self::start_with_qad(false).await
    }

    pub async fn start_with_qad(qad: bool) -> Result<Self> {
        Self::start_config(qad, None).await
    }
    #[allow(dead_code)]
    pub async fn authenticated(token: &str) -> Result<Self> {
        Self::start_config(false, Some(token.to_owned())).await
    }
    async fn start_config(qad: bool, token: Option<String>) -> Result<Self> {
        let generated =
            rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])?;
        let certificate = generated.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der());
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key.into())?;
        let mut relay = RelayConfig::new((Ipv4Addr::LOCALHOST, 0));
        if let Some(token) = token {
            relay.access = Arc::new(TokenAccess(token));
        }
        relay.tls = Some(TlsConfig::new(
            (Ipv4Addr::LOCALHOST, 0),
            CertConfig::Manual { server_config: tls },
        ));
        // No application throughput, total-byte or connection-count quota is configured.
        assert!(relay.limits.client_rx.is_none());
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        if qad {
            config.quic = Some(iroh_relay::server::QuicConfig::new((
                Ipv4Addr::LOCALHOST,
                0,
            )));
        }
        let server = Server::spawn(config).await?;
        let url = format!("https://{}", server.https_addr().unwrap()).parse()?;
        Ok(Self {
            server,
            url,
            certificate,
            certificate_pem: generated.cert.pem(),
        })
    }

    pub async fn endpoint(&self, relay_only: bool, trust: bool) -> Result<Endpoint> {
        let mut relay_config = iroh_relay::RelayConfig::from(self.url.clone());
        if let Some(address) = self.server.quic_addr() {
            relay_config.quic = Some(iroh_relay::RelayQuicConfig::new(address.port()));
        }
        let mut builder = Endpoint::builder(presets::Minimal)
            .alpns(vec![PROBE_ALPN.to_vec()])
            .clear_ip_transports()
            .relay_mode(RelayMode::Custom(iroh_relay::RelayMap::from_iter([
                relay_config,
            ])));
        if trust {
            // Trust this temporary certificate explicitly: never disable TLS verification.
            builder = builder.ca_tls_config(CaTlsConfig::custom_roots([self.certificate.clone()]));
        }
        if !relay_only {
            builder = builder.bind_addr((Ipv4Addr::LOCALHOST, 0))?;
        }
        Ok(builder.bind().await?)
    }
}

#[derive(Debug)]
struct TokenAccess(String);
impl iroh_relay::server::AccessControl for TokenAccess {
    async fn on_connect(
        &self,
        request: &iroh_relay::server::ClientRequest,
    ) -> iroh_relay::server::Access {
        // Native product clients must not put admission secrets into URLs.
        if request.uri().query().is_none()
            && request
                .headers()
                .get("Authorization")
                .and_then(|v| v.to_str().ok())
                == Some(format!("Bearer {}", self.0).as_str())
        {
            iroh_relay::server::Access::Allow
        } else {
            iroh_relay::server::Access::Deny { reason: None }
        }
    }
}
