// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Admission for a new Windows central private store; never repairs existing ACLs.
//!
//! Both the file and its direct storage directory must have a protected, non-null
//! DACL containing only ordinary allow ACEs for the process user, SYSTEM or built-in
//! Administrators, and an owner equal to the process user or SYSTEM. Inherited,
//! deny, object and callback ACEs are deliberately rejected. Ancestors need not be
//! private, but must be real directories and remain pinned throughout the read.
//! Current-user/SYSTEM/Administrators are trusted principals: this does not isolate
//! hostile processes already running as that user or holding administrative rights.
//! No existing Codex authentication file or device-token storage is migrated.

use std::{
    ffi::c_void,
    fmt,
    fs::File,
    io::Read,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{INVALID_HANDLE_VALUE, LocalFree},
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
};
use zeroize::Zeroizing;

pub const MAX_PRIVATE_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrivateFileError {
    UnsafePath,
    Unavailable,
    UnsafeFile,
    UnsafeAcl,
    TooLarge,
    Changed,
}
impl fmt::Display for PrivateFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnsafePath => "CENTRAL_PRIVATE_PATH_UNSAFE",
            Self::Unavailable => "CENTRAL_PRIVATE_FILE_UNAVAILABLE",
            Self::UnsafeFile => "CENTRAL_PRIVATE_FILE_UNSAFE",
            Self::UnsafeAcl => "CENTRAL_PRIVATE_ACL_UNSAFE",
            Self::TooLarge => "CENTRAL_PRIVATE_FILE_TOO_LARGE",
            Self::Changed => "CENTRAL_PRIVATE_FILE_CHANGED",
        })
    }
}
impl std::error::Error for PrivateFileError {}
type Result<T> = std::result::Result<T, PrivateFileError>;
struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

