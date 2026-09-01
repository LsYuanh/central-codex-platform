// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

use std::{
    env,
    error::Error,
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{process::Command, time};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

type AgentResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug)]
struct Config {
    workspace_root: PathBuf,
    gateway_url: String,
}

#[derive(Debug, Deserialize)]
struct RequestEnvelope {
    #[serde(rename = "type")]
    message_type: String,
    request: AgentRequest,
}

#[derive(Debug, Deserialize)]
struct AgentRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[tokio::main]
async fn main() -> AgentResult<()> {
    let config = parse_args()?;
    println!("Local Agent workspace: {}", config.workspace_root.display());

    loop {
        match run_connection(&config).await {
            Ok(()) => eprintln!("Fake Central connection closed"),
            Err(error) => eprintln!("Fake Central connection failed: {error}"),
        }
        time::sleep(Duration::from_secs(2)).await;
    }
}

fn parse_args() -> AgentResult<Config> {
    let mut workspace_root: Option<PathBuf> = None;
    let mut gateway_url: Option<String> = None;
    let mut arguments = env::args().skip(1);

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--workspace-root" => workspace_root = arguments.next().map(PathBuf::from),
            "--gateway-url" => gateway_url = arguments.next(),
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }

    let workspace_root = workspace_root.ok_or("--workspace-root is required")?;
    let workspace_root = workspace_root.canonicalize()?;
    if !workspace_root.is_dir() {
        return Err("workspace root must be an existing directory".into());
    }

    let gateway_url = gateway_url.ok_or("--gateway-url is required")?;
    if !gateway_url.starts_with("ws://127.0.0.1:") && !gateway_url.starts_with("ws://localhost:") {
        return Err("this local Spike only permits a loopback Fake Central URL".into());
    }

    Ok(Config {
        workspace_root,
        gateway_url,
    })
}

async fn run_connection(config: &Config) -> AgentResult<()> {
    let (socket, _) = connect_async(&config.gateway_url).await?;
    let (mut writer, mut reader) = socket.split();
    let hello = json!({
        "type": "agent.hello",
        "agent": {
            "version": env!("CARGO_PKG_VERSION"),
            "os": env::consts::OS,
            "arch": env::consts::ARCH,
            "capabilities": ["workspace/list", "read_file", "exec:version-only"]
        }
    });
    writer.send(Message::Text(hello.to_string().into())).await?;

    let mut heartbeat = time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let message = json!({ "type": "agent.heartbeat" });
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
                if envelope.message_type != "agent.request" {
                    continue;
                }

                let response = handle_request(&config.workspace_root, envelope.request).await;
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

    match result {
        Ok(result) => json!({
            "type": "agent.response",
            "response": { "id": request_id, "ok": true, "result": result }
        }),
        Err(error) => json!({
            "type": "agent.response",
            "response": { "id": request_id, "ok": false, "error": error }
        }),
    }
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
