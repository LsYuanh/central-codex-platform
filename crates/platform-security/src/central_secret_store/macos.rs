// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Current-user POSIX protection, NOT encryption. All record IO is relative to
//! an opened directory. No repair of existing permissions or symbolic links.
use super::*;
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::Component,
};

fn unsafe_store<T>(_: T) -> SecretStoreError {
    SecretStoreError::UnsafeStore
}
fn name(value: &std::ffi::OsStr) -> Result<CString> {
    CString::new(value.as_bytes()).map_err(unsafe_store)
}
fn checked(file: &File, directory: bool, private: bool) -> Result<()> {
    let m = file.metadata().map_err(unsafe_store)?;
    let uid = unsafe { libc::geteuid() };
    if (directory && !m.is_dir())
        || (!directory && (!m.is_file() || m.nlink() != 1))
        || (m.uid() != uid && (private || m.uid() != 0))
        || (private && m.mode() & 0o077 != 0)
        || (!private && m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0))
    {
        return Err(SecretStoreError::UnsafeStore);
    }
    Ok(())
}

/// Root/current-user owned ancestors, no mutable group ancestors. Missing
/// directories are created 0700. The final directory must be private if asked.
pub fn pin_directories(path: &Path, create: bool, private: bool) -> Result<Vec<File>> {
    if !path.is_absolute()
        || path.components().count() > 128
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(SecretStoreError::UnsafeStore);
    }
    let mut pins = vec![File::open("/").map_err(unsafe_store)?];
    let components: Vec<_> = path
        .components()
        .filter_map(|c| {
            if let Component::Normal(n) = c {
                Some(n)
            } else {
                None
            }
        })
        .collect();
    for (index, component) in components.iter().enumerate() {
        let component = name(component)?;
        let parent = pins.last().unwrap().as_raw_fd();
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut fd = unsafe { libc::openat(parent, component.as_ptr(), flags) };
        if fd < 0 && create && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
        {
            if unsafe { libc::mkdirat(parent, component.as_ptr(), 0o700) } != 0
                && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
            {
                return Err(SecretStoreError::UnsafeStore);
            }
            fd = unsafe { libc::openat(parent, component.as_ptr(), flags) };
        }
        if fd < 0 {
            return Err(
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                    SecretStoreError::NotFound
                } else {
                    SecretStoreError::UnsafeStore
                },
            );
        }
        let file = unsafe { File::from_raw_fd(fd) };
        checked(&file, true, private && index + 1 == components.len())?;
        pins.push(file);
    }
    if components.is_empty() && private {
        return Err(SecretStoreError::UnsafeStore);
    }
    Ok(pins)
}

fn open_at(directory: &File, filename: &str, flags: i32) -> Result<File> {
    let filename = CString::new(filename).map_err(unsafe_store)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            filename.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                SecretStoreError::NotFound
            } else {
                SecretStoreError::UnsafeStore
            },
        );
    }
    let file = unsafe { File::from_raw_fd(fd) };
    checked(&file, false, true)?;
    Ok(file)
}

/// Safely read a bounded private source without following any directory alias.
pub fn read_private(path: &Path, maximum: usize) -> Result<Zeroizing<Vec<u8>>> {
    let pins = pin_directories(
        path.parent().ok_or(SecretStoreError::UnsafeStore)?,
        false,
        false,
    )?;
    let filename = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or(SecretStoreError::UnsafeStore)?;
    let file = open_at(pins.last().unwrap(), filename, libc::O_RDONLY)?;
    let before = file.metadata().map_err(unsafe_store)?;
    if before.len() > maximum as u64 {
        return Err(SecretStoreError::TooLarge);
    }
    let mut data = Zeroizing::new(Vec::with_capacity(before.len() as usize + 1));
    (&file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut data)
        .map_err(unsafe_store)?;
    let after = file.metadata().map_err(unsafe_store)?;
    checked(&file, false, true)?;
    if data.len() > maximum
        || before.len() != after.len()
        || data.len() as u64 != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(SecretStoreError::UnsafeStore);
    }
    Ok(data)
}

