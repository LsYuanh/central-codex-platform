// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Read-only inspection of a catalog compiled into the application. Resource
//! manifests, renderer paths and discovered executables are never trust anchors.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

const CATALOG: &str = include_str!("../../../../harness/central-runtime-catalog.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    packages: Vec<Package>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {
    id: String,
    label: String,
    version: String,
    platform: String,
    architecture: String,
    marker: String,
    qualified: bool,
    blockers: Vec<String>,
    files: Vec<PackageFile>,
}
#[derive(Deserialize)]
struct PackageFile {
    name: String,
    path: String,
    bytes: u64,
    sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPackage {
    id: String,
    label: String,
    version: String,
    platform: String,
    architecture: String,
    marker: String,
    qualified: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    name: String,
    path: String,
    status: &'static str,
    reason_code: Option<&'static str>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageInspection {
    pub package_id: String,
    pub status: &'static str,
    pub ready: bool,
    pub qualified: bool,
    pub files: Vec<FileInspection>,
    pub blockers: Vec<String>,
}

fn trusted_catalog() -> Catalog {
    let catalog: Catalog =
        serde_json::from_str(CATALOG).expect("compiled runtime catalog is valid");
    assert_eq!(catalog.schema_version, 1);
    catalog
}
pub fn catalog() -> Vec<PublicPackage> {
    let mut entries: Vec<PublicPackage> = trusted_catalog()
        .packages
        .into_iter()
        .map(|package| PublicPackage {
            id: package.id,
            label: package.label,
            version: package.version,
            platform: package.platform,
            architecture: package.architecture,
            marker: package.marker,
            // No launch-capable package exists in this application version.
            qualified: false,
        })
        .collect();
    entries.extend(
        service_catalog()
            .packages
            .into_iter()
            .map(|package| PublicPackage {
                id: package.id,
                label: package.label,
                version: package.version,
                platform: package.platform,
                architecture: package.architecture,
                marker: package.marker,
                qualified: false,
            }),
    );
    entries
}

pub(crate) fn service_version(id: &str) -> Option<String> {
    service_catalog()
        .packages
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.version)
}

fn relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', ':'])
        && value.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
        })
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}
fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
/// Reject junctions/reparse points as well as ordinary symlinks at every existing
/// path component, including ancestors of resource_dir. No binaries are executed.
fn inspect_path(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute() {
        return Err("RUNTIME_PATH_UNSAFE");
    }
    let mut prefix = std::path::PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err("RUNTIME_PATH_UNSAFE");
        }
        prefix.push(part);
        // A prefix is not a filesystem entry. VerbatimDisk (\\?\C:) is
        // considered absolute by Path, but Windows cannot stat it until the
        // following RootDir is present. Inspect RootDir and every child normally.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&prefix) {
            Ok(metadata) if linked(&metadata) => return Err("RUNTIME_PATH_UNSAFE"),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("RUNTIME_MISSING");
            }
            Err(_) => return Err("RUNTIME_UNREADABLE"),
        }
    }
    Ok(())
}

fn verify_file(root: &Path, spec: &PackageFile) -> Result<(), &'static str> {
    if !relative_path(&spec.path) {
        return Err("RUNTIME_PATH_UNSAFE");
    }
    let path = root.join(&spec.path);
    inspect_path(&path)?;
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        options.share_mode(1); // deny writes/deletes while this handle is hashed
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&path).map_err(|_| "RUNTIME_UNREADABLE")?;
    let metadata = file.metadata().map_err(|_| "RUNTIME_UNREADABLE")?;
    if linked(&metadata) || !metadata.is_file() {
        return Err("RUNTIME_PATH_UNSAFE");
    }
    if metadata.len() != spec.bytes {
        return Err("RUNTIME_SIZE_MISMATCH");
    }
    let mut reader = file.take(spec.bytes.saturating_add(1));
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let count = reader.read(&mut buffer).map_err(|_| "RUNTIME_UNREADABLE")?;
        if count == 0 {
            break;
        }
        size += count as u64;
        digest.update(&buffer[..count]);
    }
    if size != spec.bytes {
        return Err("RUNTIME_SIZE_MISMATCH");
    }
    if format!("{:x}", digest.finalize()) != spec.sha256 {
        return Err("RUNTIME_HASH_MISMATCH");
    }
    Ok(())
}

