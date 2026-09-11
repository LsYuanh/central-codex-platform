// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Developer-only NDJSON relay. Bearer authentication stays inside this process.
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Read},
    path::PathBuf,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::mpsc, time};
use tokio_tungstenite::tungstenite::Message;

const GATEWAY: &str = "wss://192.0.2.10:4529/ws";
const MAX_LINE: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    namespace: String,
    gateway: String,
    ca: String,
    #[serde(rename = "token-root")]
    directory: PathBuf,
}

fn input_lines() -> mpsc::Receiver<Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel(8);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let mut first = true;
        loop {
            let limit = if first { 16 * 1024 } else { MAX_LINE };
            let mut line = Vec::new();
            let read = (&mut reader)
                .take(limit as u64 + 1)
                .read_until(b'\n', &mut line);
            match read {
                Ok(0) => break,
                Ok(_) if line.len() <= limit && line.last() == Some(&b'\n') => {
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if sender.blocking_send(Ok(line)).is_err() {
                        break;
                    }
                }
                _ => {
                    let _ = sender.blocking_send(Err("TOKEN_SOCKET_QA_INPUT_LIMIT_OR_INVALID"));
                    break;
                }
            }
            first = false;
        }
    });
    receiver
}

async fn emit(value: &Value, token: &str) -> Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "TOKEN_SOCKET_QA_OUTPUT_INVALID")?;
    if bytes.len() > MAX_LINE || String::from_utf8_lossy(&bytes).contains(token) {
        return Err("TOKEN_SOCKET_QA_OUTPUT_REJECTED");
    }
    bytes.push(b'\n');
    time::timeout(Duration::from_secs(10), async {
        let mut stdout = tokio::io::stdout();
        stdout.write_all(&bytes).await?;
        stdout.flush().await
    })
    .await
    .map_err(|_| "TOKEN_SOCKET_QA_OUTPUT_TIMEOUT")?
    .map_err(|_| "TOKEN_SOCKET_QA_OUTPUT_CLOSED")
}

async fn run() -> Result<()> {
    let mut input = input_lines();
    let first = time::timeout(Duration::from_secs(15), input.recv())
        .await
        .map_err(|_| "TOKEN_SOCKET_QA_SETUP_TIMEOUT")?
        .ok_or("TOKEN_SOCKET_QA_SETUP_REQUIRED")??;
    let config: Config =
        serde_json::from_slice(&first).map_err(|_| "TOKEN_SOCKET_QA_SETUP_INVALID")?;
    if config.gateway != GATEWAY
        || !config.namespace.starts_with("com.centralcodex.harnessqa")
        || config.namespace.len() > 128
        || !config.directory.is_absolute()
        || config.ca.is_empty()
        || !PathBuf::from(&config.ca).is_absolute()
    {
        return Err("TOKEN_SOCKET_QA_SCOPE_REJECTED");
    }
    let credential =
        platform_security::device_token::load(&config.directory, &config.namespace, GATEWAY)
            .map_err(|_| "TOKEN_SOCKET_QA_LOCAL_IDENTITY_UNAVAILABLE")?;
    let mut socket = platform_security::socket(GATEWAY, &config.ca, credential.bearer())
        .await
        .map_err(|_| "TOKEN_SOCKET_QA_CONNECT_FAILED")?;
    emit(&json!({"type":"qa.relay.ready","authMode":"device-token-v1","deviceId":credential.device_id,"deviceKey":credential.device_key,"userId":credential.user.id}), credential.bearer()).await?;
    let deadline = time::sleep(Duration::from_secs(600));
    tokio::pin!(deadline);
    let result: Result<()> = loop {
        tokio::select! {
            _ = &mut deadline => break Err("TOKEN_SOCKET_QA_TOTAL_TIMEOUT"),
            outgoing = input.recv() => {
                let Some(outgoing) = outgoing else { break Ok(()); };
                let outgoing = match outgoing { Ok(value) => value, Err(error) => break Err(error) };
                let value: Value = match serde_json::from_slice(&outgoing) { Ok(value) => value, Err(_) => break Err("TOKEN_SOCKET_QA_REQUEST_INVALID") };
                if !matches!(value["type"].as_str(), Some("request" | "approval.response")) {
                    break Err("TOKEN_SOCKET_QA_REQUEST_REJECTED");
                }
                let sent = time::timeout(Duration::from_secs(10), socket.send(Message::Text(value.to_string().into()))).await;
                if !matches!(sent, Ok(Ok(()))) { break Err("TOKEN_SOCKET_QA_SEND_FAILED"); }
            }
            incoming = time::timeout(Duration::from_secs(120), socket.next()) => {
                let incoming = match incoming { Ok(Some(Ok(value))) => value, Ok(None) => break Ok(()), _ => break Err("TOKEN_SOCKET_QA_RECEIVE_FAILED") };
                match incoming {
                    Message::Text(text) => {
                        if text.len() > MAX_LINE { break Err("TOKEN_SOCKET_QA_FRAME_LIMIT"); }
                        let value: Value = match serde_json::from_str(text.as_str()) { Ok(value) => value, Err(_) => break Err("TOKEN_SOCKET_QA_FRAME_INVALID") };
                        if let Err(error) = emit(&value, credential.bearer()).await { break Err(error); }
                    }
                    Message::Ping(bytes) => {
                        if !matches!(time::timeout(Duration::from_secs(10), socket.send(Message::Pong(bytes))).await, Ok(Ok(()))) { break Err("TOKEN_SOCKET_QA_PONG_FAILED"); }
                    }
                    Message::Close(_) => break Ok(()),
                    Message::Binary(_) => break Err("TOKEN_SOCKET_QA_BINARY_REJECTED"),
                    _ => {}
                }
            }
        }
    };
    let _ = time::timeout(Duration::from_secs(2), socket.close(None)).await;
    result
}

#[tokio::main]
async fn main() {
    if let Err(code) = run().await {
        eprintln!("{code}");
        std::process::exit(1);
    }
}
