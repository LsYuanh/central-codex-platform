// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

use std::{
    collections::HashMap,
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    process::Command,
    sync::{mpsc, watch},
    task::JoinSet,
    time,
};
use tokio_tungstenite::{connect_async_with_config, tungstenite::Message};
mod attachments;
mod command_output;
mod documents;
mod outputs;
mod process;
mod process_sessions;
mod runtime;
mod skills;
#[cfg(windows)]
mod windows_job;
mod workspace;

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

type AgentResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug)]
struct Config {
    workspace_root: PathBuf,
    gateway_url: String,
    allow_absolute: bool,
    attachment_stdio: bool,
    device_id: String,
    device_key: String,
}

#[derive(Debug, Deserialize)]
struct RequestEnvelope {
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    version: Option<u32>,
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    request: Option<LegacyAgentRequest>,
    #[serde(default)]
    payload: Option<Value>,
    #[serde(default, rename = "requestId", alias = "request_id")]
    request_id: Option<String>,
    #[serde(default, rename = "taskId", alias = "task_id")]
    task_id: Option<String>,
    #[serde(default, rename = "traceId", alias = "trace_id")]
    trace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LegacyAgentRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
struct AgentRequestPayload {
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug)]
struct AgentRequest {
    id: String,
    method: String,
    params: Value,
    task_id: Option<String>,
    trace_id: Option<String>,
}

impl RequestEnvelope {
    fn into_request(self) -> Result<AgentRequest, String> {
        if let Some(payload) = self.payload {
            let payload: AgentRequestPayload = serde_json::from_value(payload)
                .map_err(|error| format!("invalid agent.request payload: {error}"))?;
            let id = self
                .request_id
                .ok_or_else(|| "versioned agent.request is missing requestId".to_string())?;
            return Ok(AgentRequest {
                id,
                method: payload.method,
                params: payload.params,
                task_id: self.task_id,
                trace_id: self.trace_id,
            });
        }

        self.request
            .map(|request| AgentRequest {
                id: request.id,
                method: request.method,
                params: request.params,
                task_id: None,
                trace_id: None,
            })
            .ok_or_else(|| "agent.request is missing request or payload".to_string())
    }
}

#[tokio::main]
async fn main() -> AgentResult<()> {
    #[cfg(windows)]
    windows_job::install()?;
    let config = parse_args()?;
    eprintln!("Local Agent workspace: {}", config.workspace_root.display());
    let files = Arc::new(Mutex::new(attachments::Attachments::new(
        config.workspace_root.clone(),
        config.allow_absolute,
    )));
    files
        .lock()
        .unwrap()
        .set_identity(config.device_id.clone(), config.device_key.clone());
    let activity = Arc::new(runtime::Activity::default());
    if config.attachment_stdio {
        start_attachment_stdio(files.clone(), activity.clone());
    }

    loop {
        match run_connection(&config, &files, &activity).await {
            Ok(()) => eprintln!("Gateway connection closed; retrying"),
            Err(error) if platform_security::device_token::is_terminal(&error.to_string()) => {
                return Err(error);
            }
            Err(error) => eprintln!("Gateway connection failed: {error}; retrying"),
        }
        time::sleep(Duration::from_secs(2)).await;
    }
}