pub fn inspect(resource_dir: &Path, package_id: &str) -> PackageInspection {
    if service_catalog()
        .packages
        .iter()
        .any(|package| package.id == package_id)
    {
        return inspect_service(resource_dir, package_id);
    }
    let mut result = PackageInspection {
        package_id: package_id.to_owned(),
        status: "unknown",
        ready: false,
        qualified: false,
        files: vec![],
        blockers: vec![],
    };
    let Some(package) = trusted_catalog()
        .packages
        .into_iter()
        .find(|package| package.id == package_id)
    else {
        result.blockers.push("RUNTIME_UNKNOWN_PACKAGE".into());
        return result;
    };
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    if package.platform != platform || package.architecture != std::env::consts::ARCH {
        result.status = "unsupported";
        result.blockers.push("RUNTIME_PLATFORM_MISMATCH".into());
        return result;
    }
    if !relative_path(&package.id) || package.id.contains('/') {
        result.status = "invalid";
        result.blockers.push("RUNTIME_PATH_UNSAFE".into());
        return result;
    }
    let root = resource_dir.join("central-runtime").join(&package.id);
    result.files = package
        .files
        .iter()
        .map(|spec| {
            let failure = verify_file(&root, spec).err();
            FileInspection {
                name: spec.name.clone(),
                path: spec.path.clone(),
                status: match failure {
                    None => "passed",
                    Some("RUNTIME_MISSING") => "missing",
                    Some(_) => "invalid",
                },
                reason_code: failure,
            }
        })
        .collect();
    result.status = if result.files.iter().any(|file| file.status == "invalid") {
        "invalid"
    } else if result.files.iter().any(|file| file.status == "missing") {
        "missing"
    } else {
        "candidate-incomplete"
    };
    result.blockers = package.blockers;
    if package.qualified || result.blockers.is_empty() {
        // Even a future accidental catalog edit cannot enable starting a service.
        result
            .blockers
            .push("RUNTIME_LIFECYCLE_NOT_IMPLEMENTED".into());
    }
    result
}

