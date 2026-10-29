// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Verify a real relay rejects an unenrolled random key after a trusted TLS handshake.
use std::{sync::Arc, time::Duration};

use anyhow::{Result, ensure};
use iroh::{Endpoint, SecretKey, endpoint::presets};
use iroh_relay::{
    client::{ClientBuilder, ConnectError},
    protos::handshake,
    tls::CaTlsConfig,
};
use rustls::pki_types::{CertificateDer, pem::PemObject};

#[tokio::main]
async fn main() -> Result<()> {
    let url: iroh::RelayUrl = std::env::var("PEER_PROBE_RELAY_URL")?.parse()?;
    ensure!(url.as_str().starts_with("https://"), "relay requires HTTPS");
    let pem = std::fs::read(std::env::var("PEER_PROBE_CA_FILE")?)?;
    let roots = CertificateDer::pem_slice_iter(&pem).collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(!roots.is_empty(), "empty relay CA file");
    let tls = CaTlsConfig::custom_roots(roots)
        .client_config(Arc::new(rustls::crypto::ring::default_provider()))?;
    let endpoint = Endpoint::builder(presets::Minimal).bind().await?;
    let attempt = tokio::time::timeout(
        Duration::from_secs(15),
        ClientBuilder::new(url, SecretKey::generate(), endpoint.dns_resolver()?.clone())
            .tls_client_config(tls)
            .connect(),
    )
    .await;
    endpoint.close().await;
    // A timeout or TLS failure is not evidence that endpoint authorization works.
    let denied = matches!(
        attempt,
        Ok(Err(ConnectError::Handshake {
            source: handshake::Error::ServerDeniedAuth { .. },
            ..
        }))
    );
    ensure!(denied, "expected an explicit relay authentication denial");
    println!("{{\"uninvitedKeyDenied\":true,\"evidence\":\"ServerDeniedAuth\"}}");
    Ok(())
}
