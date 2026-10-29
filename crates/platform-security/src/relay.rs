// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Preserve the original HTTPS/WSS authority and certificate checks over an opaque relay stream.
use peer_transport::relay::Client;
pub use peer_transport::relay::{Access, Target};
use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf, copy_bidirectional},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub struct NetworkStream {
    stream: Box<dyn Io>,
    _relay: Option<Client>,
}
impl NetworkStream {
    pub async fn connect(gateway: &str, target: Option<&Target>) -> Result<Self, String> {
        if let Some(target) = target {
            let client = Client::new(target)
                .await
                .map_err(|_| "RELAY_CONFIG_INVALID")?;
            let stream = client
                .stream()
                .await
                .map_err(|_| "RELAY_CONNECTION_FAILED")?;
            Ok(Self {
                stream: Box::new(stream),
                _relay: Some(client),
            })
        } else {
            let u = url::Url::parse(gateway).map_err(|_| "CENTRAL_CONNECTION_FAILED")?;
            let stream = timeout(
                Duration::from_secs(20),
                TcpStream::connect((
                    u.host_str().ok_or("CENTRAL_CONNECTION_FAILED")?,
                    u.port_or_known_default()
                        .ok_or("CENTRAL_CONNECTION_FAILED")?,
                )),
            )
            .await
            .map_err(|_| "CENTRAL_CONNECTION_TIMEOUT")?
            .map_err(|e| crate::transport::error_code(&e))?;
            Ok(Self {
                stream: Box::new(stream),
                _relay: None,
            })
        }
    }
}
impl AsyncRead for NetworkStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        b: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.stream).poll_read(cx, b)
    }
}
impl AsyncWrite for NetworkStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        b: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut *self.stream).poll_write(cx, b)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.stream).poll_shutdown(cx)
    }
}

/// Local CONNECT adapter for reqwest (including the updater's separate reqwest version).
/// It binds only loopback, accepts only the paired authority, and never terminates inner TLS.
pub struct HttpRoute {
    proxy: Option<String>,
    task: Option<JoinHandle<()>>,
}
impl Drop for HttpRoute {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
impl HttpRoute {
    pub async fn new(gateway: &str, target: Option<&Target>) -> Result<Self, String> {
        let Some(target) = target else {
            return Ok(Self {
                proxy: None,
                task: None,
            });
        };
        let u = url::Url::parse(&crate::origin(gateway)?).map_err(|_| "RELAY_CONFIG_INVALID")?;
        let host = u.host().ok_or("RELAY_CONFIG_INVALID")?;
        let authority = format!(
            "{}:{}",
            host,
            u.port_or_known_default().ok_or("RELAY_CONFIG_INVALID")?
        );
        let client = Arc::new(
            Client::new(target)
                .await
                .map_err(|_| "RELAY_CONFIG_INVALID")?,
        );
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "RELAY_LOCAL_BIND_FAILED")?;
        let proxy = format!(
            "http://{}",
            listener
                .local_addr()
                .map_err(|_| "RELAY_LOCAL_BIND_FAILED")?
        );
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let Ok((mut tcp,_))=accepted else {break};
                        let client=client.clone();let authority=authority.clone();
                        tasks.spawn(async move {
                            let established=timeout(Duration::from_secs(25),async {
                                let mut header=Vec::new();
                                while !header.ends_with(b"\r\n\r\n") {
                                    if header.len()>=8192 {return Err(())}
                                    header.push(tcp.read_u8().await.map_err(|_|())?);
                                }
                                let first=std::str::from_utf8(&header).map_err(|_|())?.split("\r\n").next().ok_or(())?;
                                if first!=format!("CONNECT {authority} HTTP/1.1") {return Err(())}
                                let peer=client.stream().await.map_err(|_|())?;
                                tcp.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.map_err(|_|())?;
                                Ok(peer)
                            }).await;
                            if let Ok(Ok(mut peer))=established {let _=copy_bidirectional(&mut tcp,&mut peer).await;}
                        });
                    }
                    _=tasks.join_next(),if !tasks.is_empty()=>{}
                }
            }
        });
        Ok(Self {
            proxy: Some(proxy),
            task: Some(task),
        })
    }
    pub fn proxy_url(&self) -> Option<&str> {
        self.proxy.as_deref()
    }
    pub fn configure(
        &self,
        builder: reqwest::ClientBuilder,
    ) -> Result<reqwest::ClientBuilder, String> {
        Ok(if let Some(proxy) = self.proxy_url() {
            builder.proxy(reqwest::Proxy::https(proxy).map_err(|_| "RELAY_CONFIG_INVALID")?)
        } else {
            builder
        })
    }
}

pub struct HttpClient {
    pub client: reqwest::Client,
    _route: HttpRoute,
}
impl std::ops::Deref for HttpClient {
    type Target = reqwest::Client;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}
impl HttpClient {
    pub async fn new(
        gateway: &str,
        target: Option<&Target>,
        builder: reqwest::ClientBuilder,
    ) -> Result<Self, String> {
        let route = HttpRoute::new(gateway, target).await?;
        let client = route
            .configure(builder)?
            .build()
            .map_err(|_| "CENTRAL_TLS_INIT_FAILED")?;
        Ok(Self {
            client,
            _route: route,
        })
    }
}
