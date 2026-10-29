// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Real TLS + authenticated relay + product pairing/storage/HTTP/WSS adapters, all on ephemeral loopback ports.
#[path = "../../peer-transport/tests/support/relay.rs"]
#[allow(dead_code)]
mod fixture;
use futures_util::{SinkExt, StreamExt};
use peer_transport::relay::{Access, Host, Target, new_seed};
use platform_security::{device_token, pairing_bundle::Bundle};
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinSet,
    time::timeout,
};
use tokio_tungstenite::tungstenite::Message;
const TOKEN: &str = "synthetic-relay-admission-0123456789abcdef";
const DEVICE: &str =
    "ydt1.synthetic-device-token-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

#[tokio::test]
async fn pairing_storage_http_wss_and_revocation_keep_inner_tls() -> anyhow::Result<()> {
    exercise(false, false).await
}

#[tokio::test]
#[ignore = "requires RELAY_LOCAL_AGENT_EXE pointing to the freshly built Local Agent"]
async fn real_agent_tools_and_restart_through_relay() -> anyhow::Result<()> {
    exercise(true, false).await
}

#[tokio::test]
async fn unified_pairing_upgrades_existing_identity_and_selects_lan_relay_lan() -> anyhow::Result<()>
{
    exercise(false, true).await
}

