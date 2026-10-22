// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Native update authority. Only a signed complete runtime can become a candidate.
use crate::{config, runtime_package};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, &'static str>;
const CHANNEL: &str = include_str!("../../../../harness/runtime-update-channel.json");
const PIN: &str = include_str!("../../../../harness/upstream.json");
const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    manifest_url: String,
    public_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Envelope {
    pub payload: String,
    pub signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Descriptor {
    pub schema_version: u32,
    pub version: String,
    pub sequence: u64,
    pub host_protocol: String,
    pub archive_url: String,
    pub archive_bytes: u64,
    pub archive_sha256: String,
    pub package: serde_json::Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Selection {
    pub baseline_id: String,
    pub active: Envelope,
    pub previous: Option<Envelope>,
    pub pending: bool,
    pub backup_id: String,
    pub data_directory: PathBuf,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: &'static str,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub checked_at: Option<u64>,
    pub code: Option<&'static str>,
}
pub struct Updater {
    status: Mutex<Status>,
    pub(crate) candidate: Mutex<Option<Envelope>>,
    requested: AtomicBool,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn version(value: &str) -> Option<[u32; 3]> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some([
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ])
}
pub(crate) fn root(app_data: &Path) -> Result<PathBuf> {
    config::resource_root(&app_data.join("runtime-updates"), true)
        .map_err(|_| "UPDATE_STORAGE_UNSAFE")
}
fn public_download(url: &str) -> bool {
    url.starts_with("https://github.com/LsYuanh/central-codex-platform/releases/download/")
        && !url.contains(['?', '#', '\\'])
}
fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent("Yuan-Zhou-runtime-updates")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5
                && attempt.url().scheme() == "https"
                && matches!(
                    attempt.url().host_str(),
                    Some(
                        "github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| "UPDATE_NETWORK_UNAVAILABLE")
}
fn get(url: &str, max: u64) -> Result<Vec<u8>> {
    let response = client()?
        .get(url)
        // Runtime archives can take several minutes on ordinary LAN uplinks.
        .timeout(Duration::from_secs(if max > 2 * 1024 * 1024 {
            600
        } else {
            60
        }))
        .send()
        .map_err(|_| "UPDATE_NETWORK_UNAVAILABLE")?;
    if response.status().as_u16() == 404 {
        return Err("UPDATE_CHANNEL_NOT_PUBLISHED");
    }
    if !response.status().is_success() {
        return Err("UPDATE_DOWNLOAD_FAILED");
    }
    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "UPDATE_DOWNLOAD_FAILED")?;
    if bytes.len() as u64 > max {
        return Err("UPDATE_DOWNLOAD_TOO_LARGE");
    }
    Ok(bytes)
}
pub(crate) fn authenticate(envelope: &Envelope) -> Result<Descriptor> {
    let channel: Channel = serde_json::from_str(CHANNEL).map_err(|_| "UPDATE_CHANNEL_INVALID")?;
    authenticate_with_key(envelope, &channel.public_key)
}
fn authenticate_with_key(envelope: &Envelope, public_key: &str) -> Result<Descriptor> {
    if envelope.payload.len() > 2 * 1024 * 1024 || envelope.signature.len() > 4096 {
        return Err("UPDATE_SIGNATURE_INVALID");
    }
    let key = STANDARD
        .decode(public_key.trim())
        .map_err(|_| "UPDATE_CHANNEL_INVALID")?;
    let key = minisign_verify::PublicKey::decode(
        std::str::from_utf8(&key).map_err(|_| "UPDATE_CHANNEL_INVALID")?,
    )
    .map_err(|_| "UPDATE_CHANNEL_INVALID")?;
    let signature = STANDARD
        .decode(envelope.signature.trim())
        .map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
    let signature = minisign_verify::Signature::decode(
        std::str::from_utf8(&signature).map_err(|_| "UPDATE_SIGNATURE_INVALID")?,
    )
    .map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
    key.verify(envelope.payload.as_bytes(), &signature, false)
        .map_err(|_| "UPDATE_SIGNATURE_INVALID")?;
    let descriptor: Descriptor =
        serde_json::from_str(&envelope.payload).map_err(|_| "UPDATE_DESCRIPTOR_INVALID")?;
    validate_descriptor(&descriptor)?;
    Ok(descriptor)
}
fn validate_descriptor(d: &Descriptor) -> Result<()> {
    let id = d.package["id"]
        .as_str()
        .ok_or("UPDATE_DESCRIPTOR_INVALID")?;
    if d.schema_version != 1
        || !matches!(
            d.host_protocol.as_str(),
            "central-runtime-update/v1" | "central-runtime-update/v2"
        )
        || d.sequence == 0
        || version(&d.version).is_none()
        || d.package["version"] != d.version
        || d.package["platform"] != "darwin"
        || d.package["architecture"] != "aarch64"
        || id.len() > 120
        || id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || id == "."
        || id == ".."
        || d.archive_bytes == 0
        || d.archive_bytes > MAX_ARCHIVE
        || d.archive_sha256.len() != 64
        || !d.archive_sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || !public_download(&d.archive_url)
    {
        return Err("UPDATE_DESCRIPTOR_INVALID");
    }
    Ok(())
}
pub(crate) fn save_json(root: &Path, name: &str, value: &impl Serialize) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(|_| "UPDATE_STORAGE_FAILED")?;
    serde_json::to_writer(&mut temp, value).map_err(|_| "UPDATE_STORAGE_FAILED")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "UPDATE_STORAGE_FAILED")?;
    temp.persist(root.join(name))
        .map_err(|_| "UPDATE_STORAGE_FAILED")?;
    sync_directory(root)?;
    Ok(())
}
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| "UPDATE_STORAGE_FAILED")?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
pub(crate) fn data_identity(data: &Path) -> Result<PathBuf> {
    config::resource_root(data, false).map_err(|_| "UPDATE_BACKUP_UNSAFE")
}
fn validate_data_identity(selected: &Selection, data: &Path) -> Result<()> {
    if data_identity(data)? != selected.data_directory {
        return Err("UPDATE_DATA_DIRECTORY_CHANGED");
    }
    Ok(())
}
pub(crate) fn selection(app_data: &Path) -> Result<Option<Selection>> {
    let path = root(app_data)?.join("selection.json");
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| "UPDATE_STORAGE_FAILED")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 5 * 1024 * 1024
    {
        return Err("UPDATE_STORAGE_UNSAFE");
    }
    let value: Selection =
        serde_json::from_slice(&fs::read(path).map_err(|_| "UPDATE_STORAGE_FAILED")?)
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
    authenticate(&value.active)?;
    if let Some(previous) = &value.previous {
        authenticate(previous)?;
    }
    if !value.backup_id.starts_with("backup-")
        || value.backup_id.len() > 80
        || !value
            .backup_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("UPDATE_STORAGE_UNSAFE");
    }
    Ok(Some(value))
}
fn copy_tree(source: &Path, destination: &Path, total: &mut u64) -> Result<()> {
    copy_tree_inner(source, destination, total, None)
}
fn worker_launch_cache(relative: &Path) -> bool {
    let Some(parts): Option<Vec<_>> = relative.iter().map(|p| p.to_str()).collect() else {
        return false;
    };
    parts.len() == 5
        && parts[0] == "workers"
        && parts[1].len() == 64
        && parts[1]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && parts[2..] == ["home", "tmp", "arg0"]
}
fn copy_tree_inner(
    source: &Path,
    destination: &Path,
    total: &mut u64,
    snapshot_root: Option<&Path>,
) -> Result<()> {
    let meta = fs::symlink_metadata(source).map_err(|_| "UPDATE_BACKUP_FAILED")?;
    if meta.file_type().is_symlink() {
        return Err("UPDATE_BACKUP_UNSAFE");
    }
    // App Server recreates these executable aliases on every worker launch.
    // Exclude only its exact cache directory, after rejecting a linked root;
    // history, credentials and all other paths retain the strict copy policy.
    if snapshot_root
        .and_then(|root| source.strip_prefix(root).ok())
        .is_some_and(worker_launch_cache)
    {
        return if meta.is_dir() {
            Ok(())
        } else {
            Err("UPDATE_BACKUP_UNSAFE")
        };
    }
    if meta.is_dir() {
        fs::create_dir(destination).map_err(|_| "UPDATE_BACKUP_FAILED")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(destination, fs::Permissions::from_mode(0o700))
                .map_err(|_| "UPDATE_BACKUP_FAILED")?;
        }
        for entry in fs::read_dir(source).map_err(|_| "UPDATE_BACKUP_FAILED")? {
            let entry = entry.map_err(|_| "UPDATE_BACKUP_FAILED")?;
            if snapshot_root == Some(source) && entry.file_name() == ".central-service.lock" {
                continue;
            }
            copy_tree_inner(
                &entry.path(),
                &destination.join(entry.file_name()),
                total,
                snapshot_root,
            )?;
        }
        sync_directory(destination)?;
    } else if meta.is_file() {
        *total = total
            .checked_add(meta.len())
            .ok_or("UPDATE_BACKUP_TOO_LARGE")?;
        if *total > 10 * 1024 * 1024 * 1024 {
            return Err("UPDATE_BACKUP_TOO_LARGE");
        }
        fs::copy(source, destination).map_err(|_| "UPDATE_BACKUP_FAILED")?;
        fs::OpenOptions::new()
            .write(true)
            .open(destination)
            .and_then(|f| f.sync_all())
            .map_err(|_| "UPDATE_BACKUP_FAILED")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                destination,
                fs::Permissions::from_mode(meta.permissions().mode() & 0o700),
            )
            .map_err(|_| "UPDATE_BACKUP_FAILED")?;
        }
    } else {
        return Err("UPDATE_BACKUP_UNSAFE");
    }
    Ok(())
}
pub(crate) fn backup(app_data: &Path, data: &Path) -> Result<String> {
    let root = root(app_data)?;
    if root.starts_with(data) || data.starts_with(&root) {
        return Err("UPDATE_BACKUP_UNSAFE");
    }
    config::resource_root(data, false).map_err(|_| "UPDATE_BACKUP_UNSAFE")?;
    let _guard = platform_security::central_secret_store::lock_runtime_root(data)
        .map_err(|_| "UPDATE_DATA_BUSY")?;
    let id = format!("backup-{}", now());
    let destination = root.join(&id);
    // The owner lock stays held and is never part of a data snapshot.
    copy_tree_inner(data, &destination, &mut 0, Some(data))?;
    sync_directory(&root)?;
    Ok(id)
}
/// Called only after verified process cleanup, including interrupted-update startup recovery.
pub(crate) fn recover(app_data: &Path, data: &Path) -> Result<()> {
    let Some(selected) = selection(app_data)? else {
        return Ok(());
    };
    if !selected.pending {
        return Ok(());
    }
    validate_data_identity(&selected, data)?;
    let root = root(app_data)?;
    if root.starts_with(data) || data.starts_with(&root) {
        return Err("UPDATE_BACKUP_UNSAFE");
    }
    restore_data(&root, data, &selected.backup_id)?;
    if let Some(previous) = selected.previous {
        save_json(
            &root,
            "selection.json",
            &Selection {
                active: previous,
                previous: None,
                pending: false,
                ..selected
            },
        )?;
    } else {
        fs::remove_file(root.join("selection.json")).map_err(|_| "UPDATE_STORAGE_FAILED")?;
        sync_directory(&root)?;
    }
    Ok(())
}
fn restore_data(root: &Path, data: &Path, backup_id: &str) -> Result<()> {
    let backup = root.join(backup_id);
    if !backup.is_dir() {
        return Err("UPDATE_ROLLBACK_MISSING");
    }
    let parent = data.parent().ok_or("UPDATE_BACKUP_UNSAFE")?;
    config::resource_root(parent, false).map_err(|_| "UPDATE_BACKUP_UNSAFE")?;
    let _guard = platform_security::central_secret_store::lock_runtime_root(data)
        .map_err(|_| "UPDATE_DATA_BUSY")?;
    let restored = parent.join(format!(".runtime-restore-{}", now()));
    copy_tree(&backup, &restored, &mut 0)?;
    // Keep the failed attempt's data for diagnosis; never merge incompatible histories.
    let failed = parent.join(format!(".runtime-failed-{}", now()));
    fs::create_dir(&failed).map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&failed, fs::Permissions::from_mode(0o700))
            .map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
    }
    // Preserve the locked root/inode. A pending journal makes interrupted restores repeatable.
    for entry in fs::read_dir(data).map_err(|_| "UPDATE_ROLLBACK_FAILED")? {
        let entry = entry.map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
        if entry.file_name() == ".central-service.lock" {
            continue;
        }
        fs::rename(entry.path(), failed.join(entry.file_name()))
            .map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
    }
    for entry in fs::read_dir(&restored).map_err(|_| "UPDATE_ROLLBACK_FAILED")? {
        let entry = entry.map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
        if entry.file_name() == ".central-service.lock" {
            continue;
        }
        fs::rename(entry.path(), data.join(entry.file_name()))
            .map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
    }
    sync_directory(data)?;
    sync_directory(&failed)?;
    fs::remove_dir(&restored).map_err(|_| "UPDATE_ROLLBACK_FAILED")?;
    sync_directory(parent)?;
    Ok(())
}
pub(crate) fn prepare(
    app_data: &Path,
    resources: &Path,
    baseline: &str,
) -> Result<runtime_package::PreparedServicePackage> {
    if let Some(selected) = selection(app_data)? {
        if selected.baseline_id == baseline {
            let d = authenticate(&selected.active)?;
            return runtime_package::prepare_authenticated_update(&root(app_data)?, d.package);
        }
    }
    runtime_package::prepare_service(resources, baseline)
}
fn unpack(bytes: &[u8], destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut total = 0u64;
    let mut count = 0;
    for entry in archive.entries().map_err(|_| "UPDATE_ARCHIVE_INVALID")? {
        let mut entry = entry.map_err(|_| "UPDATE_ARCHIVE_INVALID")?;
        count += 1;
        let key = entry
            .path()
            .map_err(|_| "UPDATE_ARCHIVE_INVALID")?
            .into_owned();
        if key.as_os_str().is_empty()
            || !key.components().all(|c| matches!(c, Component::Normal(_)))
            || key.to_string_lossy().contains(['\\', ':'])
        {
            return Err("UPDATE_ARCHIVE_UNSAFE");
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("UPDATE_ARCHIVE_UNSAFE");
        }
        total = total
            .checked_add(entry.size())
            .ok_or("UPDATE_ARCHIVE_INVALID")?;
        if count > 16384 || total > MAX_ARCHIVE {
            return Err("UPDATE_ARCHIVE_TOO_LARGE");
        }
        let path = destination.join(key);
        if kind.is_dir() {
            fs::create_dir_all(path).map_err(|_| "UPDATE_STORAGE_FAILED")?;
            continue;
        }
        fs::create_dir_all(path.parent().ok_or("UPDATE_ARCHIVE_UNSAFE")?)
            .map_err(|_| "UPDATE_STORAGE_FAILED")?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if entry.header().mode().unwrap_or(0) & 0o111 != 0 {
                0o700
            } else {
                0o600
            });
        }
        let mut file = options.open(path).map_err(|_| "UPDATE_ARCHIVE_UNSAFE")?;
        std::io::copy(&mut entry, &mut file).map_err(|_| "UPDATE_STORAGE_FAILED")?;
    }
    Ok(())
}
pub(crate) fn prune(app_data: &Path, selected: &Selection) -> Result<()> {
    let root = root(app_data)?;
    let current = authenticate(&selected.active)?;
    let previous = selected.previous.as_ref().map(authenticate).transpose()?;
    let keep = [
        current.package["id"].as_str(),
        previous.as_ref().and_then(|d| d.package["id"].as_str()),
    ];
    for folder in [root.clone(), root.join("central-service")] {
        if !folder.exists() {
            continue;
        }
        config::resource_root(&folder, false).map_err(|_| "UPDATE_STORAGE_UNSAFE")?;
        for entry in fs::read_dir(&folder).map_err(|_| "UPDATE_STORAGE_FAILED")? {
            let entry = entry.map_err(|_| "UPDATE_STORAGE_FAILED")?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let remove = if folder == root {
                name.starts_with("backup-") && name != selected.backup_id
            } else {
                !keep.contains(&Some(name.as_str()))
            };
            if remove
                && entry
                    .file_type()
                    .map_err(|_| "UPDATE_STORAGE_FAILED")?
                    .is_dir()
            {
                // Only immediate children of the fixed native update directory are eligible.
                if !entry.path().starts_with(&root) {
                    return Err("UPDATE_STORAGE_UNSAFE");
                }
                fs::remove_dir_all(entry.path()).map_err(|_| "UPDATE_CLEANUP_FAILED")?;
            }
        }
    }
    Ok(())
}

