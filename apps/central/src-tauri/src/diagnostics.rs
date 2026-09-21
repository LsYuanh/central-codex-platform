// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Explicit public projection only. Never serialize configuration or process
//! snapshots wholesale, and never inspect credentials, user databases or logs.
use crate::{config, service_process};
use serde::Serialize;
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Component, Path},
    time::{SystemTime, UNIX_EPOCH},
};

const METRICS_MAX_AGE_MS: u64 = 10_000;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema_version: u64,
    pub generated_at: u64,
    pub app_version: String,
    pub platform: &'static str,
    pub configuration: Configuration,
    pub service: Service,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub status: &'static str,
    pub revision: Option<u64>,
    pub limits: Option<config::Limits>,
    pub shutdown: Option<config::Shutdown>,
    pub runtime_selected: bool,
    pub certificate_selected: bool,
    pub error_code: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub state: service_process::State,
    pub generation: u64,
    pub sequence: u64,
    pub observed_at: u64,
    pub cleanup_verified: bool,
    pub forced_stop: bool,
    pub failure_code: Option<&'static str>,
    pub metrics_status: &'static str,
    pub metrics: Option<service_process::RuntimeMetrics>,
}

fn public_code(code: &str) -> &'static str {
    // Return a literal, never the supplied value, even if a future upstream
    // failure begins including an OS message, a path or a child stderr line.
    match code {
        "CONFIG_INVALID" => "CONFIG_INVALID",
        "CONFIG_STORAGE_UNSAFE" => "CONFIG_STORAGE_UNSAFE",
        "CONFIG_VERSION_UNSUPPORTED" => "CONFIG_VERSION_UNSUPPORTED",
        "RUNTIME_PLATFORM_MISMATCH" => "RUNTIME_PLATFORM_MISMATCH",
        "OPERATION_BUSY" => "OPERATION_BUSY",
        "SERVICE_STATE_FAILED" => "SERVICE_STATE_FAILED",
        "SERVICE_ALREADY_ACTIVE" => "SERVICE_ALREADY_ACTIVE",
        "SERVICE_GENERATION_LIMIT" => "SERVICE_GENERATION_LIMIT",
        "SERVICE_ACTOR_UNAVAILABLE" => "SERVICE_ACTOR_UNAVAILABLE",
        "SERVICE_SPEC_INVALID" => "SERVICE_SPEC_INVALID",
        "SERVICE_BOOTSTRAP_INVALID" => "SERVICE_BOOTSTRAP_INVALID",
        "SERVICE_ENV_INVALID" => "SERVICE_ENV_INVALID",
        "SERVICE_FORCED_STOP" => "SERVICE_FORCED_STOP",
        "SERVICE_START_TIMEOUT" => "SERVICE_START_TIMEOUT",
        "SERVICE_UNEXPECTED_EXIT" => "SERVICE_UNEXPECTED_EXIT",
        "SERVICE_GATEWAY_FAILED" => "SERVICE_GATEWAY_FAILED",
        "SERVICE_STOP_TIMEOUT" => "SERVICE_STOP_TIMEOUT",
        "SERVICE_EXIT_FAILED" => "SERVICE_EXIT_FAILED",
        "SERVICE_DESCENDANTS_REMAINED" => "SERVICE_DESCENDANTS_REMAINED",
        "SERVICE_CLEANUP_UNCONFIRMED" => "SERVICE_CLEANUP_UNCONFIRMED",
        "SERVICE_PLATFORM_UNSUPPORTED" => "SERVICE_PLATFORM_UNSUPPORTED",
        "SERVICE_RANDOM_FAILED" => "SERVICE_RANDOM_FAILED",
        "SERVICE_NATIVE_HANDLE_FAILED" => "SERVICE_NATIVE_HANDLE_FAILED",
        "SERVICE_PIPE_FAILED" => "SERVICE_PIPE_FAILED",
        "SERVICE_JOB_ATTACH_FAILED" => "SERVICE_JOB_ATTACH_FAILED",
        "SERVICE_JOB_FAILED" => "SERVICE_JOB_FAILED",
        "SERVICE_SPAWN_FAILED" => "SERVICE_SPAWN_FAILED",
        "SERVICE_RESUME_FAILED" => "SERVICE_RESUME_FAILED",
        "SERVICE_WRITER_FAILED" => "SERVICE_WRITER_FAILED",
        "SERVICE_CONTROL_FRAME_LIMIT" => "SERVICE_CONTROL_FRAME_LIMIT",
        "SERVICE_BOOTSTRAP_WRITE_FAILED" => "SERVICE_BOOTSTRAP_WRITE_FAILED",
        _ => "INTERNAL_ERROR",
    }
}

pub fn build_report(root: &Path, snapshot: service_process::Snapshot) -> Report {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    build_report_at(root, snapshot, now)
}

