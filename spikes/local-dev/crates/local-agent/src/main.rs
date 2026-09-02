// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

use std::{
    env,
    error::Error,
    fs,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{process::Command, time};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

type AgentResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug)]
struct Config {
    workspace_root: PathBuf,
    gateway_url: String,
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
    let config = parse_args()?;
    println!("Local Agent workspace: {}", config.workspace_root.display());

    loop {
        match run_connection(&config).await {
            Ok(()) => eprintln!("Gateway connection closed; retrying"),
            Err(error) => eprintln!("Gateway connection failed: {error}; retrying"),
        }
        time::sleep(Duration::from_secs(2)).await;
    }
}

fn parse_args() -> AgentResult<Config> {
    let mut workspace_root: Option<PathBuf> = None;
    let mut gateway_url: Option<String> = None;
    let mut allow_insecure_lan = false;
    let mut arguments = env::args().skip(1);

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--workspace-root" => workspace_root = arguments.next().map(PathBuf::from),
            "--gateway-url" => gateway_url = arguments.next(),
            "--allow-insecure-lan" => allow_insecure_lan = true,
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }

    let workspace_root = workspace_root.ok_or("--workspace-root is required")?;
    let workspace_root = workspace_root.canonicalize()?;
    if !workspace_root.is_dir() {
        return Err("workspace root must be an existing directory".into());
    }

    let gateway_url = gateway_url.ok_or("--gateway-url is required")?;
    let loopback = gateway_url.starts_with("ws://127.0.0.1:") || gateway_url.starts_with("ws://localhost:");
    if !loopback && !allow_insecure_lan {
        return Err("non-loopback ws:// gateway requires --allow-insecure-lan".into());
    }

    Ok(Config {
        workspace_root,
        gateway_url,
    })
}

async fn run_connection(config: &Config) -> AgentResult<()> {
    let (socket, _) = connect_async(&config.gateway_url).await?;
    let (mut writer, mut reader) = socket.split();
    let hello = versioned_message(
        "agent.hello",
        json!({
            "agent": {
                "version": env!("CARGO_PKG_VERSION"),
                "os": env::consts::OS,
                "arch": env::consts::ARCH,
                "capabilities": ["workspace/list", "read_file", "exec:version-only"]
            }
        }),
        None,
        None,
        None,
    );
    writer.send(Message::Text(hello.to_string().into())).await?;

    let mut heartbeat = time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let message = versioned_message("agent.heartbeat", json!({ "state": "idle" }), None, None, None);
                writer.send(Message::Text(message.to_string().into())).await?;
            }
            incoming = reader.next() => {
                let Some(incoming) = incoming else {
                    return Ok(());
                };
                let incoming = incoming?;
                if incoming.is_close() {
                    return Ok(());
                }
                if !incoming.is_text() {
                    continue;
                }

                let text = incoming.into_text()?;
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
                if envelope.message_type != "agent.request" {
                    continue;
                }

                if let Some(protocol) = envelope.protocol.as_deref() {
                    if protocol != "agentrpc" || envelope.version != Some(1) {
                        eprintln!("Rejected unsupported AgentRPC protocol version");
                        continue;
                    }
                }
                let request = match envelope.into_request() {
                    Ok(request) => request,
                    Err(error) => {
                        eprintln!("Rejected malformed agent request: {error}");
                        continue;
                    }
                };
                let response = handle_request(&config.workspace_root, request).await;
                writer.send(Message::Text(response.to_string().into())).await?;
            }
        }
    }
}

async fn handle_request(workspace_root: &Path, request: AgentRequest) -> Value {
    let request_id = request.id.clone();
    let result = match request.method.as_str() {
        "workspace/list" => list_workspace(workspace_root, &request.params),
        "read_file" => read_file(workspace_root, &request.params),
        "exec" => execute_version_command(workspace_root, &request.params).await,
        _ => Err(format!("unsupported method: {}", request.method)),
    };

    let response = match result {
        Ok(result) => json!({ "id": request_id, "ok": true, "result": result }),
        Err(error) => json!({ "id": request_id, "ok": false, "error": error, "errorCode": "AGENT_ERROR" }),
    };
    versioned_message(
        "agent.response",
        response,
        Some(request_id.as_str()),
        request.task_id.as_deref(),
        request.trace_id.as_deref(),
    )
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
    let yoe = (doe - doe.div_euclid(1_460) + doe.div_euclid(36_524) - doe.div_euclid(146_096)).div_euclid(365);
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
        .take(200)
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

    Ok(json!({ "path": requested_path, "entries": entries }))
}

fn read_file(workspace_root: &Path, params: &Value) -> Result<Value, String> {
    let requested_path = required_string(params, "path")?;
    let target = resolve_existing_path(workspace_root, requested_path)?;
    let metadata = target.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("requested path is not a file".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("file exceeds {MAX_FILE_BYTES} byte Spike limit"));
    }

    let content = fs::read_to_string(&target).map_err(|error| error.to_string())?;
    Ok(json!({ "path": requested_path, "bytes": metadata.len(), "content": content }))
}

async fn execute_version_command(workspace_root: &Path, params: &Value) -> Result<Value, String> {
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

    if !matches!(program, "git" | "node") || args != ["--version"] {
        return Err("Spike exec only permits `git --version` or `node --version`".into());
    }

    let requested_cwd = params.get("cwd").and_then(Value::as_str).unwrap_or(".");
    let cwd = resolve_existing_path(workspace_root, requested_cwd)?;
    if !cwd.is_dir() {
        return Err("cwd must be a directory".into());
    }

    let mut command = Command::new(program);
    command.args(&args).current_dir(cwd).kill_on_drop(true);
    let output = time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "command timed out".to_string())?
        .map_err(|error| error.to_string())?;

    Ok(json!({
        "program": program,
        "args": args,
        "exitCode": output.status.code(),
        "stdout": truncate_output(&output.stdout),
        "stderr": truncate_output(&output.stderr),
        "truncated": output.stdout.len() > MAX_OUTPUT_BYTES || output.stderr.len() > MAX_OUTPUT_BYTES
    }))
}

fn resolve_existing_path(workspace_root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(requested_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("absolute paths and parent traversal are forbidden".into());
    }

    let resolved = workspace_root
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !resolved.starts_with(workspace_root) {
        return Err("resolved path escapes the workspace root".into());
    }
    Ok(resolved)
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} must be a non-empty string"))
}

fn truncate_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_OUTPUT_BYTES)]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_traversal() {
        let root = env::current_dir().expect("current directory");
        let error = resolve_existing_path(&root, "../outside").expect_err("traversal must fail");
        assert!(error.contains("forbidden"));
    }

    #[test]
    fn truncates_command_output() {
        let oversized = vec![b'x'; MAX_OUTPUT_BYTES + 10];
        assert_eq!(truncate_output(&oversized).len(), MAX_OUTPUT_BYTES);
    }
}