// A signed rebuild may keep the upstream version while changing gateway/Harness
// behavior. Its monotonic sequence, rather than only SemVer, identifies it.
fn newer_release(d: &Descriptor, current: &str, sequence: Option<u64>) -> Result<bool> {
    let incoming = version(&d.version).ok_or("UPDATE_DESCRIPTOR_INVALID")?;
    let installed = version(current).ok_or("UPDATE_DESCRIPTOR_INVALID")?;
    if incoming < installed {
        return Ok(false);
    }
    if let Some(previous) = sequence {
        if incoming == installed && d.sequence == previous {
            return Ok(false);
        }
        if d.sequence <= previous {
            return Err("UPDATE_REPLAY_DENIED");
        }
    }
    Ok(true)
}

// v1 envelopes remain readable for existing selection/rollback journals. New
// installations must understand the private modelProxy bootstrap introduced in 0.1.8.
pub(crate) fn require_proxy_protocol(d: &Descriptor) -> Result<()> {
    if d.host_protocol != "central-runtime-update/v2" {
        return Err("UPDATE_HOST_PROTOCOL_INCOMPATIBLE");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_path(temp: &tempfile::TempDir) -> PathBuf {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
            temp.path().canonicalize().unwrap()
        }
        #[cfg(not(unix))]
        {
            temp.path().to_path_buf()
        }
    }
    fn descriptor() -> Descriptor {
        Descriptor{schema_version:1,version:"0.156.1".into(),sequence:1,host_protocol:"central-runtime-update/v1".into(),archive_url:"https://github.com/LsYuanh/central-codex-platform/releases/download/runtime-0.156.1-1/runtime.tar.gz".into(),archive_bytes:10,archive_sha256:"a".repeat(64),package:serde_json::json!({"id":"runtime-one","version":"0.156.1","platform":"darwin","architecture":"aarch64"})}
    }
    #[test]
    fn only_stable_platform_compatible_descriptors_are_admitted() {
        assert!(validate_descriptor(&descriptor()).is_ok());
        assert!(version("0.156.1") > version("0.99.10"));
        for bad in ["1.2", "1.2.3-beta", "1.2.3.4", "+1.2.3", "1.2.-1"] {
            assert!(version(bad).is_none());
        }
        for id in ["../escape", "a/b", "a\\b", ".", "..", ""] {
            let mut d = descriptor();
            d.package["id"] = id.into();
            assert!(validate_descriptor(&d).is_err());
        }
        let mut d = descriptor();
        d.archive_url = "https://attacker.invalid/runtime.tar.gz".into();
        assert!(validate_descriptor(&d).is_err());
        let mut d = descriptor();
        d.host_protocol = "future/v2".into();
        assert!(validate_descriptor(&d).is_err());
    }
    #[test]
    fn signed_rebuilds_update_without_allowing_replay_or_downgrade() {
        let mut d = descriptor();
        d.sequence = 20;
        assert_eq!(newer_release(&d, "0.156.1", Some(19)), Ok(true));
        assert_eq!(newer_release(&d, "0.156.1", Some(20)), Ok(false));
        assert_eq!(
            newer_release(&d, "0.156.1", Some(21)),
            Err("UPDATE_REPLAY_DENIED")
        );
        assert_eq!(
            newer_release(&d, "0.155.0", Some(21)),
            Err("UPDATE_REPLAY_DENIED")
        );
        assert_eq!(newer_release(&d, "0.157.0", Some(19)), Ok(false));
        assert_eq!(newer_release(&d, "0.155.0", Some(19)), Ok(true));
        assert_eq!(newer_release(&d, "0.156.1", None), Ok(true));
    }
    #[test]
    fn proxy_host_rejects_legacy_updates_but_can_read_old_journals() {
        let mut d = descriptor();
        assert!(validate_descriptor(&d).is_ok());
        assert_eq!(
            require_proxy_protocol(&d),
            Err("UPDATE_HOST_PROTOCOL_INCOMPATIBLE")
        );
        d.host_protocol = "central-runtime-update/v2".into();
        assert!(validate_descriptor(&d).is_ok());
        assert!(require_proxy_protocol(&d).is_ok());
    }
    #[test]
    fn unsigned_or_forged_channel_is_rejected() {
        let env = Envelope {
            payload: "{}".into(),
            signature: STANDARD.encode("untrusted comment: forged\nAAAA\n"),
        };
        assert!(matches!(
            authenticate(&env),
            Err("UPDATE_SIGNATURE_INVALID")
        ));
    }
    #[test]
    fn signed_descriptor_is_bound_to_exact_bytes_and_trusted_key() {
        let envelope = Envelope {
            payload: include_str!(
                "../../../../tests/fixtures/runtime-update-signature/descriptor.json"
            )
            .into(),
            signature: include_str!(
                "../../../../tests/fixtures/runtime-update-signature/descriptor.json.sig"
            )
            .into(),
        };
        let public_key =
            include_str!("../../../../tests/fixtures/runtime-update-signature/public.key");
        assert_eq!(
            authenticate_with_key(&envelope, public_key)
                .unwrap()
                .version,
            "0.156.1"
        );
        // A QA signature is never accepted by the production trust root.
        assert!(authenticate(&envelope).is_err());
        let mut tampered = envelope.clone();
        tampered.payload.push(' ');
        assert!(authenticate_with_key(&tampered, public_key).is_err());
        tampered = envelope;
        tampered.signature = STANDARD.encode("invalid");
        assert!(authenticate_with_key(&tampered, public_key).is_err());
    }
    #[test]
    fn recovery_refuses_a_different_data_directory() {
        let root = tempfile::tempdir().unwrap();
        let original = fixture_path(&root).join("original");
        let changed = fixture_path(&root).join("changed");
        drop(platform_security::central_secret_store::lock_runtime_root(&original).unwrap());
        drop(platform_security::central_secret_store::lock_runtime_root(&changed).unwrap());
        let selected = Selection {
            baseline_id: "qa".into(),
            active: Envelope {
                payload: "".into(),
                signature: "".into(),
            },
            previous: None,
            pending: true,
            backup_id: "backup-qa".into(),
            data_directory: data_identity(&original).unwrap(),
        };
        assert!(validate_data_identity(&selected, &original).is_ok());
        assert_eq!(
            validate_data_identity(&selected, &changed),
            Err("UPDATE_DATA_DIRECTORY_CHANGED")
        );
    }
    fn archive(kind: tar::EntryType) -> Vec<u8> {
        let writer = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(writer);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(0);
        header.set_mode(0o600);
        if kind.is_symlink() {
            header.set_link_name("../escape").unwrap();
        }
        header.set_cksum();
        archive
            .append_data(&mut header, "entry", std::io::empty())
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap()
    }
    #[test]
    fn archive_links_and_replacement_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            unpack(&archive(tar::EntryType::Symlink), root.path()),
            Err("UPDATE_ARCHIVE_UNSAFE")
        );
        unpack(&archive(tar::EntryType::Regular), root.path()).unwrap();
        assert_eq!(
            unpack(&archive(tar::EntryType::Regular), root.path()),
            Err("UPDATE_ARCHIVE_UNSAFE")
        );
        assert_eq!(fs::read(root.path().join("entry")).unwrap(), b"");
    }
    #[test]
    fn snapshot_copy_preserves_content_and_refuses_existing_target() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("history.json"), b"history sentinel").unwrap();
        let target = root.path().join("backup");
        copy_tree(&source, &target, &mut 0).unwrap();
        assert_eq!(
            fs::read(target.join("history.json")).unwrap(),
            b"history sentinel"
        );
        assert!(copy_tree(&source, &target, &mut 0).is_err());
    }
    #[test]
    #[cfg(unix)]
    fn snapshot_excludes_worker_launch_aliases_but_rejects_data_links() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let home = data.join("workers").join("a".repeat(64)).join("home");
        let aliases = home.join("tmp/arg0");
        fs::create_dir_all(aliases.join("codex-arg0-test")).unwrap();
        symlink(
            "/outside/app-server",
            aliases.join("codex-arg0-test/apply_patch"),
        )
        .unwrap();
        fs::write(home.join("history.json"), b"history").unwrap();
        fs::write(home.join("tmp/keep"), b"keep").unwrap();
        let target = temp.path().join("snapshot");
        copy_tree_inner(&data, &target, &mut 0, Some(&data)).unwrap();
        let saved_home = target.join(home.strip_prefix(&data).unwrap());
        assert!(!saved_home.join("tmp/arg0").exists());
        assert_eq!(
            fs::read(saved_home.join("history.json")).unwrap(),
            b"history"
        );
        assert_eq!(fs::read(saved_home.join("tmp/keep")).unwrap(), b"keep");
        symlink("/outside/history", home.join("data-link")).unwrap();
        assert_eq!(
            copy_tree_inner(&data, &temp.path().join("bad-data"), &mut 0, Some(&data)),
            Err("UPDATE_BACKUP_UNSAFE")
        );
        fs::remove_file(home.join("data-link")).unwrap();
        fs::remove_dir_all(&aliases).unwrap();
        symlink("/outside/cache", &aliases).unwrap();
        assert_eq!(
            copy_tree_inner(&data, &temp.path().join("bad-cache"), &mut 0, Some(&data)),
            Err("UPDATE_BACKUP_UNSAFE")
        );
    }
    #[test]
    fn only_exact_worker_launch_cache_is_excluded() {
        let id = "a".repeat(64);
        assert!(worker_launch_cache(Path::new(&format!(
            "workers/{id}/home/tmp/arg0"
        ))));
        for name in [
            format!("other/{id}/home/tmp/arg0"),
            "workers/user/home/tmp/arg0".into(),
            format!("workers/{id}/home/tmp/arg0/child"),
            format!("workers/{id}/home/tmp/other"),
        ] {
            assert!(!worker_launch_cache(Path::new(&name)));
        }
    }
    #[test]
    fn data_restore_replaces_failed_history_and_can_be_retried() {
        let temp = tempfile::tempdir().unwrap();
        let app = fixture_path(&temp).join("app");
        let data = fixture_path(&temp).join("data");
        drop(platform_security::central_secret_store::lock_runtime_root(&data).unwrap());
        fs::write(data.join("history.json"), b"old history").unwrap();
        let backup_id = backup(&app, &data).unwrap();
        fs::write(data.join("history.json"), b"failed migration").unwrap();
        fs::write(data.join("new-schema.json"), b"new schema").unwrap();
        restore_data(&root(&app).unwrap(), &data, &backup_id).unwrap();
        assert_eq!(fs::read(data.join("history.json")).unwrap(), b"old history");
        assert!(!data.join("new-schema.json").exists());
        std::thread::sleep(Duration::from_millis(2));
        fs::write(data.join("history.json"), b"interrupted retry").unwrap();
        restore_data(&root(&app).unwrap(), &data, &backup_id).unwrap();
        assert_eq!(fs::read(data.join("history.json")).unwrap(), b"old history");
        assert!(temp.path().read_dir().unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".runtime-failed-")
        }));
    }
}
impl Updater {
    pub fn new() -> Self {
        let pin: serde_json::Value = serde_json::from_str(PIN).expect("upstream pin");
        Self {
            status: Mutex::new(Status {
                state: if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                    "idle"
                } else {
                    "unsupported"
                },
                current_version: pin["version"].as_str().unwrap().into(),
                latest_version: None,
                checked_at: None,
                code: None,
            }),
            candidate: Mutex::new(None),
            requested: AtomicBool::new(false),
        }
    }
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
    pub fn request_check(&self) {
        self.requested.store(true, Ordering::SeqCst);
    }
    pub fn take_request(&self) -> bool {
        self.requested.swap(false, Ordering::SeqCst)
    }
    pub(crate) fn current(&self, value: String) {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .current_version = value;
    }
    pub(crate) fn set(&self, state: &'static str, code: Option<&'static str>) {
        let mut s = self.status.lock().unwrap_or_else(|p| p.into_inner());
        s.state = state;
        s.code = code;
    }
    pub fn check(&self, app_data: &Path) -> Result<()> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Ok(());
        }
        // A lost activation acknowledgement must be reconciled before checking again.
        if matches!(
            self.status().state,
            "applying" | "rolling-back" | "activation-unconfirmed"
        ) {
            return Ok(());
        }
        *self.candidate.lock().map_err(|_| "UPDATE_STORAGE_FAILED")? = None;
        self.set("checking", None);
        let result = self.check_inner(app_data);
        if let Err(code) = result {
            self.set(
                if code == "UPDATE_CHANNEL_NOT_PUBLISHED" {
                    "waiting-for-package"
                } else {
                    "failed"
                },
                Some(code),
            );
        }
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .checked_at = Some(now());
        result
    }
    fn check_inner(&self, app_data: &Path) -> Result<()> {
        let baseline = config::read(app_data)
            .map_err(|_| "UPDATE_STORAGE_FAILED")?
            .config
            .map(|c| c.runtime_package_id);
        let current = selection(app_data)?
            .filter(|s| baseline.as_deref() == Some(s.baseline_id.as_str()) && !s.pending);
        let pin: serde_json::Value =
            serde_json::from_str(PIN).map_err(|_| "UPDATE_CHANNEL_INVALID")?;
        let baseline_version = baseline
            .as_deref()
            .and_then(runtime_package::service_version);
        self.current(
            baseline_version
                .as_deref()
                .unwrap_or(pin["version"].as_str().ok_or("UPDATE_CHANNEL_INVALID")?)
                .into(),
        );
        if let Some(s) = &current {
            self.status.lock().unwrap().current_version = authenticate(&s.active)?.version;
        }
        let release: serde_json::Value = serde_json::from_slice(&get(
            "https://api.github.com/repos/openai/codex/releases/latest",
            1024 * 1024,
        )?)
        .map_err(|_| "UPDATE_RELEASE_INVALID")?;
        let latest = release["tag_name"]
            .as_str()
            .and_then(|s| s.strip_prefix("rust-v"))
            .filter(|s| version(s).is_some())
            .ok_or("UPDATE_RELEASE_INVALID")?;
        if release["prerelease"] != false || release["draft"] != false {
            return Err("UPDATE_RELEASE_INVALID");
        }
        self.status.lock().unwrap().latest_version = Some(latest.into());
        let channel: Channel =
            serde_json::from_str(CHANNEL).map_err(|_| "UPDATE_CHANNEL_INVALID")?;
        let envelope = Envelope {
            payload: String::from_utf8(get(&channel.manifest_url, 2 * 1024 * 1024)?)
                .map_err(|_| "UPDATE_DESCRIPTOR_INVALID")?,
            signature: String::from_utf8(get(&(channel.manifest_url + ".sig"), 4096)?)
                .map_err(|_| "UPDATE_SIGNATURE_INVALID")?,
        };
        let d = authenticate(&envelope)?;
        require_proxy_protocol(&d)?;
        let failed = root(app_data)?.join("failed-sequence.json");
        if failed.exists() {
            let metadata = fs::symlink_metadata(&failed).map_err(|_| "UPDATE_STORAGE_FAILED")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 128 {
                return Err("UPDATE_STORAGE_UNSAFE");
            }
            let sequence: u64 =
                serde_json::from_slice(&fs::read(failed).map_err(|_| "UPDATE_STORAGE_FAILED")?)
                    .map_err(|_| "UPDATE_STORAGE_FAILED")?;
            if d.sequence <= sequence {
                return Err("UPDATE_PREVIOUSLY_FAILED");
            }
        }
        let current_version = self.status().current_version;
        let current_sequence = current
            .as_ref()
            .map(|s| authenticate(&s.active).map(|d| d.sequence))
            .transpose()?;
        if !newer_release(&d, &current_version, current_sequence)? {
            self.set(
                if version(latest) > version(&current_version) {
                    "waiting-for-package"
                } else {
                    "up-to-date"
                },
                None,
            );
            return Ok(());
        }
        let update_root = root(app_data)?;
        let id = d.package["id"]
            .as_str()
            .ok_or("UPDATE_DESCRIPTOR_INVALID")?;
        if runtime_package::prepare_authenticated_update(&update_root, d.package.clone()).is_err() {
            self.set("downloading", None);
            let archive = get(&d.archive_url, d.archive_bytes)?;
            if archive.len() as u64 != d.archive_bytes
                || format!("{:x}", Sha256::digest(&archive)) != d.archive_sha256
            {
                return Err("UPDATE_HASH_MISMATCH");
            }
            let staging =
                tempfile::tempdir_in(&update_root).map_err(|_| "UPDATE_STORAGE_FAILED")?;
            let package = staging.path().join("central-service").join(id);
            fs::create_dir_all(&package).map_err(|_| "UPDATE_STORAGE_FAILED")?;
            unpack(&archive, &package)?;
            drop(runtime_package::prepare_authenticated_update(
                staging.path(),
                d.package.clone(),
            )?);
            let target = update_root.join("central-service");
            config::resource_root(&target, true).map_err(|_| "UPDATE_STORAGE_UNSAFE")?;
            if target.join(id).exists() {
                return Err("UPDATE_PACKAGE_ALREADY_EXISTS");
            }
            fs::rename(package, target.join(id)).map_err(|_| "UPDATE_STORAGE_FAILED")?;
        }
        *self.candidate.lock().unwrap() = Some(envelope);
        self.set("waiting-for-idle", None);
        Ok(())
    }
}
