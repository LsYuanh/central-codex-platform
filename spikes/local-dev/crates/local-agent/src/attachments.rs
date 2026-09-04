// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageFormat, ImageReader, Limits};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};
use uuid::Uuid;

pub const CHUNK: usize = 256 * 1024;
const IMAGE_LIMIT: usize = 5 * 1024 * 1024;
const MEMORY_LIMIT: usize = 20 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(60);
struct Transfer {
    bytes: Vec<u8>,
    path: Option<PathBuf>,
    version: String,
    touched: Instant,
}
pub struct Attachments {
    root: PathBuf,
    allow_absolute: bool,
    transfers: HashMap<String, Transfer>,
    temp_root: PathBuf,
    identity: Value,
    outputs: super::outputs::Outputs,
}

impl Attachments {
    pub fn new(root: PathBuf, allow_absolute: bool) -> Self {
        Self {
            outputs: super::outputs::Outputs::new(root.clone(), allow_absolute),
            root,
            allow_absolute,
            transfers: HashMap::new(),
            temp_root: std::env::temp_dir().join("codexia-attachments-v1"),
            identity: json!({}),
        }
    }
    pub fn set_identity(&mut self, device_id: String, device_key: String) {
        self.identity = json!({"deviceId":device_id,"deviceKey":device_key,"workspaceRoot":super::outputs::display_path(&self.root)});
    }
    pub fn has_transfers(&mut self) -> bool {
        self.expire();
        !self.transfers.is_empty() || self.outputs.has_transfers()
    }
    pub fn expire(&mut self) {
        self.transfers.retain(|_, t| t.touched.elapsed() < TTL);
        self.outputs.expire();
    }
    fn resolve(&self, p: &Value) -> Result<PathBuf, String> {
        let raw = super::required_string(p, "path")?;
        let path = Path::new(raw);
        if path.is_absolute() && self.allow_absolute {
            if raw.starts_with("\\\\") || raw.starts_with("//") {
                return Err("NETWORK_PATH_UNSUPPORTED".into());
            }
            path.canonicalize().map_err(|e| e.to_string())
        } else {
            super::resolve_existing_path(&self.root, raw)
        }
    }
    pub fn call(&mut self, method: &str, p: &Value, local: bool) -> Result<Value, String> {
        self.expire();
        match method {
            "file/write_text" | "file/write_begin" | "file/write_chunk" | "file/write_commit"
            | "file/write_abort" | "file/copy" | "file/publish" | "file/output_paths"
            | "file/reveal" => self.outputs.call(method, p, local),
            "attachment/identity" if local => Ok(self.identity.clone()),
            "file/stat" => {
                let path = self.resolve(p)?;
                let mut info = stat(&path)?;
                let requested = Path::new(super::required_string(p, "path")?);
                let original = if requested.is_absolute() {
                    requested.to_path_buf()
                } else {
                    self.root.join(requested)
                };
                info["isSymlink"] = json!(
                    fs::symlink_metadata(original)
                        .map(|m| m.file_type().is_symlink())
                        .unwrap_or(false)
                );
                Ok(info)
            }
            "file/read_text" => {
                let path = self.resolve(p)?;
                let before = stat(&path)?;
                check_version(p, &before)?;
                if before["kind"] == "image" || before["kind"] == "document" {
                    return Err(
                        "FORMAT_UNSUPPORTED: use an image input or a local document parser".into(),
                    );
                }
                let offset = p["offset"].as_u64().unwrap_or(0);
                let mut file = File::open(&path).map_err(|e| e.to_string())?;
                if offset > before["bytes"].as_u64().unwrap_or(0) {
                    return Err("INVALID_OFFSET".into());
                }
                file.seek(SeekFrom::Start(offset))
                    .map_err(|e| e.to_string())?;
                let mut data = Vec::new();
                file.take(64 * 1024)
                    .read_to_end(&mut data)
                    .map_err(|e| e.to_string())?;
                if data.contains(&0) {
                    return Err("ENCODING_UNSUPPORTED: expected UTF-8 text".into());
                }
                let end = match std::str::from_utf8(&data) {
                    Ok(_) => data.len(),
                    Err(e)
                        if e.error_len().is_none()
                            && offset + (data.len() as u64)
                                < before["bytes"].as_u64().unwrap_or(0) =>
                    {
                        e.valid_up_to()
                    }
                    Err(_) => return Err("ENCODING_UNSUPPORTED: expected UTF-8 text".into()),
                };
                if end == 0 && !data.is_empty() {
                    return Err("ENCODING_UNSUPPORTED".into());
                }
                let after = stat(&path)?;
                if before["version"] != after["version"] {
                    return Err("SOURCE_CHANGED".into());
                }
                let next = offset + end as u64;
                Ok(
                    json!({"path": before["path"], "version": before["version"], "content": std::str::from_utf8(&data[..end]).unwrap(), "offset":offset, "nextOffset":next, "truncated": next < before["bytes"].as_u64().unwrap_or(0), "encoding":"utf-8"}),
                )
            }
            "file/read_image" | "attachment/preview" | "attachment/output_preview" => {
                if method.starts_with("attachment/") && !local {
                    return Err("LOCAL_IPC_ONLY".into());
                }
                let path = self.resolve(p)?;
                let info = stat(&path)?;
                check_version(p, &info)?;
                let image_limit = if local {
                    super::outputs::OUTPUT_LIMIT
                } else {
                    IMAGE_LIMIT
                };
                if info["bytes"].as_u64().unwrap_or(u64::MAX) > image_limit as u64 {
                    return Err("IMAGE_TOO_LARGE: maximum 5 MiB".into());
                }
                let mut bytes = Vec::new();
                File::open(&path)
                    .map_err(|e| e.to_string())?
                    .take(image_limit as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > image_limit {
                    return Err("IMAGE_TOO_LARGE".into());
                }
                let decoded = decode(&bytes)?;
                if info["version"] != stat(&path)?["version"] {
                    return Err("SOURCE_CHANGED".into());
                }
                if method.starts_with("attachment/") {
                    let (width, height) = if method == "attachment/output_preview" {
                        (960, 720)
                    } else {
                        (240, 180)
                    };
                    let thumb = decoded.thumbnail(width, height).to_rgb8();
                    let mut encoded = Cursor::new(Vec::new());
                    image::DynamicImage::ImageRgb8(thumb)
                        .write_to(&mut encoded, ImageFormat::Jpeg)
                        .map_err(|e| e.to_string())?;
                    return Ok(
                        json!({"url":format!("data:image/jpeg;base64,{}", STANDARD.encode(encoded.into_inner())), "version":info["version"]}),
                    );
                }
                let format = image::guess_format(&bytes).map_err(|e| e.to_string())?;
                let mime = match format {
                    ImageFormat::Png => "image/png",
                    ImageFormat::Jpeg => "image/jpeg",
                    ImageFormat::WebP => "image/webp",
                    ImageFormat::Gif => "image/gif",
                    _ => return Err("IMAGE_FORMAT_UNSUPPORTED".into()),
                };
                let total = bytes.len();
                let id = self.insert(
                    bytes,
                    Some(path),
                    info["version"].as_str().unwrap_or("").to_owned(),
                )?;
                Ok(
                    json!({"transferId":id, "totalBytes":total, "chunkBytes":CHUNK, "mimeType":mime, "width":decoded.width(), "height":decoded.height(), "version":info["version"]}),
                )
            }
            "file/read_chunk" => {
                let id = super::required_string(p, "transferId")?;
                let offset = p["offset"].as_u64().ok_or("INVALID_OFFSET")? as usize;
                let t = self.transfers.get_mut(id).ok_or("TRANSFER_EXPIRED")?;
                if let Some(path) = &t.path {
                    if stat(path)?["version"] != t.version {
                        return Err("SOURCE_CHANGED".into());
                    }
                }
                if offset > t.bytes.len() || offset % CHUNK != 0 {
                    return Err("INVALID_OFFSET".into());
                }
                let end = (offset + CHUNK).min(t.bytes.len());
                t.touched = Instant::now();
                Ok(
                    json!({"transferId":id, "offset":offset, "sequence":offset/CHUNK, "totalBytes":t.bytes.len(), "data": STANDARD.encode(&t.bytes[offset..end]), "done":end == t.bytes.len()}),
                )
            }
            "file/close_transfer" => {
                self.transfers
                    .remove(super::required_string(p, "transferId")?);
                Ok(json!({"closed":true}))
            }
            "attachment/import_begin" if local => {
                let id = self.insert(Vec::new(), None, String::new())?;
                Ok(json!({"transferId":id}))
            }
            "attachment/import_chunk" if local => {
                let data = super::required_string(p, "data")?;
                if data.len() > CHUNK * 4 / 3 + 4 {
                    return Err("CHUNK_TOO_LARGE".into());
                }
                let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
                let t = self
                    .transfers
                    .get_mut(super::required_string(p, "transferId")?)
                    .ok_or("TRANSFER_EXPIRED")?;
                if t.path.is_some()
                    || p["offset"].as_u64() != Some(t.bytes.len() as u64)
                    || t.bytes.len() + bytes.len() > IMAGE_LIMIT
                {
                    return Err("INVALID_IMPORT_CHUNK".into());
                }
                t.bytes.extend(bytes);
                t.touched = Instant::now();
                Ok(json!({"nextOffset":t.bytes.len()}))
            }
            "attachment/import_commit" if local => {
                let id = super::required_string(p, "transferId")?;
                let t = self.transfers.remove(id).ok_or("TRANSFER_EXPIRED")?;
                if t.path.is_some() {
                    return Err("INVALID_IMPORT".into());
                }
                decode(&t.bytes)?;
                fs::create_dir_all(&self.temp_root).map_err(|e| e.to_string())?;
                // Only UUID files registered by this Agent are eligible for expiry.
                self.cleanup_temp()?;
                let used: u64 = fs::read_dir(&self.temp_root)
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .filter_map(|e| e.metadata().ok())
                    .map(|m| m.len())
                    .sum();
                if used + t.bytes.len() as u64 > 100 * 1024 * 1024 {
                    return Err("TEMP_CAPACITY: retained attachments reached 100 MiB".into());
                }
                let extension = match image::guess_format(&t.bytes).map_err(|e| e.to_string())? {
                    ImageFormat::Png => "png",
                    ImageFormat::Jpeg => "jpg",
                    ImageFormat::WebP => "webp",
                    ImageFormat::Gif => "gif",
                    _ => return Err("IMAGE_FORMAT_UNSUPPORTED".into()),
                };
                let target = self.temp_root.join(format!("{id}.{extension}"));
                let mut out = File::options()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .map_err(|e| e.to_string())?;
                out.write_all(&t.bytes).map_err(|e| e.to_string())?;
                fs::write(
                    self.temp_root.join(format!("{id}.registered")),
                    target.file_name().unwrap().to_string_lossy().as_bytes(),
                )
                .map_err(|e| e.to_string())?;
                stat(&target)
            }
            // Remove references never deletes original files. Clipboard files expire after 7 days.
            _ => Err(format!("UNSUPPORTED_ATTACHMENT_METHOD: {method}")),
        }
    }
    fn insert(
        &mut self,
        bytes: Vec<u8>,
        path: Option<PathBuf>,
        version: String,
    ) -> Result<String, String> {
        if self.transfers.len() >= 4
            || self
                .transfers
                .values()
                .map(|t| t.bytes.len())
                .sum::<usize>()
                + bytes.len()
                > MEMORY_LIMIT
        {
            return Err("TRANSFER_BUSY".into());
        }
        let id = Uuid::new_v4().to_string();
        self.transfers.insert(
            id.clone(),
            Transfer {
                bytes,
                path,
                version,
                touched: Instant::now(),
            },
        );
        Ok(id)
    }
    fn cleanup_temp(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.temp_root)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let marker = entry.path();
            if marker.extension().and_then(|s| s.to_str()) != Some("registered") {
                continue;
            }
            let Some(id) = marker.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if Uuid::parse_str(id).is_err()
                || entry
                    .metadata()
                    .map_err(|e| e.to_string())?
                    .modified()
                    .map_err(|e| e.to_string())?
                    .elapsed()
                    .unwrap_or_default()
                    < Duration::from_secs(7 * 86400)
            {
                continue;
            }
            let name = fs::read_to_string(&marker).map_err(|e| e.to_string())?;
            if ["png", "jpg", "webp", "gif"]
                .iter()
                .any(|ext| name == format!("{id}.{ext}"))
            {
                let _ = fs::remove_file(self.temp_root.join(name));
                let _ = fs::remove_file(marker);
            }
        }
        Ok(())
    }
}
fn check_version(p: &Value, stat: &Value) -> Result<(), String> {
    if let Some(version) = p["version"].as_str() {
        if stat["version"] != version {
            return Err("SOURCE_CHANGED".into());
        }
    }
    Ok(())
}
pub(crate) fn decode(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    let (width, height) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| format!("IMAGE_DECODE_FAILED: {e}"))?;
    if u64::from(width) * u64::from(height) > 16_000_000 {
        return Err("IMAGE_PIXEL_LIMIT: maximum 16 megapixels".into());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(80 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| format!("IMAGE_DECODE_FAILED: {e}"))?;
    if u64::from(image.width()) * u64::from(image.height()) > 16_000_000 {
        return Err("IMAGE_PIXEL_LIMIT: maximum 16 megapixels".into());
    }
    Ok(image)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("codexia-unit-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn agent(&self, absolute: bool) -> Attachments {
            let root = self.0.join("workspace");
            fs::create_dir_all(&root).unwrap();
            Attachments::new(root.canonicalize().unwrap(), absolute)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn absolute_attachment_and_relative_sandbox() {
        let f = Fixture::new();
        let p = f.0.join("outside.txt");
        fs::write(&p, "client-only").unwrap();
        let mut trusted = f.agent(true);
        let mut restricted = f.agent(false);
        assert_eq!(
            trusted
                .call("file/read_text", &json!({"path":p}), false)
                .unwrap()["content"],
            "client-only"
        );
        assert!(
            restricted
                .call("file/stat", &json!({"path":p}), false)
                .is_err()
        );
        assert!(
            trusted
                .call("file/stat", &json!({"path":"../outside.txt"}), false)
                .is_err()
        );
        assert!(
            trusted
                .call("file/stat", &json!({"path":"C:outside.txt"}), false)
                .is_err()
        );
    }
    #[test]
    fn text_pages_preserve_utf8_and_detect_change() {
        let f = Fixture::new();
        let p = f.0.join("text.txt");
        let content = "a".repeat(65535) + "你好";
        fs::write(&p, &content).unwrap();
        let mut a = f.agent(true);
        let first = a.call("file/read_text", &json!({"path":p}), false).unwrap();
        assert_eq!(first["nextOffset"], 65535);
        assert_eq!(first["truncated"], true);
        let second = a
            .call(
                "file/read_text",
                &json!({"path":p,"offset":first["nextOffset"],"version":first["version"]}),
                false,
            )
            .unwrap();
        assert_eq!(second["content"], "你好");
        assert_eq!(second["truncated"], false);
        fs::write(&p, "changed").unwrap();
        assert!(
            a.call(
                "file/read_text",
                &json!({"path":p,"version":first["version"]}),
                false
            )
            .unwrap_err()
            .contains("SOURCE_CHANGED")
        );
        fs::write(&p, [0, 1, 2, 255]).unwrap();
        assert!(
            a.call("file/read_text", &json!({"path":p}), false)
                .unwrap_err()
                .contains("ENCODING_UNSUPPORTED")
        );
    }
    #[test]
    fn image_chunks_bound_frames_detect_change_and_close() {
        let f = Fixture::new();
        let p = f.0.join("image.png");
        let mut seed = 7u32;
        let image = image::RgbImage::from_fn(700, 700, |_, _| {
            let mut rgb = [0; 3];
            for v in &mut rgb {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                *v = (seed >> 24) as u8;
            }
            image::Rgb(rgb)
        });
        image.save(&p).unwrap();
        let original = fs::read(&p).unwrap();
        assert!(original.len() > 1024 * 1024);
        let mut a = f.agent(true);
        let open = a
            .call("file/read_image", &json!({"path":p}), false)
            .unwrap();
        let id = &open["transferId"];
        let mut restored = Vec::new();
        for offset in (0..original.len()).step_by(CHUNK) {
            let chunk = a
                .call(
                    "file/read_chunk",
                    &json!({"transferId":id,"offset":offset}),
                    false,
                )
                .unwrap();
            assert!(chunk.to_string().len() < 1024 * 1024);
            restored.extend(STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
        }
        assert_eq!(restored, original);
        fs::write(&p, "changed").unwrap();
        assert!(
            a.call(
                "file/read_chunk",
                &json!({"transferId":id,"offset":0}),
                false
            )
            .unwrap_err()
            .contains("SOURCE_CHANGED")
        );
        a.call("file/close_transfer", &json!({"transferId":id}), false)
            .unwrap();
        assert!(a.transfers.is_empty());
    }
    #[test]
    fn clipboard_is_local_only_and_retains_original() {
        let f = Fixture::new();
        let mut a = f.agent(true);
        a.temp_root = f.0.join("temp");
        assert!(
            a.call("attachment/import_begin", &json!({}), false)
                .is_err()
        );
        let begin = a.call("attachment/import_begin", &json!({}), true).unwrap();
        let id = &begin["transferId"];
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        a.call(
            "attachment/import_chunk",
            &json!({"transferId":id,"offset":0,"data":STANDARD.encode(bytes.into_inner())}),
            true,
        )
        .unwrap();
        let saved = a
            .call("attachment/import_commit", &json!({"transferId":id}), true)
            .unwrap();
        assert!(Path::new(saved["path"].as_str().unwrap()).is_file());
        a.cleanup_temp().unwrap();
        assert!(Path::new(saved["path"].as_str().unwrap()).is_file());
        assert!(
            a.call("attachment/import_commit", &json!({"transferId":id}), true)
                .is_err()
        );
    }
}
pub(crate) fn stat(path: &Path) -> Result<Value, String> {
    let m = path.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() {
        return Err("NOT_A_FILE".into());
    }
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    let (kind, mime) = match ext.as_str() {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "webp" => ("image", "image/webp"),
        "gif" => ("image", "image/gif"),
        "pdf" | "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" => {
            ("document", "application/octet-stream")
        }
        "txt" | "md" | "rs" | "ts" | "tsx" | "js" | "json" | "csv" | "py" | "css" | "html"
        | "log" | "toml" | "yaml" | "yml" => ("text", "text/plain"),
        _ => ("unknown", "application/octet-stream"),
    };
    let modified = m
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let raw = path.to_string_lossy();
    let display = raw.strip_prefix("\\\\?\\").unwrap_or(&raw);
    Ok(
        json!({"path":display,"name":path.file_name().unwrap_or_default().to_string_lossy(),"bytes":m.len(),"modifiedAt":modified.as_millis().to_string(),"version":format!("{}:{}",m.len(),modified.as_nanos()),"kind":kind,"mimeType":mime,"isSymlink":fs::symlink_metadata(path).map(|m|m.file_type().is_symlink()).unwrap_or(false)}),
    )
}