fn build_report_at(root: &Path, snapshot: service_process::Snapshot, now: u64) -> Report {
    let configuration = match config::read(root) {
        Ok(response) => match response.config {
            Some(c) => Configuration {
                status: "available",
                revision: Some(c.revision),
                limits: Some(c.limits),
                shutdown: Some(c.shutdown),
                runtime_selected: !c.runtime_package_id.is_empty(),
                certificate_selected: !c.tls.certificate_id.is_empty(),
                error_code: None,
            },
            None => empty_configuration("missing", None),
        },
        Err(error) => empty_configuration("unavailable", Some(public_code(error.code))),
    };
    let (metrics_status, metrics) = project_metrics(&snapshot, now);
    Report {
        schema_version: 1,
        generated_at: now,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        platform: if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "other"
        },
        configuration,
        service: Service {
            state: snapshot.state,
            generation: snapshot.generation,
            sequence: snapshot.sequence,
            observed_at: snapshot.observed_at,
            cleanup_verified: snapshot.cleanup_verified,
            forced_stop: snapshot.forced_stop,
            failure_code: snapshot.failure_code.map(public_code),
            metrics_status,
            metrics,
        },
    }
}

fn empty_configuration(status: &'static str, error_code: Option<&'static str>) -> Configuration {
    Configuration {
        status,
        revision: None,
        limits: None,
        shutdown: None,
        runtime_selected: false,
        certificate_selected: false,
        error_code,
    }
}

fn project_metrics(
    snapshot: &service_process::Snapshot,
    now: u64,
) -> (&'static str, Option<service_process::RuntimeMetrics>) {
    if snapshot.state != service_process::State::Running {
        return ("inactive", None);
    }
    let Some(m) = &snapshot.metrics else {
        return ("missing", None);
    };
    if snapshot.instance_id.is_none()
        || snapshot.cleanup_verified
        || snapshot.forced_stop
        || snapshot.failure_code.is_some()
        || m.sequence == 0
        || m.sequence > SAFE_INTEGER
        || m.online_devices > 100_000
        || m.active_turns > 128
        || m.workers > 128
        || m.ready_workers > m.workers
        || m.starting_workers > 128
        || m.stopping_workers > 128
    {
        return ("missing", None);
    }
    if m.observed_at > now || now - m.observed_at > METRICS_MAX_AGE_MS {
        return ("stale", None);
    }
    ("fresh", Some(m.clone()))
}

