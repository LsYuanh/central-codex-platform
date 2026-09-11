// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Client-only, bounded workspace operations. These never inherit LAN absolute-path access.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{process::Command, sync::watch};

const FILE_LIMIT: usize = 1024 * 1024;
const PAGE_BYTES: usize = 64 * 1024;
const SCAN_ENTRIES: usize = 10_000;
const SCAN_BYTES: usize = 8 * 1024 * 1024;
static PATCH_LOCK: Mutex<()> = Mutex::new(());

fn io_error(error: std::io::Error) -> String {
    format!(
        "{}: {error}",
        match error.kind() {
            std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            std::io::ErrorKind::NotFound => "PATH_NOT_FOUND",
            _ => "WORKSPACE_IO_ERROR",
        }
    )
}

fn link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub fn resolve(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let relative = Path::new(raw);
    if raw.contains(':')
        || raw.contains('\\') && !cfg!(windows)
        || relative.is_absolute()
        || relative.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(
            "WORKSPACE_PATH_DENIED: a workspace-relative path without traversal is required".into(),
        );
    }
    let mut target = root.to_path_buf();
    for component in relative.components() {
        if let Component::Normal(part) = component {
            #[cfg(windows)]
            if part.to_string_lossy().ends_with(['.', ' ']) {
                return Err("WORKSPACE_PATH_DENIED: ambiguous Windows path component".into());
            }
            target.push(part);
            if link(&fs::symlink_metadata(&target).map_err(io_error)?) {
                return Err(
                    "WORKSPACE_PATH_DENIED: symlink/reparse paths are not supported".into(),
                );
            }
        }
    }
    let canonical = target.canonicalize().map_err(io_error)?;
    if !canonical.starts_with(root) {
        return Err("WORKSPACE_PATH_DENIED: resolved path leaves the workspace".into());
    }
    Ok(canonical)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn snapshot(root: &Path, raw: &str, limit: usize) -> Result<(Vec<u8>, String), String> {
    let path = resolve(root, raw)?;
    let file = File::open(&path).map_err(io_error)?;
    let before = file.metadata().map_err(io_error)?;
    if !before.is_file() {
        return Err("NOT_A_FILE".into());
    }
    if before.len() > limit as u64 {
        return Err("FILE_TOO_LARGE".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let after_path = resolve(root, raw)?;
    let after = fs::metadata(after_path).map_err(io_error)?;
    if bytes.len() > limit
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("VERSION_CONFLICT: file changed during read".into());
    }
    let version = format!("sha256:{:x}", Sha256::digest(&bytes));
    Ok((bytes, version))
}

fn text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.contains(&0) {
        return Err("ENCODING_UNSUPPORTED: expected UTF-8 text".into());
    }
    String::from_utf8(bytes).map_err(|_| "ENCODING_UNSUPPORTED: expected UTF-8 text".into())
}

fn checkpoint(cancel: &watch::Receiver<bool>, started: Instant) -> Result<(), String> {
    if *cancel.borrow() {
        return Err("WORKSPACE_CANCELLED".into());
    }
    if started.elapsed() > Duration::from_secs(5) {
        return Err("WORKSPACE_TIMEOUT".into());
    }
    Ok(())
}

pub fn call(
    root: &Path,
    method: &str,
    p: &Value,
    cancel: &watch::Receiver<bool>,
) -> Result<Value, String> {
    let started = Instant::now();
    checkpoint(cancel, started)?;
    match method {
        "workspace/context" => context(root, p, cancel, started),
        "workspace/read_text" => read_text(root, p),
        "workspace/search" => search(root, p, cancel, started),
        "workspace/apply_patch" => apply_patch(root, p, cancel, started),
        _ => Err("CAPABILITY_UNAVAILABLE: unsupported workspace operation".into()),
    }
}