const SERVICE_CATALOG: &str = include_str!("../../../../harness/central-service-catalog.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceCatalog {
    schema_version: u32,
    packages: Vec<ServicePackage>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServicePackage {
    id: String,
    label: String,
    version: String,
    platform: String,
    architecture: String,
    marker: String,
    qualified: bool,
    manifest: ManifestFile,
    file_count: usize,
    entrypoint: String,
    node: String,
    #[serde(default)]
    host: String,
    app_server: String,
    #[serde(default)]
    private_helper: String,
    #[serde(default)]
    seatbelt_profile: String,
    blockers: Vec<String>,
}
#[derive(Clone, Deserialize)]
struct ManifestFile {
    path: String,
    bytes: u64,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceManifest {
    schema_version: u32,
    kind: String,
    ready: bool,
    qualified: bool,
    entrypoint: String,
    files: Vec<ManifestFile>,
}

/// Keep this value alive throughout the service lifetime. These are resource
/// paths selected by a compiled catalog, never paths accepted from a renderer.
/// Windows file handles deny write/delete sharing; directory handles deny
/// delete sharing. This does not claim full isolation from a malicious owner.
pub struct PreparedServicePackage {
    pub app_server: PathBuf,
    pub root: PathBuf,
    pub node: PathBuf,
    pub gateway: PathBuf,
    _files: Vec<File>,
    _directories: BTreeMap<PathBuf, File>,
}
#[derive(Debug)]
struct ServiceFailure {
    code: &'static str,
    path: String,
}
fn service_failure(code: &'static str, path: impl Into<String>) -> ServiceFailure {
    ServiceFailure {
        code,
        path: path.into(),
    }
}
fn service_catalog() -> ServiceCatalog {
    let value: ServiceCatalog =
        serde_json::from_str(SERVICE_CATALOG).expect("compiled service catalog is valid");
    assert_eq!(value.schema_version, 1);
    value
}
fn package_root(resource_dir: &Path, id: &str) -> Result<PathBuf, &'static str> {
    if !resource_dir.is_absolute() || !relative_path(id) || id.contains('/') {
        return Err("RUNTIME_PATH_UNSAFE");
    }
    let root = resource_dir.join("central-service").join(id);
    #[cfg(windows)]
    {
        use std::path::Prefix;
        // Return DOS paths compatible with the native host and Node's strict
        // canonical-file checks; never convert UNC/volume aliases implicitly.
        let mut parts = root.components();
        match parts.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(_) => {}
                Prefix::VerbatimDisk(letter) => {
                    let mut dos = PathBuf::from(format!("{}:", letter as char));
                    for part in parts {
                        dos.push(part);
                    }
                    return Ok(dos);
                }
                _ => return Err("RUNTIME_PATH_UNSAFE"),
            },
            _ => return Err("RUNTIME_PATH_UNSAFE"),
        }
    }
    Ok(root)
}
fn opened_links(file: &File) -> Result<u64, &'static str> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err("RUNTIME_UNREADABLE");
        }
        Ok(information.nNumberOfLinks as u64)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(file.metadata().map_err(|_| "RUNTIME_UNREADABLE")?.nlink())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = file;
        Err("RUNTIME_PLATFORM_MISMATCH")
    }
}
fn open_pinned(path: &Path, directory: bool) -> Result<File, &'static str> {
    inspect_path(path)?;
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000 | if directory { 0x02000000 } else { 0 });
        options.share_mode(if directory { 1 | 2 } else { 1 });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| "RUNTIME_UNREADABLE")?;
    let metadata = file.metadata().map_err(|_| "RUNTIME_UNREADABLE")?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = unsafe { libc::geteuid() };
        if (metadata.uid() != owner && !(directory && metadata.uid() == 0))
            || metadata.mode() & 0o022 != 0
        {
            return Err("RUNTIME_PATH_UNSAFE");
        }
    }
    if linked(&metadata)
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || opened_links(&file)? != 1))
    {
        return Err("RUNTIME_PATH_UNSAFE");
    }
    Ok(file)
}
fn pin_parents(path: &Path, pins: &mut BTreeMap<PathBuf, File>) -> Result<(), &'static str> {
    let mut prefix = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err("RUNTIME_PATH_UNSAFE");
        }
        prefix.push(part);
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        if !pins.contains_key(&prefix) {
            pins.insert(prefix.clone(), open_pinned(&prefix, true)?);
        }
    }
    Ok(())
}
fn hash_pinned(file: &mut File, expected: &ManifestFile) -> Result<(), &'static str> {
    if expected.bytes > 1024 * 1024 * 1024
        || expected.sha256.len() != 64
        || !expected
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("RUNTIME_MANIFEST_INVALID");
    }
    if file.metadata().map_err(|_| "RUNTIME_UNREADABLE")?.len() != expected.bytes {
        return Err("RUNTIME_SIZE_MISMATCH");
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "RUNTIME_UNREADABLE")?;
    let mut reader = file.take(expected.bytes + 1);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0;
    loop {
        let count = reader.read(&mut buffer).map_err(|_| "RUNTIME_UNREADABLE")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        digest.update(&buffer[..count]);
    }
    if bytes != expected.bytes {
        return Err("RUNTIME_SIZE_MISMATCH");
    }
    if format!("{:x}", digest.finalize()) != expected.sha256 {
        return Err("RUNTIME_HASH_MISMATCH");
    }
    Ok(())
}
fn service_platform(package: &ServicePackage) -> bool {
    ((package.platform == "win32" && cfg!(windows))
        || (package.platform == "darwin" && cfg!(target_os = "macos")))
        && package.architecture == std::env::consts::ARCH
}
fn inventory_service(
    root: &Path,
    folder: &Path,
    expected: &BTreeSet<String>,
    directories: &BTreeSet<String>,
    pins: &mut BTreeMap<PathBuf, File>,
) -> Result<(), ServiceFailure> {
    for entry in fs::read_dir(folder).map_err(|_| service_failure("RUNTIME_UNREADABLE", ""))? {
        let entry = entry.map_err(|_| service_failure("RUNTIME_UNREADABLE", ""))?;
        let path = entry.path();
        let key = path
            .strip_prefix(root)
            .ok()
            .and_then(|value| value.to_str())
            .ok_or_else(|| service_failure("RUNTIME_PATH_UNSAFE", ""))?
            .replace('\\', "/");
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| service_failure("RUNTIME_UNREADABLE", key.clone()))?;
        if linked(&metadata) {
            return Err(service_failure("RUNTIME_PATH_UNSAFE", key));
        }
        if metadata.is_dir() {
            if !directories.contains(&key) {
                return Err(service_failure("RUNTIME_UNDECLARED_FILE", key));
            }
            pin_parents(&path, pins).map_err(|code| service_failure(code, key.clone()))?;
            inventory_service(root, &path, expected, directories, pins)?;
        } else if !metadata.is_file() || !expected.contains(&key) {
            return Err(service_failure("RUNTIME_UNDECLARED_FILE", key));
        }
    }
    Ok(())
}
fn prepare_service_inner(
    resource_dir: &Path,
    package: &ServicePackage,
) -> Result<(PreparedServicePackage, Vec<FileInspection>), ServiceFailure> {
    if !service_platform(package) {
        return Err(service_failure("RUNTIME_PLATFORM_MISMATCH", ""));
    }
    #[cfg(target_os = "macos")]
    {
        // macOS GUI processes commonly start with 256 descriptors. The complete
        // package intentionally keeps every verified artifact pinned at once.
        let needed = package
            .file_count
            .checked_mul(3)
            .and_then(|n| n.checked_add(512))
            .filter(|n| *n <= 16384)
            .ok_or_else(|| service_failure("RUNTIME_MANIFEST_INVALID", ""))?
            as libc::rlim_t;
        let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
            return Err(service_failure("RUNTIME_OPEN_FILE_LIMIT", ""));
        }
        if limit.rlim_cur < needed {
            if limit.rlim_max < needed {
                return Err(service_failure("RUNTIME_OPEN_FILE_LIMIT", ""));
            }
            limit.rlim_cur = needed;
            if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
                return Err(service_failure("RUNTIME_OPEN_FILE_LIMIT", ""));
            }
        }
    }
    if package.qualified
        || package.manifest.path != "manifest.json"
        || package.manifest.bytes > 2 * 1024 * 1024
    {
        return Err(service_failure("RUNTIME_MANIFEST_INVALID", "manifest.json"));
    }
    let root = package_root(resource_dir, &package.id).map_err(|code| service_failure(code, ""))?;
    let mut directories = BTreeMap::new();
    pin_parents(&root, &mut directories).map_err(|code| service_failure(code, ""))?;
    let mut manifest_handle = open_pinned(&root.join("manifest.json"), false)
        .map_err(|code| service_failure(code, "manifest.json"))?;
    // Trust comes from this compile-time pin; never from the file's own fields.
    hash_pinned(&mut manifest_handle, &package.manifest)
        .map_err(|code| service_failure(code, "manifest.json"))?;
    manifest_handle
        .seek(SeekFrom::Start(0))
        .map_err(|_| service_failure("RUNTIME_UNREADABLE", "manifest.json"))?;
    let mut bytes = Vec::with_capacity(package.manifest.bytes as usize);
    (&mut manifest_handle)
        .take(package.manifest.bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| service_failure("RUNTIME_UNREADABLE", "manifest.json"))?;
    let manifest: ServiceManifest = serde_json::from_slice(&bytes)
        .map_err(|_| service_failure("RUNTIME_MANIFEST_INVALID", "manifest.json"))?;
    if manifest.schema_version != 1
        || manifest.kind != "central-gateway-candidate"
        || manifest.ready
        || manifest.qualified
        || manifest.entrypoint != package.entrypoint
        || manifest.files.len() != package.file_count
    {
        return Err(service_failure("RUNTIME_MANIFEST_INVALID", "manifest.json"));
    }
    let mut file_keys = BTreeSet::from(["manifest.json".to_string()]);
    let mut lowercase_keys = BTreeSet::from(["manifest.json".to_string()]);
    let mut directory_keys = BTreeSet::new();
    let mut total = 0u64;
    for entry in &manifest.files {
        if !relative_path(&entry.path) || !lowercase_keys.insert(entry.path.to_ascii_lowercase()) {
            return Err(service_failure("RUNTIME_PATH_UNSAFE", entry.path.clone()));
        }
        file_keys.insert(entry.path.clone());
        let mut parent = Path::new(&entry.path).parent();
        while let Some(value) = parent.filter(|value| !value.as_os_str().is_empty()) {
            directory_keys.insert(value.to_string_lossy().replace('\\', "/"));
            parent = value.parent();
        }
        total = total
            .checked_add(entry.bytes)
            .ok_or_else(|| service_failure("RUNTIME_MANIFEST_INVALID", ""))?;
        if total > 1024 * 1024 * 1024 {
            return Err(service_failure("RUNTIME_MANIFEST_INVALID", ""));
        }
    }
    let mut required = vec![&package.node, &package.entrypoint, &package.app_server];
    if package.platform == "darwin" {
        if !package.host.is_empty() || !package.private_helper.is_empty() {
            return Err(service_failure("RUNTIME_MANIFEST_INVALID", "manifest.json"));
        }
        required.push(&package.seatbelt_profile);
    } else {
        required.extend([&package.host, &package.private_helper]);
    }
    for entry in required {
        if !file_keys.contains(entry) {
            return Err(service_failure("RUNTIME_MANIFEST_INVALID", entry.clone()));
        }
    }
    inventory_service(&root, &root, &file_keys, &directory_keys, &mut directories)?;
    let mut handles = vec![manifest_handle];
    let mut checks = vec![FileInspection {
        name: "受信服务清单".into(),
        path: "manifest.json".into(),
        status: "passed",
        reason_code: None,
    }];
    for entry in &manifest.files {
        let path = root.join(&entry.path);
        pin_parents(
            path.parent()
                .ok_or_else(|| service_failure("RUNTIME_PATH_UNSAFE", entry.path.clone()))?,
            &mut directories,
        )
        .map_err(|code| service_failure(code, entry.path.clone()))?;
        let mut handle =
            open_pinned(&path, false).map_err(|code| service_failure(code, entry.path.clone()))?;
        hash_pinned(&mut handle, entry)
            .map_err(|code| service_failure(code, entry.path.clone()))?;
        handles.push(handle);
        checks.push(FileInspection {
            name: entry.path.clone(),
            path: entry.path.clone(),
            status: "passed",
            reason_code: None,
        });
    }
    inventory_service(&root, &root, &file_keys, &directory_keys, &mut directories)?;
    Ok((
        PreparedServicePackage {
            app_server: root.join(&package.app_server),
            node: root.join(&package.node),
            gateway: root.join(&package.entrypoint),
            root,
            _files: handles,
            _directories: directories,
        },
        checks,
    ))
}

