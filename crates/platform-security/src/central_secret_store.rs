// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Append-only central records: Windows DPAPI; macOS private, unencrypted files.
//! Trusts the current user and administrators; it is not a boundary against
//! hostile processes already holding that identity. No existing store is repaired.
use std::{fmt, path::Path};
use zeroize::Zeroizing;

pub const MAX_SECRET_BYTES: usize = 2 * 1024 * 1024;
const MAX_RECORDS: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretStoreError {
    Unsupported,
    InvalidNamespace,
    InvalidId,
    UnsafeStore,
    NotFound,
    TooLarge,
    Capacity,
    Unavailable,
    Corrupt,
}
impl SecretStoreError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "CENTRAL_SECRET_WINDOWS_REQUIRED",
            Self::InvalidNamespace => "CENTRAL_SECRET_NAMESPACE_INVALID",
            Self::InvalidId => "CENTRAL_SECRET_ID_INVALID",
            Self::UnsafeStore => "CENTRAL_SECRET_STORE_UNSAFE",
            Self::NotFound => "CENTRAL_SECRET_NOT_FOUND",
            Self::TooLarge => "CENTRAL_SECRET_TOO_LARGE",
            Self::Capacity => "CENTRAL_SECRET_CAPACITY",
            Self::Unavailable => "CENTRAL_SECRET_UNAVAILABLE",
            Self::Corrupt => "CENTRAL_SECRET_CORRUPT",
        }
    }
}
impl fmt::Display for SecretStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for SecretStoreError {}
type Result<T> = std::result::Result<T, SecretStoreError>;

fn namespace_valid(namespace: &str) -> bool {
    !namespace.is_empty()
        && namespace.len() <= 64
        && namespace.as_bytes()[0].is_ascii_alphanumeric()
        && namespace
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        && !namespace.ends_with('.')
}
fn id_valid(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Encrypt before creating the immutable record. Returns only a random public ID.
pub fn create(app_data: &Path, namespace: &str, payload: &[u8]) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        macos::create(app_data, namespace, payload)
    }
    #[cfg(windows)]
    {
        windows::create(app_data, namespace, payload)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app_data, namespace, payload);
        Err(SecretStoreError::Unsupported)
    }
}
/// Decrypt a record whose ID and namespace are authenticated as DPAPI entropy.
pub fn load(app_data: &Path, namespace: &str, id: &str) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(target_os = "macos")]
    {
        macos::load(app_data, namespace, id)
    }
    #[cfg(windows)]
    {
        windows::load(app_data, namespace, id)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app_data, namespace, id);
        Err(SecretStoreError::Unsupported)
    }
}
/// Enumerate opaque record IDs only. Individual corrupt ciphertexts are retained
/// in this list so callers can report each load failure without hiding the record.
pub fn list(app_data: &Path, namespace: &str) -> Result<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        macos::list(app_data, namespace)
    }
    #[cfg(windows)]
    {
        windows::list(app_data, namespace)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (app_data, namespace);
        Err(SecretStoreError::Unsupported)
    }
}