// New files may only be created inside an existing, verified parent. Directory creation
// is deliberately separate: a typo must not silently materialize a parallel project tree.
fn destination(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let requested = Path::new(raw);
    let parent = requested.parent().ok_or("INVALID_PATH")?;
    let parent = resolve(root, parent.to_str().ok_or("INVALID_PATH")?)?;
    let filename = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("INVALID_PATH")?;
    #[cfg(windows)]
    if filename.ends_with(['.', ' ']) {
        return Err("WORKSPACE_PATH_DENIED: ambiguous Windows destination".into());
    }
    if filename.contains(':')
        || filename.eq_ignore_ascii_case(".git")
        || requested.components().any(|part| {
            part.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".git")
        })
    {
        return Err("WORKSPACE_PATH_DENIED: repository metadata cannot be patched".into());
    }
    let path = parent.join(filename);
    match fs::symlink_metadata(&path) {
        Ok(_) => resolve(root, raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(io_error(error)),
    }
}

fn version_at(root: &Path, raw: &str) -> Result<String, String> {
    let path = destination(root, raw)?;
    if !path.exists() {
        return Ok("missing".into());
    }
    snapshot(root, raw, FILE_LIMIT).map(|(_, version)| version)
}

struct Change {
    path: String,
    content: Option<String>,
}

