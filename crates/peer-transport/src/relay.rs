// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Relay-only product transport. No discovery, UDP punching, command execution or arbitrary proxy targets.
use anyhow::{Result, ensure};
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, SecretKey, endpoint::presets,
    tls::CaTlsConfig,
};
use n0_watcher::Watcher;
use rustls::pki_types::{CertificateDer, pem::PemObject};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, time::Duration};
use tokio::{
    io::copy_bidirectional,
    net::{TcpSocket, TcpStream},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use zeroize::Zeroize;

pub const ALPN: &[u8] = b"yuan-zhou/gateway-tunnel/1";
pub fn central_id(seed: [u8; 32]) -> String {
    SecretKey::from_bytes(&seed).public().to_string()
}
pub fn new_seed() -> [u8; 32] {
    SecretKey::generate().to_bytes()
}
const CONNECT: Duration = Duration::from_secs(20);

// No Debug: admission tokens travel only in an HTTPS Authorization header and the private store.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Access {
    pub url: String,
    #[serde(default)]
    pub ca_pem: String,
    pub token: String,
}
impl Drop for Access {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
impl Access {
    pub fn validate(&self) -> Result<()> {
        let u = url::Url::parse(&self.url)?;
        ensure!(
            u.scheme() == "https"
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
                && u.path() == "/",
            "RELAY_CONFIG_INVALID"
        );
        ensure!(
            self.token.len() >= 32
                && self.token.len() <= 4096
                && self.token.bytes().all(|b| b.is_ascii_graphic()),
            "RELAY_TOKEN_INVALID"
        );
        ensure!(self.ca_pem.len() <= 65536, "RELAY_CA_INVALID");
        if !self.ca_pem.is_empty() {
            // This public trust material is copied into pairing bundles. Refuse mixed
            // PEM files (especially a server private key) instead of silently skipping them.
            let mut rest = self.ca_pem.trim();
            while !rest.is_empty() {
                rest = rest
                    .strip_prefix("-----BEGIN CERTIFICATE-----")
                    .ok_or_else(|| anyhow::anyhow!("RELAY_CA_INVALID"))?;
                let (_, tail) = rest
                    .split_once("-----END CERTIFICATE-----")
                    .ok_or_else(|| anyhow::anyhow!("RELAY_CA_INVALID"))?;
                rest = tail.trim();
            }
            let certs = CertificateDer::pem_slice_iter(self.ca_pem.as_bytes())
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ensure!(!certs.is_empty(), "RELAY_CA_INVALID");
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub access: Access,
    pub central_id: String,
}
impl Target {
    pub fn validate(&self) -> Result<()> {
        self.access.validate()?;
        self.central_id.parse::<EndpointId>()?;
        Ok(())
    }
}

pub async fn endpoint(access: &Access, seed: Option<[u8; 32]>) -> Result<Endpoint> {
    access.validate()?;
    let url: iroh::RelayUrl = access.url.parse()?;
    let map = RelayMap::from_iter([url]).with_auth_token(access.token.clone());
    let mut builder = Endpoint::builder(presets::Minimal)
        .alpns(vec![ALPN.to_vec()])
        .clear_ip_transports()
        .relay_mode(RelayMode::Custom(map));
    if let Some(seed) = seed {
        builder = builder.secret_key(SecretKey::from_bytes(&seed));
    }
    if !access.ca_pem.is_empty() {
        let roots = CertificateDer::pem_slice_iter(access.ca_pem.as_bytes())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        builder = builder.ca_tls_config(CaTlsConfig::custom_roots(roots));
    }
    Ok(builder.bind().await?)
}

/// One endpoint per owning client session; iroh reconnects the relay, never replays application bytes.
pub struct Client {
    endpoint: Endpoint,
    peer: EndpointAddr,
}
impl Client {
    pub async fn new(target: &Target) -> Result<Self> {
        target.validate()?;
        let endpoint = endpoint(&target.access, None).await?;
        let peer = EndpointAddr::new(target.central_id.parse()?)
            .with_relay_url(target.access.url.parse()?);
        Ok(Self { endpoint, peer })
    }
    pub async fn stream(&self) -> Result<crate::PeerStream> {
        let connection = timeout(CONNECT, self.endpoint.connect(self.peer.clone(), ALPN)).await??;
        crate::authorize_peer(&connection, self.peer.id)?;
        let (send, recv) = timeout(CONNECT, connection.open_bi()).await??;
        Ok(crate::PeerStream::new(send, recv).retain_connection(connection))
    }
}
fn close_endpoint(endpoint: Endpoint) {
    // QUIC needs an explicit close notification: dropping sockets alone makes the
    // peer wait for an idle timeout. Owner tasks are already stopped before this.
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        runtime.spawn(async move {
            let _ = timeout(Duration::from_secs(5), endpoint.close()).await;
        });
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        close_endpoint(self.endpoint.clone());
    }
}

/// Accepts opaque TLS streams and forwards only to the locally configured central gateway.
/// Inner TLS and device-token checks remain mandatory, including pairing and revocation.
pub struct Host {
    task: JoinHandle<()>,
    endpoint: Endpoint,
}
impl Host {
    pub async fn start(access: &Access, seed: [u8; 32], gateway: SocketAddr) -> Result<Self> {
        ensure!(!gateway.ip().is_unspecified(), "RELAY_TARGET_NOT_LOCAL");
        if !gateway.ip().is_loopback() {
            // Existing deployments may bind one local LAN interface instead of 0.0.0.0.
            // Binding an ephemeral local socket proves ownership without a remote proxy target.
            let socket = if gateway.is_ipv4() {
                TcpSocket::new_v4()?
            } else {
                TcpSocket::new_v6()?
            };
            socket
                .bind(SocketAddr::new(gateway.ip(), 0))
                .map_err(|_| anyhow::anyhow!("RELAY_TARGET_NOT_LOCAL"))?;
        }
        let endpoint = endpoint(access, Some(seed)).await?;
        timeout(CONNECT, endpoint.online()).await?;
        let ep = endpoint.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    incoming=ep.accept()=>{
                        let Some(incoming)=incoming else { break };
                        connections.spawn(async move {
                            let Ok(Ok(connection))=timeout(CONNECT,incoming).await else { return };
                            let mut streams=JoinSet::new();
                            loop {
                                tokio::select! {
                                    accepted=connection.accept_bi()=>{
                                        let Ok((send,recv))=accepted else { break };
                                        streams.spawn(async move {
                                            let Ok(Ok(mut tcp))=timeout(CONNECT,TcpStream::connect(gateway)).await else { return };
                                            let mut peer=crate::PeerStream::new(send,recv);
                                            let _=copy_bidirectional(&mut peer,&mut tcp).await;
                                        });
                                    }
                                    _=streams.join_next(), if !streams.is_empty()=>{}
                                }
                            }
                        });
                    }
                    _=connections.join_next(), if !connections.is_empty()=>{}
                }
            }
        });
        Ok(Self { task, endpoint })
    }
    pub fn central_id(&self) -> String {
        self.endpoint.id().to_string()
    }
    pub fn online(&self) -> bool {
        self.endpoint
            .home_relay_status()
            .get()
            .iter()
            .any(|s| s.is_connected())
            && !self.task.is_finished()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
        close_endpoint(self.endpoint.clone());
    }
}