fn parse_args() -> AgentResult<Config> {
    let mut workspace_root: Option<PathBuf> = None;
    let mut gateway_url: Option<String> = None;
    let mut allow_insecure_lan = false;
    let mut attachment_stdio = false;
    let mut arguments = env::args().skip(1);

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--workspace-root" => workspace_root = arguments.next().map(PathBuf::from),
            "--gateway-url" => gateway_url = arguments.next(),
            "--allow-insecure-lan" => allow_insecure_lan = true,
            "--attachment-stdio" => attachment_stdio = true,
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }

    let workspace_root = workspace_root.ok_or("--workspace-root is required")?;
    let workspace_root = workspace_root.canonicalize()?;
    if !workspace_root.is_dir() {
        return Err("workspace root must be an existing directory".into());
    }

    let mut gateway_url = gateway_url.ok_or("--gateway-url is required")?;
    let device_key;
    let mut parsed = url::Url::parse(&gateway_url)?;
    let mut device_id = parsed
        .query_pairs()
        .find(|(key, _)| key == "deviceId")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| "default-device".into());
    if parsed.scheme() == "wss" {
        let namespace = env::var("YUAN_PLATFORM_NAMESPACE")
            .map_err(|_| "authenticated Agent requires desktop namespace")?;
        let credential = platform_security::device_token::load(
            &platform_security::device_token::directory_from_env()?,
            &namespace,
            &gateway_url,
        )?;
        if credential.device_id != device_id || credential.device_key.is_empty() {
            return Err("paired device identity mismatch".into());
        }
        device_key = credential.device_key.clone();
    } else {
        device_key = local_device_key()?;
    }
    // Migrate the shared desktop default to a persistent per-installation identity.
    // Explicit development device IDs retain their existing routing semantics.
    if attachment_stdio && device_id == "desktop-device" {
        device_id = format!("desktop-{device_key}");
        let pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .filter(|(key, _)| key != "deviceId")
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        parsed.set_query(None);
        parsed
            .query_pairs_mut()
            .extend_pairs(pairs)
            .append_pair("deviceId", &device_id);
        gateway_url = parsed.to_string();
    }
    let loopback =
        gateway_url.starts_with("ws://127.0.0.1:") || gateway_url.starts_with("ws://localhost:");
    if parsed.scheme() != "wss" && !loopback && !allow_insecure_lan {
        return Err("non-loopback ws:// gateway requires --allow-insecure-lan".into());
    }

    Ok(Config {
        workspace_root,
        gateway_url,
        // File access follows the client's OS account, independently of transport security.
        allow_absolute: true,
        attachment_stdio,
        device_id,
        device_key,
    })
}

