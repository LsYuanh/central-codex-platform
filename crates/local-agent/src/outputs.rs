// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::path::Component;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

struct PendingWrite {
    params: Value,
    file: tempfile::NamedTempFile,
    received: u64,
    total: u64,
    sha256: String,
    touched: Instant,
}
pub struct Outputs {
    root: PathBuf,
    absolute: bool,
    downloads: PathBuf,
    writes: HashMap<String, PendingWrite>,
}

impl Outputs {
    pub fn has_transfers(&self) -> bool {
        !self.writes.is_empty()
    }
    pub fn new(root: PathBuf, _absolute: bool) -> Self {
        let downloads = dirs::download_dir()
            .or_else(|| dirs::home_dir().map(|p| p.join("Downloads")))
            .unwrap_or_else(|| root.clone())
            .join("Codexia");
        Self {
            root,
            absolute: true,
            downloads,
            writes: HashMap::new(),
        }
    }
    pub fn expire(&mut self) {
        self.writes
            .retain(|_, w| w.touched.elapsed() < Duration::from_secs(60));
    }
    pub fn call(&mut self, method: &str, p: &Value, local: bool) -> Result<Value, String> {
        self.expire();
        match method {
            "file/output_paths" => Ok(
                json!({"downloads":display_path(&self.downloads),"workspace":display_path(&self.root),"outputDirectory":display_path(&self.root),"absolutePaths":self.absolute}),
            ),
            "file/write_text" => {
                let content = p["content"].as_str().ok_or("content must be UTF-8 text")?;
                self.save(p, content.as_bytes())
            }
            "file/write_begin" => {
                let total = p["totalBytes"].as_u64().ok_or("INVALID_TOTAL_BYTES")?;
                let sha256 = p["sha256"]
                    .as_str()
                    .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
                    .ok_or("sha256 is required")?
                    .to_lowercase();
                self.destination(p)?;
                let id = Uuid::new_v4().to_string();
                self.writes.insert(
                    id.clone(),
                    PendingWrite {
                        params: p.clone(),
                        file: tempfile::NamedTempFile::new().map_err(|e| e.to_string())?,
                        received: 0,
                        total,
                        sha256,
                        touched: Instant::now(),
                    },
                );
                Ok(json!({"transferId":id,"chunkBytes":super::attachments::CHUNK}))
            }
            "file/write_chunk" => {
                let encoded = p["data"].as_str().ok_or("data is required")?;
                if encoded.len() > super::attachments::CHUNK * 4 / 3 + 4 {
                    return Err("CHUNK_TOO_LARGE".into());
                }
                let data = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
                let w = self
                    .writes
                    .get_mut(super::required_string(p, "transferId")?)
                    .ok_or("WRITE_EXPIRED")?;
                let offset = p["offset"].as_u64().ok_or("INVALID_OFFSET")?;
                if data.len() > super::attachments::CHUNK {
                    return Err("CHUNK_TOO_LARGE".into());
                }
                let end = offset
                    .checked_add(data.len() as u64)
                    .ok_or("INVALID_OFFSET")?;
                // Idempotent chunk replay compares bytes on disk, without retaining the file in RAM.
                if offset < w.received && end <= w.received {
                    let mut previous = vec![0; data.len()];
                    w.file
                        .seek(SeekFrom::Start(offset))
                        .and_then(|_| w.file.read_exact(&mut previous))
                        .map_err(|e| e.to_string())?;
                    if previous != data {
                        return Err("INVALID_WRITE_CHUNK".into());
                    }
                } else {
                    if offset != w.received || end > w.total {
                        return Err("INVALID_WRITE_CHUNK".into());
                    }
                    w.file
                        .seek(SeekFrom::Start(offset))
                        .and_then(|_| w.file.write_all(&data))
                        .map_err(|e| e.to_string())?;
                    w.received = end;
                }
                w.touched = Instant::now();
                Ok(json!({"nextOffset":w.received}))
            }
            "file/write_commit" => {
                let id = super::required_string(p, "transferId")?;
                let w = self.writes.get(id).ok_or("WRITE_EXPIRED")?;
                if w.received != w.total || file_hash(w.file.path())? != w.sha256 {
                    return Err("WRITE_CHECKSUM_MISMATCH".into());
                }
                let result = self.save_file(&w.params, w.file.path())?;
                self.writes.remove(id);
                Ok(result)
            }
            "file/write_abort" => {
                self.writes.remove(super::required_string(p, "transferId")?);
                Ok(json!({"closed":true}))
            }
            "file/copy" => {
                let source = self.existing(super::required_string(p, "sourcePath")?)?;
                self.save_file(p, &source)
            }
            "file/publish" => {
                let path = self.existing(super::required_string(p, "path")?)?;
                verified(&path)
            }
            "file/reveal" if local => {
                let path = self.existing(super::required_string(p, "path")?)?;
                let parent = path.parent().ok_or("No parent directory")?;
                let mut command = if cfg!(target_os = "windows") {
                    std::process::Command::new("explorer.exe")
                } else if cfg!(target_os = "macos") {
                    std::process::Command::new("open")
                } else {
                    std::process::Command::new("xdg-open")
                };
                command.arg(parent).spawn().map_err(|e| e.to_string())?;
                Ok(json!({"opened":true,"directory":display_path(parent)}))
            }
            _ => Err(format!("UNSUPPORTED_OUTPUT_METHOD: {method}")),
        }
    }
    fn existing(&self, raw: &str) -> Result<PathBuf, String> {
        super::workspace::resolve(&self.root, raw)
    }
    fn destination(&self, p: &Value) -> Result<PathBuf, String> {
        let requested = if let Some(raw) = p["path"].as_str().filter(|v| !v.is_empty()) {
            validate_path(raw)?;
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                if !self.absolute {
                    return Err("ABSOLUTE_WRITE_DISABLED".into());
                }
                path
            } else {
                self.root.join(path)
            }
        } else {
            if !self.absolute {
                return Err("ABSOLUTE_WRITE_DISABLED".into());
            }
            let name = super::required_string(p, "name")?;
            if name.contains(['/', '\\', ':']) || name == "." || name == ".." {
                return Err("INVALID_OUTPUT_NAME".into());
            }
            validate_path(name)?;
            self.root.join(name)
        };
        let parent = requested.parent().ok_or("INVALID_OUTPUT_PATH")?;
        let mut ancestor = parent;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("INVALID_OUTPUT_PARENT")?;
        }
        let canonical = ancestor.canonicalize().map_err(|e| e.to_string())?;
        if let Ok(meta) = fs::metadata(&requested) {
            if !meta.is_file() {
                return Err("OUTPUT_TARGET_NOT_REGULAR_FILE".into());
            }
            return requested.canonicalize().map_err(|e| e.to_string());
        }
        Ok(canonical.join(
            requested
                .strip_prefix(ancestor)
                .map_err(|e| e.to_string())?,
        ))
    }
    fn save(&self, p: &Value, data: &[u8]) -> Result<Value, String> {
        let mut source = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        source.write_all(data).map_err(|e| e.to_string())?;
        self.save_file(p, source.path())
    }
    fn save_file(&self, p: &Value, source: &Path) -> Result<Value, String> {
        let target = self.destination(p)?;
        let digest = file_hash(source)?;
        let total = fs::metadata(source).map_err(|e| e.to_string())?.len();
        let exists = target.exists();
        if exists {
            if fs::metadata(&target).map_err(|e| e.to_string())?.len() == total
                && file_hash(&target)? == digest
            {
                return verified(&target);
            }
            if p["overwrite"] != true {
                return Err(
                    "FILE_EXISTS: choose another name or explicitly overwrite with expectedVersion"
                        .into(),
                );
            }
            let version = p["expectedVersion"]
                .as_str()
                .ok_or("EXPECTED_VERSION_REQUIRED")?;
            if super::attachments::stat(&target)?["version"] != version {
                return Err("SOURCE_CHANGED".into());
            }
        }
        let parent = target.parent().ok_or("INVALID_OUTPUT_PARENT")?;
        fs::create_dir_all(parent).map_err(|e| format!("CREATE_DIRECTORY_FAILED: {e}"))?;
        self.destination(p)?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("WRITE_DENIED: {e}"))?;
        std::io::copy(
            &mut fs::File::open(source).map_err(|e| e.to_string())?,
            &mut temporary,
        )
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| format!("WRITE_FAILED: {e}"))?;
        // A user-owned copy source can change during streaming. Verify the
        // complete staged snapshot before replacing an existing destination.
        if temporary
            .as_file()
            .metadata()
            .map_err(|e| e.to_string())?
            .len()
            != total
            || file_hash(temporary.path())? != digest
        {
            return Err("SOURCE_CHANGED".into());
        }
        if exists {
            if super::attachments::stat(&target)?["version"] != p["expectedVersion"] {
                return Err("SOURCE_CHANGED".into());
            }
            temporary
                .persist(&target)
                .map_err(|e| format!("WRITE_COMMIT_FAILED: {e}"))?;
        } else {
            temporary
                .persist_noclobber(&target)
                .map_err(|e| format!("WRITE_COMMIT_FAILED: {e}"))?;
        }
        let result = verified(&target)?;
        if result["sha256"] != digest {
            return Err("WRITE_VERIFY_FAILED".into());
        }
        Ok(result)
    }
}
pub(crate) fn validate_path(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.contains(['\0', '\r', '\n']) {
        return Err("INVALID_LOCAL_PATH".into());
    }
    #[cfg(windows)]
    {
        let path = Path::new(raw);
        if path.has_root() && !path.is_absolute()
            || path.components().any(|c| match c {
                Component::Prefix(prefix) => {
                    !path.is_absolute()
                        || !matches!(
                            prefix.kind(),
                            std::path::Prefix::Disk(_)
                                | std::path::Prefix::UNC(_, _)
                                | std::path::Prefix::VerbatimDisk(_)
                                | std::path::Prefix::VerbatimUNC(_, _)
                        )
                }
                Component::Normal(part) => {
                    part.to_string_lossy().contains(':')
                        || part.to_string_lossy().ends_with(['.', ' '])
                }
                _ => false,
            })
        {
            return Err("INVALID_WINDOWS_PATH".into());
        }
    }
    Ok(())
}
pub fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        value.trim_start_matches("\\\\?\\").to_string()
    }
}
pub(crate) fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
#[cfg(test)]
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn verified(path: &Path) -> Result<Value, String> {
    let mut before = super::attachments::stat(path)?;
    let digest = file_hash(path)?;
    if before["version"] != super::attachments::stat(path)?["version"] {
        return Err("SOURCE_CHANGED".into());
    }
    before["sha256"] = json!(digest);
    before["verified"] = json!(true);
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absolute_write_verify_overwrite_and_failure() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let dest = temp.path().join("outside/result.txt");
        let raw = display_path(&dest);
        let mut files = Outputs::new(root.clone(), true);
        let first = files
            .call(
                "file/write_text",
                &json!({"path":raw,"content":"client output"}),
                false,
            )
            .unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "client output");
        assert_eq!(first["verified"], true);
        assert!(
            files
                .call(
                    "file/write_text",
                    &json!({"path":raw,"content":"new"}),
                    false
                )
                .unwrap_err()
                .contains("FILE_EXISTS")
        );
        assert!(
            files
                .call(
                    "file/write_text",
                    &json!({"path":raw,"content":"new","overwrite":true,"expectedVersion":"old"}),
                    false
                )
                .is_err()
        );
        files.call("file/write_text",&json!({"path":raw,"content":"new","overwrite":true,"expectedVersion":first["version"]}),false).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new");
        assert!(
            Outputs::new(root, false)
                .call(
                    "file/write_text",
                    &json!({"path":raw,"content":"no"}),
                    false
                )
                .is_err()
        );
        assert!(
            files
                .call(
                    "file/write_text",
                    &json!({"path":"../escape.txt","content":"external output"}),
                    false
                )
                .is_ok()
        );
    }
    #[test]
    fn chunk_integrity_abort_and_default_directory() {
        let temp = tempfile::tempdir().unwrap();
        let mut files = Outputs::new(temp.path().canonicalize().unwrap(), true);
        files.downloads = temp.path().join("Downloads/Codexia");
        let bytes = vec![42; super::super::attachments::CHUNK + 13];
        let p = json!({"name":"result.bin","totalBytes":bytes.len(),"sha256":hash(&bytes)});
        let id = files.call("file/write_begin", &p, false).unwrap()["transferId"].clone();
        for (index, part) in bytes.chunks(super::super::attachments::CHUNK).enumerate() {
            let chunk = json!({"transferId":id,"offset":index*super::super::attachments::CHUNK,"data":STANDARD.encode(part)});
            files.call("file/write_chunk", &chunk, false).unwrap();
            files.call("file/write_chunk", &chunk, false).unwrap();
        }
        let result = files
            .call("file/write_commit", &json!({"transferId":id}), false)
            .unwrap();
        assert_eq!(result["sha256"], hash(&bytes));
        assert_eq!(fs::read(files.root.join("result.bin")).unwrap(), bytes);
        assert!(
            files
                .call("file/reveal", &json!({"path":result["path"]}), false)
                .is_err()
        );
        let id = files
            .call(
                "file/write_begin",
                &json!({"name":"bad.bin","totalBytes":2,"sha256":hash(b"ab")}),
                false,
            )
            .unwrap()["transferId"]
            .clone();
        assert!(
            files
                .call("file/write_commit", &json!({"transferId":id}), false)
                .is_err()
        );
        files
            .call("file/write_abort", &json!({"transferId":id}), false)
            .unwrap();
        assert!(!files.downloads.join("bad.bin").exists());
    }
}
