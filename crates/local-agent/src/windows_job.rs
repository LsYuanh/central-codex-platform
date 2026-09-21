// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Keep command descendants tied to the Agent even when TerminateProcess skips cleanup.
use std::{
    io,
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::null,
    sync::OnceLock,
};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    },
    Threading::GetCurrentProcess,
};

// Static storage is intentional: closing a local guard would also kill this Agent,
// which belongs to the job. The OS closes this non-inheritable handle on process exit.
static PROCESS_JOB: OnceLock<Result<OwnedHandle, String>> = OnceLock::new();

pub fn install() -> Result<(), String> {
    PROCESS_JOB
        .get_or_init(create)
        .as_ref()
        .map(|_| ())
        .map_err(Clone::clone)
}

fn create() -> Result<OwnedHandle, String> {
    // Null SECURITY_ATTRIBUTES creates a non-inheritable handle; descendants must
    // inherit job membership, never the handle that controls its lifetime.
    let raw = unsafe { CreateJobObjectW(null(), null()) };
    if raw.is_null() {
        return Err(format!(
            "AGENT_JOB_SETUP_FAILED: CreateJobObjectW: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: CreateJobObjectW returned a new owned handle, closed on setup failure.
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(format!(
            "AGENT_JOB_SETUP_FAILED: SetInformationJobObject: {}",
            io::Error::last_os_error()
        ));
    }
    // Assign before any command is spawned, so descendant inheritance has no race.
    // Modern Windows permits nesting under a launcher/sandbox job; refusal is fatal.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) } == 0 {
        return Err(format!(
            "AGENT_JOB_SETUP_FAILED: AssignProcessToJobObject: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(job)
}