fn apply_patch(
    root: &Path,
    p: &Value,
    cancel: &watch::Receiver<bool>,
    started: Instant,
) -> Result<Value, String> {
    use codex_patch_core::{ApplyPatchFileUpdateMode, Hunk, derive_new_contents, parse_patch};
    let _guard = PATCH_LOCK
        .try_lock()
        .map_err(|_| "WORKSPACE_BUSY: another patch is active")?;
    let patch = crate::required_string(p, "patch")?;
    if patch.len() > 256 * 1024 {
        return Err("PATCH_TOO_LARGE".into());
    }
    let patch_hash = format!("sha256:{:x}", Sha256::digest(patch.as_bytes()));
    if !p["dryRun"].as_bool().unwrap_or(false) {
        if p["patchHash"].as_str() != Some(patch_hash.as_str()) {
            return Err("PATCH_APPROVAL_MISMATCH: preview patchHash is required".into());
        }
        let expected = p["expectedVersions"]
            .as_object()
            .ok_or("VERSION_REQUIRED: preview expectedVersions is required")?;
        if expected.len() > 200 {
            return Err("PATCH_TOO_LARGE".into());
        }
        for (path, version) in expected {
            if version.as_str() != Some(version_at(root, path)?.as_str()) {
                return Err("VERSION_CONFLICT: files changed since preview/approval".into());
            }
        }
    }
    let parsed = parse_patch(patch).map_err(|error| format!("INVALID_PATCH: {error}"))?;
    if parsed.workdir.is_some() || parsed.environment_id.is_some() {
        return Err("WORKSPACE_PATH_DENIED: patch cannot override task binding".into());
    }
    if parsed.hunks.is_empty() || parsed.hunks.len() > 100 {
        return Err("INVALID_PATCH: require 1 to 100 file hunks".into());
    }
    let mut changes = Vec::<Change>::new();
    let mut versions = serde_json::Map::new();
    let mut total_bytes = 0;
    for hunk in parsed.hunks {
        checkpoint(cancel, started)?;
        let is_add = matches!(&hunk, Hunk::AddFile { .. });
        let mut observed_version = None;
        let (path, content, moved) = match hunk {
            Hunk::AddFile { path, contents } => (path, Some(contents), None),
            Hunk::DeleteFile { path } => (path, None, None),
            Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            } => {
                let raw = path.to_str().ok_or("INVALID_PATH")?;
                let (bytes, version) = snapshot(root, raw, FILE_LIMIT)?;
                observed_version = Some(version);
                let original = text(bytes)?;
                let content = derive_new_contents(
                    &original,
                    raw,
                    &chunks,
                    ApplyPatchFileUpdateMode::PreserveLineEndings,
                )
                .map_err(|error| format!("PATCH_CONTEXT_CONFLICT: {error}"))?;
                (path, Some(content), move_path)
            }
        };
        let raw = path.to_str().ok_or("INVALID_PATH")?.to_owned();
        let version = version_at(root, &raw)?;
        if observed_version.is_some_and(|observed| observed != version) {
            return Err("VERSION_CONFLICT: source changed during patch preparation".into());
        }
        // Add is allowed only for an absent destination, even if upstream permits overwrite.
        if is_add && version != "missing" {
            return Err("VERSION_CONFLICT: add destination already exists".into());
        }
        if version == "missing" && content.is_none() {
            return Err("PATH_NOT_FOUND".into());
        }
        if let Some(ref content) = content {
            total_bytes += content.len();
            if content.len() > FILE_LIMIT || total_bytes > SCAN_BYTES {
                return Err("PATCH_TOO_LARGE".into());
            }
        }
        if versions.insert(raw.clone(), json!(version)).is_some() {
            return Err("INVALID_PATCH: duplicate source path".into());
        }
        if let Some(moved) = moved {
            let moved = moved.to_str().ok_or("INVALID_PATH")?.to_owned();
            let destination_version = version_at(root, &moved)?;
            if destination_version != "missing" {
                return Err("VERSION_CONFLICT: move destination exists".into());
            }
            if versions
                .insert(moved.clone(), json!(destination_version))
                .is_some()
            {
                return Err("INVALID_PATCH: overlapping paths".into());
            }
            changes.push(Change {
                path: moved,
                content,
            });
            changes.push(Change {
                path: raw,
                content: None,
            });
        } else {
            changes.push(Change { path: raw, content });
        }
    }
    // Reject path aliases (case variants on Windows, ./ aliases on all platforms).
    let mut unique = std::collections::HashSet::new();
    for change in &changes {
        let path = destination(root, &change.path)?
            .to_string_lossy()
            .to_string();
        let key = if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        };
        if !unique.insert(key) {
            return Err("INVALID_PATCH: aliased or overlapping paths".into());
        }
    }
    let summary: Vec<_> = changes.iter().map(|c| json!({"path":c.path,"operation":if c.content.is_none() { "delete" } else if versions[&c.path] == "missing" { "add" } else { "update" }})).collect();
    if p["dryRun"].as_bool().unwrap_or(false) {
        return Ok(
            json!({"source":"client","dryRun":true,"patchHash":patch_hash,"expectedVersions":versions,"changes":summary,"upstream":"3d2ee51ca2d5db578f328aa75e20aa22c0197c9a"}),
        );
    }
    let expected = p["expectedVersions"]
        .as_object()
        .ok_or("VERSION_REQUIRED: preview expectedVersions is required")?;
    if expected != &versions {
        return Err("VERSION_CONFLICT: files changed since preview/approval".into());
    }
    let mut applied = Vec::new();
    for change in changes {
        let expected_result = change
            .content
            .as_ref()
            .map(|content| format!("sha256:{:x}", Sha256::digest(content.as_bytes())))
            .unwrap_or_else(|| "missing".into());
        let outcome = (|| {
            checkpoint(cancel, started)?;
            let target = destination(root, &change.path)?;
            if version_at(root, &change.path)? != versions[&change.path].as_str().unwrap() {
                return Err("VERSION_CONFLICT".into());
            }
            if target.exists()
                && fs::metadata(&target)
                    .map_err(io_error)?
                    .permissions()
                    .readonly()
            {
                return Err("PERMISSION_DENIED: patch target is read-only".into());
            }
            match change.content {
                Some(content) => {
                    let parent = target.parent().ok_or("INVALID_PATH")?;
                    let mut temporary =
                        tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
                    temporary.write_all(content.as_bytes()).map_err(io_error)?;
                    temporary.as_file().sync_all().map_err(io_error)?;
                    if versions[&change.path] != "missing" {
                        temporary
                            .as_file()
                            .set_permissions(fs::metadata(&target).map_err(io_error)?.permissions())
                            .map_err(io_error)?;
                    }
                    // Revalidate after staging and immediately before committing.
                    if destination(root, &change.path)? != target
                        || version_at(root, &change.path)?
                            != versions[&change.path].as_str().unwrap()
                    {
                        return Err("VERSION_CONFLICT".into());
                    }
                    if versions[&change.path] == "missing" {
                        temporary
                            .persist_noclobber(&target)
                            .map_err(|error| io_error(error.error))?;
                    } else {
                        temporary
                            .persist(&target)
                            .map_err(|error| io_error(error.error))?;
                    }
                }
                None => fs::remove_file(&target).map_err(io_error)?,
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = outcome {
            return Ok(
                json!({"source":"client","outcome":if applied.is_empty() { "failed" } else { "partial" },"applied":applied,"failedPath":change.path,"error":error,"atomic":false,"retrySafe":false,"patchHash":patch_hash}),
            );
        }
        match version_at(root, &change.path) {
            Ok(version) if version == expected_result => {
                applied.push(json!({"path":change.path,"version":version}))
            }
            verified => {
                applied.push(json!({"path":change.path,"version":"unknown"}));
                return Ok(
                    json!({"source":"client","outcome":"unknown","applied":applied,"failedPath":change.path,
                    "error":format!("WORKSPACE_RESULT_UNKNOWN: commit finished but verification disagreed: {verified:?}"),
                    "atomic":false,"retrySafe":false,"patchHash":patch_hash}),
                );
            }
        }
    }
    Ok(
        json!({"source":"client","outcome":"completed","applied":applied,"atomic":false,"retrySafe":false,"patchHash":patch_hash}),
    )
}

fn context(
    root: &Path,
    p: &Value,
    cancel: &watch::Receiver<bool>,
    started: Instant,
) -> Result<Value, String> {
    let raw = p["path"].as_str().unwrap_or(".");
    let target = resolve(root, raw)?;
    let directory = if target.is_dir() {
        target.as_path()
    } else {
        target.parent().ok_or("INVALID_PATH")?
    };
    let mut ancestors: Vec<_> = directory
        .ancestors()
        .take_while(|path| path.starts_with(root))
        .collect();
    ancestors.reverse();
    let mut rules = Vec::new();
    let mut total = 0;
    for directory in ancestors {
        checkpoint(cancel, started)?;
        for name in ["AGENTS.override.md", "AGENTS.md"] {
            let path = directory.join(name);
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_error(e)),
                Ok(_) => {}
            }
            let raw = relative(root, &path);
            let (bytes, version) = snapshot(root, &raw, PAGE_BYTES)?;
            total += bytes.len();
            if total > PAGE_BYTES {
                return Err("RULES_TOO_LARGE: combined project rules exceed 64 KiB".into());
            }
            let content = text(bytes)?;
            if content.trim().is_empty() {
                continue;
            }
            rules.push(json!({"path":raw,"content":content,"version":version}));
            break;
        }
    }
    Ok(
        json!({"source":"client","workspaceRoot":crate::outputs::display_path(root),"path":raw,
        "os":std::env::consts::OS,"arch":std::env::consts::ARCH,
        "shell":if cfg!(windows) { "powershell" } else { "sh" },
        "rules":rules,"ruleScope":"workspace-root-to-target","globalRulesIncluded":false}),
    )
}

