// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Real QUIC/TLS/relay sockets on loopback, not a WAN/NAT or production gateway acceptance.

use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use iroh::{
    Endpoint, EndpointAddr, RelayMode, SecretKey,
    endpoint::{Connection, presets},
    tls::CaTlsConfig,
};
use iroh_relay::server::{CertConfig, RelayConfig, Server, ServerConfig, TlsConfig};
use peer_transport::{
    PROBE_ALPN, PeerStream, Route, authorize_peer, connect_prefer_direct, selected_route,
};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use tokio::time::timeout;

const HANDSHAKE: Duration = Duration::from_secs(8);
const DIRECT_GRACE: Duration = Duration::from_millis(500);
// Test deadline/sample size only. Neither value is a transport or product quota.
const CASE_DEADLINE: Duration = Duration::from_secs(40);
const SAMPLE_BYTES: u64 = 8 * 1024 * 1024 + 17;

struct LocalRelay {
    server: Server,
    url: iroh::RelayUrl,
    certificate: CertificateDer<'static>,
}

impl LocalRelay {
    async fn start() -> Result<Self> {
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
        relay.tls = Some(TlsConfig::new(
            (Ipv4Addr::LOCALHOST, 0),
            CertConfig::Manual { server_config: tls },
        ));
        // No application throughput, total-byte or connection-count quota is configured.
        assert!(relay.limits.client_rx.is_none());
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        let server = Server::spawn(config).await?;
        let url = format!("https://{}", server.https_addr().unwrap()).parse()?;
        Ok(Self {
            server,
            url,
            certificate,
        })
    }

