// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Phase-one transport verification. Not yet wired into either desktop application.

use std::{
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use anyhow::{Result, bail};
use futures_util::StreamExt;
use iroh::{Endpoint, EndpointAddr, EndpointId, endpoint::Connection};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, timeout};

pub const PROBE_ALPN: &[u8] = b"yuan-zhou/peer-transport-probe/2";

/// Adapt one authenticated QUIC stream for the existing TLS/HTTP/WebSocket stack.
/// This carries bytes only: it never interprets or executes a device command.
pub struct PeerStream {
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
}

impl PeerStream {
    pub fn new(send: iroh::endpoint::SendStream, recv: iroh::endpoint::RecvStream) -> Self {
        Self { send, recv }
    }
}

impl AsyncRead for PeerStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.recv).poll_read(cx, buf)
    }
}

impl AsyncWrite for PeerStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        AsyncWrite::poll_write(Pin::new(&mut self.send), cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        AsyncWrite::poll_flush(Pin::new(&mut self.send), cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        AsyncWrite::poll_shutdown(Pin::new(&mut self.send), cx)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Direct,
    Relay,
    Unavailable,
}

/// Inspect the selected path, rather than mistaking a configured relay for active relay use.
pub fn selected_route(connection: &Connection) -> Route {
    let paths = connection.paths();
    match paths.iter().find(|path| path.is_selected()) {
        Some(path) if path.is_ip() => Route::Direct,
        Some(path) if path.is_relay() => Route::Relay,
        _ => Route::Unavailable,
    }
}

/// The trusted identity must come from pairing, independently of discovered addresses.
/// These durations bound connection establishment only, never business execution or byte counts.
pub async fn connect_prefer_direct(
    endpoint: &Endpoint,
    address: EndpointAddr,
    trusted_peer: EndpointId,
    handshake_timeout: Duration,
    direct_grace: Duration,
) -> Result<Connection> {
    if address.id != trusted_peer {
        bail!("PEER_IDENTITY_MISMATCH");
    }
    let connection = timeout(handshake_timeout, endpoint.connect(address, PROBE_ALPN))
        .await
        .map_err(|_| anyhow::anyhow!("PEER_CONNECT_TIMEOUT"))??;
    authorize_peer(&connection, trusted_peer)?;

    // Iroh may exchange handshake/path-discovery packets over the relay. Keep application
    // streams unopened while giving the direct path a chance; there is no request replay.
    let deadline = Instant::now() + direct_grace;
    let mut paths = connection.paths_stream();
    loop {
        if selected_route(&connection) == Route::Direct {
            return Ok(connection.clone());
        }
        tokio::select! {
            _ = connection.closed() => bail!("PEER_CONNECTION_CLOSED"),
            _ = tokio::time::sleep_until(deadline) => {
                if selected_route(&connection) == Route::Unavailable {
                    bail!("PEER_PATH_UNAVAILABLE");
                }
                return Ok(connection.clone());
            }
            next = paths.next() => {
                if next.is_none() { bail!("PEER_CONNECTION_CLOSED"); }
            }
        }
    }
}

/// Transport encryption authenticates a key; authorization still has to bind that key
/// to an invited device. A successful QUIC handshake alone grants no business access.
pub fn authorize_peer(connection: &Connection, trusted_peer: EndpointId) -> Result<()> {
    if connection.remote_id() != trusted_peer {
        connection.close(1u32.into(), b"PEER_NOT_AUTHORIZED");
        bail!("PEER_NOT_AUTHORIZED");
    }
    Ok(())
}