fn read_text(root: &Path, p: &Value) -> Result<Value, String> {
    let raw = crate::required_string(p, "path")?;
    let (bytes, version) = snapshot(root, raw, FILE_LIMIT)?;
    if p["version"].as_str().is_some_and(|v| v != version) {
        return Err("VERSION_CONFLICT".into());
    }
    let content = text(bytes)?;
    let offset = p["offset"].as_u64().unwrap_or(0) as usize;
    if offset > content.len() || !content.is_char_boundary(offset) {
        return Err("INVALID_OFFSET".into());
    }
    let mut end = content.len().min(offset.saturating_add(PAGE_BYTES));
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    Ok(
        json!({"source":"client","path":raw,"version":version,"bytes":content.len(),
        "content":&content[offset..end],"offset":offset,"nextOffset":end,"truncated":end<content.len()}),
    )
}

fn search(
    root: &Path,
    p: &Value,
    cancel: &watch::Receiver<bool>,
    started: Instant,
) -> Result<Value, String> {
    let raw = p["path"].as_str().unwrap_or(".");
    let start = resolve(root, raw)?;
    if !start.is_dir() {
        return Err("NOT_A_DIRECTORY".into());
    }
    let query = p["query"].as_str().unwrap_or("");
    if query.len() > 4096 {
        return Err("QUERY_TOO_LARGE".into());
    }
    let mode = p["mode"].as_str().unwrap_or("files");
    if mode != "files" && mode != "text" {
        return Err("INVALID_SEARCH_MODE".into());
    }
    if mode == "text" && query.is_empty() {
        return Err("EMPTY_QUERY".into());
    }
    let offset = p["cursor"]
        .as_str()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| "INVALID_CURSOR")?;
    if offset > SCAN_ENTRIES {
        return Err("INVALID_CURSOR".into());
    }
    let limit = p["limit"].as_u64().unwrap_or(100).clamp(1, 200) as usize;
    let mut directories = vec![start];
    let mut paths = Vec::new();
    let mut skipped = 0;
    let mut scanned = 0;
    let mut scan_truncated = false;
    while let Some(directory) = directories.pop() {
        checkpoint(cancel, started)?;
        let mut children = Vec::new();
        for entry in fs::read_dir(directory).map_err(io_error)? {
            checkpoint(cancel, started)?;
            if scanned == SCAN_ENTRIES {
                scan_truncated = true;
                break;
            }
            scanned += 1;
            let entry = entry.map_err(io_error)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(io_error)?;
            if link(&metadata) {
                skipped += 1;
                continue;
            }
            if entry.file_name() == ".git" {
                continue;
            }
            // Resolve each descendant afresh before reading it, including its ancestors.
            let path = resolve(root, &relative(root, &entry.path()))?;
            if metadata.is_dir() {
                children.push(path.clone());
            }
            if metadata.is_file() || metadata.is_dir() {
                paths.push((path, metadata.is_dir()));
            }
        }
        if scan_truncated {
            break;
        }
        children.sort();
        directories.extend(children.into_iter().rev());
    }
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    let mut matches = Vec::new();
    let mut total_matches = 0;
    let mut read_bytes = 0;
    let mut response_bytes = 0;
    let mut more = false;
    'files: for (path, is_dir) in paths {
        checkpoint(cancel, started)?;
        let name = relative(root, &path);
        let mut candidates = Vec::new();
        if mode == "files" {
            if name.contains(query) {
                candidates
                    .push(json!({"path":name,"kind":if is_dir { "directory" } else { "file" }}));
            }
        } else if !is_dir {
            let (bytes, version) = match snapshot(root, &name, FILE_LIMIT) {
                Ok(v) => v,
                Err(e) if e == "FILE_TOO_LARGE" => {
                    skipped += 1;
                    continue;
                }
                Err(e) => return Err(e),
            };
            read_bytes += bytes.len();
            if read_bytes > SCAN_BYTES {
                scan_truncated = true;
                break;
            }
            let content = match text(bytes) {
                Ok(v) => v,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            for (line, value) in content.lines().enumerate() {
                if line % 100 == 0 {
                    checkpoint(cancel, started)?;
                }
                if let Some(column) = value.find(query) {
                    let mut end = value.len().min(1024);
                    while !value.is_char_boundary(end) {
                        end -= 1;
                    }
                    candidates.push(json!({"path":name,"line":line+1,"column":column+1,"text":&value[..end],"lineTruncated":end<value.len(),"version":version}));
                    // Every page is bounded, even when one file contains millions of matches.
                    if total_matches + candidates.len() > offset + limit {
                        break;
                    }
                }
            }
        }
        for candidate in candidates {
            if total_matches == SCAN_ENTRIES {
                scan_truncated = true;
                break 'files;
            }
            total_matches += 1;
            if total_matches <= offset {
                continue;
            }
            let size = candidate.to_string().len();
            if matches.len() == limit || response_bytes + size > PAGE_BYTES {
                more = true;
                break 'files;
            }
            response_bytes += size;
            matches.push(candidate);
        }
    }
    Ok(
        json!({"source":"client","path":raw,"mode":mode,"matches":matches,
        "nextCursor":if more { Some((offset+matches.len()).to_string()) } else { None },
        "scanTruncated":scan_truncated,"scannedEntries":scanned,"skippedEntries":skipped,
        "pagination":"live-rescan","limits":{"entries":SCAN_ENTRIES,"fileBytes":FILE_LIMIT,"scanBytes":SCAN_BYTES,"pageBytes":PAGE_BYTES}}),
    )
}