    async fn endpoint(&self, relay_only: bool, trust: bool) -> Result<Endpoint> {
        let mut builder = Endpoint::builder(presets::Minimal)
            .alpns(vec![PROBE_ALPN.to_vec()])
            .clear_ip_transports()
            .relay_mode(RelayMode::custom([self.url.clone()]));
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

async fn direct_endpoint() -> Result<Endpoint> {
    Ok(Endpoint::builder(presets::Minimal)
        .alpns(vec![PROBE_ALPN.to_vec()])
        .clear_ip_transports()
        .bind_addr((Ipv4Addr::LOCALHOST, 0))?
        .bind()
        .await?)
}

async fn connect(
    client: &Endpoint,
    server: &Endpoint,
    address: EndpointAddr,
) -> Result<(Connection, Connection)> {
    let accept = async {
        let incoming = server
            .accept()
            .await
            .ok_or_else(|| anyhow::anyhow!("accept closed"))?;
        let connection = incoming.await?;
        authorize_peer(&connection, client.id())?;
        Ok::<_, anyhow::Error>(connection)
    };
    let dial = connect_prefer_direct(client, address, server.id(), HANDSHAKE, DIRECT_GRACE);
    tokio::try_join!(dial, accept)
}

/// Full duplex streaming, fixed working buffer, no read-to-end allocation or total-size cap.
async fn round_trip(client: &Connection, server: &Connection, bytes: u64) -> Result<()> {
    let echo = async {
        let (mut send, mut recv) = server.accept_bi().await?;
        let copied = tokio::io::copy(&mut recv, &mut send).await?;
        send.finish()?;
        assert_eq!(copied, bytes);
        Ok::<_, anyhow::Error>(())
    };
    let exchange = async {
        let (mut send, mut recv) = client.open_bi().await?;
        let write = async {
            let buffer: Vec<u8> = (0..64 * 1024).map(|i| (i % 251) as u8).collect();
            let mut remaining = bytes;
            let mut hash = Sha256::new();
            while remaining > 0 {
                let count = remaining.min(buffer.len() as u64) as usize;
                send.write_all(&buffer[..count]).await?;
                hash.update(&buffer[..count]);
                remaining -= count as u64;
            }
            send.finish()?;
            Ok::<_, anyhow::Error>(hash.finalize())
        };
        let read = async {
            let mut buffer = vec![0; 64 * 1024];
            let mut received = 0u64;
            let mut hash = Sha256::new();
            while let Some(count) = recv.read(&mut buffer).await? {
                hash.update(&buffer[..count]);
                received += count as u64;
            }
            assert_eq!(received, bytes);
            Ok::<_, anyhow::Error>(hash.finalize())
        };
        let (written, received) = tokio::try_join!(write, read)?;
        assert_eq!(written, received);
        Ok::<_, anyhow::Error>(())
    };
    tokio::try_join!(echo, exchange)?;
    Ok(())
}

async fn close_pair(client: Endpoint, server: Endpoint) {
    tokio::join!(client.close(), server.close());
}

#[tokio::test]
async fn direct_duplex_streams_and_reconnect() -> Result<()> {
    timeout(CASE_DEADLINE, async {
        let client = direct_endpoint().await?;
        let server = direct_endpoint().await?;
        let (outgoing, incoming) = connect(&client, &server, server.addr()).await?;
        assert_eq!(selected_route(&outgoing), Route::Direct);
        // Sequential streams and a new transport connection never replay earlier bytes.
        round_trip(&outgoing, &incoming, SAMPLE_BYTES).await?;
        round_trip(&outgoing, &incoming, 31).await?;
        outgoing.close(0u32.into(), b"test reconnect");
        incoming.closed().await;
        let (outgoing, incoming) = connect(&client, &server, server.addr()).await?;
        round_trip(&outgoing, &incoming, 67).await?;
        close_pair(client, server).await;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test]
async fn no_direct_path_uses_authenticated_tls_relay() -> Result<()> {
    timeout(CASE_DEADLINE, async {
        let relay = LocalRelay::start().await?;
        // Removing UDP transports models a blocked direct path without changing OS firewall rules.
        let client = relay.endpoint(true, true).await?;
        let server = relay.endpoint(true, true).await?;
        timeout(HANDSHAKE, async {
            tokio::join!(client.online(), server.online());
        })
        .await?;
        let address = EndpointAddr::new(server.id()).with_relay_url(relay.url.clone());
        let (outgoing, incoming) = connect(&client, &server, address).await?;
        assert_eq!(selected_route(&outgoing), Route::Relay);
        let before = relay.server.metrics().server.bytes_sent.get();
        round_trip(&outgoing, &incoming, SAMPLE_BYTES).await?;
        assert!(relay.server.metrics().server.bytes_sent.get() - before >= SAMPLE_BYTES * 2);
        close_pair(client, server).await;
        relay.server.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test]
async fn direct_path_wins_with_relay_available() -> Result<()> {
    timeout(CASE_DEADLINE, async {
        let relay = LocalRelay::start().await?;
        let client = relay.endpoint(false, true).await?;
        let server = relay.endpoint(false, true).await?;
        timeout(HANDSHAKE, async {
            tokio::join!(client.online(), server.online());
        })
        .await?;
        let (outgoing, incoming) = connect(&client, &server, server.addr()).await?;
        assert_eq!(selected_route(&outgoing), Route::Direct);
        let before = relay.server.metrics().server.bytes_sent.get();
        round_trip(&outgoing, &incoming, SAMPLE_BYTES).await?;
        assert_eq!(selected_route(&outgoing), Route::Direct);
        // Control packets are allowed; the multi-megabyte payload must not cross the relay.
        assert!(relay.server.metrics().server.bytes_sent.get() - before < 64 * 1024);
        relay.server.shutdown().await?;
        round_trip(&outgoing, &incoming, 4097).await?;
        close_pair(client, server).await;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test]
async fn untrusted_relay_certificate_is_rejected() -> Result<()> {
    let relay = LocalRelay::start().await?;
    let endpoint = relay.endpoint(true, false).await?;
    // Failed relays need not appear in iroh's home-relay watcher. Verify the exact
    // CA configuration against the live server; timeout alone is not TLS evidence.
    let config = CaTlsConfig::embedded()
        .client_config(Arc::new(rustls::crypto::ring::default_provider()))?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let tcp = tokio::net::TcpStream::connect(relay.server.https_addr().unwrap()).await?;
    let error = timeout(HANDSHAKE, connector.connect("127.0.0.1".try_into()?, tcp))
        .await?
        .err()
        .expect("untrusted TLS certificate was accepted");
    assert!(matches!(
        error
            .get_ref()
            .and_then(|e| e.downcast_ref::<rustls::Error>()),
        Some(rustls::Error::InvalidCertificate(
            rustls::CertificateError::UnknownIssuer
        ))
    ));
    assert!(
        timeout(Duration::from_secs(1), endpoint.online())
            .await
            .is_err()
    );
    endpoint.close().await;
    relay.server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn wss_preserves_hostname_validation_over_relay() -> Result<()> {
    timeout(CASE_DEADLINE, async {
        let relay = LocalRelay::start().await?;
        let client = relay.endpoint(true, true).await?;
        let server = relay.endpoint(true, true).await?;
        timeout(HANDSHAKE, async {
            tokio::join!(client.online(), server.online());
        })
        .await?;
        let (outgoing, incoming) = connect(&client, &server, server.addr()).await?;
        let generated = rcgen::generate_simple_self_signed(vec!["central.probe.invalid".into()])?;
        let cert = generated.cert.der().clone();
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.clone()],
            PrivatePkcs8KeyDer::from(generated.signing_key.serialize_der()).into(),
        )?;
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert)?;
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let connector = tokio_tungstenite::Connector::Rustls(Arc::new(tls));
        let server_work = async {
            let (send, recv) = incoming.accept_bi().await?;
            let tls = acceptor.accept(PeerStream::new(send, recv)).await?;
            let mut socket = tokio_tungstenite::accept_async(tls).await?;
            let message = socket.next().await.unwrap()?;
            socket.send(message).await?;
            // A second stream with a wrong hostname must fail during TLS, before HTTP.
            let (send, recv) = incoming.accept_bi().await?;
            assert!(acceptor.accept(PeerStream::new(send, recv)).await.is_err());
            Ok::<_, anyhow::Error>(())
        };
        let client_work = async {
            let (send, recv) = outgoing.open_bi().await?;
            let (mut socket, _) = tokio_tungstenite::client_async_tls_with_config(
                "wss://central.probe.invalid/ws/agent",
                PeerStream::new(send, recv),
                None,
                Some(connector.clone()),
            )
            .await?;
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    "transport-probe-only".into(),
                ))
                .await?;
            assert_eq!(
                socket.next().await.unwrap()?.into_text()?,
                "transport-probe-only"
            );
            let (send, recv) = outgoing.open_bi().await?;
            let result = tokio_tungstenite::client_async_tls_with_config(
                "wss://wrong.probe.invalid/ws/agent",
                PeerStream::new(send, recv),
                None,
                Some(connector),
            )
            .await;
            let error = result.err().expect("wrong TLS name was accepted");
            assert!(format!("{error:?}").contains("NotValidForName"));
            Ok::<_, anyhow::Error>(())
        };
        tokio::try_join!(server_work, client_work)?;
        close_pair(client, server).await;
        relay.server.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test]
async fn discovered_identity_cannot_replace_paired_identity() -> Result<()> {
    let client = direct_endpoint().await?;
    let server = direct_endpoint().await?;
    let trusted = SecretKey::generate().public();
    let result =
        connect_prefer_direct(&client, server.addr(), trusted, HANDSHAKE, DIRECT_GRACE).await;
    assert_eq!(result.unwrap_err().to_string(), "PEER_IDENTITY_MISMATCH");
    close_pair(client, server).await;
    Ok(())
}

#[tokio::test]
async fn encrypted_but_uninvited_peer_gets_no_application_stream() -> Result<()> {
    timeout(CASE_DEADLINE, async {
        let client = direct_endpoint().await?;
        let server = direct_endpoint().await?;
        let (outgoing, incoming) = connect(&client, &server, server.addr()).await?;
        let allowed = SecretKey::generate().public();
        assert!(authorize_peer(&incoming, allowed).is_err());
        timeout(HANDSHAKE, outgoing.closed()).await?;
        assert!(outgoing.open_bi().await.is_err());
        close_pair(client, server).await;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}
