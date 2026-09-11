// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Explicit opt-in acceptance only; never compiled into the desktop product.
#![cfg(all(test, windows))]
use crate::{
    model_accounts,
    people::{Mutation, People},
    service::{Service, StartRequest},
    service_process::State,
    tls,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    mem::{size_of, zeroed},
    net::TcpListener,
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    ptr::{null, null_mut},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, System::JobObjects::*};
use zeroize::Zeroizing;
type QaResult<T> = std::result::Result<T, &'static str>;
const MODEL: &str = "gpt-6-astra";
const WORK_LIMIT: Duration = Duration::from_secs(270);
const OPENSSL: &str = "C:/Program Files/Git/usr/bin/openssl.exe";

struct Job(OwnedHandle);
impl Job {
    fn new() -> QaResult<Self> {
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err("LIVE_QA_JOB_FAILED");
            }
            let handle = OwnedHandle::from_raw_handle(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err("LIVE_QA_JOB_FAILED");
            }
            Ok(Self(handle))
        }
    }
    fn assign(&self, child: &mut Child) -> QaResult<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) } == 0 {
            let _ = child.kill();
            let _ = child.wait();
            return Err("LIVE_QA_JOB_ASSIGN_FAILED");
        }
        Ok(())
    }
    fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0.as_raw_handle(), 1);
        }
    }
    fn empty(&self) -> bool {
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            ) != 0
                && info.ActiveProcesses == 0
        }
    }
    fn cleanup(&self) -> bool {
        self.terminate();
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            if self.empty() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        self.empty()
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        self.terminate();
    }
}
fn environment(command: &mut Command) {
    command.env_clear().creation_flags(0x08000000);
    for name in ["SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}
fn random_password() -> QaResult<Zeroizing<String>> {
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let mut bytes = Zeroizing::new([0u8; 32]);
    if unsafe {
        BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err("LIVE_QA_RANDOM_FAILED");
    }
    let mut text = Zeroizing::new(String::with_capacity(64));
    for byte in bytes.iter() {
        use std::fmt::Write;
        write!(&mut *text, "{byte:02x}").map_err(|_| "LIVE_QA_RANDOM_FAILED")?;
    }
    Ok(text)
}
fn dos(path: PathBuf) -> QaResult<PathBuf> {
    let text = path.to_str().ok_or("LIVE_QA_WORKSPACE_UNSAFE")?;
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) != Some(&b':') {
            return Err("LIVE_QA_WORKSPACE_UNSAFE");
        }
        Ok(PathBuf::from(rest))
    } else {
        Ok(path)
    }
}
fn regular(path: &Path) -> QaResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "LIVE_QA_BINARY_MISSING")?;
    if !path.is_absolute() || !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("LIVE_QA_BINARY_UNSAFE");
    }
    Ok(())
}
fn command(job: &Job, args: &[&str], directory: &Path) -> QaResult<()> {
    let mut cmd = Command::new(OPENSSL);
    environment(&mut cmd);
    cmd.args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|_| "LIVE_QA_TLS_GENERATION_FAILED")?;
    job.assign(&mut child)?;
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "LIVE_QA_TLS_GENERATION_FAILED")?
        {
            return if status.success() {
                Ok(())
            } else {
                Err("LIVE_QA_TLS_GENERATION_FAILED")
            };
        }
        if Instant::now() >= end {
            let _ = child.kill();
            let _ = child.wait();
            return Err("LIVE_QA_TLS_GENERATION_TIMEOUT");
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn certificate(job: &Job, directory: &Path) -> QaResult<()> {
    fs::create_dir(directory).map_err(|_| "LIVE_QA_TEMP_FAILED")?;
    regular(Path::new(OPENSSL))?;
    fs::write(directory.join("ca.cnf"),"[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Central Live Acceptance Temporary CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n").map_err(|_|"LIVE_QA_TEMP_FAILED")?;
    fs::write(directory.join("leaf.cnf"),"[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:central-test.invalid,DNS:localhost,IP:127.0.0.1\n").map_err(|_|"LIVE_QA_TEMP_FAILED")?;
    command(
        job,
        &[
            "req",
            "-new",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-sha256",
            "-keyout",
            "ca-key.pem",
            "-out",
            "ca.pem",
            "-config",
            "ca.cnf",
        ],
        directory,
    )?;
    command(
        job,
        &[
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "server-key.pem",
            "-out",
            "server.csr",
            "-subj",
            "/CN=localhost",
        ],
        directory,
    )?;
    command(
        job,
        &[
            "x509",
            "-req",
            "-in",
            "server.csr",
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca-key.pem",
            "-set_serial",
            "1",
            "-days",
            "2",
            "-sha256",
            "-out",
            "server.pem",
            "-extfile",
            "leaf.cnf",
            "-extensions",
            "server",
        ],
        directory,
    )
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u8,
    ok: bool,
    model: &'static str,
    checks: Vec<&'static str>,
    service_instance_id: Option<String>,
    device_id: Option<String>,
    proof: Option<ProofSummary>,
    metrics: MetricsEvidence,
    service_cleanup_verified: bool,
    node_job_cleanup_verified: bool,
    temporary_store_removed: bool,
    error_code: Option<&'static str>,
    elapsed_ms: u64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsEvidence {
    idle_before_client: bool,
    active_model_observed: bool,
    idle_turn_after_completion: bool,
    offline_after_revocation: bool,
    cleared_after_shutdown: bool,
    latest_sequence: u64,
}
fn current_metrics(
    service: &Service,
    instance: &str,
) -> Option<crate::service_process::RuntimeMetrics> {
    let snapshot = service.snapshot();
    if snapshot.state != State::Running || snapshot.instance_id.as_deref() != Some(instance) {
        return None;
    }
    let metrics = snapshot.metrics?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    (metrics.observed_at <= now && now - metrics.observed_at <= 10_000).then_some(metrics)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    phase: String,
    code: Option<String>,
    device_id: Option<String>,
    #[serde(default)]
    agent_exited: bool,
    evidence: Option<Evidence>,
    summary: Option<ProofSummary>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    actual_local_agent: bool,
    workspace_read_verified: bool,
    model_tool_read_verified: bool,
    model_tool_exec_verified: bool,
    random_proof_verified: bool,
    turn_completed: bool,
    runtime_marker_verified: bool,
}
impl Evidence {
    fn complete(&self) -> bool {
        self.actual_local_agent
            && self.workspace_read_verified
            && self.model_tool_read_verified
            && self.model_tool_exec_verified
            && self.random_proof_verified
            && self.turn_completed
            && self.runtime_marker_verified
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofSummary {
    input_sha256: String,
    proof_sha256: String,
    tool_read_count: u64,
    tool_exec_count: u64,
    marker: String,
}
impl ProofSummary {
    fn valid(&self) -> bool {
        let hash = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
        hash(&self.input_sha256)
            && hash(&self.proof_sha256)
            && self.tool_read_count > 0
            && self.tool_exec_count > 0
            && self.marker == "yuan-zhou-remote-workspace/1"
    }
}
enum Event {
    Frame(Frame),
    Failure(&'static str),
    InputReady,
    OutputClosed,
    ErrorClosed,
}
fn stdout_reader(
    mut stdout: impl Read + Send + 'static,
    tx: mpsc::Sender<Event>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut bytes = Zeroizing::new(Vec::with_capacity(8192));
        let mut chunk = Zeroizing::new([0u8; 1024]);
        let mut total = 0usize;
        loop {
            let count = match stdout.read(&mut *chunk) {
                Ok(0) => break,
                Ok(count) => count,
                Err(_) => {
                    let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_OUTPUT_FAILED"));
                    return;
                }
            };
            total += count;
            if total > 128 * 1024 {
                let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_OUTPUT_LIMIT"));
                return;
            }
            for b in &chunk[..count] {
                if *b == b'\n' {
                    let frame = serde_json::from_slice::<Frame>(&bytes);
                    bytes.clear();
                    match frame {
                        Ok(frame) => {
                            if tx.send(Event::Frame(frame)).is_err() {
                                return;
                            }
                        }
                        Err(_) => {
                            let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_PROTOCOL_INVALID"));
                            return;
                        }
                    }
                } else {
                    if bytes.len() >= 8192 {
                        let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_OUTPUT_LIMIT"));
                        return;
                    }
                    bytes.push(*b);
                }
            }
        }
        if !bytes.is_empty() {
            let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_PROTOCOL_INVALID"));
        }
        let _ = tx.send(Event::OutputClosed);
    })
}
fn stderr_reader(
    mut stderr: impl Read + Send + 'static,
    tx: mpsc::Sender<Event>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        // Never persist or print child stderr; only its bounded byte count is relevant.
        let mut bytes = Zeroizing::new([0u8; 1024]);
        let mut total = 0usize;
        loop {
            match stderr.read(&mut *bytes) {
                Ok(0) => {
                    let _ = tx.send(Event::ErrorClosed);
                    return;
                }
                Ok(n) => {
                    total += n;
                    if total > 16 * 1024 {
                        let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_STDERR_LIMIT"));
                        return;
                    }
                }
                Err(_) => {
                    let _ = tx.send(Event::Failure("LIVE_QA_CLIENT_STDERR_FAILED"));
                    return;
                }
            }
        }
    })
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn public_client_error(value: Option<&str>) -> &'static str {
    const CODES: &[&str] = &[
        "QA_AGENT_DID_NOT_EXIT",
        "QA_AGENT_REVOKE_EXIT_UNCONFIRMED",
        "QA_ASSISTANT_OUTPUT_LIMIT",
        "QA_BINARY_INVALID",
        "QA_BOOTSTRAP_EXTRA",
        "QA_BOOTSTRAP_FIELDS",
        "QA_BOOTSTRAP_INVALID",
        "QA_BOOTSTRAP_LIMIT",
        "QA_BOOTSTRAP_TIMEOUT",
        "QA_CHILD_DIAGNOSTIC_LIMIT",
        "QA_CHILD_SPAWN_FAILED",
        "QA_CONTROLLER_CLOSED",
        "QA_CONTROLLER_FAILED",
        "QA_DEVICE_ID_INVALID",
        "QA_GATEWAY_REQUEST_FAILED",
        "QA_HELPER_CLEANUP_FAILED",
        "QA_HELPER_FRAME_LIMIT",
        "QA_HELPER_PROTOCOL_INVALID",
        "QA_HELPER_TOTAL_OUTPUT_LIMIT",
        "QA_LIVE_CLIENT_FAILED",
        "QA_MODEL_INVALID",
        "QA_MODEL_TOOL_EVIDENCE_MISSING",
        "QA_MODEL_TOOL_FAILED",
        "QA_MODEL_TURN_FAILED",
        "QA_MODEL_TURN_TIMEOUT",
        "QA_NATIVE_PAIR_TIMEOUT",
        "QA_OUTPUT_INVALID",
        "QA_PAIR_CODE_INVALID",
        "QA_PATH_INVALID",
        "QA_PROOF_FILE_UNSAFE",
        "QA_PROOF_SCRIPT_CHANGED",
        "QA_RANDOM_PROOF_NOT_REPRODUCED",
        "QA_REAL_AGENT_OFFLINE",
        "QA_REAL_AGENT_READ_FAILED",
        "QA_REVOKE_NOT_OBSERVED",
        "QA_RPC_TIMEOUT",
        "QA_RUNTIME_MARKER_MISSING",
        "QA_RUNTIME_UNAVAILABLE",
        "QA_TARGET_INVALID",
        "QA_THREAD_MISSING",
        "QA_TOO_MANY_TOOLS",
        "QA_TOOL_RECEIPT_UNMATCHED",
        "QA_TOTAL_TIMEOUT",
        "QA_UI_UNAVAILABLE",
        "QA_UI_UNEXPECTED_CLOSE",
        "QA_UNEXPECTED_APPROVAL",
        "QA_UNEXPECTED_COMMAND",
        "QA_UNEXPECTED_CONTROLLER_INPUT",
        "QA_UNEXPECTED_TOOL",
        "QA_WINDOWS_STDIN_ONLY",
        "QA_WORKSPACE_INVALID",
        "QA_WORKSPACE_NOT_FRESH",
    ];
    CODES
        .iter()
        .copied()
        .find(|code| Some(*code) == value)
        .unwrap_or("LIVE_QA_CLIENT_FAILED")
}
fn fixture_config(
    temporary: &Path,
    port: u16,
    certificate_id: &str,
    package: &str,
) -> serde_json::Value {
    // Public production configuration deliberately rejects loopback client URLs.
    // Its synthetic DNS name resolves to the owned listener in People; the real
    // Local Agent independently uses the same certificate's localhost SAN.
    serde_json::json!({"schemaVersion":1,"revision":0,"dataDirectory":temporary.join("service-data").to_string_lossy(),"listen":{"host":"127.0.0.1","port":port},"clientUrl":format!("wss://central-test.invalid:{port}/ws"),"tls":{"certificateId":certificate_id},"runtimePackageId":package,"limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},"shutdown":{"graceMs":1000,"forceMs":5000}})
}
fn live_run(
    service: &Service,
    job: &Job,
    temporary: &Path,
    output: &Path,
    deadline: Instant,
    expired: &AtomicBool,
    report: &mut Report,
    child: &mut Option<Child>,
    readers: &mut Vec<thread::JoinHandle<()>>,
    stdin_release: &mut Option<mpsc::Sender<()>>,
) -> QaResult<()> {
    let local = dos(Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .map_err(|_| "LIVE_QA_WORKSPACE_UNSAFE")?)?;
    let resources = dos(PathBuf::from(
        std::env::var_os("CENTRAL_SERVICE_QA_RESOURCES").ok_or("LIVE_QA_RESOURCES_REQUIRED")?,
    ))?;
    if !resources.is_absolute() {
        return Err("LIVE_QA_RESOURCES_REQUIRED");
    }
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../harness/central-service-catalog.json"
    ))
    .map_err(|_| "LIVE_QA_CATALOG_INVALID")?;
    let package = catalog["packages"][0]["id"]
        .as_str()
        .ok_or("LIVE_QA_CATALOG_INVALID")?;
    let node = resources
        .join("central-service")
        .join(package)
        .join("bin/node.exe");
    let agent = dos(std::env::var_os("CENTRAL_LIVE_QA_AGENT")
        .map(PathBuf::from)
        .unwrap_or_else(|| local.join("target/debug/local-agent.exe")))?;
    let helper = dos(std::env::var_os("CENTRAL_LIVE_QA_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|| local.join("target/debug/examples/central-live-client.exe")))?;
    let script = local.join("scripts/central-live-client-qa.mjs");
    for path in [&node, &agent, &helper, &script] {
        regular(path)?;
    }
    let tls_directory = temporary.join("tls");
    certificate(job, &tls_directory)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "LIVE_QA_LISTENER_FAILED")?;
    let port = listener
        .local_addr()
        .map_err(|_| "LIVE_QA_LISTENER_FAILED")?
        .port();
    drop(listener);
    let gateway = format!("wss://localhost:{port}/ws");
    let configured_url = format!("wss://central-test.invalid:{port}/ws");
    let app_data = temporary.join("native-app-data");
    let imported_tls =
        tls::import_directory(&app_data, &tls_directory, &configured_url).map_err(|e| e.code)?;
    let config = fixture_config(temporary, port, &imported_tls.certificate_id, package);
    service
        .save_config(&app_data, "live-config".into(), 0, config)
        .map_err(|e| e.code)?;
    report
        .checks
        .push("synthetic_configuration_validated_and_saved");
    // Explicitly authorized real login import. Only the native DPAPI store and
    // Service bootstrap receive its credential; Node below receives a pairing code.
    let account = model_accounts::import_existing(&app_data).map_err(|e| e.code)?;
    report
        .checks
        .push("native_existing_login_imported_to_temporary_dpapi");
    let password = random_password()?;
    let start = service
        .start(
            &app_data,
            &resources,
            StartRequest {
                request_id: "live-start".into(),
                expected_revision: 1,
                account_id: account.account_id,
                admin_username: Some("live-admin".into()),
                admin_password: Some(Zeroizing::new(password.to_string())),
            },
        )
        .map_err(|e| e.code)?;
    let instance = start.instance_id.ok_or("LIVE_QA_INSTANCE_MISSING")?;
    report.service_instance_id = Some(instance.clone());
    while service.snapshot().state != State::Running {
        if expired.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return Err("LIVE_QA_DEADLINE");
        }
        if service.snapshot().state == State::Failed {
            return Err("LIVE_QA_SERVICE_START_FAILED");
        }
        thread::sleep(Duration::from_millis(25));
    }
    report
        .checks
        .push("owned_service_running_with_localhost_tls");
    let idle_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(metrics) = current_metrics(service, &instance) {
            if metrics.online_devices != 0 || metrics.active_turns != 0 || metrics.workers != 0 {
                return Err("LIVE_QA_METRICS_INITIAL_NOT_IDLE");
            }
            report.metrics.idle_before_client = true;
            report.metrics.latest_sequence = metrics.sequence;
            break;
        }
        if Instant::now() >= idle_deadline {
            return Err("LIVE_QA_METRICS_INITIAL_MISSING");
        }
        thread::sleep(Duration::from_millis(25));
    }
    let people = People::new();
    people
        .login(service, &app_data, &instance, "live-admin".into(), password)
        .map_err(|e| e.code)?;
    let user = people
        .mutate(
            service,
            &app_data,
            &instance,
            "live-create-user",
            Mutation::CreateUser {
                username: "live-qa-user".into(),
            },
        )
        .map_err(|e| e.code)?
        .user
        .ok_or("LIVE_QA_USER_MISSING")?;
    let code = people
        .mutate(
            service,
            &app_data,
            &instance,
            "live-pair-code",
            Mutation::PairCode {
                user_id: user.id.clone(),
            },
        )
        .map_err(|e| e.code)?
        .pairing
        .ok_or("LIVE_QA_PAIR_CODE_MISSING")?
        .code;
    let workspace = temporary.join("workspace");
    fs::create_dir(&workspace).map_err(|_| "LIVE_QA_TEMP_FAILED")?;
    let mut command = Command::new(node);
    environment(&mut command);
    command
        .arg(script)
        .current_dir(&local)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    *child = Some(command.spawn().map_err(|_| "LIVE_QA_CLIENT_SPAWN_FAILED")?);
    let process = child.as_mut().unwrap();
    job.assign(process)?;
    // The trusted script may spawn descendants only after receiving this input.
    // Assignment precedes the barrier; NODE_OPTIONS and inherited secrets are absent.
    let (tx, rx) = mpsc::channel();
    readers.push(stdout_reader(
        process.stdout.take().ok_or("LIVE_QA_CLIENT_PIPE_FAILED")?,
        tx.clone(),
    ));
    readers.push(stderr_reader(
        process.stderr.take().ok_or("LIVE_QA_CLIENT_PIPE_FAILED")?,
        tx.clone(),
    ));
    let mut stdin = process.stdin.take().ok_or("LIVE_QA_CLIENT_PIPE_FAILED")?;
    let mut input=Zeroizing::new(serde_json::to_vec(&serde_json::json!({"gateway":gateway,"caPath":tls_directory.join("ca.pem"),"code":code,"agentBinary":agent,"helperBinary":helper,"workspace":workspace,"output":output.join("client-result.json"),"model":MODEL})).map_err(|_|"LIVE_QA_CLIENT_INPUT_FAILED")?);
    input.push(b'\n');
    let (release, hold) = mpsc::channel();
    *stdin_release = Some(release);
    readers.push(thread::spawn(move || {
        let result = stdin.write_all(&input).and_then(|_| stdin.flush());
        let _ = tx.send(if result.is_ok() {
            Event::InputReady
        } else {
            Event::Failure("LIVE_QA_CLIENT_INPUT_FAILED")
        });
        if result.is_ok() {
            let _ = hold.recv();
        }
        drop(stdin);
    }));
    let mut paired = None::<String>;
    let mut online = false;
    let mut completed = false;
    let mut revoked = false;
    let mut terminal = false;
    let mut output_closed = false;
    let mut error_closed = false;
    let mut next_inventory = Instant::now();
    loop {
        if expired.load(Ordering::SeqCst) || Instant::now() >= deadline {
            return Err("LIVE_QA_DEADLINE");
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Event::Failure(code)) => return Err(code),
            Ok(Event::InputReady) => {}
            Ok(Event::OutputClosed) => output_closed = true,
            Ok(Event::ErrorClosed) => error_closed = true,
            Ok(Event::Frame(frame)) => {
                if frame.phase == "failed" {
                    return Err(public_client_error(frame.code.as_deref()));
                }
                let device = frame
                    .device_id
                    .as_deref()
                    .ok_or("LIVE_QA_CLIENT_PROTOCOL_INVALID")?;
                if !id(device) {
                    return Err("LIVE_QA_CLIENT_PROTOCOL_INVALID");
                }
                match frame.phase.as_str() {
                    "paired" => {
                        if paired.is_some() {
                            return Err("LIVE_QA_CLIENT_PROTOCOL_INVALID");
                        }
                        paired = Some(device.into());
                        report.device_id = Some(device.into());
                        report.checks.push("native_pairing_completed");
                    }
                    "completed" => {
                        if paired.as_deref() != Some(device) || completed {
                            return Err("LIVE_QA_CLIENT_PROTOCOL_INVALID");
                        }
                        if !frame.evidence.as_ref().is_some_and(Evidence::complete)
                            || !frame.summary.as_ref().is_some_and(ProofSummary::valid)
                        {
                            return Err("LIVE_QA_EVIDENCE_INCOMPLETE");
                        }
                        report.proof = frame.summary;
                        completed = true;
                        report
                            .checks
                            .push("real_model_and_local_agent_turn_completed");
                    }
                    "revoked" => {
                        if paired.as_deref() != Some(device) || !revoked || !frame.agent_exited {
                            return Err("LIVE_QA_CLIENT_PROTOCOL_INVALID");
                        }
                        terminal = true;
                        report
                            .checks
                            .push("revocation_auth_terminal_and_agent_exit_confirmed");
                    }
                    _ => return Err("LIVE_QA_CLIENT_PROTOCOL_INVALID"),
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
        }
        if let Some(metrics) = current_metrics(service, &instance) {
            report.metrics.latest_sequence = metrics.sequence;
            if metrics.online_devices == 1
                && metrics.active_turns == 1
                && metrics.workers == 1
                && metrics.ready_workers == 1
            {
                report.metrics.active_model_observed = true;
            }
            if completed && metrics.active_turns == 0 {
                report.metrics.idle_turn_after_completion = true;
            }
        }
        if let Some(device) = paired.as_ref() {
            if !revoked && Instant::now() >= next_inventory {
                let inventory = people
                    .list(service, &app_data, &instance)
                    .map_err(|e| e.code)?;
                let found = inventory
                    .devices
                    .iter()
                    .find(|d| &d.id == device && d.user_id == user.id)
                    .ok_or("LIVE_QA_DEVICE_NOT_OWNED")?;
                if found.online && !online {
                    online = true;
                    report
                        .checks
                        .push("native_people_inventory_observed_agent_online");
                }
                next_inventory = Instant::now() + Duration::from_secs(1);
                if completed && online && report.metrics.idle_turn_after_completion {
                    people
                        .mutate(
                            service,
                            &app_data,
                            &instance,
                            "live-revoke-device",
                            Mutation::RevokeDevice {
                                device_id: device.clone(),
                            },
                        )
                        .map_err(|e| e.code)?;
                    revoked = true;
                    report.checks.push("native_admin_revoked_completed_device");
                }
            }
        }
        if let Some(status) = process
            .try_wait()
            .map_err(|_| "LIVE_QA_CLIENT_EXIT_FAILED")?
        {
            if !status.success() && output_closed && error_closed {
                return Err("LIVE_QA_CLIENT_FAILED");
            }
            if output_closed && error_closed && !terminal {
                return Err("LIVE_QA_CLIENT_TERMINAL_MISSING");
            }
            if output_closed && error_closed {
                break;
            }
        }
    }
    if !online || !completed || !revoked {
        return Err("LIVE_QA_EVIDENCE_INCOMPLETE");
    }
    if !report.metrics.active_model_observed || !report.metrics.idle_turn_after_completion {
        return Err("LIVE_QA_METRICS_ACTIVE_MISSING");
    }
    let offline_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(metrics) = current_metrics(service, &instance) {
            if metrics.online_devices == 0 && metrics.active_turns == 0 {
                report.metrics.offline_after_revocation = true;
                report.metrics.latest_sequence = metrics.sequence;
                break;
            }
        }
        if Instant::now() >= offline_deadline {
            return Err("LIVE_QA_METRICS_OFFLINE_MISSING");
        }
        thread::sleep(Duration::from_millis(25));
    }
    report
        .checks
        .push("owned_metrics_idle_active_complete_revoke_verified");
    let inventory = people
        .list(service, &app_data, &instance)
        .map_err(|e| e.code)?;
    if !inventory
        .devices
        .iter()
        .any(|d| Some(&d.id) == paired.as_ref() && d.revoked && !d.online)
    {
        return Err("LIVE_QA_REVOCATION_NOT_OBSERVED");
    }
    people
        .logout(service, &app_data, &instance)
        .map_err(|e| e.code)?;
    Ok(())
}

