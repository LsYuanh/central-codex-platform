// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Windows remote-worker CODEX_HOME only. Never substitutes a lexical path for
// canonicalization or changes the filesystem access token.
use std::ffi::{OsString, c_void};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Component, Path, PathBuf, Prefix};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn GetFinalPathNameByHandleW(
        handle: *mut c_void,
        buffer: *mut u16,
        length: u32,
        flags: u32,
    ) -> u32;
    fn GetFileInformationByHandleEx(
        handle: *mut c_void,
        class: i32,
        info: *mut c_void,
        size: u32,
    ) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: i32,
        info: *mut c_void,
        size: u32,
        returned: *mut u32,
    ) -> i32;
}

pub(crate) fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) => {
            if error.raw_os_error() != Some(5)
                || std::env::var("CODEX_REMOTE_WORKSPACE").as_deref() != Ok("1")
                || !is_app_container().unwrap_or(false)
            {
                return Err(error);
            }
            canonicalize_local_directory_nt(path)
        }
    }
}

fn is_app_container() -> io::Result<bool> {
    let mut token = std::ptr::null_mut();
    // TOKEN_QUERY; the resulting owned handle is never inherited.
    if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut enabled: u32 = 0;
    let mut returned = 0;
    // TokenIsAppContainer = 29.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            29,
            (&mut enabled as *mut u32).cast(),
            4,
            &mut returned,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(returned == 4 && enabled == 1)
}

fn open_directory(path: &Path) -> io::Result<File> {
    // FILE_READ_ATTRIBUTES, FILE_SHARE_READ|WRITE|DELETE, BACKUP_SEMANTICS.
    // No BACKUP privilege, OPEN_REPARSE_POINT, or access-right overrides.
    let file = OpenOptions::new()
        .access_mode(0x80)
        .share_mode(7)
        .custom_flags(0x02000000)
        .open(path)?;
    if !file.metadata()?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CODEX_HOME must be a directory",
        ));
    }
    Ok(file)
}

#[repr(C)]
#[derive(Default, PartialEq, Eq)]
struct FileIdentity {
    volume_serial_number: u64,
    file_id: [u8; 16],
}
fn identity(file: &File) -> io::Result<FileIdentity> {
    let mut info = FileIdentity::default();
    // FileIdInfo = 18, Windows 8+. Fail closed on filesystems that cannot provide it.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            18,
            (&mut info as *mut FileIdentity).cast(),
            std::mem::size_of::<FileIdentity>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

fn canonicalize_local_directory_nt(path: &Path) -> io::Result<PathBuf> {
    // Only the launcher's existing local drive directory qualifies for this
    // fallback. UNC, supplied device paths and drive-relative paths fail closed.
    if !path.is_absolute()
        || !matches!(path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Remote CODEX_HOME requires a local absolute drive path",
        ));
    }
    let source = open_directory(path)?;
    let mut buffer = vec![0u16; 32768];
    // FILE_NAME_NORMALIZED (0) | VOLUME_NAME_NT (2): resolve the actual opened
    // object. FILE_NAME_OPENED and VOLUME_NAME_NONE are deliberately not used.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            source.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            2,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= buffer.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Canonical home path exceeds the supported limit",
        ));
    }
    buffer.truncate(length as usize);
    let result = local_nt_path(&buffer)?;
    let reopened = open_directory(&result)?;
    if identity(&source)? != identity(&reopened)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Canonical home directory identity changed",
        ));
    }
    Ok(result)
}

fn local_nt_path(nt: &[u16]) -> io::Result<PathBuf> {
    let prefix: Vec<u16> = r"\Device\HarddiskVolume".encode_utf16().collect();
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Unsupported canonical local volume path",
        )
    };
    let rest = nt.strip_prefix(prefix.as_slice()).ok_or_else(invalid)?;
    let digits = rest
        .iter()
        .take_while(|&&c| (b'0' as u16..=b'9' as u16).contains(&c))
        .count();
    // Require a directory below a local volume, never a volume root or another
    // NT device (Mup, named pipe, console, shadow-copy device, etc.).
    if digits == 0
        || rest.get(digits) != Some(&(b'\\' as u16))
        || rest.len() <= digits + 1
        || !rest[digits + 1..].iter().any(|&c| c != b'\\' as u16)
        || nt.contains(&0)
    {
        return Err(invalid());
    }
    let mut full: Vec<u16> = r"\\?\GLOBALROOT".encode_utf16().collect();
    full.extend_from_slice(nt);
    let path = PathBuf::from(OsString::from_wide(&full));
    if path
        .components()
        .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_normalized_local_directory_names() {
        assert!(
            local_nt_path(
                &r"\Device\HarddiskVolume3\Users\本机\home"
                    .encode_utf16()
                    .collect::<Vec<_>>()
            )
            .is_ok()
        );
        for path in [
            r"\Device\HarddiskVolume3\",
            r"\Device\HarddiskVolume3\\",
            r"\Device\HarddiskVolume3",
            r"\Device\HarddiskVolumeShadowCopy1\home",
            r"\Device\Mup\server\home",
            r"\Device\NamedPipe\home",
            r"\Device\HarddiskVolume3\home\..\secret",
        ] {
            assert!(
                local_nt_path(&path.encode_utf16().collect::<Vec<_>>()).is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn missing_directory_is_not_turned_into_lexical_success() {
        let path = std::env::temp_dir().join(format!("yuan-home-absent-{}", std::process::id()));
        assert!(!path.exists());
        assert!(canonicalize(&path).is_err());
    }
}
