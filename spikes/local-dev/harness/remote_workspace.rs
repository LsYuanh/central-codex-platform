//! Yuan Zhou's process-wide, fail-closed workspace boundary.
//! This module is added to the pinned upstream codex-core by the patch generator.
use serde_json::Value;
use std::sync::OnceLock;

pub const MARKER: &str = "yuan-zhou-remote-workspace/1";

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("CODEX_REMOTE_WORKSPACE").as_deref() == Ok("1"))
}

pub fn device_tool(name: &str) -> bool {
    matches!(
        name,
        "device_workspace_list"
            | "device_read_file"
            | "device_exec"
            | "device_read_text"
            | "device_write_file"
            | "device_copy_file"
            | "device_publish_file"
            | "device_output_paths"
            | "device_list_outputs"
            | "device_workspace_context"
            | "device_workspace_search"
            | "device_workspace_read_text"
            | "device_workspace_git_status"
            | "device_workspace_git_diff"
            | "device_workspace_apply_patch"
    )
}

pub fn validate_request(request: &Value) -> Result<(), String> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        method,
        "initialize"
            | "thread/start"
            | "thread/resume"
            | "thread/read"
            | "thread/list"
            | "thread/loaded/list"
            | "thread/name/set"
            | "thread/archive"
            | "thread/unarchive"
            | "thread/unsubscribe"
            | "turn/start"
            | "turn/steer"
            | "turn/interrupt"
            | "model/list"
            | "account/read"
            | "account/rateLimits/read"
    ) {
        return Err(format!("REMOTE_WORKSPACE_UNSUPPORTED: {method}"));
    }
    let Some(params) = request.get("params").and_then(Value::as_object) else {
        return Ok(());
    };
    for key in [
        "config",
        "permissions",
        "sandboxPolicy",
        "sandbox",
        "approvalPolicy",
        "approvalsReviewer",
        "environment",
        "environments",
        "path",
        "forkFrom",
    ] {
        if params.get(key).is_some_and(|v| !v.is_null()) {
            return Err(format!("REMOTE_WORKSPACE_OVERRIDE_DENIED: {key}"));
        }
    }
    if let Some(cwd) = params.get("cwd").filter(|v| !v.is_null()) {
        let worker = std::env::current_dir().map_err(|e| e.to_string())?;
        if cwd.as_str() != worker.to_str() {
            return Err("REMOTE_WORKSPACE_OVERRIDE_DENIED: cwd".into());
        }
    }
    if let Some(input) = params.get("input").and_then(Value::as_array) {
        for item in input {
            if !matches!(
                item.get("type").and_then(Value::as_str),
                Some("text" | "image")
            ) {
                return Err("REMOTE_WORKSPACE_UNSUPPORTED: local input or skill".into());
            }
            if item.get("type").and_then(Value::as_str) == Some("image")
                && !item
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| url.starts_with("data:image/"))
            {
                return Err("REMOTE_WORKSPACE_UNSUPPORTED: only inline images".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_workspace_rpc_and_overrides() {
        for method in [
            "command/exec",
            "fs/readFile",
            "fuzzyFileSearch",
            "review/start",
            "thread/fork",
            "skills/list",
            "mcpServer/reload",
        ] {
            assert!(validate_request(&json!({"method": method})).is_err());
        }
        for key in [
            "cwd",
            "config",
            "sandbox",
            "approvalPolicy",
            "path",
            "environments",
        ] {
            assert!(
                validate_request(&json!({"method":"thread/start", "params":{key:"/private"}}))
                    .is_err()
            );
        }
        assert!(validate_request(&json!({"method":"turn/start","params":{"input":[{"type":"localImage","path":"/private/image.png"}]}})).is_err());
        assert!(
            validate_request(
                &json!({"method":"turn/start","params":{"input":[{"type":"text","text":"test"}]}})
            )
            .is_ok()
        );
    }

    #[test]
    fn allowlist_is_exact() {
        assert!(device_tool("device_exec"));
        for name in [
            "exec_command",
            "apply_patch",
            "device_mcp_exec",
            "device_exec_extra",
            "spawn_agent",
        ] {
            assert!(!device_tool(name));
        }
    }
}
