// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path},
};

fn component(p: &Value, key: &str) -> Result<String, String> {
    let s = p[key].as_str().ok_or("SKILL_ID_INVALID")?;
    if s.is_empty() || s.len() > 80 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("SKILL_ID_INVALID".into());
    }
    Ok(s.into())
}
fn safe_directory(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path.strip_prefix(root).map_err(|_| "SKILL_PATH_INVALID")?;
    let mut cursor = root.to_path_buf();
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            if !matches!(part, Component::Normal(_)) {
                return Err("SKILL_PATH_INVALID".into());
            }
            cursor.push(part);
        }
        let meta = fs::symlink_metadata(&cursor)
            .map_err(|e| format!("SKILL_DIRECTORY_UNAVAILABLE: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("SKILL_LINK_DENIED".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("SKILL_LINK_DENIED".into());
            }
        }
    }
    Ok(())
}
fn walk(root: &Path, dir: &Path, rows: &mut Vec<Value>, total: &mut u64) -> Result<(), String> {
    safe_directory(root, dir)?;
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("SKILL_LINK_DENIED".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("SKILL_LINK_DENIED".into());
            }
        }
        if meta.is_dir() {
            walk(root, &item.path(), rows, total)?;
        } else if meta.is_file() {
            let digest = super::outputs::file_hash(&item.path())?;
            *total = total.checked_add(meta.len()).ok_or("SKILL_SIZE_INVALID")?;
            let path = item
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            rows.push(json!({"path":path,"bytes":meta.len(),"sha256":digest}));
        } else {
            return Err("SKILL_FILE_INVALID".into());
        }
    }
    Ok(())
}

pub fn call(method: &str, p: &Value) -> Result<Value, String> {
    let root = dirs::data_local_dir()
        .ok_or("SKILL_CACHE_UNAVAILABLE")?
        .join("com.centralcodex.localspike")
        .join("skills-v1");
    call_at(&root, method, p)
}
fn call_at(root: &Path, method: &str, p: &Value) -> Result<Value, String> {
    let scope = component(p, "scope")?;
    let id = component(p, "id")?;
    let path = root.join(scope).join(id);
    if method == "skills/create" {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        safe_directory(root, root)?;
        let parent = path.parent().unwrap();
        if !parent.exists() {
            fs::create_dir(parent).map_err(|e| e.to_string())?;
        }
        safe_directory(root, parent)?;
        if !path.exists() {
            fs::create_dir(&path).map_err(|e| e.to_string())?;
        }
        safe_directory(root, &path)?;
        return Ok(
            json!({"source":"client","path":super::outputs::display_path(&path),"os":std::env::consts::OS}),
        );
    }
    safe_directory(root, &path)?;
    if method == "skills/check" {
        let programs = p["programs"]
            .as_array()
            .ok_or("SKILL_DEPENDENCIES_INVALID")?;
        if programs.len() > 12 {
            return Err("SKILL_DEPENDENCIES_INVALID".into());
        }
        let mut missing = Vec::new();
        for value in programs {
            let name = value.as_str().ok_or("SKILL_DEPENDENCIES_INVALID")?;
            if name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
            {
                return Err("SKILL_DEPENDENCIES_INVALID".into());
            }
            let extensions = if cfg!(windows) {
                vec!["", ".exe", ".cmd", ".bat", ".com"]
            } else {
                vec![""]
            };
            let found = std::env::var_os("PATH").is_some_and(|paths| {
                std::env::split_paths(&paths).any(|dir| {
                    extensions
                        .iter()
                        .any(|ext| dir.join(format!("{name}{ext}")).is_file())
                })
            });
            if !found {
                missing.push(name);
            }
        }
        return Ok(json!({"source":"client","missing":missing}));
    }
    if method == "skills/inspect" {
        let mut rows = Vec::new();
        let mut total = 0;
        walk(&path, &path, &mut rows, &mut total)?;
        rows.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        return Ok(
            json!({"source":"client","path":super::outputs::display_path(&path),"files":rows,"bytes":total,"os":std::env::consts::OS}),
        );
    }
    if method == "skills/read" {
        let raw = p["file"].as_str().ok_or("SKILL_PATH_INVALID")?;
        let relative = Path::new(raw);
        if raw.contains('\\')
            || raw.contains(':')
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("SKILL_PATH_INVALID".into());
        }
        let file = path.join(relative);
        safe_directory(root, file.parent().ok_or("SKILL_PATH_INVALID")?)?;
        let meta = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("SKILL_FILE_INVALID".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("SKILL_LINK_DENIED".into());
            }
        }
        let before = super::attachments::stat(&file)?;
        if Some(super::outputs::file_hash(&file)?.as_str()) != p["sha256"].as_str() {
            return Err("SKILL_SOURCE_CHANGED".into());
        }
        let offset = p["offset"].as_u64().ok_or("SKILL_OFFSET_INVALID")?;
        if offset > meta.len() {
            return Err("SKILL_OFFSET_INVALID".into());
        }
        let mut source = fs::File::open(&file).map_err(|e| e.to_string())?;
        source
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        source
            .take(256 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let end = offset + bytes.len() as u64;
        if super::attachments::stat(&file)?["version"] != before["version"] {
            return Err("SKILL_SOURCE_CHANGED".into());
        }
        return Ok(json!({"data":STANDARD.encode(&bytes),"nextOffset":end,"done":end==meta.len()}));
    }
    Err("SKILL_METHOD_UNSUPPORTED".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn package_snapshot_detects_changes_and_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("cache");
        let p = json!({"scope":"user-a","id":"draft-a"});
        call_at(&root, "skills/create", &p).unwrap();
        fs::write(root.join("user-a/draft-a/SKILL.md"), "hello").unwrap();
        let snapshot = call_at(&root, "skills/inspect", &p).unwrap();
        let read = json!({"scope":"user-a","id":"draft-a","file":"SKILL.md","sha256":snapshot["files"][0]["sha256"],"offset":0});
        assert_eq!(
            call_at(&root, "skills/read", &read).unwrap()["data"],
            "aGVsbG8="
        );
        fs::write(root.join("user-a/draft-a/SKILL.md"), "changed").unwrap();
        assert!(
            call_at(&root, "skills/read", &read)
                .unwrap_err()
                .contains("SOURCE_CHANGED")
        );
        assert!(call_at(&root, "skills/create", &json!({"scope":"..","id":"a"})).is_err());
        assert!(
            call_at(
                &root,
                "skills/read",
                &json!({"scope":"user-a","id":"draft-a","file":"../secret","offset":0})
            )
            .is_err()
        );
    }
}