pub async fn git(
    root: &Path,
    method: &str,
    p: &Value,
    cancel: watch::Receiver<bool>,
) -> Result<Value, String> {
    if *cancel.borrow() {
        return Err("WORKSPACE_CANCELLED".into());
    }
    let raw = p["path"].as_str().unwrap_or(".");
    let cwd = resolve(root, raw)?;
    if !cwd.is_dir() {
        return Err("NOT_A_DIRECTORY".into());
    }
    let repository = cwd
        .ancestors()
        .take_while(|path| path.starts_with(root))
        .find(|path| path.join(".git").exists())
        .ok_or("NOT_A_WORKSPACE_REPOSITORY")?;
    let git_dir = resolve(root, &relative(root, &repository.join(".git")))?;
    if !git_dir.is_dir() {
        return Err("GIT_LAYOUT_UNSUPPORTED: external gitdir/worktree links are disabled".into());
    }
    // Git reads its own metadata internally, so reject unsupported indirect metadata
    // before starting it. A bounded audit is explicit about repositories it cannot prove.
    let mut pending = vec![git_dir.clone()];
    let mut metadata_entries = 0;
    while let Some(directory) = pending.pop() {
        if *cancel.borrow() {
            return Err("WORKSPACE_CANCELLED".into());
        }
        for entry in fs::read_dir(directory).map_err(io_error)? {
            metadata_entries += 1;
            if metadata_entries > SCAN_ENTRIES {
                return Err("GIT_LAYOUT_UNSUPPORTED: metadata exceeds bounded path audit; use a smaller repository".into());
            }
            let entry = entry.map_err(io_error)?;
            let path = resolve(root, &relative(root, &entry.path()))?;
            if fs::metadata(&path).map_err(io_error)?.is_dir() {
                pending.push(path);
            }
        }
    }
    // External config includes, worktree relocation and shared object stores need an audited adapter.
    let config_path = relative(root, &git_dir.join("config"));
    let config = text(snapshot(root, &config_path, PAGE_BYTES)?.0)?.to_ascii_lowercase();
    let compact_config: String = config.chars().filter(|c| !c.is_whitespace()).collect();
    if compact_config.contains("[include")
        || config
            .lines()
            .any(|line| line.trim_start().starts_with("worktree"))
        || git_dir.join("commondir").exists()
        || git_dir.join("objects/info/alternates").exists()
    {
        return Err("GIT_LAYOUT_UNSUPPORTED: external repository references are disabled".into());
    }
    let mut args = vec![
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "color.ui=false",
    ];
    match method {
        "workspace/git_status" => args.extend([
            "status",
            "--short",
            "--untracked-files=normal",
            "--ignore-submodules=all",
        ]),
        "workspace/git_diff" => {
            args.extend([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
            ]);
            if p["staged"].as_bool().unwrap_or(false) {
                args.push("--cached");
            }
        }
        _ => return Err("CAPABILITY_UNAVAILABLE".into()),
    }
    args.extend(["--", "."]);
    let args: Vec<String> = args.into_iter().map(str::to_owned).collect();
    let mut command = Command::new("git");
    command
        .args(&args)
        .current_dir(&cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    let mut result = crate::process::run_command(
        command,
        "git",
        &args,
        Duration::from_secs(15),
        cancel,
        Arc::new(|_| {}),
    )
    .await?;
    result["source"] = json!("client");
    result["path"] = json!(raw);
    result["staged"] =
        json!(method == "workspace/git_diff" && p["staged"].as_bool().unwrap_or(false));
    result["repositoryRoot"] = json!(crate::outputs::display_path(repository));
    result["format"] = json!(if method == "workspace/git_status" {
        "git-short"
    } else {
        "git-unified-diff"
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_rules_and_detects_version_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("AGENTS.md"), "root rule").unwrap();
        fs::write(root.join("src/AGENTS.md"), "ignored rule").unwrap();
        fs::write(root.join("src/AGENTS.override.md"), "child rule").unwrap();
        fs::write(root.join("src/code.txt"), "marker\nmarker\n").unwrap();
        let (_, cancel) = watch::channel(false);
        let rules = call(
            &root,
            "workspace/context",
            &json!({"path":"src/code.txt"}),
            &cancel,
        )
        .unwrap();
        assert_eq!(rules["rules"][1]["content"], "child rule");
        let read = call(
            &root,
            "workspace/read_text",
            &json!({"path":"src/code.txt"}),
            &cancel,
        )
        .unwrap();
        fs::write(root.join("src/code.txt"), "changed").unwrap();
        assert!(
            call(
                &root,
                "workspace/read_text",
                &json!({"path":"src/code.txt","version":read["version"]}),
                &cancel
            )
            .unwrap_err()
            .contains("VERSION_CONFLICT")
        );
        assert!(resolve(&root, "../outside").is_err());
        assert!(resolve(&root, root.to_str().unwrap()).is_err());
        #[cfg(windows)]
        assert!(destination(&root, "new-file. ").is_err());
    }

    #[test]
    fn pages_search_and_honors_cancel() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("a.txt"), "match\nmatch\nmatch\n").unwrap();
        let (send, cancel) = watch::channel(false);
        let first = call(
            &root,
            "workspace/search",
            &json!({"mode":"text","query":"match","limit":2}),
            &cancel,
        )
        .unwrap();
        assert_eq!(first["matches"].as_array().unwrap().len(), 2);
        assert_eq!(first["nextCursor"], "2");
        let second = call(
            &root,
            "workspace/search",
            &json!({"mode":"text","query":"match","limit":2,"cursor":"2"}),
            &cancel,
        )
        .unwrap();
        assert_eq!(second["matches"][0]["line"], 3);
        assert!(second["nextCursor"].is_null());
        send.send(true).unwrap();
        assert_eq!(
            call(&root, "workspace/search", &json!({}), &cancel).unwrap_err(),
            "WORKSPACE_CANCELLED"
        );
    }

    #[test]
    fn patch_preview_checks_approval_and_preserves_crlf() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("a.txt"), "before\r\nretained\r\n").unwrap();
        let (_, cancel) = watch::channel(false);
        let patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-before\n+after\n*** End Patch";
        let preview = call(
            &root,
            "workspace/apply_patch",
            &json!({"patch":patch,"dryRun":true}),
            &cancel,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "before\r\nretained\r\n"
        );
        assert!(
            call(
                &root,
                "workspace/apply_patch",
                &json!({"patch":patch}),
                &cancel
            )
            .unwrap_err()
            .contains("PATCH_APPROVAL_MISMATCH")
        );
        let params = json!({"patch":patch,"patchHash":preview["patchHash"],"expectedVersions":preview["expectedVersions"]});
        fs::write(root.join("a.txt"), "other\r\n").unwrap();
        assert!(
            call(&root, "workspace/apply_patch", &params, &cancel)
                .unwrap_err()
                .starts_with("VERSION_CONFLICT")
        );
        fs::write(root.join("a.txt"), "before\r\nretained\r\n").unwrap();
        assert_eq!(
            call(&root, "workspace/apply_patch", &params, &cancel).unwrap()["outcome"],
            "completed"
        );
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "after\r\nretained\r\n"
        );
        assert!(
            call(&root, "workspace/apply_patch", &params, &cancel)
                .unwrap_err()
                .starts_with("VERSION_CONFLICT")
        );
        let add_existing = "*** Begin Patch\n*** Add File: a.txt\n+overwrite\n*** End Patch";
        assert!(
            call(
                &root,
                "workspace/apply_patch",
                &json!({"patch":add_existing,"dryRun":true}),
                &cancel
            )
            .unwrap_err()
            .starts_with("VERSION_CONFLICT")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_skips_search_links() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(outside.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        assert!(
            resolve(&root, "escape/secret")
                .unwrap_err()
                .contains("WORKSPACE_PATH_DENIED")
        );
        let (_, cancel) = watch::channel(false);
        let result = call(&root, "workspace/search", &json!({}), &cancel).unwrap();
        assert_eq!(result["skippedEntries"], 1);
        assert_eq!(result["matches"].as_array().unwrap().len(), 0);
    }
}