// Parse raw UTF-16 rather than Path::components, which normalizes away `.`.
fn components(path: &Path) -> Result<(Vec<u16>, Vec<Vec<u16>>)> {
    let mut raw: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .map(|c| if c == 47 { 92 } else { c })
        .collect();
    if raw.starts_with(&[92, 92, 63, 92]) {
        raw.drain(..4);
    }
    if raw.len() < 4
        || !((65..=90).contains(&raw[0]) || (97..=122).contains(&raw[0]))
        || raw[1..3] != [58, 92]
    {
        return Err(PrivateFileError::UnsafePath);
    }
    let parts: Vec<Vec<u16>> = raw[3..].split(|c| *c == 92).map(<[u16]>::to_vec).collect();
    for part in &parts {
        if part.is_empty()
            || part == &[46]
            || part == &[46, 46]
            || matches!(part.last(), Some(32 | 46))
            || part
                .iter()
                .any(|c| *c < 32 || [34, 42, 58, 60, 62, 63, 124].contains(c))
        {
            return Err(PrivateFileError::UnsafePath);
        }
        let base: String = String::from_utf16_lossy(part)
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"].contains(&base.as_str())
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(PrivateFileError::UnsafePath);
        }
    }
    Ok((raw[..3].to_vec(), parts))
}
fn wide(path: &[u16]) -> Vec<u16> {
    path.iter().copied().chain(Some(0)).collect()
}
fn open(path: &[u16], directory: bool, check_acl: bool) -> Result<File> {
    // Omitting WRITE/DELETE sharing refuses pre-existing mutation handles and
    // prevents opening new ones while the complete ancestor chain is held.
    // FILE_LIST_DIRECTORY counts as data access for sharing checks; metadata-only
    // handles do not exclude later directory mutation handles on Windows.
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            if directory {
                FILE_LIST_DIRECTORY
                    | FILE_READ_ATTRIBUTES
                    | if check_acl { READ_CONTROL } else { 0 }
            } else {
                0x80000000
            },
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(PrivateFileError::Unavailable);
    }
    // SAFETY: the non-inheritable CreateFile handle has a single owner.
    let file = unsafe { File::from_raw_handle(handle) };
    information(&file, directory)?;
    Ok(file)
}
fn information(file: &File, directory: bool) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
        || unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
    {
        return Err(PrivateFileError::Unavailable);
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && info.nNumberOfLinks != 1)
    {
        return Err(PrivateFileError::UnsafeFile);
    }
    Ok(info)
}
fn final_path(file: &File) -> Result<Vec<u16>> {
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            VOLUME_NAME_GUID,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(PrivateFileError::Unavailable);
    }
    buffer.truncate(length);
    Ok(buffer)
}
fn path_equal(a: &[u16], b: &[u16]) -> bool {
    let fold = |v: &u16| if (65..=90).contains(v) { *v + 32 } else { *v };
    a.iter().map(fold).eq(b.iter().map(fold))
}
fn is_volume_root(path: &[u16]) -> bool {
    // Reject SUBST mappings to a subdirectory: its hidden upper ancestors would
    // otherwise not be in our pinned chain. Native GUID syntax is 49 UTF-16 units.
    path.len() == 49
        && path.starts_with(&"\\\\?\\Volume{".encode_utf16().collect::<Vec<_>>())
        && path[47..] == [125, 92]
}
fn bounded_ace_sid(ace: &[u8]) -> Result<&[u8]> {
    // Ordinary allow ACE prefix is 8 bytes; SID header is a further 8 bytes.
    // Validate count and extent before asking any native API to dereference SID.
    if ace.len() < 16 || ace[9] > 15 {
        return Err(PrivateFileError::UnsafeAcl);
    }
    let end = 16 + usize::from(ace[9]) * 4;
    ace.get(8..end).ok_or(PrivateFileError::UnsafeAcl)
}
fn private_acl(file: &File, user: &[u8]) -> Result<()> {
    unsafe {
        let mut owner = null_mut();
        let mut acl = null_mut();
        let mut sd = null_mut();
        if GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        ) != 0
        {
            return Err(PrivateFileError::Unavailable);
        }
        let _sd = Local(sd);
        let mut control = 0;
        let mut revision = 0;
        if owner.is_null()
            || IsValidSid(owner) == 0
            || acl.is_null()
            || IsValidAcl(acl) == 0
            || (EqualSid(owner, user.as_ptr() as _) == 0
                && IsWellKnownSid(owner, WinLocalSystemSid) == 0)
            || GetSecurityDescriptorControl(sd, &mut control, &mut revision) == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(PrivateFileError::UnsafeAcl);
        }
        let mut size = std::mem::zeroed::<ACL_SIZE_INFORMATION>();
        if GetAclInformation(
            acl,
            (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ) == 0
            || size.AceCount == 0
        {
            return Err(PrivateFileError::UnsafeAcl);
        }
        for index in 0..size.AceCount {
            let mut raw = null_mut();
            if GetAce(acl, index, &mut raw) == 0 || raw.is_null() {
                return Err(PrivateFileError::UnsafeAcl);
            }
            let header = &*raw.cast::<ACE_HEADER>();
            if header.AceType != 0
                || header.AceSize < 16
                || u32::from(header.AceFlags)
                    & !(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | NO_PROPAGATE_INHERIT_ACE)
                    != 0
            {
                return Err(PrivateFileError::UnsafeAcl);
            }
            // IsValidAcl/GetAce establish the ACE extent in this system-owned SD.
            let ace = std::slice::from_raw_parts(raw.cast::<u8>(), header.AceSize as usize);
            let sid = bounded_ace_sid(ace)?.as_ptr() as *mut c_void;
            if IsValidSid(sid) == 0
                || (EqualSid(sid, user.as_ptr() as _) == 0
                    && IsWellKnownSid(sid, WinLocalSystemSid) == 0
                    && IsWellKnownSid(sid, WinBuiltinAdministratorsSid) == 0)
            {
                return Err(PrivateFileError::UnsafeAcl);
            }
        }
    }
    Ok(())
}
fn identity(info: &BY_HANDLE_FILE_INFORMATION) -> (u32, u32, u32, u32, u32) {
    (
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
        info.nFileSizeHigh,
        info.nFileSizeLow,
    )
}