fn store(root: &Path, namespace: &str, create: bool) -> Result<Vec<File>> {
    if !namespace_valid(namespace) {
        return Err(SecretStoreError::InvalidNamespace);
    }
    pin_directories(root, create, true)?;
    let parent = root.join("central-secrets");
    pin_directories(&parent, create, true)?;
    pin_directories(&parent.join(namespace), create, true)
}
fn enumerate(directory: &File) -> Result<Vec<String>> {
    // fdopendir owns the duplicate. readdir never follows a user-controlled path.
    let fd = unsafe { libc::dup(directory.as_raw_fd()) };
    if fd < 0 {
        return Err(SecretStoreError::Unavailable);
    }
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        unsafe { libc::close(fd) };
        return Err(SecretStoreError::Unavailable);
    }
    struct Dir(*mut libc::DIR);
    impl Drop for Dir {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }
    let owned = Dir(raw);
    let mut ids = Vec::new();
    loop {
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(owned.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                return Err(SecretStoreError::Unavailable);
            }
            break;
        }
        let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        let filename = std::str::from_utf8(bytes).map_err(unsafe_store)?;
        if filename == "." || filename == ".." || filename == ".store.lock" {
            continue;
        }
        let id = filename
            .strip_suffix(".private")
            .ok_or(SecretStoreError::UnsafeStore)?;
        if !id_valid(id) {
            return Err(SecretStoreError::InvalidId);
        }
        open_at(directory, filename, libc::O_RDONLY)?;
        ids.push(id.to_owned());
        if ids.len() > MAX_RECORDS {
            return Err(SecretStoreError::Capacity);
        }
    }
    ids.sort();
    Ok(ids)
}
pub(super) fn create(root: &Path, namespace: &str, payload: &[u8]) -> Result<String> {
    if payload.len() > MAX_SECRET_BYTES {
        return Err(SecretStoreError::TooLarge);
    }
    let pins = store(root, namespace, true)?;
    let dir = pins.last().unwrap();
    let lock = open_at(dir, ".store.lock", libc::O_RDWR | libc::O_CREAT)?;
    lock.try_lock().map_err(|_| SecretStoreError::Unavailable)?;
    if enumerate(dir)?.len() >= MAX_RECORDS {
        return Err(SecretStoreError::Capacity);
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| SecretStoreError::Unavailable)?;
    let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let mut file = open_at(
        dir,
        &format!("{id}.private"),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
    )?;
    // Immutable names and an exclusive store lock prevent readers observing an
    // in-progress write; failed partial records remain visible as corrupt data.
    file.write_all(payload).map_err(unsafe_store)?;
    file.sync_all().map_err(unsafe_store)?;
    dir.sync_all().map_err(unsafe_store)?;
    Ok(id)
}
pub(super) fn load(root: &Path, namespace: &str, id: &str) -> Result<Zeroizing<Vec<u8>>> {
    if !id_valid(id) {
        return Err(SecretStoreError::InvalidId);
    }
    let pins = store(root, namespace, false)?;
    let dir = pins.last().unwrap();
    let lock = open_at(dir, ".store.lock", libc::O_RDWR | libc::O_CREAT)?;
    lock.try_lock().map_err(|_| SecretStoreError::Unavailable)?;
    let file = open_at(dir, &format!("{id}.private"), libc::O_RDONLY)?;
    let size = file.metadata().map_err(unsafe_store)?.len();
    if size > MAX_SECRET_BYTES as u64 {
        return Err(SecretStoreError::TooLarge);
    }
    let mut data = Zeroizing::new(Vec::with_capacity(size as usize + 1));
    (&file)
        .take(MAX_SECRET_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(unsafe_store)?;
    if data.len() as u64 != size {
        return Err(SecretStoreError::Corrupt);
    }
    Ok(data)
}
pub(super) fn list(root: &Path, namespace: &str) -> Result<Vec<String>> {
    let pins = match store(root, namespace, false) {
        Ok(p) => p,
        Err(SecretStoreError::NotFound) => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let dir = pins.last().unwrap();
    let lock = open_at(dir, ".store.lock", libc::O_RDWR | libc::O_CREAT)?;
    lock.try_lock().map_err(|_| SecretStoreError::Unavailable)?;
    enumerate(dir)
}
pub(super) fn lock_runtime_root(path: &Path) -> Result<(Vec<File>, File)> {
    pin_directories(
        path.parent().ok_or(SecretStoreError::UnsafeStore)?,
        false,
        false,
    )?;
    let pins = pin_directories(path, true, true)?;
    let lock = open_at(
        pins.last().unwrap(),
        ".central-service.lock",
        libc::O_RDWR | libc::O_CREAT,
    )?;
    lock.try_lock().map_err(|_| SecretStoreError::Unavailable)?;
    Ok((pins, lock))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn private_records_roundtrip_and_reject_alias_and_broad_permissions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let id = create(&root, "test-v1", b"synthetic-private-record").unwrap();
        assert_eq!(
            &*load(&root, "test-v1", &id).unwrap(),
            b"synthetic-private-record"
        );
        assert_eq!(list(&root, "test-v1").unwrap(), vec![id.clone()]);
        let record = root
            .join("central-secrets/test-v1")
            .join(format!("{id}.private"));
        std::fs::set_permissions(&record, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&root, "test-v1", &id).is_err());
        let alias = root.join("alias");
        symlink(root.join("central-secrets"), &alias).unwrap();
        assert!(pin_directories(&alias, false, true).is_err());
    }
    #[test]
    fn runtime_lock_is_exclusive() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("runtime");
        let first = lock_runtime_root(&root).unwrap();
        assert!(lock_runtime_root(&root).is_err());
        drop(first);
        assert!(lock_runtime_root(&root).is_ok());
    }
}