pub fn prepare_service(
    resource_dir: &Path,
    package_id: &str,
) -> Result<PreparedServicePackage, &'static str> {
    let package = service_catalog()
        .packages
        .into_iter()
        .find(|package| package.id == package_id)
        .ok_or("RUNTIME_UNKNOWN_PACKAGE")?;
    prepare_service_inner(resource_dir, &package)
        .map(|(prepared, _)| prepared)
        .map_err(|error| error.code)
}

/// The caller has already authenticated this descriptor with the compiled update key.
pub(crate) fn prepare_authenticated_update(
    resources: &Path,
    descriptor: serde_json::Value,
) -> Result<PreparedServicePackage, &'static str> {
    let package: ServicePackage =
        serde_json::from_value(descriptor).map_err(|_| "RUNTIME_MANIFEST_INVALID")?;
    prepare_service_inner(resources, &package)
        .map(|(prepared, _)| prepared)
        .map_err(|error| error.code)
}
fn inspect_service(resource_dir: &Path, package_id: &str) -> PackageInspection {
    let package = service_catalog()
        .packages
        .into_iter()
        .find(|package| package.id == package_id)
        .expect("known service package");
    let mut result = PackageInspection {
        package_id: package.id.clone(),
        status: "invalid",
        ready: false,
        qualified: false,
        files: vec![],
        blockers: package.blockers.clone(),
    };
    match prepare_service_inner(resource_dir, &package) {
        Ok((_prepared, checks)) => {
            result.status = "verified";
            result.files = checks;
        }
        Err(error) => {
            result.status = match error.code {
                "RUNTIME_MISSING" => "missing",
                "RUNTIME_PLATFORM_MISMATCH" => "unsupported",
                _ => "invalid",
            };
            result.files.push(FileInspection {
                name: "完整服务包".into(),
                path: error.path,
                status: "invalid",
                reason_code: Some(error.code),
            });
            result.blockers.push(error.code.to_string());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires explicit packaged Mac resources; no service is started"]
    fn packaged_macos_resources_pass_native_trust_and_permissions() {
        let root = std::env::var_os("CENTRAL_MACOS_RESOURCE_QA")
            .expect("explicit resource directory required");
        let package = service_catalog()
            .packages
            .into_iter()
            .rev()
            .find(|p| p.platform == "darwin")
            .unwrap();
        let prepared = prepare_service(Path::new(&root), &package.id).unwrap();
        assert!(prepared.node.is_file());
        assert!(prepared.gateway.is_file());
    }

    #[cfg(windows)]
    fn tiny_service(resource: &Path) -> ServicePackage {
        let id = "service-test";
        let root = resource.join("central-service").join(id);
        fs::create_dir_all(root.join("bin")).unwrap();
        let names = [
            "bin/node.exe",
            "bin/gateway.js",
            "bin/host.exe",
            "bin/app-server.exe",
            "bin/helper.exe",
        ];
        let files: Vec<serde_json::Value> = names.iter().map(|name| {
            fs::write(root.join(name), name.as_bytes()).unwrap();
            serde_json::json!({"path":name,"bytes":name.len(),"sha256":format!("{:x}",Sha256::digest(name.as_bytes()))})
        }).collect();
        let manifest = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"kind":"central-gateway-candidate","ready":false,"qualified":false,"entrypoint":names[1],"files":files})).unwrap();
        fs::write(root.join("manifest.json"), &manifest).unwrap();
        serde_json::from_value(serde_json::json!({"id":id,"label":"test","version":"1","platform":"win32","architecture":"x86_64","marker":"test","qualified":false,
            "manifest":{"path":"manifest.json","bytes":manifest.len(),"sha256":format!("{:x}",Sha256::digest(&manifest))},"fileCount":5,
            "node":names[0],"entrypoint":names[1],"host":names[2],"appServer":names[3],"privateHelper":names[4],"blockers":[]})).unwrap()
    }

    #[test]
    fn service_catalog_has_independent_manifest_anchor() {
        let catalog = service_catalog();
        assert!(!catalog.packages.is_empty());
        for package in catalog.packages {
            assert!(!package.qualified);
            assert_eq!(package.manifest.path, "manifest.json");
            assert_eq!(package.manifest.sha256.len(), 64);
            assert!(package.file_count > 800);
        }
    }

    #[cfg(windows)]
    #[test]
    fn prepared_service_pins_files_and_directories_until_drop() {
        let directory = tempfile::tempdir().unwrap();
        let package = tiny_service(directory.path());
        let (prepared, checks) = prepare_service_inner(directory.path(), &package).unwrap();
        assert_eq!(checks.len(), 6);
        assert!(fs::write(&prepared.node, b"tamper").is_err());
        assert!(fs::rename(&prepared.root, directory.path().join("moved")).is_err());
        let node = prepared.node.clone();
        drop(prepared);
        fs::write(node, b"after-drop").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn self_reported_manifest_hash_never_replaces_compiled_anchor() {
        let directory = tempfile::tempdir().unwrap();
        let package = tiny_service(directory.path());
        let manifest_path = directory
            .path()
            .join("central-service/service-test/manifest.json");
        let original = fs::read_to_string(&manifest_path).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"bin/node.exe"));
        fs::write(manifest_path, original.replace(&hash, &"0".repeat(64))).unwrap();
        match prepare_service_inner(directory.path(), &package) {
            Err(error) => assert_eq!(error.code, "RUNTIME_HASH_MISMATCH"),
            Ok(_) => panic!("forged manifest accepted"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn service_rejects_undeclared_files_and_hardlinks() {
        let directory = tempfile::tempdir().unwrap();
        let package = tiny_service(directory.path());
        let root = directory.path().join("central-service/service-test");
        fs::write(root.join("injected.js"), b"extra").unwrap();
        match prepare_service_inner(directory.path(), &package) {
            Err(error) => assert_eq!(error.code, "RUNTIME_UNDECLARED_FILE"),
            Ok(_) => panic!("undeclared file accepted"),
        }
        fs::remove_file(root.join("injected.js")).unwrap();
        fs::hard_link(
            root.join("bin/node.exe"),
            directory.path().join("outside-link"),
        )
        .unwrap();
        match prepare_service_inner(directory.path(), &package) {
            Err(error) => assert_eq!(error.code, "RUNTIME_PATH_UNSAFE"),
            Ok(_) => panic!("hardlink accepted"),
        }
    }

    fn sample(bytes: &[u8]) -> PackageFile {
        PackageFile {
            name: "test".into(),
            path: "sample.bin".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }
    #[test]
    fn compiled_candidate_never_qualifies() {
        let packages = trusted_catalog().packages;
        assert_eq!(packages.len(), 1);
        assert!(!packages[0].qualified);
        assert!(!catalog()[0].qualified);
        assert_eq!(
            packages[0].files[0].sha256,
            "117549a4f5fde94b376ab4c1cdd821706030289362e0055e836c97cc973b986b"
        );
        assert!(
            packages[0]
                .blockers
                .contains(&"PRODUCTION_WORKER_MISSING".to_owned())
        );
    }
    #[test]
    fn rejects_unknown_and_traversal_package_ids() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["../evil", "C:/fake", "unknown"] {
            let result = inspect(dir.path(), id);
            assert_eq!(result.status, "unknown");
            assert!(!result.ready);
            assert!(result.files.is_empty());
        }
    }
    #[test]
    fn verifies_bytes_then_detects_tampering_and_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let spec = sample(b"verified");
        assert_eq!(verify_file(dir.path(), &spec), Err("RUNTIME_MISSING"));
        fs::write(dir.path().join(&spec.path), b"verified").unwrap();
        assert_eq!(verify_file(dir.path(), &spec), Ok(()));
        fs::write(dir.path().join(&spec.path), b"modified").unwrap();
        assert_eq!(verify_file(dir.path(), &spec), Err("RUNTIME_HASH_MISMATCH"));
        fs::write(dir.path().join(&spec.path), b"short").unwrap();
        assert_eq!(verify_file(dir.path(), &spec), Err("RUNTIME_SIZE_MISMATCH"));
    }
    #[cfg(windows)]
    #[test]
    fn verifies_normal_and_verbatim_windows_resource_paths() {
        let dir = tempfile::tempdir().unwrap();
        let spec = sample(b"verified");
        fs::write(dir.path().join(&spec.path), b"verified").unwrap();
        let canonical = fs::canonicalize(dir.path()).unwrap();
        assert!(matches!(
            canonical.components().next(),
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));
        assert_eq!(verify_file(dir.path(), &spec), Ok(()));
        assert_eq!(verify_file(&canonical, &spec), Ok(()));
        // Canonical/verbatim inputs still apply the same integrity checks.
        fs::write(dir.path().join(&spec.path), b"modified").unwrap();
        assert_eq!(verify_file(&canonical, &spec), Err("RUNTIME_HASH_MISMATCH"));
    }
    #[test]
    fn rejects_unsafe_catalog_paths() {
        for path in [
            "../bin", "a/../bin", "C:/bin", "/bin", "a\\b", "a//b", "a/./b", "a:b", "a.",
        ] {
            assert!(!relative_path(path), "{path}");
        }
        assert!(relative_path("bin/codex-app-server.exe"));
    }
    #[test]
    fn rejects_directory_instead_of_component_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sample.bin")).unwrap();
        assert!(verify_file(dir.path(), &sample(b"verified")).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_in_component_path() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("original"), b"verified").unwrap();
        std::os::unix::fs::symlink("original", dir.path().join("sample.bin")).unwrap();
        assert_eq!(
            verify_file(dir.path(), &sample(b"verified")),
            Err("RUNTIME_PATH_UNSAFE")
        );
    }
}