/// Read from the same validated handle, retaining pinned ancestor handles until
/// the final ACL/identity check. Returns zeroizing bytes; never includes paths,
/// security descriptors, OS diagnostics or file contents in an error.
pub fn read_private_file(path: &Path, max_bytes: usize) -> Result<Zeroizing<Vec<u8>>> {
    read_inner(path, max_bytes, || {})
}
fn read_inner(
    path: &Path,
    max_bytes: usize,
    before_read: impl FnOnce(),
) -> Result<Zeroizing<Vec<u8>>> {
    if max_bytes == 0 || max_bytes > MAX_PRIVATE_FILE_BYTES {
        return Err(PrivateFileError::TooLarge);
    }
    let (root, parts) = components(path)?;
    let user =
        crate::device_token::secure::user_sid().map_err(|_| PrivateFileError::Unavailable)?;
    const DRIVE_FIXED: u32 = 3;
    if unsafe { GetDriveTypeW(wide(&root).as_ptr()) } != DRIVE_FIXED {
        return Err(PrivateFileError::UnsafePath);
    }
    let root_file = open(&root, true, parts.len() == 1)?;
    let mut current_path = final_path(&root_file)?;
    // Bind each opened handle to the original volume GUID before inspecting or
    // reading its data; a remapped drive cannot substitute a different object.
    // Use the caller's drive syntax for opens (Windows policy may deny volume
    // device aliases), then compare the handle's GUID path to this pinned path.
    if !is_volume_root(&current_path) {
        return Err(PrivateFileError::UnsafePath);
    }
    let mut open_path = "\\\\?\\"
        .encode_utf16()
        .chain(root.iter().copied())
        .collect::<Vec<_>>();
    let mut ancestors = vec![(root_file, current_path.clone())];
    for (index, part) in parts[..parts.len() - 1].iter().enumerate() {
        if current_path.last() != Some(&92) {
            current_path.push(92);
        }
        current_path.extend(part);
        if open_path.last() != Some(&92) {
            open_path.push(92);
        }
        open_path.extend(part);
        let file = open(&open_path, true, index + 2 == parts.len())?;
        if !path_equal(&final_path(&file)?, &current_path) {
            return Err(PrivateFileError::Changed);
        }
        ancestors.push((file, current_path.clone()));
    }
    private_acl(
        &ancestors.last().ok_or(PrivateFileError::UnsafePath)?.0,
        &user,
    )?;
    if current_path.last() != Some(&92) {
        current_path.push(92);
    }
    current_path.extend(parts.last().ok_or(PrivateFileError::UnsafePath)?);
    if open_path.last() != Some(&92) {
        open_path.push(92);
    }
    open_path.extend(parts.last().ok_or(PrivateFileError::UnsafePath)?);
    let mut file = open(&open_path, false, true)?;
    if !path_equal(&final_path(&file)?, &current_path) {
        return Err(PrivateFileError::Changed);
    }
    private_acl(&file, &user)?;
    let before = information(&file, false)?;
    let length = ((before.nFileSizeHigh as u64) << 32) | before.nFileSizeLow as u64;
    if length > max_bytes as u64 {
        return Err(PrivateFileError::TooLarge);
    }
    before_read();
    // Never grow a secret-bearing Vec: reallocations would leave the former
    // allocation outside Zeroizing's reach. Check EOF in a separate wiped byte.
    let mut bytes = Zeroizing::new(vec![0; length as usize]);
    file.read_exact(&mut bytes)
        .map_err(|_| PrivateFileError::Changed)?;
    let mut extra = Zeroizing::new([0u8; 1]);
    if file
        .read(extra.as_mut())
        .map_err(|_| PrivateFileError::Unavailable)?
        != 0
    {
        return Err(PrivateFileError::Changed);
    }
    private_acl(&file, &user)?;
    if identity(&before) != identity(&information(&file, false)?)
        || bytes.len() as u64 != length
        || !path_equal(&final_path(&file)?, &current_path)
    {
        return Err(PrivateFileError::Changed);
    }
    for (directory, expected) in &ancestors {
        information(directory, true)?;
        if !path_equal(&final_path(directory)?, expected) {
            return Err(PrivateFileError::Changed);
        }
    }
    private_acl(
        &ancestors.last().ok_or(PrivateFileError::UnsafePath)?.0,
        &user,
    )?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn user_text() -> String {
        unsafe {
            let sid = crate::device_token::secure::user_sid().unwrap();
            let mut text = null_mut();
            assert_ne!(ConvertSidToStringSidW(sid.as_ptr() as _, &mut text), 0);
            let _text = Local(text.cast());
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            String::from_utf16(std::slice::from_raw_parts(text, length)).unwrap()
        }
    }
    // Mutations are confined to fresh tempfile fixtures, never a user store.
    fn set_acl(path: &Path, suffix: &str, protected: bool) {
        unsafe {
            let text = format!(
                "D:{}(A;;FA;;;{}){}",
                if protected { "P" } else { "" },
                user_text(),
                suffix
            );
            let sddl: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
            let mut sd = null_mut();
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut sd,
                    null_mut()
                ),
                0
            );
            let _sd = Local(sd);
            let mut acl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            assert_ne!(
                GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted),
                0
            );
            let mut path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            assert_eq!(
                SetNamedSecurityInfoW(
                    path.as_mut_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION
                        | if protected {
                            PROTECTED_DACL_SECURITY_INFORMATION
                        } else {
                            UNPROTECTED_DACL_SECURITY_INFORMATION
                        },
                    null_mut(),
                    null_mut(),
                    acl,
                    null_mut()
                ),
                0
            );
        }
    }
    struct Fixture {
        _temp: tempfile::TempDir,
        directory: PathBuf,
        file: PathBuf,
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("private");
        fs::create_dir(&directory).unwrap();
        set_acl(&directory, "", true);
        let file = directory.join("synthetic.dat");
        fs::write(&file, b"SYNTHETIC_PRIVATE_BYTES").unwrap();
        set_acl(&file, "", true);
        Fixture {
            _temp: temp,
            directory,
            file,
        }
    }
    #[test]
    fn admits_current_user_and_explicit_trusted_principals() {
        let f = fixture();
        assert_eq!(
            read_private_file(&f.file, 100).unwrap().as_slice(),
            b"SYNTHETIC_PRIVATE_BYTES"
        );
        set_acl(&f.directory, "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", true);
        set_acl(&f.file, "(A;;FA;;;SY)(A;;FA;;;BA)", true);
        assert_eq!(
            read_private_file(&f.file, 100).unwrap().as_slice(),
            b"SYNTHETIC_PRIVATE_BYTES"
        );
    }
    #[test]
    fn rejects_world_users_worker_and_arbitrary_group_aces() {
        let f = fixture();
        for sid in [
            "WD",
            "BU",
            "S-1-15-2-1",
            "S-1-15-2-123-456-789-123-456-789-123",
            "S-1-5-21-123-456-789-1999",
        ] {
            set_acl(&f.file, &format!("(A;;FR;;;{sid})"), true);
            assert_eq!(
                read_private_file(&f.file, 100).err(),
                Some(PrivateFileError::UnsafeAcl)
            );
        }
    }
    #[test]
    fn rejects_unprotected_file_and_broad_storage_directory() {
        let f = fixture();
        set_acl(&f.file, "", false);
        assert_eq!(
            read_private_file(&f.file, 100).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
        set_acl(&f.file, "", true);
        set_acl(&f.directory, "(A;;FR;;;WD)", true);
        assert_eq!(
            read_private_file(&f.file, 100).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
    }
    #[test]
    fn rejects_an_unprotected_private_store_root() {
        let f = fixture();
        set_acl(&f.directory, "", false);
        assert_eq!(
            read_private_file(&f.file, 100).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
    }
    #[test]
    fn only_a_native_volume_root_can_anchor_the_directory_chain() {
        let root = r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\";
        assert!(is_volume_root(&root.encode_utf16().collect::<Vec<_>>()));
        assert!(!is_volume_root(
            &format!("{root}substituted-directory")
                .encode_utf16()
                .collect::<Vec<_>>()
        ));
        assert!(!is_volume_root(
            &r"\\server\share\".encode_utf16().collect::<Vec<_>>()
        ));
    }
    #[test]
    fn rejects_deny_and_inherit_only_aces_conservatively() {
        let f = fixture();
        for suffix in ["(D;;FW;;;BU)", "(A;OIIO;FR;;;SY)"] {
            set_acl(&f.directory, suffix, true);
            // A deny may prevent the initial read; either way no bytes admitted.
            assert!(read_private_file(&f.file, 100).is_err());
        }
    }
    #[test]
    fn rejects_null_dacl() {
        let f = fixture();
        unsafe {
            let mut path: Vec<u16> = f.file.as_os_str().encode_wide().chain(Some(0)).collect();
            assert_eq!(
                SetNamedSecurityInfoW(
                    path.as_mut_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut()
                ),
                0
            );
        }
        assert_eq!(
            read_private_file(&f.file, 100).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
    }
    #[test]
    fn rejects_hardlinks_directories_and_size_limits() {
        let f = fixture();
        let link = f.directory.join("second-link");
        fs::hard_link(&f.file, &link).unwrap();
        assert_eq!(
            read_private_file(&f.file, 100).err(),
            Some(PrivateFileError::UnsafeFile)
        );
        fs::remove_file(link).unwrap();
        let directory_file = f.directory.join("directory-as-file");
        fs::create_dir(&directory_file).unwrap();
        assert_eq!(
            read_private_file(&directory_file, 100).err(),
            Some(PrivateFileError::UnsafeFile)
        );
        assert_eq!(
            read_private_file(&f.file, 1).err(),
            Some(PrivateFileError::TooLarge)
        );
        assert_eq!(
            read_private_file(&f.file, 0).err(),
            Some(PrivateFileError::TooLarge)
        );
        assert_eq!(
            read_private_file(&f.file, MAX_PRIVATE_FILE_BYTES + 1).err(),
            Some(PrivateFileError::TooLarge)
        );
    }
    #[test]
    fn rejects_lexical_aliases_and_alternate_streams_before_opening() {
        for path in [
            r"relative.dat",
            r"C:\private\..\secret",
            r"C:\private\.\secret",
            r"C:\private\secret:stream",
            r"C:\private\secret.",
            r"C:\private\secret ",
            r"C:\private\\secret",
            r"\\server\share\secret",
            r"\\.\pipe\secret",
            r"C:\private\NUL",
            r"C:\private\COM1.txt",
            "C:\\private\\secret\0suffix",
        ] {
            assert_eq!(
                read_private_file(Path::new(path), 100).err(),
                Some(PrivateFileError::UnsafePath)
            );
        }
    }
    #[test]
    fn rejects_a_junction_ancestor() {
        let f = fixture();
        let junction = f._temp.path().join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&f.directory)
            .output()
            .unwrap()
            .status;
        assert!(status.success(), "fresh QA junction creation required");
        assert_eq!(
            read_private_file(&junction.join("synthetic.dat"), 100).err(),
            Some(PrivateFileError::UnsafeFile)
        );
        fs::remove_dir(junction).unwrap();
    }
    #[test]
    fn rejects_a_junction_at_the_final_component() {
        let f = fixture();
        let junction = f.directory.join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&f._temp.path())
            .output()
            .unwrap()
            .status;
        assert!(status.success(), "fresh QA junction creation required");
        assert_eq!(
            read_private_file(&junction, 100).err(),
            Some(PrivateFileError::UnsafeFile)
        );
        fs::remove_dir(junction).unwrap();
    }
    #[test]
    fn rejects_undersized_ace_sid_before_native_pointer_validation() {
        assert_eq!(
            bounded_ace_sid(&[0; 12]).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
        let mut ace = [0; 16];
        ace[9] = 1;
        assert_eq!(
            bounded_ace_sid(&ace).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
        ace[9] = 255;
        assert_eq!(
            bounded_ace_sid(&ace).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
        ace[9] = 0;
        assert_eq!(bounded_ace_sid(&ace).unwrap().len(), 8);
    }
    #[test]
    fn pins_file_and_ancestors_against_replacement_and_writers() {
        let f = fixture();
        let bytes = read_inner(&f.file, 100, || {
            assert!(fs::rename(&f.file, f.directory.join("replacement")).is_err());
            assert!(fs::rename(&f.directory, f._temp.path().join("moved")).is_err());
            assert!(fs::OpenOptions::new().write(true).open(&f.file).is_err());
            unsafe {
                let path: Vec<u16> = f
                    .directory
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                let handle = CreateFileW(
                    path.as_ptr(),
                    0x40000000,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    null_mut(),
                );
                if handle != INVALID_HANDLE_VALUE {
                    drop(File::from_raw_handle(handle));
                    panic!("Pinned directory admitted a mutation handle");
                }
            }
        })
        .unwrap();
        assert_eq!(bytes.as_slice(), b"SYNTHETIC_PRIVATE_BYTES");
        fs::rename(&f.file, f.directory.join("after-read")).unwrap();
    }
    #[test]
    fn detects_acl_change_before_return() {
        let f = fixture();
        assert_eq!(
            read_inner(&f.file, 100, || set_acl(&f.file, "(A;;FR;;;WD)", true)).err(),
            Some(PrivateFileError::UnsafeAcl)
        );
    }
}