/// Pin a private runtime root and acquire its single fixed ownership lock.
/// Only the final directory may be created; existing permissions are never repaired.
pub fn lock_runtime_root(path: &Path) -> Result<(Vec<std::fs::File>, std::fs::File)> {
    #[cfg(target_os = "macos")]
    {
        macos::lock_runtime_root(path)
    }
    #[cfg(windows)]
    {
        windows::lock_runtime_root(path)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = path;
        Err(SecretStoreError::Unsupported)
    }
}

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::{central_private_file, device_token::secure};
    use std::{
        fs::{self, File, OpenOptions},
        io::Write,
        os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
        path::PathBuf,
    };
    // windows-sys exposes READ_CONTROL with the file access rights here.
    use windows_sys::Win32::Storage::FileSystem::*;

    const MAX_CIPHERTEXT_BYTES: usize = MAX_SECRET_BYTES + 65536;
    struct Store {
        directory: PathBuf,
        _pins: Vec<File>,
    }
    fn entropy(namespace: &str, id: &str) -> String {
        format!("yuan-central-secret/v1:{namespace}:{id}")
    }
    fn wide(raw: &[u16]) -> Vec<u16> {
        raw.iter().copied().chain(Some(0)).collect()
    }
    fn unsafe_store<T>(_: T) -> SecretStoreError {
        SecretStoreError::UnsafeStore
    }
    fn final_path(file: &File) -> Result<Vec<u16>> {
        let mut out = vec![0u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                out.as_mut_ptr(),
                out.len() as u32,
                VOLUME_NAME_GUID,
            )
        } as usize;
        if length == 0 || length >= out.len() {
            return Err(SecretStoreError::UnsafeStore);
        }
        out.truncate(length);
        Ok(out)
    }
    fn same_path(a: &[u16], b: &[u16]) -> bool {
        let fold = |c: &u16| if (65..=90).contains(c) { *c + 32 } else { *c };
        a.iter().map(fold).eq(b.iter().map(fold))
    }
    // Pin every directory from the physical fixed-volume root before creating
    // or enumerating. No reparse ancestors, alternate streams, DOS aliases,
    // SUBST subdirectory roots or rename/write sharing are admitted.
    fn pin_chain(
        path: &Path,
        create_last: bool,
        missing_last_ok: bool,
    ) -> Result<Option<Vec<File>>> {
        let mut raw: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .map(|c| if c == 47 { 92 } else { c })
            .collect();
        if raw.starts_with(&[92, 92, 63, 92]) {
            raw.drain(..4);
        }
        if raw.len() < 3
            || raw.len() > 32000
            || !((65..=90).contains(&raw[0]) || (97..=122).contains(&raw[0]))
            || raw[1..3] != [58, 92]
        {
            return Err(SecretStoreError::UnsafeStore);
        }
        let parts: Vec<&[u16]> = if raw.len() == 3 {
            Vec::new()
        } else {
            raw[3..].split(|c| *c == 92).collect()
        };
        if parts.len() > 128 {
            return Err(SecretStoreError::UnsafeStore);
        }
        for part in &parts {
            if part.is_empty()
                || *part == [46]
                || *part == [46, 46]
                || matches!(part.last(), Some(32 | 46))
                || part
                    .iter()
                    .any(|c| *c < 32 || [34, 42, 58, 60, 62, 63, 124].contains(c))
            {
                return Err(SecretStoreError::UnsafeStore);
            }
            let base = String::from_utf16_lossy(part)
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase();
            if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&base.as_str())
                || (base.len() == 4
                    && (base.starts_with("COM") || base.starts_with("LPT"))
                    && matches!(base.as_bytes()[3], b'1'..=b'9'))
            {
                return Err(SecretStoreError::UnsafeStore);
            }
        }
        if unsafe { GetDriveTypeW(wide(&raw[..3]).as_ptr()) } != 3 {
            return Err(SecretStoreError::UnsafeStore);
        }
        let mut opened = Vec::new();
        let mut prefix: Vec<u16> = "\\\\?\\"
            .encode_utf16()
            .chain(raw[..3].iter().copied())
            .collect();
        let mut expected = Vec::new();
        for index in 0..=parts.len() {
            if index > 0 {
                if prefix.last() != Some(&92) {
                    prefix.push(92);
                }
                prefix.extend(parts[index - 1]);
                if expected.last() != Some(&92) {
                    expected.push(92);
                }
                expected.extend(parts[index - 1]);
            }
            let current = PathBuf::from(std::ffi::OsString::from_wide(&prefix));
            let open = || {
                OpenOptions::new()
                    .access_mode(FILE_READ_ATTRIBUTES | READ_CONTROL)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&current)
            };
            let file = match open() {
                Ok(file) => file,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && index == parts.len()
                        && index > 0 =>
                {
                    if create_last {
                        // Only this final application directory may be created.
                        // Its complete existing parent chain is already pinned.
                        secure::create_directory(&current).map_err(unsafe_store)?;
                        open().map_err(unsafe_store)?
                    } else if missing_last_ok {
                        return Ok(None);
                    } else {
                        return Err(SecretStoreError::UnsafeStore);
                    }
                }
                Err(_) => return Err(SecretStoreError::UnsafeStore),
            };
            let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
            if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
                || unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
                || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
                || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE)
                    != 0
            {
                return Err(SecretStoreError::UnsafeStore);
            }
            let final_name = final_path(&file)?;
            if index == 0 {
                let root_prefix: Vec<u16> = "\\\\?\\Volume{".encode_utf16().collect();
                if final_name.len() != 49
                    || !final_name.starts_with(&root_prefix)
                    || final_name[47..] != [125, 92]
                {
                    return Err(SecretStoreError::UnsafeStore);
                }
                expected = final_name;
            } else if !same_path(&final_name, &expected) {
                return Err(SecretStoreError::UnsafeStore);
            }
            opened.push(file);
        }
        Ok(Some(opened))
    }
    pub(super) fn lock_runtime_root(path: &Path) -> Result<(Vec<File>, File)> {
        use std::io::{Read, Write};
        let pins = pin_chain(path, true, false)?.ok_or(SecretStoreError::UnsafeStore)?;
        secure::check_directory(path).map_err(unsafe_store)?;
        let lock_path = path.join(".central-service.lock");
        if !lock_path.exists() {
            if fs::read_dir(path).map_err(unsafe_store)?.next().is_some() {
                return Err(SecretStoreError::UnsafeStore);
            }
            let mut created = secure::create_file(&lock_path).map_err(unsafe_store)?;
            created
                .write_all(b"central-service-data/v1\n")
                .map_err(unsafe_store)?;
            created.sync_all().map_err(unsafe_store)?;
        }
        {
            let _verified = secure::open_read(&lock_path).map_err(unsafe_store)?;
        }
        let mut lock = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&lock_path)
            .map_err(unsafe_store)?;
        let metadata = lock.metadata().map_err(unsafe_store)?;
        if !metadata.is_file() || metadata.len() != 24 {
            return Err(SecretStoreError::UnsafeStore);
        }
        let mut marker = String::new();
        lock.read_to_string(&mut marker).map_err(unsafe_store)?;
        if marker != "central-service-data/v1\n" {
            return Err(SecretStoreError::UnsafeStore);
        }
        lock.try_lock().map_err(unsafe_store)?;
        Ok((pins, lock))
    }
    fn store(app_data: &Path, namespace: &str, create: bool) -> Result<Option<Store>> {
        if !namespace_valid(namespace) {
            return Err(SecretStoreError::InvalidNamespace);
        }
        let Some(mut pins) = pin_chain(app_data, create, !create)? else {
            return Ok(None);
        };
        let mut directory = app_data.to_path_buf();
        for part in ["central-secrets", namespace] {
            directory.push(part);
            if create {
                secure::create_directory(&directory).map_err(unsafe_store)?;
            } else if let Err(error) = fs::symlink_metadata(&directory) {
                if error.kind() == std::io::ErrorKind::NotFound {
                    return Ok(None);
                }
                return Err(SecretStoreError::UnsafeStore);
            }
            pins.extend(pin_chain(&directory, false, false)?.ok_or(SecretStoreError::UnsafeStore)?);
            secure::check_directory(&directory).map_err(unsafe_store)?;
        }
        Ok(Some(Store {
            directory,
            _pins: pins,
        }))
    }
    fn ids(store: &Store) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for (count, item) in fs::read_dir(&store.directory)
            .map_err(unsafe_store)?
            .enumerate()
        {
            if count >= MAX_RECORDS {
                return Err(SecretStoreError::Capacity);
            }
            let item = item.map_err(unsafe_store)?;
            if let Some(name) = item.file_name().to_str() {
                if let Some(id) = name.strip_suffix(".dpapi") {
                    if id_valid(id) {
                        ids.push(id.to_owned());
                    }
                }
            }
        }
        ids.sort();
        Ok(ids)
    }
    pub(super) fn create(app_data: &Path, namespace: &str, payload: &[u8]) -> Result<String> {
        if payload.is_empty() || payload.len() > MAX_SECRET_BYTES {
            return Err(SecretStoreError::TooLarge);
        }
        let store = store(app_data, namespace, true)?.ok_or(SecretStoreError::Unavailable)?;
        if ids(&store)?.len() >= MAX_RECORDS {
            return Err(SecretStoreError::Capacity);
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| SecretStoreError::Unavailable)?;
        let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let ciphertext = secure::encode(payload, &entropy(namespace, &id))
            .map_err(|_| SecretStoreError::Unavailable)?;
        if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            return Err(SecretStoreError::TooLarge);
        }
        // CREATE_NEW denies a collision. On uncertain write/fsync failure leave
        // only the partial ciphertext record; never overwrite or replay it.
        let mut file = secure::create_file(&store.directory.join(format!("{id}.dpapi")))
            .map_err(|_| SecretStoreError::Unavailable)?;
        file.write_all(&ciphertext)
            .and_then(|_| file.sync_all())
            .map_err(|_| SecretStoreError::Unavailable)?;
        Ok(id)
    }
    pub(super) fn load(app_data: &Path, namespace: &str, id: &str) -> Result<Zeroizing<Vec<u8>>> {
        if !id_valid(id) {
            return Err(SecretStoreError::InvalidId);
        }
        let store = store(app_data, namespace, false)?.ok_or(SecretStoreError::NotFound)?;
        let path = store.directory.join(format!("{id}.dpapi"));
        if let Err(error) = fs::symlink_metadata(&path) {
            return Err(if error.kind() == std::io::ErrorKind::NotFound {
                SecretStoreError::NotFound
            } else {
                SecretStoreError::UnsafeStore
            });
        }
        let ciphertext = central_private_file::read_private_file(&path, MAX_CIPHERTEXT_BYTES)
            .map_err(unsafe_store)?;
        let plaintext = secure::decode(&ciphertext, &entropy(namespace, id))
            .map_err(|_| SecretStoreError::Corrupt)?;
        if plaintext.is_empty() || plaintext.len() > MAX_SECRET_BYTES {
            return Err(SecretStoreError::Corrupt);
        }
        Ok(plaintext)
    }
    pub(super) fn list(app_data: &Path, namespace: &str) -> Result<Vec<String>> {
        match store(app_data, namespace, false)? {
            Some(store) => ids(&store),
            None => Ok(Vec::new()),
        }
    }
    use std::os::windows::ffi::OsStringExt;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_and_ids_are_bounded_unambiguous_components() {
        assert!(namespace_valid("tls-certificates-v1"));
        for namespace in ["", ".", "..", "a/b", "a\\b", "a:", "a."] {
            assert!(!namespace_valid(namespace));
        }
        assert!(id_valid("0123456789abcdef0123456789abcdef"));
        for id in ["", "../bad", "0123456789ABCDEF0123456789ABCDEF"] {
            assert!(!id_valid(id));
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn unsupported_platform_never_stores_plaintext() {
        assert_eq!(
            create(Path::new("/tmp"), "tls-certificates-v1", b"synthetic").unwrap_err(),
            SecretStoreError::Unsupported
        );
        assert_eq!(
            load(Path::new("/tmp"), "tls-certificates-v1", "bad").unwrap_err(),
            SecretStoreError::Unsupported
        );
        assert_eq!(
            list(Path::new("/tmp"), "tls-certificates-v1").unwrap_err(),
            SecretStoreError::Unsupported
        );
    }
    #[cfg(windows)]
    mod native {
        use super::*;
        use std::fs;
        const NAMESPACE: &str = "tls-certificates-v1";
        fn record(root: &Path, id: &str) -> std::path::PathBuf {
            root.join("central-secrets")
                .join(NAMESPACE)
                .join(format!("{id}.dpapi"))
        }
        #[test]
        fn actual_dpapi_roundtrip_random_ids_and_ciphertext_only() {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            let secret = b"SYNTHETIC_ONLY_PRIVATE_KEY_0123456789";
            assert!(list(&root, NAMESPACE).unwrap().is_empty());
            let a = create(&root, NAMESPACE, secret).unwrap();
            let b = create(&root, NAMESPACE, secret).unwrap();
            assert_ne!(a, b);
            assert_eq!(load(&root, NAMESPACE, &a).unwrap().as_slice(), secret);
            let disk = fs::read(record(&root, &a)).unwrap();
            assert!(!disk.windows(secret.len()).any(|bytes| bytes == secret));
            assert_ne!(disk, fs::read(record(&root, &b)).unwrap());
            assert_eq!(list(&root, NAMESPACE).unwrap().len(), 2);
        }
        #[test]
        fn ciphertext_is_bound_to_namespace_and_id_and_corruption_is_local() {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            let a = create(&root, NAMESPACE, b"synthetic-a").unwrap();
            let b = create(&root, NAMESPACE, b"synthetic-b").unwrap();
            let original = fs::read(record(&root, &b)).unwrap();
            fs::write(record(&root, &b), fs::read(record(&root, &a)).unwrap()).unwrap();
            assert_eq!(
                load(&root, NAMESPACE, &b).unwrap_err(),
                SecretStoreError::Corrupt
            );
            assert_eq!(
                load(&root, NAMESPACE, &a).unwrap().as_slice(),
                b"synthetic-a"
            );
            assert_eq!(list(&root, NAMESPACE).unwrap().len(), 2);
            fs::write(record(&root, &b), original).unwrap();
            let other = create(&root, "other", b"synthetic-other").unwrap();
            let other_path = root
                .join("central-secrets/other")
                .join(format!("{other}.dpapi"));
            fs::rename(
                &other_path,
                root.join("central-secrets/other")
                    .join(format!("{a}.dpapi")),
            )
            .unwrap();
            fs::write(
                root.join("central-secrets/other")
                    .join(format!("{a}.dpapi")),
                fs::read(record(&root, &a)).unwrap(),
            )
            .unwrap();
            assert_eq!(
                load(&root, "other", &a).unwrap_err(),
                SecretStoreError::Corrupt
            );
        }
        #[test]
        fn refuses_hardlinks_broad_existing_store_and_invalid_paths() {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            let id = create(&root, NAMESPACE, b"synthetic").unwrap();
            let alias = root.join("alias");
            fs::hard_link(record(&root, &id), &alias).unwrap();
            assert_eq!(
                load(&root, NAMESPACE, &id).unwrap_err(),
                SecretStoreError::UnsafeStore
            );
            let broad = tempfile::tempdir().unwrap();
            fs::create_dir(broad.path().join("central-secrets")).unwrap();
            assert_eq!(
                create(broad.path(), NAMESPACE, b"synthetic").unwrap_err(),
                SecretStoreError::UnsafeStore
            );
            assert_eq!(
                create(&root, NAMESPACE, &[]).unwrap_err(),
                SecretStoreError::TooLarge
            );
            assert_eq!(
                create(&root, NAMESPACE, &vec![0; MAX_SECRET_BYTES + 1]).unwrap_err(),
                SecretStoreError::TooLarge
            );
        }
        #[test]
        fn raw_dot_segments_and_trailing_separators_are_rejected_before_any_creation() {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            // On Windows a verbatim PathBuf::join("..") normalizes the dot
            // segment before the callee sees it. Construct raw OsStrings here
            // so this test exercises the actual unnormalized API input.
            for suffix in [
                r"\..",
                r"\.",
                r"\",
                r"\\missing",
                r"\.\missing",
                r"\missing\..",
            ] {
                let mut raw = root.as_os_str().to_os_string();
                raw.push(suffix);
                let candidate = std::path::PathBuf::from(raw);
                assert_eq!(
                    create(&candidate, NAMESPACE, b"synthetic").unwrap_err(),
                    SecretStoreError::UnsafeStore
                );
                assert_eq!(
                    list(&candidate, NAMESPACE).unwrap_err(),
                    SecretStoreError::UnsafeStore
                );
                assert_eq!(
                    load(&candidate, NAMESPACE, "0123456789abcdef0123456789abcdef").unwrap_err(),
                    SecretStoreError::UnsafeStore
                );
            }
            assert!(!root.join("central-secrets").exists());
            assert!(!root.join("missing").exists());
        }
        #[test]
        fn refuses_real_junction_ancestor_without_creating_a_store() {
            use std::os::windows::process::CommandExt;
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join("target");
            let alias = temp.path().join("junction");
            fs::create_dir(&target).unwrap();
            let status = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&alias)
                .arg(&target)
                .creation_flags(0x08000000)
                .output()
                .unwrap()
                .status;
            assert!(status.success(), "fresh synthetic junction required");
            assert_eq!(
                create(&alias, NAMESPACE, b"synthetic").unwrap_err(),
                SecretStoreError::UnsafeStore
            );
            assert!(!target.join("central-secrets").exists());
            fs::remove_dir(alias).unwrap();
        }
        #[test]
        fn runtime_root_is_exclusive_reusable_and_does_not_adopt_existing_data() {
            let temp = tempfile::tempdir().unwrap();
            let parent = fs::canonicalize(temp.path()).unwrap();
            let root = parent.join("runtime");
            let guard = lock_runtime_root(&root).unwrap();
            assert!(lock_runtime_root(&root).is_err(), "second owner must fail");
            fs::write(root.join("public-state.json"), b"{}").unwrap();
            assert!(
                fs::rename(&root, parent.join("moved")).is_err(),
                "live root stays pinned"
            );
            drop(guard);
            drop(lock_runtime_root(&root).unwrap());
            let unrelated = parent.join("unrelated");
            crate::device_token::secure::create_directory(&unrelated).unwrap();
            fs::write(unrelated.join("keep.txt"), b"preserved").unwrap();
            assert!(lock_runtime_root(&unrelated).is_err());
            assert_eq!(fs::read(unrelated.join("keep.txt")).unwrap(), b"preserved");
            assert!(!unrelated.join(".central-service.lock").exists());
            fs::write(root.join(".central-service.lock"), b"invalid").unwrap();
            assert!(lock_runtime_root(&root).is_err());
        }
        #[test]
        fn first_install_creates_only_the_final_app_directory_and_reads_missing_as_empty() {
            let temp = tempfile::tempdir().unwrap();
            let parent = fs::canonicalize(temp.path()).unwrap();
            let app_data = parent.join("new-application-data");
            assert!(list(&app_data, NAMESPACE).unwrap().is_empty());
            assert_eq!(
                load(&app_data, NAMESPACE, "0123456789abcdef0123456789abcdef").unwrap_err(),
                SecretStoreError::NotFound
            );
            assert!(
                !app_data.exists(),
                "read APIs must not create application directories"
            );
            let id = create(&app_data, NAMESPACE, b"synthetic-first-install").unwrap();
            assert_eq!(
                load(&app_data, NAMESPACE, &id).unwrap().as_slice(),
                b"synthetic-first-install"
            );
            crate::device_token::secure::check_directory(&app_data).unwrap();
            let missing_parent = parent.join("not-created");
            assert_eq!(
                create(&missing_parent.join("child"), NAMESPACE, b"synthetic").unwrap_err(),
                SecretStoreError::UnsafeStore
            );
            assert!(
                !missing_parent.exists(),
                "missing ancestors must never be recursively created"
            );
        }
    }
}