/// Saves only to the native picker destination. No overwrite, parent creation,
/// raw error text or partial destination file on an ordinary write failure.
pub fn write_report(path: &Path, report: &Report) -> config::Result<()> {
    let failed = || config::failure("DIAGNOSTICS_EXPORT_FAILED");
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(failed());
    }
    match fs::symlink_metadata(path) {
        Ok(_) => return Err(config::failure("DIAGNOSTICS_TARGET_EXISTS")),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return Err(failed()),
    }
    let parent = path.parent().ok_or_else(failed)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".central-diagnostics-")
        .tempfile_in(parent)
        .map_err(|_| failed())?;
    serde_json::to_writer_pretty(temp.as_file_mut(), report).map_err(|_| failed())?;
    temp.write_all(b"\n").map_err(|_| failed())?;
    temp.as_file().sync_all().map_err(|_| failed())?;
    temp.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == ErrorKind::AlreadyExists {
            config::failure("DIAGNOSTICS_TARGET_EXISTS")
        } else {
            failed()
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use service_process::{RuntimeMetrics, Snapshot, State};

    fn snapshot() -> Snapshot {
        Snapshot {
            account_updates_supported: false,
            state: State::Running,
            generation: 2,
            sequence: 3,
            instance_id: Some("INSTANCE_CANARY_SECRET".to_owned()),
            observed_at: 20_000,
            deadline_at: Some(987_654_321),
            pid: Some(987_654_320),
            cleanup_verified: false,
            forced_stop: false,
            failure_code: None,
            metrics: Some(RuntimeMetrics {
                online_devices: 1,
                active_turns: 1,
                workers: 1,
                ready_workers: 1,
                starting_workers: 0,
                stopping_workers: 0,
                sequence: 2,
                observed_at: 20_000,
            }),
        }
    }

    #[cfg(windows)]
    #[test]
    fn report_omits_config_paths_identifiers_and_unread_secret_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app");
        config::save(
            &root,
            "synthetic-request".into(),
            0,
            serde_json::json!({
                "schemaVersion":1,"revision":0,
                "dataDirectory":temp.path().join("PATH_CANARY_SECRET"),
                "listen":{"host":"127.0.0.1","port":45410},
                "clientUrl":"wss://host-canary-secret.example:45410/ws",
                "tls":{"certificateId":"CERT_CANARY_SECRET"},
                "runtimePackageId":"RUNTIME_CANARY_SECRET",
                "limits":{"maxWorkers":8,"perUserTurns":2,"totalTurns":8},
                "shutdown":{"graceMs":10000,"forceMs":5000}
            }),
        )
        .unwrap();
        for name in ["auth.json", "users.db", "service.log"] {
            fs::write(root.join(name), b"CREDENTIAL_USER_DEVICE_LOG_CANARY_SECRET").unwrap();
        }
        let mut state = snapshot();
        state.failure_code = Some("CHILD_ERROR_CANARY_SECRET");
        let report = build_report_at(&root, state, 20_001);
        assert_eq!(report.configuration.status, "available");
        assert_eq!(report.configuration.revision, Some(1));
        assert!(report.configuration.runtime_selected);
        assert!(report.configuration.certificate_selected);
        assert_eq!(report.service.failure_code, Some("INTERNAL_ERROR"));
        let text = serde_json::to_string(&report).unwrap();
        assert!(!text.to_ascii_lowercase().contains("canary"));
        for forbidden in [
            "instanceId",
            "pid",
            "deadlineAt",
            "dataDirectory",
            "clientUrl",
            "listen",
            "certificateId",
            "runtimePackageId",
        ] {
            assert!(
                !text.contains(forbidden),
                "unexpected exported field: {forbidden}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn missing_and_corrupt_config_are_partial_results_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("missing");
        let missing = build_report_at(&root, snapshot(), 20_001);
        assert_eq!(missing.configuration.status, "missing");
        assert_eq!(missing.service.metrics_status, "fresh");
        assert!(!root.exists());
        fs::create_dir_all(root.join("config")).unwrap();
        let path = root.join("config/central-config.json");
        fs::write(&path, b"CORRUPT_CANARY_SECRET").unwrap();
        let corrupt = build_report_at(&root, snapshot(), 20_001);
        assert_eq!(corrupt.configuration.status, "unavailable");
        assert_eq!(
            corrupt.configuration.error_code,
            Some("CONFIG_STORAGE_UNSAFE")
        );
        assert_eq!(corrupt.service.metrics_status, "fresh");
        assert!(!serde_json::to_string(&corrupt).unwrap().contains("CANARY"));
        assert_eq!(fs::read(&path).unwrap(), b"CORRUPT_CANARY_SECRET");
    }

    #[test]
    fn metrics_require_running_fresh_valid_sample() {
        let mut state = snapshot();
        assert_eq!(project_metrics(&state, 30_000).0, "fresh");
        assert_eq!(project_metrics(&state, 30_001), ("stale", None));
        assert_eq!(project_metrics(&state, 19_999), ("stale", None));
        for status in [
            State::Stopped,
            State::Starting,
            State::Stopping,
            State::Failed,
        ] {
            state.state = status;
            assert_eq!(project_metrics(&state, 20_001), ("inactive", None));
        }
        state = snapshot();
        state.metrics = None;
        assert_eq!(project_metrics(&state, 20_001), ("missing", None));
        state = snapshot();
        state.metrics.as_mut().unwrap().ready_workers = 2;
        assert_eq!(project_metrics(&state, 20_001), ("missing", None));
        for flag in ["cleanup", "forced", "failure", "instance"] {
            state = snapshot();
            match flag {
                "cleanup" => state.cleanup_verified = true,
                "forced" => state.forced_stop = true,
                "failure" => state.failure_code = Some("SERVICE_GATEWAY_FAILED"),
                _ => state.instance_id = None,
            }
            assert_eq!(project_metrics(&state, 20_001), ("missing", None));
        }
        assert_eq!(
            public_code("SERVICE_GATEWAY_FAILED"),
            "SERVICE_GATEWAY_FAILED"
        );
        assert_eq!(
            public_code("SERVICE_GATEWAY_FAILED: private path"),
            "INTERNAL_ERROR"
        );
    }

    #[test]
    fn export_is_complete_and_never_overwrites_existing_target() {
        let temp = tempfile::tempdir().unwrap();
        let report = build_report_at(&temp.path().join("missing"), snapshot(), 20_001);
        let path = temp.path().join("report.json");
        write_report(&path, &report).unwrap();
        let original = fs::read(&path).unwrap();
        let saved: serde_json::Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(saved["schemaVersion"], 1);
        assert_eq!(saved["service"]["metricsStatus"], "fresh");
        assert_eq!(
            write_report(&path, &report).unwrap_err().code,
            "DIAGNOSTICS_TARGET_EXISTS"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        assert_eq!(
            write_report(temp.path(), &report).unwrap_err().code,
            "DIAGNOSTICS_TARGET_EXISTS"
        );
        assert_eq!(
            write_report(&temp.path().join("absent/report.json"), &report)
                .unwrap_err()
                .code,
            "DIAGNOSTICS_EXPORT_FAILED"
        );
        assert!(!temp.path().join("absent").exists());
        assert_eq!(
            write_report(Path::new("relative-report.json"), &report)
                .unwrap_err()
                .code,
            "DIAGNOSTICS_EXPORT_FAILED"
        );
    }
}