async fn exercise(with_agent: bool, automatic: bool) -> anyhow::Result<()> {
    let relay = fixture::LocalRelay::authenticated(TOKEN).await?;
    let access = Access {
        url: relay.url.to_string(),
        ca_pem: relay.certificate_pem.clone(),
        token: TOKEN.into(),
    };
    let cert =
        rcgen::generate_simple_self_signed(vec!["central.example".into(), "127.0.0.1".into()])?;
    let pem = cert.cert.pem();
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.cert.der().clone()],
        PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
    )?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let lan = TcpListener::bind("127.0.0.1:0").await?;
    let lan_address = lan.local_addr()?;
    let lan_enabled = Arc::new(AtomicBool::new(true));
    let enabled = lan_enabled.clone();
    let forwarding = tokio::spawn(async move {
        while let Ok((mut incoming, _)) = lan.accept().await {
            if !enabled.load(Ordering::SeqCst) {
                continue;
            }
            tokio::spawn(async move {
                if let Ok(mut backend) = tokio::net::TcpStream::connect(address).await {
                    let _ = tokio::io::copy_bidirectional(&mut incoming, &mut backend).await;
                }
            });
        }
    });
    let connection = Arc::new(std::sync::Mutex::new(serde_json::Value::Null));
    let shared_connection = connection.clone();
    let pairs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server_pairs = pairs.clone();
    let revoked = Arc::new(AtomicBool::new(false));
    let state = revoked.clone();
    let (agents, mut incoming_agents) = tokio::sync::mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let accept = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let mut tasks = JoinSet::new();
        loop {
            tokio::select! {
                accepted=listener.accept()=>{let Ok((tcp,_))=accepted else {break};let accept=accept.clone();let state=state.clone();let agents=agents.clone();let connection=shared_connection.clone();let pairs=server_pairs.clone();
                    tasks.spawn(async move{
                        let Ok(tls)=accept.accept(tcp).await else{return};let mut io=BufReader::new(tls);
                        let Ok(prefix)=io.fill_buf().await else{return};
                        if prefix.starts_with(b"GET /ws"){
                            let is_agent=prefix.starts_with(b"GET /ws/agent");
                            let result=tokio_tungstenite::accept_hdr_async(io,move|request:&tokio_tungstenite::tungstenite::handshake::server::Request,response:tokio_tungstenite::tungstenite::handshake::server::Response|{
                                if state.load(Ordering::SeqCst)||request.headers().get("authorization").and_then(|v|v.to_str().ok())!=Some(format!("Bearer {DEVICE}").as_str()){
                                    let mut error=tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(None);*error.status_mut()=tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
                                    error.headers_mut().insert("X-Yuan-Auth-Error","DEVICE_REVOKED".parse().unwrap());Err(error)
                                }else{Ok(response)}
                            }).await;
                            if let Ok(mut ws)=result{if is_agent{let _=agents.send(ws);return;}while let Some(Ok(message))=ws.next().await{if message.is_close(){break}if ws.send(message).await.is_err(){break}}}return;
                        }
                        let mut first=String::new();if io.read_line(&mut first).await.is_err(){return};let mut length=0;let mut authorized=false;
                        loop{let mut line=String::new();if io.read_line(&mut line).await.unwrap_or(0)==0{return};if line=="\r\n"{break}
                            if let Some(v)=line.to_ascii_lowercase().strip_prefix("content-length:"){length=v.trim().parse().unwrap_or(0)}
                            if line.trim().eq_ignore_ascii_case(&format!("authorization: Bearer {DEVICE}")){authorized=true}
                        }
                        let mut body=vec![0;length];if io.read_exact(&mut body).await.is_err(){return}
                        let identity=json!({"authMode":"device-token-v1","deviceId":"test-device","deviceKey":"a".repeat(64),"user":{"id":"test-user","username":"test"}});
                        let response=if first.starts_with("POST /auth/device/pair "){
                            pairs.fetch_add(1,Ordering::SeqCst);let input:serde_json::Value=serde_json::from_slice(&body).unwrap();assert_eq!(input["code"],"p".repeat(40));
                            let mut data=identity;data["deviceToken"]=DEVICE.into();json!({"ok":true,"data":data})
                        }else if first.starts_with("POST /transport/config ")&&authorized&&!state.load(Ordering::SeqCst){json!({"ok":true,"data":{"protocol":"yuan-connection/v1","deviceId":"test-device","deviceKey":"a".repeat(64),"userId":"test-user","relay":connection.lock().unwrap().clone()}})}else if authorized&&!state.load(Ordering::SeqCst){json!({"ok":true,"data":identity})}else{json!({"ok":false,"error":"DEVICE_REVOKED"})};
                        let body=response.to_string();let header=format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                        let _=io.write_all(header.as_bytes()).await;let _=io.write_all(body.as_bytes()).await;let _=io.shutdown().await;
                    });
                }
                _=tasks.join_next(),if !tasks.is_empty()=>{}
            }
        }
    });
    let seed = new_seed();
    let mut host = Some(Host::start(&access, seed, address).await?);
    let target = Target {
        access,
        central_id: host.as_ref().unwrap().central_id(),
    };
    *connection.lock().unwrap() = serde_json::to_value(&target)?;
    let gateway = if automatic {
        format!("wss://127.0.0.1:{}/ws", lan_address.port())
    } else {
        format!("wss://central.example:{}/ws", address.port())
    };
    let mut bundle = Bundle::new(
        gateway.clone(),
        pem,
        "p".repeat(40),
        platform_security::now() + 240_000,
    )
    .map_err(anyhow::Error::msg)?;
    if !automatic {
        bundle.relay = Some(target.clone());
    }
    let bundle = Bundle::decode(&bundle.encode().map_err(anyhow::Error::msg)?)
        .map_err(anyhow::Error::msg)?;
    let app_directory = tempfile::tempdir()?;
    // macOS /var is a symlink. Give the credential store the real test directory,
    // retaining its production rule against symlinked credential ancestors.
    let app = app_directory.path().canonicalize()?;
    let namespace = "com.yuanzhou.relay-test";
    let credential = timeout(
        Duration::from_secs(30),
        device_token::pair_bundle(&app, namespace, &bundle, "test"),
    )
    .await?
    .map_err(anyhow::Error::msg)?;
    if automatic {
        assert!(credential.relay.is_none());
        assert!(
            device_token::sync_connection(&app, namespace, &gateway, "")
                .await
                .map_err(anyhow::Error::msg)?
        );
        assert!(
            !device_token::sync_connection(&app, namespace, &gateway, "")
                .await
                .map_err(anyhow::Error::msg)?
        );
    }
    let stored = device_token::load(&app, namespace, &gateway).map_err(anyhow::Error::msg)?;
    assert_eq!(stored.relay.as_ref().unwrap().central_id, target.central_id);
    assert_eq!(stored.device_id, credential.device_id);
    assert_eq!(stored.device_key, credential.device_key);
    assert_eq!(stored.user.id, credential.user.id);
    assert_eq!(stored.bearer(), credential.bearer());
    assert_eq!(
        pairs.load(Ordering::SeqCst),
        1,
        "routing upgrade must not pair again"
    );
    let ca = device_token::bundled_ca_path(&app, namespace, &gateway)
        .map_err(anyhow::Error::msg)?
        .unwrap();
    let ca = ca.to_str().unwrap();
    assert_eq!(
        device_token::status(&app, namespace, &gateway, ca).await["status"],
        "active"
    );
    // The updater uses reqwest 0.13, while pairing uses 0.12. Exercise both against
    // an authority that cannot resolve directly, preserving the inner TLS name.
    let update_route = platform_security::relay::HttpRoute::new(&gateway, stored.relay.as_ref())
        .await
        .map_err(anyhow::Error::msg)?;
    let updater = reqwest_updater::Client::builder()
        .no_proxy()
        .proxy(reqwest_updater::Proxy::https(
            update_route.proxy_url().unwrap(),
        )?)
        .use_preconfigured_tls(
            platform_security::central_tls_config(ca).map_err(anyhow::Error::msg)?,
        )
        .https_only(true)
        .redirect(reqwest_updater::redirect::Policy::none())
        .build()?;
    let update = updater
        .get(format!(
            "{}/client-updates/latest.json",
            platform_security::origin(&gateway).unwrap()
        ))
        .bearer_auth(stored.bearer())
        .send()
        .await?;
    assert!(update.status().is_success());
    assert!(update.text().await?.contains("test-device"));
    if automatic {
        *connection.lock().unwrap() = json!({"invalid":"route"});
        assert!(
            device_token::sync_connection(&app, namespace, &gateway, ca)
                .await
                .is_err()
        );
        assert_eq!(
            device_token::load(&app, namespace, &gateway)
                .unwrap()
                .bearer(),
            stored.bearer()
        );
        assert_eq!(
            device_token::load(&app, namespace, &gateway)
                .unwrap()
                .relay
                .as_ref()
                .unwrap()
                .central_id,
            target.central_id
        );
        *connection.lock().unwrap() = serde_json::Value::Null;
        assert!(
            device_token::sync_connection(&app, namespace, &gateway, ca)
                .await
                .unwrap()
        );
        let lan_only = device_token::load(&app, namespace, &gateway).unwrap();
        assert!(lan_only.relay.is_none());
        assert_eq!(lan_only.device_id, stored.device_id);
        *connection.lock().unwrap() = serde_json::to_value(&target)?;
        assert!(
            device_token::sync_connection(&app, namespace, &gateway, ca)
                .await
                .unwrap()
        );
        // Reuse the same HTTP adapter across networks, as the updater does.
        let persistent = stored
            .http(&gateway, ca)
            .await
            .map_err(anyhow::Error::msg)?;
        for (available, expected) in [(true, "lan"), (false, "relay"), (true, "lan")] {
            lan_enabled.store(available, Ordering::SeqCst);
            let response = persistent
                .get(platform_security::origin(&gateway).unwrap())
                .bearer_auth(stored.bearer())
                .send()
                .await?;
            assert!(response.status().is_success());
            assert!(response.text().await?.contains("test-device"));
            let mut connection = stored
                .socket(&gateway, ca)
                .await
                .map_err(anyhow::Error::msg)?;
            assert_eq!(stored.public()["connectionMode"], expected);
            connection
                .send(Message::Text("same-existing-conversation".into()))
                .await?;
            assert_eq!(
                connection.next().await.unwrap()?.into_text()?,
                "same-existing-conversation"
            );
            assert_eq!(
                device_token::status(&app, namespace, &gateway, ca).await["status"],
                "active"
            );
            connection.close(None).await?;
            let route = platform_security::relay::HttpRoute::automatic(
                &gateway,
                stored.relay.as_ref(),
                platform_security::central_tls_config(ca).map_err(anyhow::Error::msg)?,
            )
            .await
            .map_err(anyhow::Error::msg)?;
            assert!(route.proxy_url().is_some());
        }
        // LAN must remain independent of relay availability/credentials.
        let mut unavailable = Bundle::new(
            gateway.clone(),
            bundle.ca_pem.clone(),
            "p".repeat(40),
            platform_security::now() + 240_000,
        )
        .map_err(anyhow::Error::msg)?;
        let mut denied = target.clone();
        denied.access.token = "incorrect-relay-token-0123456789abcdef".into();
        unavailable.relay = Some(denied);
        // Use the already-paired identity for this route check; no extra pairing.
        let tls = platform_security::central_tls_config(ca).map_err(anyhow::Error::msg)?;
        let route = platform_security::relay::HttpRoute::automatic(
            &gateway,
            unavailable.relay.as_ref(),
            tls,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let client = platform_security::relay::HttpClient::automatic(
            &gateway,
            unavailable.relay.as_ref(),
            platform_security::central_tls_config(ca).map_err(anyhow::Error::msg)?,
        )
        .await
        .map_err(anyhow::Error::msg)?;
        assert!(
            client
                .get(platform_security::origin(&gateway).unwrap())
                .bearer_auth(stored.bearer())
                .send()
                .await?
                .status()
                .is_success()
        );
        drop(route);
    }
    let mut ws = stored
        .socket(&gateway, ca)
        .await
        .map_err(anyhow::Error::msg)?;
    let data = vec![0xa7; 8 * 1024 * 1024 + 17];
    ws.send(Message::Binary(data.clone().into())).await?;
    let echoed = timeout(Duration::from_secs(20), ws.next())
        .await?
        .unwrap()?;
    assert_eq!(echoed.into_data().as_ref(), data);
    ws.close(None).await?;
    if with_agent {
        let executable =
            std::env::var_os("RELAY_LOCAL_AGENT_EXE").expect("fresh Local Agent binary required");
        let workspace = tempfile::tempdir()?;
        let proof = format!("client-only-{}", platform_security::now());
        std::fs::write(workspace.path().join("proof.txt"), &proof)?;
        let mut command = tokio::process::Command::new(executable);
        command.args([
            "--workspace-root",
            workspace.path().to_str().unwrap(),
            "--gateway-url",
            &format!("{}/agent?deviceId=test-device", gateway),
        ]);
        command
            .env("YUAN_PLATFORM_DATA_DIR", &app)
            .env("YUAN_PLATFORM_NAMESPACE", namespace)
            .env("YUAN_PLATFORM_CA", ca);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        for round in 0..2 {
            let mut agent = timeout(Duration::from_secs(45), incoming_agents.recv())
                .await?
                .ok_or_else(|| anyhow::anyhow!("agent did not connect"))?;
            let hello = timeout(Duration::from_secs(10), async {
                loop {
                    let m = agent.next().await.unwrap().unwrap();
                    if m.is_text() {
                        let v: serde_json::Value =
                            serde_json::from_str(m.to_text().unwrap()).unwrap();
                        if v["type"] == "agent.hello" {
                            break v;
                        }
                    }
                }
            })
            .await?;
            assert_eq!(hello["payload"]["agent"]["deviceKey"], "a".repeat(64));
            agent.send(Message::Text(json!({"protocol":"agentrpc","version":1,"type":"agent.request","requestId":"read-proof","payload":{"method":"read_file","params":{"path":"proof.txt"}}}).to_string().into())).await?;
            let response = timeout(Duration::from_secs(15), async {
                loop {
                    let m = agent.next().await.unwrap().unwrap();
                    if m.is_text() {
                        let v: serde_json::Value =
                            serde_json::from_str(m.to_text().unwrap()).unwrap();
                        if v["type"] == "agent.response" {
                            break v;
                        }
                    }
                }
            })
            .await?;
            assert_eq!(response["payload"]["ok"], true, "{response}");
            assert_eq!(response["payload"]["result"]["content"], proof);
            let (program, args) = if cfg!(windows) {
                (
                    "powershell",
                    vec![
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Get-Content -LiteralPath proof.txt",
                    ],
                )
            } else {
                ("cat", vec!["proof.txt"])
            };
            agent.send(Message::Text(json!({"protocol":"agentrpc","version":1,"type":"agent.request","requestId":"exec-proof","payload":{"method":"exec","params":{"program":program,"args":args,"cwd":"."}}}).to_string().into())).await?;
            let response = timeout(Duration::from_secs(20), async {
                loop {
                    let m = agent.next().await.unwrap().unwrap();
                    if m.is_text() {
                        let v: serde_json::Value =
                            serde_json::from_str(m.to_text().unwrap()).unwrap();
                        if v["type"] == "agent.response" {
                            break v;
                        }
                    }
                }
            })
            .await?;
            assert_eq!(response["payload"]["ok"], true, "{response}");
            assert_eq!(response["payload"]["result"]["exitCode"], 0, "{response}");
            assert!(
                response["payload"]["result"]["stdout"]
                    .as_str()
                    .unwrap()
                    .contains(&proof)
            );
            if round == 0 {
                // Stop the owning forwarder, then restore the same pinned central identity.
                drop(host.take());
                timeout(Duration::from_secs(5), async {
                    while let Some(Ok(message)) = agent.next().await {
                        if message.is_close() {
                            break;
                        }
                    }
                })
                .await?;
                drop(agent);
                host = Some(Host::start(&target.access, seed, address).await?);
                assert_eq!(host.as_ref().unwrap().central_id(), target.central_id);
            }
        }
        child.kill().await?;
        child.wait().await?;
    }
    // Original hostname validation survives both the relay and local CONNECT adapter.
    let wrong = gateway.replace(
        if automatic {
            "127.0.0.1"
        } else {
            "central.example"
        },
        "wrong.example",
    );
    assert!(stored.socket(&wrong, ca).await.is_err());
    let wrong_http = stored.http(&wrong, ca).await.map_err(anyhow::Error::msg)?;
    assert!(
        wrong_http
            .get(platform_security::origin(&wrong).unwrap())
            .send()
            .await
            .is_err()
    );
    revoked.store(true, Ordering::SeqCst);
    assert_eq!(
        device_token::status(&app, namespace, &gateway, ca).await["status"],
        "revoked"
    );
    assert!(matches!(stored.socket(&gateway,ca).await,Err(e)if e=="DEVICE_REVOKED"));
    let disconnected = device_token::disconnect(&app, namespace, &gateway, ca)
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(disconnected["localRemoved"], true);
    assert!(device_token::load(&app, namespace, &gateway).is_err());
    drop(host);
    server.abort();
    forwarding.abort();
    relay.server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn relay_rejects_wrong_admission_and_remote_forward_targets() -> anyhow::Result<()> {
    let relay = fixture::LocalRelay::authenticated(TOKEN).await?;
    let access = Access {
        url: relay.url.to_string(),
        ca_pem: relay.certificate_pem.clone(),
        token: "incorrect-admission-0123456789abcdef".into(),
    };
    let mut mixed = access.clone();
    mixed
        .ca_pem
        .push_str("\n-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n");
    assert!(
        mixed.validate().is_err(),
        "pairing must never carry private PEM blocks"
    );
    let endpoint = peer_transport::relay::endpoint(&access, None).await?;
    assert!(
        timeout(Duration::from_secs(3), endpoint.online())
            .await
            .is_err()
    );
    endpoint.close().await;
    assert!(
        Host::start(&access, new_seed(), "192.0.2.1:4510".parse()?)
            .await
            .is_err()
    );
    relay.server.shutdown().await?;
    Ok(())
}