async fn run_connection(
    config: &Config,
    files: &Arc<Mutex<attachments::Attachments>>,
    activity: &Arc<runtime::Activity>,
) -> AgentResult<()> {
    let socket = if config.gateway_url.starts_with("wss://") {
        platform_security::device_token::agent_socket(
            &platform_security::device_token::directory_from_env()?,
            &env::var("YUAN_PLATFORM_NAMESPACE")?,
            &config.gateway_url,
            &env::var("YUAN_PLATFORM_CA").unwrap_or_default(),
        )
        .await?
    } else {
        connect_async_with_config(
            &config.gateway_url,
            Some(
                tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(None)
                    .max_frame_size(None),
            ),
            false,
        )
        .await?
        .0
    };
    let (mut socket_writer, mut reader) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Value>();
    let mut writer = tokio::spawn(async move {
        while let Some(value) = outbound_rx.recv().await {
            socket_writer
                .send(Message::Text(value.to_string().into()))
                .await?;
        }
        Ok::<(), tokio_tungstenite::tungstenite::Error>(())
    });
    let hello = versioned_message(
        "agent.hello",
        json!({
            "agent": {
                "deviceKey": config.device_key,
                "version": env!("CARGO_PKG_VERSION"),
                "os": env::consts::OS,
                "arch": env::consts::ARCH,
                "workspaceRoot": outputs::display_path(&config.workspace_root),
                "capabilities": ["skills/v1", "client-paths/v1", "remote-workspace/v1", "workspace/context", "workspace/search", "workspace/read_text", "workspace/git_status", "workspace/git_diff", "workspace/apply_patch", "workspace/list", "read_file", "exec", "exec-stream/v1", "exec-sessions/v1", "job.cancel", "attachments/v1", "documents/v1", "outputs/v1", "file/stat", "file/read_document", "file/read_text", "file/read_image", "file/read_chunk", "file/close_transfer", "file/write_text", "file/write_begin", "file/write_chunk", "file/write_commit", "file/write_abort", "file/copy", "file/publish", "file/output_paths"],
                "absolutePaths": config.allow_absolute
            }
        }),
        None,
        None,
        None,
    );
    outbound.send(hello).map_err(|_| "AgentRPC writer closed")?;

    let mut heartbeat = time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    let cancellations = Arc::new(Mutex::new(HashMap::<String, watch::Sender<bool>>::new()));
    let sessions = Arc::new(process_sessions::Sessions::default());
    let mut tasks = JoinSet::new();
    let connection_result: AgentResult<()> = loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                files.lock().unwrap().expire();
                let busy = !cancellations.lock().unwrap().is_empty();
                let message = versioned_message("agent.heartbeat", json!({ "state": if busy { "busy" } else { "idle" } }), None, None, None);
                if outbound.send(message).is_err() { break Err("AgentRPC writer closed".into()); }
            }
            incoming = reader.next() => {
                let Some(incoming) = incoming else {
                    break Ok(());
                };
                let incoming = match incoming { Ok(value) => value, Err(error) => break Err(error.into()) };
                if let Message::Close(frame) = &incoming {
                    if let Some(frame) = frame {
                        let reason = frame.reason.as_str();
                        if platform_security::device_token::is_terminal(reason) {
                            break Err(reason.to_string().into());
                        }
                    }
                    break Ok(());
                }
                if !incoming.is_text() {
                    continue;
                }

                let text = match incoming.into_text() { Ok(value) => value, Err(error) => break Err(error.into()) };
                let envelope: RequestEnvelope = match serde_json::from_str(text.as_ref()) {
                    Ok(envelope) => envelope,
                    Err(error) => {
                        eprintln!("Rejected malformed gateway message: {error}");
                        continue;
                    }
                };
                if envelope.message_type == "agent.hello_ack" {
                    continue;
                }
                if let Some(protocol) = envelope.protocol.as_deref() {
                    if protocol != "agentrpc" || envelope.version != Some(1) {
                        eprintln!("Rejected unsupported AgentRPC protocol version");
                        continue;
                    }
                }
                if envelope.message_type == "job.cancel" {
                    if envelope.protocol.as_deref() != Some("agentrpc") || envelope.version != Some(1) {
                        eprintln!("Rejected unversioned AgentRPC cancellation");
                        continue;
                    }
                    let Some(request_id) = envelope.request_id else { continue };
                    let accepted = cancellations.lock().unwrap().get(&request_id).is_some_and(|cancel| cancel.send(true).is_ok())
                        | sessions.cancel(&request_id,envelope.task_id.as_deref());
                    let ack = versioned_message("job.cancel_ack", json!({"accepted":accepted}), Some(&request_id), envelope.task_id.as_deref(), envelope.trace_id.as_deref());
                    let _ = outbound.send(ack);
                    continue;
                }
                if envelope.message_type != "agent.request" { continue; }

                let request = match envelope.into_request() {
                    Ok(request) => request,
                    Err(error) => {
                        eprintln!("Rejected malformed agent request: {error}");
                        continue;
                    }
                };
                let request_id = request.id.clone();
                if let Some(binding) = request.params.get("__remoteWorkspace") {
                    if binding["policy"].as_str() != Some("remote-workspace/v1")
                        || binding["workspaceRoot"].as_str() != Some(outputs::display_path(&config.workspace_root).as_str())
                        || binding["deviceId"].as_str() != Some(config.device_id.as_str())
                        || binding["deviceKey"].as_str() != Some(config.device_key.as_str())
                        || binding["userId"].as_str().is_none_or(str::is_empty)
                    {
                        let response = versioned_message("agent.response", json!({"ok":false,"error":"WORKSPACE_BINDING_MISMATCH: device identity or workspace changed","errorCode":"WORKSPACE_BINDING_MISMATCH"}), Some(&request_id), request.task_id.as_deref(), request.trace_id.as_deref());
                        let _ = outbound.send(response);
                        continue;
                    }
                }
                let (cancel_tx, cancel_rx) = watch::channel(false);
                if cancellations.lock().unwrap().contains_key(&request_id) {
                    let response = versioned_message("agent.response", json!({"ok":false,"error":"duplicate requestId","errorCode":"DUPLICATE_REQUEST"}), Some(&request_id), request.task_id.as_deref(), request.trace_id.as_deref());
                    let _ = outbound.send(response);
                    continue;
                }
                cancellations.lock().unwrap().insert(request_id.clone(), cancel_tx);
                let workspace_root = config.workspace_root.clone();
                let allow_absolute = config.allow_absolute;
                let files = Arc::clone(files);
                let activity = Arc::clone(activity);
                let outbound_task = outbound.clone();
                let cancellations_task = cancellations.clone();
                let sessions = sessions.clone();
                tasks.spawn(async move {
                    let response = handle_request(&workspace_root, allow_absolute, &files, &activity, &sessions, request, cancel_rx, outbound_task.clone()).await;
                    cancellations_task.lock().unwrap().remove(&request_id);
                    let _ = outbound_task.send(response);
                });
            }
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                if let Err(error) = result { eprintln!("Agent request task failed: {error}"); }
            }
            result = &mut writer => {
                break match result {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(error.into()),
                    Err(error) => Err(error.into()),
                };
            }
        }
    };

    for cancel in cancellations.lock().unwrap().values() {
        let _ = cancel.send(true);
    }
    sessions.close().await;
    if time::timeout(Duration::from_secs(5), async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
    }
    drop(outbound);
    if !writer.is_finished() {
        writer.abort();
    }
    connection_result
}

