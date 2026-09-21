// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// QA only: compile the exact production-candidate helper into an isolated fixture.
#[path = "windows_home.rs"]
mod windows_home;

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

fn raw_error(result: io::Result<PathBuf>) -> i32 {
    result.err().and_then(|error| error.raw_os_error()).unwrap_or(-1)
}

fn main() {
    let home = PathBuf::from(std::env::var_os("CODEX_HOME").expect("isolated CODEX_HOME"));
    let worker = std::env::current_dir().expect("worker cwd");
    let root = worker.parent().expect("synthetic QA root");
    assert_eq!(std::env::var("CODEX_REMOTE_WORKSPACE").as_deref(), Ok("1"));
    assert_eq!(raw_error(std::fs::canonicalize(&home)), 5, "fixture must reproduce the original DOS failure");
    let canonical = windows_home::canonicalize(&home).expect("own-home helper canonicalization");
    assert!(canonical.to_string_lossy().starts_with(r"\\?\GLOBALROOT\Device\HarddiskVolume"));
    let central_error = raw_error(windows_home::canonicalize(&root.join("central")));
    let bob_error = raw_error(windows_home::canonicalize(&root.join("bob")));
    assert_eq!(central_error, 5, "central directory must remain denied");
    assert_eq!(bob_error, 5, "other user's directory must remain denied");
    let missing_rejected = windows_home::canonicalize(&home.join("missing-home")).is_err();
    std::fs::write(home.join("ordinary-file"), b"SYNTHETIC_FILE").expect("ordinary file canary");
    let file_rejected = windows_home::canonicalize(&home.join("ordinary-file")).is_err();
    let supplied_device_rejected = windows_home::canonicalize(&canonical).is_err();
    let relative_rejected = windows_home::canonicalize(Path::new(".")).is_err();
    let volume_root_rejected = windows_home::canonicalize(&home.ancestors().last().expect("volume root")).is_err();
    // A fresh nonexistent share name on loopback only: no external host or
    // existing share is accessed. The helper must preserve the OS rejection.
    let unc = PathBuf::from(format!(r"\\127.0.0.1\yuan-p0-never-shared-{}\home", std::process::id()));
    let unc_rejected = windows_home::canonicalize(&unc).is_err();
    let mut central_junction_error = -1;
    let mut bob_junction_error = -1;
    let junctions_tested = std::env::var("YUAN_QA_HOME_HELPER_LINKS").as_deref() == Ok("1");
    if junctions_tested {
        central_junction_error = raw_error(windows_home::canonicalize(&worker.join("central-junction")));
        bob_junction_error = raw_error(windows_home::canonicalize(&worker.join("bob-junction")));
        assert_eq!(central_junction_error, 5, "junction must not grant access to central directory");
        assert_eq!(bob_junction_error, 5, "junction must not grant access to another user");
    }
    assert!(missing_rejected && file_rejected && supplied_device_rejected && relative_rejected);
    assert!(volume_root_rejected && unc_rejected);
    // This fixture is single-threaded, and no other code concurrently accesses
    // the process environment. Never modify the real runtime's environment.
    unsafe { std::env::remove_var("CODEX_REMOTE_WORKSPACE"); }
    let non_remote_error = raw_error(windows_home::canonicalize(&home));
    unsafe { std::env::set_var("CODEX_REMOTE_WORKSPACE", "1"); }
    assert_eq!(non_remote_error, 5, "non-remote calls must not use the fallback");
    std::env::set_current_dir(&canonical).expect("canonical own-home cwd");
    std::fs::write("helper-relative-canary", b"SYNTHETIC_HELPER").expect("relative write");
    assert_eq!(std::fs::read("helper-relative-canary").expect("relative read"), b"SYNTHETIC_HELPER");
    std::env::set_current_dir(&worker).expect("restore cwd");
    let diagnostics = format!(
        r#"{{"ownHomeCanonicalized":true,"helperIdentityCheckCompleted":true,"centralDirectoryError":{central_error},"otherUserDirectoryError":{bob_error},"missingRejected":{missing_rejected},"ordinaryFileRejected":{file_rejected},"suppliedDevicePathRejected":{supplied_device_rejected},"relativePathRejected":{relative_rejected},"volumeRootRejected":{volume_root_rejected},"uncRejected":{unc_rejected},"junctionsTested":{junctions_tested},"centralJunctionError":{central_junction_error},"otherUserJunctionError":{bob_junction_error},"nonRemoteError":{non_remote_error},"relativeReadWrite":true,"cwdRestored":true}}"#
    );
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin fixture RPC");
        if line.contains("p0-initialize") {
            writeln!(stdout, r#"{{"id":"p0-initialize","result":{{"userAgent":"SYNTHETIC_HOME_HELPER_FIXTURE yuan-zhou-remote-workspace/1","homeHelperDiagnostics":{diagnostics}}}}}"#).unwrap();
        } else if line.contains("p0-command") {
            writeln!(stdout, r#"{{"id":"p0-command","error":{{"code":-32602,"message":"REMOTE_WORKSPACE_UNSUPPORTED: command/exec"}}}}"#).unwrap();
        } else if line.contains("p0-filesystem") {
            writeln!(stdout, r#"{{"id":"p0-filesystem","error":{{"code":-32602,"message":"REMOTE_WORKSPACE_UNSUPPORTED: fs/readFile"}}}}"#).unwrap();
        }
        stdout.flush().unwrap();
    }
}