fn output_directory() -> QaResult<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repository = manifest
        .ancestors()
        .nth(3)
        .ok_or("LIVE_QA_WORKSPACE_UNSAFE")?
        .canonicalize()
        .map_err(|_| "LIVE_QA_WORKSPACE_UNSAFE")?;
    let base = repository.join("target/central-p0");
    fs::create_dir_all(&base).map_err(|_| "LIVE_QA_OUTPUT_UNSAFE")?;
    let physical_base = base.canonicalize().map_err(|_| "LIVE_QA_OUTPUT_UNSAFE")?;
    if !physical_base.starts_with(&repository) {
        return Err("LIVE_QA_OUTPUT_UNSAFE");
    }
    let output = dos(PathBuf::from(
        std::env::var_os("CENTRAL_LIVE_QA_OUTPUT").ok_or("LIVE_QA_OUTPUT_REQUIRED")?,
    ))?;
    if !output.is_absolute()
        || output
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || output.file_name().and_then(|v| v.to_str()) != Some("result.json")
    {
        return Err("LIVE_QA_OUTPUT_UNSAFE");
    }
    let directory = output.parent().ok_or("LIVE_QA_OUTPUT_UNSAFE")?;
    let parent = directory.parent().ok_or("LIVE_QA_OUTPUT_UNSAFE")?;
    if parent.canonicalize().map_err(|_| "LIVE_QA_OUTPUT_UNSAFE")?
        != base.canonicalize().map_err(|_| "LIVE_QA_OUTPUT_UNSAFE")?
    {
        return Err("LIVE_QA_OUTPUT_UNSAFE");
    }
    fs::create_dir(directory).map_err(|_| "LIVE_QA_OUTPUT_MUST_BE_NEW")?;
    Ok(directory.to_owned())
}