fn local_device_key() -> AgentResult<String> {
    let base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")))
        .ok_or("local application data directory is unavailable")?;
    let directory = base.join("Codexia");
    fs::create_dir_all(&directory)?;
    let path = directory.join("device-id-v1");
    if !path.exists() {
        use std::io::Write;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file.write_all(uuid::Uuid::new_v4().to_string().as_bytes())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let value = fs::read_to_string(path)?;
    uuid::Uuid::parse_str(value.trim())?;
    Ok(value.trim().to_string())
}

async fn handle_request(
    workspace_root: &Path,
    allow_absolute: bool,
    files: &Arc<Mutex<attachments::Attachments>>,
    activity: &Arc<runtime::Activity>,
    sessions: &process_sessions::Sessions,
    request: AgentRequest,
    cancel: watch::Receiver<bool>,
    outbound: mpsc::UnboundedSender<Value>,
) -> Value {
    let request_id = request.id.clone();
    let admission = activity.enter();
    let mut command_failure: Option<process::CommandFailure> = None;
    let result = match admission.as_ref() {
        Err(error) => Err(error.clone()),
        Ok(_) => match request.method.as_str() {
            method if method.starts_with("skills/") => skills::call(method, &request.params),
            "workspace/list" => list_workspace(workspace_root, &request.params),
            "read_file" => read_file(workspace_root, &request.params),
            "workspace/git_status" | "workspace/git_diff" => {
                workspace::git(workspace_root, &request.method, &request.params, cancel).await
            }
            method if method.starts_with("workspace/") => {
                let root = workspace_root.to_path_buf();
                let method = method.to_owned();
                let params = request.params.clone();
                tokio::task::spawn_blocking(move || {
                    workspace::call(&root, &method, &params, &cancel)
                })
                .await
                .unwrap_or_else(|error| Err(format!("WORKSPACE_RESULT_UNKNOWN: {error}")))
            }
            "exec" => {
                let sink: process::EventSink = {
                    let request_id = request.id.clone();
                    let task_id = request.task_id.clone();
                    let trace_id = request.trace_id.clone();
                    Arc::new(move |event: process::StreamEvent| {
                        let message = versioned_message(
                            "agent.event",
                            json!({
                                "stream":event.stream,
                                "sequence":event.sequence,
                                "chunk":event.chunk,
                                "done":event.done,
                                "truncated":event.truncated,
                            }),
                            Some(&request_id),
                            task_id.as_deref(),
                            trace_id.as_deref(),
                        );
                        let _ = outbound.send(message);
                    })
                };
                if request.params.get("sessionId").is_some()
                    || request.params.get("yieldMs").is_some()
                    || request.params["interactive"] == true
                {
                    sessions
                        .execute(
                            workspace_root,
                            &request.params,
                            &request.id,
                            request.task_id.as_deref(),
                            activity.clone(),
                            cancel,
                            sink,
                        )
                        .await
                } else {
                    execute_command(
                        workspace_root,
                        allow_absolute,
                        &request.params,
                        cancel,
                        sink,
                    )
                    .await
                }
            }
            .map_err(|failure| {
                let message = failure.message.clone();
                command_failure = Some(failure);
                message
            }),
            "file/read_document" => {
                let root = workspace_root.to_path_buf();
                let params = request.params.clone();
                tokio::task::spawn_blocking(move || documents::read(&root, &params, &cancel))
                    .await
                    .unwrap_or_else(|e| Err(format!("DOCUMENT_PARSE_FAILED: {e}")))
            }
            "file/read_text"
                if request.params["path"].as_str().is_some_and(|raw| {
                    Path::new(raw)
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|ext| {
                            ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]
                                .contains(&ext.to_lowercase().as_str())
                        })
                }) =>
            {
                let root = workspace_root.to_path_buf();
                let params = request.params.clone();
                tokio::task::spawn_blocking(move || documents::read(&root, &params, &cancel))
                    .await
                    .unwrap_or_else(|e| Err(format!("DOCUMENT_PARSE_FAILED: {e}")))
            }
            method if method.starts_with("file/") => {
                files.lock().unwrap().call(method, &request.params, false)
            }
            _ => Err(format!("unsupported method: {}", request.method)),
        },
    };

    let response = match result {
        Ok(result) => json!({ "id": request_id, "ok": true, "result": result }),
        Err(error) => {
            let code = error
                .split(':')
                .next()
                .filter(|code| {
                    !code.is_empty() && code.chars().all(|c| c.is_ascii_uppercase() || c == '_')
                })
                .unwrap_or("AGENT_ERROR");
            if let Some(failure) = command_failure {
                json!({ "id": request_id, "ok": false, "error": error, "errorCode": if failure.code == "AGENT_ERROR" { code } else { failure.code }, "result": failure.result })
            } else {
                json!({ "id": request_id, "ok": false, "error": error, "errorCode": code })
            }
        }
    };
    versioned_message(
        "agent.response",
        response,
        Some(request_id.as_str()),
        request.task_id.as_deref(),
        request.trace_id.as_deref(),
    )
}

