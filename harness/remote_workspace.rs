//! Yuan Zhou's process-wide, fail-closed workspace boundary.
//! This module is added to the pinned upstream codex-core by the patch generator.
use serde_json::Value;
use std::sync::OnceLock;

pub const MARKER: &str =
    "yuan-zhou-remote-workspace/1 yuan-zhou-managed-skills/1 yuan-zhou-conversation-read/1 yuan-zhou-plan-goal/1";

/// These device operations inspect client state. General exec is deliberately
/// excluded: a shell string cannot reliably prove that it has no side effects.
pub fn plan_tool(name: &str) -> bool {
    matches!(name, "device_workspace_list" | "device_read_file" | "device_read_text"
        | "device_workspace_context" | "device_workspace_search" | "device_workspace_read_text"
        | "device_workspace_git_status" | "device_workspace_git_diff" | "conversation_read")
}

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("CODEX_REMOTE_WORKSPACE").as_deref() == Ok("1"))
}

/// Only the reviewed Mac credential-broker transport may advertise native images.
pub fn image_generation_enabled() -> bool {
    enabled() && cfg!(target_os = "macos")
        && std::env::var("CODEX_REMOTE_AUTH_MODE").as_deref() == Ok("broker")
        && std::env::var("CODEX_REMOTE_IMAGE_GENERATION").as_deref() == Ok("1")
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
            | "device_skill_load"
            | "device_skill_draft"
            | "conversation_read"
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
            | "thread/delete"
            | "thread/unarchive"
            | "thread/unsubscribe"
            | "turn/start"
            | "turn/steer"
            | "turn/interrupt"
            | "model/list"
            | "account/read"
            | "account/rateLimits/read"
            | "skills/list"
            | "collaborationMode/list"
            | "thread/goal/get"
            | "thread/goal/set"
            | "thread/goal/clear"
    ) {
        return Err(format!("REMOTE_WORKSPACE_UNSUPPORTED: {method}"));
    }
    // Deletion is limited to the Worker's own persisted conversation history.
    // Never accept a caller-supplied file path or execution-policy override.
    if method == "thread/delete"
        && !request
            .get("params")
            .and_then(Value::as_object)
            .is_some_and(|params| {
                params.len() == 1
                    && params
                        .get("threadId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
            })
    {
        return Err("REMOTE_THREAD_DELETE_INVALID: expected threadId only".into());
    }
    let Some(params) = request.get("params").and_then(Value::as_object) else {
        return Ok(());
    };
    if let Some(mode) = params.get("collaborationMode").filter(|v| !v.is_null()) {
        if !matches!(mode.get("mode").and_then(Value::as_str), Some("default" | "plan"))
            || mode.get("settings").and_then(|v| v.get("developer_instructions")).is_some_and(|v| !v.is_null())
        {
            return Err("REMOTE_COLLABORATION_INVALID: use built-in mode instructions".into());
        }
    }
    if method == "skills/list" {
        // Discovery never accepts client-controlled host roots or cwd values.
        if params
            .keys()
            .any(|key| key != "forceReload" && key != "cwds")
            || params
                .get("cwds")
                .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err("REMOTE_SKILL_SCOPE_DENIED".into());
        }
    }
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
                Some("text" | "image" | "skill")
            ) {
                return Err("REMOTE_WORKSPACE_UNSUPPORTED: local input or skill".into());
            }
            if item.get("type").and_then(Value::as_str) == Some("skill") {
                let raw = item
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("REMOTE_SKILL_PATH_DENIED")?;
                let root = std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join("managed-skills");
                let canonical_cwd =
                    std::fs::canonicalize(std::env::current_dir().map_err(|e| e.to_string())?)
                        .map_err(|_| "REMOTE_SKILL_PATH_DENIED")?;
                let canonical_root =
                    std::fs::canonicalize(&root).map_err(|_| "REMOTE_SKILL_PATH_DENIED")?;
                if canonical_root != canonical_cwd.join("managed-skills")
                    || std::fs::canonicalize(root.join("catalog.json")).ok()
                        != Some(canonical_root.join("catalog.json"))
                {
                    return Err("REMOTE_SKILL_PATH_DENIED".into());
                }
                let path = std::path::Path::new(raw);
                let canonical =
                    std::fs::canonicalize(path).map_err(|_| "REMOTE_SKILL_PATH_DENIED")?;
                let relative = path
                    .strip_prefix(&root)
                    .map_err(|_| "REMOTE_SKILL_PATH_DENIED")?;
                if relative.components().count() != 3
                    || relative
                        .components()
                        .any(|c| !matches!(c, std::path::Component::Normal(_)))
                    || path.file_name().and_then(|v| v.to_str()) != Some("SKILL.md")
                    || canonical
                        != std::fs::canonicalize(&root)
                            .map_err(|_| "REMOTE_SKILL_PATH_DENIED")?
                            .join(relative)
                {
                    return Err("REMOTE_SKILL_PATH_DENIED".into());
                }
                let catalog: Value = serde_json::from_slice(
                    &std::fs::read(root.join("catalog.json"))
                        .map_err(|_| "REMOTE_SKILL_PATH_DENIED")?,
                )
                .map_err(|_| "REMOTE_SKILL_PATH_DENIED")?;
                let key = relative
                    .parent()
                    .ok_or("REMOTE_SKILL_PATH_DENIED")?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !catalog
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|v| v.as_str() == Some(&key)))
                {
                    return Err("REMOTE_SKILL_PATH_DENIED".into());
                }
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
    fn thread_delete_accepts_only_a_thread_id() {
        assert!(validate_request(&json!({"method":"thread/delete","params":{"threadId":"019b0000-0000-7000-8000-000000000001"}})).is_ok());
        for params in [
            json!(null),
            json!({}),
            json!({"threadId":""}),
            json!({"threadId":123}),
            json!({"threadIds":["thread"]}),
        ] {
            assert!(validate_request(&json!({"method":"thread/delete","params":params})).is_err());
        }
        for key in ["path", "cwd", "config", "sandbox", "force"] {
            assert!(
                validate_request(
                    &json!({"method":"thread/delete","params":{"threadId":"thread",key:"/private"}})
                )
                .is_err()
            );
        }
        for method in [
            "thread/deleteAll",
            "thread/delete/extra",
            "fs/delete",
            "command/exec",
        ] {
            assert!(
                validate_request(&json!({"method":method,"params":{"threadId":"thread"}})).is_err()
            );
        }
    }

    #[test]
    fn rejects_workspace_rpc_and_overrides() {
        for method in [
            "command/exec",
            "fs/readFile",
            "fuzzyFileSearch",
            "review/start",
            "thread/fork",
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
        assert!(device_tool("device_skill_draft"));
        assert!(device_tool("conversation_read"));
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

    #[test]
    fn managed_skill_discovery_rejects_host_overrides() {
        assert!(
            validate_request(
                &json!({"method":"skills/list","params":{"forceReload":true,"cwds":[]}})
            )
            .is_ok()
        );
        assert!(
            validate_request(&json!({"method":"skills/list","params":{"cwds":["/private"]}}))
                .is_err()
        );
        assert!(
            validate_request(&json!({"method":"skills/list","params":{"perCwdExtraUserRoots":[]}}))
                .is_err()
        );
        assert!(validate_request(&json!({"method":"turn/start","params":{"input":[{"type":"skill","name":"forged","path":"/private/SKILL.md"}]}})).is_err());
    }
}