#[test]
fn live_configuration_keeps_public_name_valid_while_agent_uses_certificate_localhost_alias() {
    let mut value = fixture_config(
        Path::new(r"C:\synthetic-acceptance"),
        14523,
        "synthetic-certificate",
        "synthetic-package",
    );
    assert!(matches!(
        crate::config::validate(value.clone()),
        crate::config::Validation::Valid { .. }
    ));
    value["clientUrl"] = serde_json::json!("wss://localhost:14523/ws");
    assert!(matches!(
        crate::config::validate(value),
        crate::config::Validation::Invalid { .. }
    ));
}

#[test]
fn live_client_errors_preserve_only_exact_fixed_codes() {
    assert_eq!(
        public_client_error(Some("QA_MODEL_TURN_TIMEOUT")),
        "QA_MODEL_TURN_TIMEOUT"
    );
    assert_eq!(
        public_client_error(Some("QA_MODEL_TURN_TIMEOUT secret detail")),
        "LIVE_QA_CLIENT_FAILED"
    );
    assert_eq!(
        public_client_error(Some("QA_UNKNOWN_SECRET_PAYLOAD")),
        "LIVE_QA_CLIENT_FAILED"
    );
    let frame: Frame =
        serde_json::from_str(r#"{"phase":"failed","code":"QA_REAL_AGENT_OFFLINE"}"#).unwrap();
    assert!(frame.device_id.is_none());
    assert_eq!(
        public_client_error(frame.code.as_deref()),
        "QA_REAL_AGENT_OFFLINE"
    );
}

#[test]
fn live_protocol_requires_complete_evidence_and_bounded_ndjson() {
    let evidence:Evidence=serde_json::from_value(serde_json::json!({"actualLocalAgent":true,"workspaceReadVerified":true,"modelToolReadVerified":true,"modelToolExecVerified":false,"randomProofVerified":true,"turnCompleted":true,"runtimeMarkerVerified":true})).unwrap();
    assert!(!evidence.complete());
    let (tx, rx) = mpsc::channel();
    let reader = stdout_reader(std::io::Cursor::new(vec![b'x'; 8193]), tx);
    reader.join().unwrap();
    assert!(matches!(
        rx.recv().unwrap(),
        Event::Failure("LIVE_QA_CLIENT_OUTPUT_LIMIT")
    ));
}

#[test]
fn live_protocol_drains_terminal_frame_before_output_closed() {
    let (tx, rx) = mpsc::channel();
    let reader = stdout_reader(
        std::io::Cursor::new(
            b"{\"phase\":\"revoked\",\"deviceId\":\"synthetic-device\",\"agentExited\":true}\n"
                .to_vec(),
        ),
        tx,
    );
    reader.join().unwrap();
    assert!(
        matches!(rx.recv().unwrap(),Event::Frame(Frame{phase,agent_exited:true,..}) if phase=="revoked")
    );
    assert!(matches!(rx.recv().unwrap(), Event::OutputClosed));
}

#[test]
#[ignore = "requires explicit real-model opt-in; imports current authorized Codex login to a temporary DPAPI store"]
fn native_service_real_model_local_agent_qa() {
    assert_eq!(
        std::env::var("CENTRAL_LIVE_QA_ALLOW_REAL_MODEL").as_deref(),
        Ok("1"),
        "LIVE_QA_OPT_IN_REQUIRED"
    );
    let started = Instant::now();
    let output = output_directory().expect("LIVE_QA_OUTPUT_PREPARATION_FAILED");
    let temporary = tempfile::Builder::new()
        .prefix("private-native-")
        .tempdir_in(&output)
        .expect("LIVE_QA_TEMP_FAILED");
    // This exact, newly-created child is the only recursive cleanup target.
    let temporary_path = temporary.path().to_owned();
    assert_eq!(temporary_path.parent(), Some(output.as_path()));
    let service = Arc::new(Service::new());
    let job = Arc::new(Job::new().expect("LIVE_QA_JOB_FAILED"));
    let expired = Arc::new(AtomicBool::new(false));
    let (stop_timer, timer) = mpsc::channel();
    let timer_service = service.clone();
    let timer_job = job.clone();
    let timer_expired = expired.clone();
    let watchdog = thread::spawn(move || {
        if timer.recv_timeout(WORK_LIMIT).is_err() {
            timer_expired.store(true, Ordering::SeqCst);
            timer_job.terminate();
            timer_service.shutdown();
        }
    });
    let mut report = Report {
        schema_version: 1,
        model: MODEL,
        ..Report::default()
    };
    let mut child = None;
    let mut readers = Vec::new();
    let mut stdin_release = None;
    let result = live_run(
        &service,
        &job,
        &temporary_path,
        &output,
        started + WORK_LIMIT,
        &expired,
        &mut report,
        &mut child,
        &mut readers,
        &mut stdin_release,
    );
    report.error_code = result.err();
    drop(stdin_release.take());
    report.node_job_cleanup_verified = job.cleanup();
    if let Some(process) = child.as_mut() {
        let _ = process.try_wait();
    }
    report.service_cleanup_verified = service.shutdown();
    report.metrics.cleared_after_shutdown = service.snapshot().metrics.is_none();
    if !report.metrics.cleared_after_shutdown {
        report.error_code = Some("LIVE_QA_METRICS_SHUTDOWN_NOT_CLEARED");
    }
    let _ = stop_timer.send(());
    let _ = watchdog.join();
    let end = Instant::now() + Duration::from_secs(2);
    while readers.iter().any(|r| !r.is_finished()) && Instant::now() < end {
        thread::sleep(Duration::from_millis(10));
    }
    if readers.iter().any(|r| !r.is_finished()) {
        report.error_code = Some("LIVE_QA_IO_CLEANUP_UNCONFIRMED");
    } else {
        for reader in readers {
            let _ = reader.join();
        }
    }
    drop(child);
    drop(service);
    drop(job);
    // Re-resolve the exact new target after every child is stopped. Never let a
    // changed directory alias redirect recursive test cleanup outside this run.
    let cleanup_safe = report.node_job_cleanup_verified
        && report.service_cleanup_verified
        && output
            .canonicalize()
            .ok()
            .zip(temporary_path.canonicalize().ok())
            .is_some_and(|(root, target)| target.parent() == Some(root.as_path()))
        && fs::symlink_metadata(&temporary_path)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink());
    report.temporary_store_removed = if cleanup_safe {
        temporary.close().is_ok() && !temporary_path.exists()
    } else {
        let _ = temporary.keep();
        false
    };
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    if expired.load(Ordering::SeqCst) || report.elapsed_ms > 300_000 {
        report.error_code = Some("LIVE_QA_DEADLINE");
    }
    report.ok = report.error_code.is_none()
        && report.node_job_cleanup_verified
        && report.service_cleanup_verified
        && report.temporary_store_removed;
    if !report.ok && report.error_code.is_none() {
        report.error_code = Some("LIVE_QA_CLEANUP_UNCONFIRMED");
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output.join("result.json"))
        .expect("LIVE_QA_RESULT_WRITE_FAILED");
    serde_json::to_writer_pretty(&mut file, &report).expect("LIVE_QA_RESULT_WRITE_FAILED");
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .expect("LIVE_QA_RESULT_WRITE_FAILED");
    println!(
        "{}",
        serde_json::to_string(&report).expect("LIVE_QA_PUBLIC_METADATA_FAILED")
    );
    assert!(
        report.ok,
        "{}",
        report.error_code.unwrap_or("LIVE_QA_FAILED")
    );
}