// Inherited anonymous pipes are accessible only to the desktop parent. No TCP listener.
fn start_attachment_stdio(
    files: Arc<Mutex<attachments::Attachments>>,
    activity: Arc<runtime::Activity>,
) {
    std::thread::spawn(move || {
        use std::io::{BufRead, Read, Write};
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = Vec::new();
            match (&mut input)
                .take(1024 * 1024 + 1)
                .read_until(b'\n', &mut line)
            {
                Ok(0) | Err(_) => break,
                _ => {}
            }
            if line.len() > 1024 * 1024 {
                break;
            }
            let response = match serde_json::from_slice::<Value>(&line) {
                Ok(v) => match (|| {
                    let method = v["method"].as_str().unwrap_or("");
                    if method == "runtime/prepare_restart" {
                        activity.pause(|| files.lock().unwrap().has_transfers())?;
                        return Ok(json!({"ready":true}));
                    }
                    let _operation = activity.enter()?;
                    files.lock().unwrap().call(method, &v["params"], true)
                })() {
                    Ok(result) => json!({"id":v["id"],"ok":true,"result":result}),
                    Err(error) => json!({"id":v["id"],"ok":false,"error":error}),
                },
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            };
            if writeln!(std::io::stdout(), "{response}").is_err() {
                break;
            }
            let _ = std::io::stdout().flush();
        }
    });
}

fn versioned_message(
    message_type: &str,
    payload: Value,
    request_id: Option<&str>,
    task_id: Option<&str>,
    trace_id: Option<&str>,
) -> Value {
    let timestamp = iso_timestamp();
    let nonce = format!(
        "local-agent-{}-{}",
        timestamp.replace([':', '.', '-'], ""),
        NONCE_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut message = json!({
        "protocol": "agentrpc",
        "version": 1,
        "type": message_type,
        "timestamp": timestamp,
        "nonce": nonce,
        "payload": payload,
    });
    if let Some(request_id) = request_id {
        message["requestId"] = json!(request_id);
    }
    if let Some(task_id) = task_id {
        message["taskId"] = json!(task_id);
    }
    if let Some(trace_id) = trace_id {
        message["traceId"] = json!(trace_id);
    }
    message
}

fn iso_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    let seconds = duration.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);

    // Civil date conversion from Unix days (UTC), avoiding another runtime
    // dependency in the small Local Agent binary.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe.div_euclid(1_460) + doe.div_euclid(36_524) - doe.div_euclid(146_096))
        .div_euclid(365);
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe.div_euclid(4) - yoe.div_euclid(100));
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    let hours = day_seconds / 3_600;
    let minutes = (day_seconds % 3_600) / 60;
    let secs = day_seconds % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{secs:02}.{:03}Z",
        duration.subsec_millis()
    )
}

fn list_workspace(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    let requested_path = params.get("path").and_then(Value::as_str).unwrap_or(".");
    let target = resolve_existing_path(workspace_root, requested_path)?;
    if !target.is_dir() {
        return Err("requested path is not a directory".into());
    }

    let mut entries = fs::read_dir(&target)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            let entry = entry.map_err(|error| error.to_string())?;
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            Ok(json!({
                "name": entry.file_name().to_string_lossy(),
                "kind": if metadata.is_dir() { "directory" } else if metadata.is_file() { "file" } else { "other" },
                "bytes": if metadata.is_file() { Some(metadata.len()) } else { None }
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    let offset = params["cursor"]
        .as_str()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| "INVALID_CURSOR")?;
    if offset > entries.len() {
        return Err("INVALID_CURSOR".into());
    }
    let next = entries.len().min(offset.saturating_add(200));
    Ok(
        json!({ "path": outputs::display_path(&target), "entries": &entries[offset..next],"nextCursor":if next<entries.len(){Some(next.to_string())}else{None},"totalEntries":entries.len() }),
    )
}

fn read_file(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    workspace::read_text(workspace_root, params)
}

async fn execute_command(
    workspace_root: &Path,
    _allow_absolute: bool,
    params: &Value,
    cancel: watch::Receiver<bool>,
    sink: process::EventSink,
) -> Result<Value, process::CommandFailure> {
    let program = required_string(params, "program")?;
    let args = params
        .get("args")
        .and_then(Value::as_array)
        .ok_or("args must be an array")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or("every arg must be a string")
        })
        .collect::<Result<Vec<_>, _>>()?;

    let requested_cwd = params.get("cwd").and_then(Value::as_str).unwrap_or(".");
    let timeout = command_timeout(params)?;
    let cwd = workspace::resolve(workspace_root, requested_cwd)?;
    if !cwd.is_dir() {
        return Err("cwd must be a directory".into());
    }

    // The command runs on the client, never on the central worker. PowerShell
    // is supported explicitly (`powershell -NoProfile -Command ...`) while
    // cwd may name any directory accessible to this OS user. Omitted cwd uses
    // the configured output directory; it is not a filesystem sandbox.
    let mut command = Command::new(program);
    command.args(&args).current_dir(cwd);
    process::run_command_session(command, program, &args, timeout, cancel, sink, None).await
}

fn command_timeout(params: &Value) -> Result<Option<Duration>, String> {
    match params.get("timeoutMs") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|n| *n > 0)
            .map(|n| Some(Duration::from_millis(n)))
            .ok_or("COMMAND_TIMEOUT_INVALID".into()),
    }
}

fn resolve_existing_path(workspace_root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    workspace::resolve(workspace_root, requested_path)
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} must be a non-empty string"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_files_outside_default_output_directory() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("outputs");
        fs::create_dir(&output).unwrap();
        fs::write(temp.path().join("outside.txt"), "client file").unwrap();
        assert_eq!(
            resolve_existing_path(&output, "../outside.txt").unwrap(),
            temp.path().join("outside.txt").canonicalize().unwrap()
        );
        assert_eq!(
            read_file(&output, &json!({"path":temp.path().join("outside.txt")})).unwrap()["content"],
            "client file"
        );
    }

    #[test]
    fn truncates_command_output() {
        const LIMIT: usize = 64 * 1024;
        let oversized = vec![b'x'; LIMIT + 10];
        let output = command_output::decode(&oversized, LIMIT);
        assert_eq!(output.text.len(), LIMIT);
        assert!(output.truncated);
    }
}
