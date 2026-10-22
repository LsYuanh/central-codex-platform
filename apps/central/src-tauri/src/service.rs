// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Native central service orchestration. No renderer launch paths or credential files.
use crate::{
    config::{self, CentralConfig, Result, failure},
    model_accounts, runtime_package, runtime_updates,
    service_process::{LaunchSpec, ServiceProcess, Snapshot, State},
    tls,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const OPERATIONS: &str = "service-operations-v1";
const MAX_OPERATIONS: usize = 4096;

pub struct Service {
    pub updates: runtime_updates::Updater,
    process: ServiceProcess,
    mutation: AtomicBool,
    closing: AtomicBool,
    session: Option<String>,
    shutdown_ms: AtomicU64,
    force_ms: AtomicU64,
    dispatch: Mutex<()>,
    running_config: Mutex<Option<CentralConfig>>,
    running_account: Mutex<Option<(String, String, String, u64)>>,
    auth_package: Mutex<Option<std::sync::Arc<runtime_package::PreparedServicePackage>>>,
    auth_cancel: AtomicBool,
}
/// Trusted native-only endpoint description; never returned to the renderer.
pub struct ManagementTarget {
    pub instance_id: String,
    pub config: CentralConfig,
    pub ca_pem: String,
}
pub struct Mutation<'a>(&'a AtomicBool);
impl Drop for Mutation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub candidate_start_available: bool,
    pub needs_admin: bool,
    pub config_revision: u64,
}

// No Debug/Serialize: password is owned only while preparing one native request.
pub struct StartRequest {
    pub request_id: String,
    pub expected_revision: u64,
    pub account_id: String,
    pub admin_username: Option<String>,
    pub admin_password: Option<Zeroizing<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    schema_version: u8,
    session_id: String,
    request_id: String,
    fingerprint: String,
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct SecretWriter(Zeroizing<Vec<u8>>);
impl Write for SecretWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > 1024 * 1024 {
            return Err(std::io::Error::other("SERVICE_BOOTSTRAP_TOO_LARGE"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn fingerprint(value: &impl Serialize) -> Result<String> {
    // Serialization streams directly into SHA256; no temporary plaintext password JSON.
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).map_err(|_| failure("SERVICE_REQUEST_INVALID"))?;
    Ok(format!("{:x}", writer.0.finalize()))
}
fn random_session() -> Option<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
        };
        let mut bytes = [0u8; 16];
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                16,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return None;
        }
        Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    #[cfg(target_os = "macos")]
    {
        let mut bytes = [0u8; 16];
        if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
            return None;
        }
        Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}
fn writable(snapshot: &Snapshot) -> Result<()> {
    if !matches!(snapshot.state, State::Stopped | State::Failed) {
        return Err(failure("SERVICE_ALREADY_ACTIVE"));
    }
    if !snapshot.cleanup_verified {
        return Err(failure("SERVICE_CLEANUP_UNVERIFIED"));
    }
    Ok(())
}
fn needs_admin(config: &CentralConfig) -> Result<bool> {
    match fs::symlink_metadata(Path::new(&config.data_directory).join("platform-auth.json")) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        _ => Err(failure("SERVICE_DATA_UNSAFE")),
    }
}

impl Service {
    pub fn new() -> Self {
        Self {
            updates: runtime_updates::Updater::new(),
            process: ServiceProcess::new(),
            mutation: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            session: random_session(),
            shutdown_ms: AtomicU64::new(20_000),
            force_ms: AtomicU64::new(5000),
            dispatch: Mutex::new(()),
            running_config: Mutex::new(None),
            running_account: Mutex::new(None),
            auth_package: Mutex::new(None),
            auth_cancel: AtomicBool::new(false),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.process.snapshot()
    }
    fn wait_update_state(&self, running: bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(55);
        while Instant::now() < deadline {
            self.open()?;
            let snapshot = self.snapshot();
            if running && snapshot.state == State::Running {
                return Ok(());
            }
            if !running
                && snapshot.cleanup_verified
                && matches!(snapshot.state, State::Stopped | State::Failed)
            {
                return Ok(());
            }
            if running && snapshot.state == State::Failed {
                return Err(failure("SERVICE_UPDATE_START_FAILED"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(failure("SERVICE_UPDATE_TIMEOUT"))
    }
    pub fn apply_pending_update(&self, app_data: &Path, resources: &Path) -> Result<()> {
        if self.updates.status().state == "activation-unconfirmed"
            && self.snapshot().state == State::Running
        {
            let _gate = self.mutation()?;
            self.process.verify_runtime(true).map_err(failure)?;
            self.updates.set("updated", None);
            if let Some(selected) = runtime_updates::selection(app_data).map_err(failure)? {
                runtime_updates::prune(app_data, &selected).map_err(failure)?;
            }
            return Ok(());
        }
        let Some(candidate) = self
            .updates
            .candidate
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))?
            .clone()
        else {
            return Ok(());
        };
        if self.snapshot().state != State::Running {
            return Ok(());
        }
        let _gate = self.mutation()?;
        let config = config::read(app_data)?
            .config
            .ok_or_else(|| failure("CONFIG_INVALID"))?;
        let account = self
            .running_account
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))?
            .as_ref()
            .map(|a| a.1.clone())
            .ok_or_else(|| failure("SERVICE_STATE_FAILED"))?;
        let request = || StartRequest {
            request_id: format!(
                "runtime-update-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            expected_revision: config.revision,
            account_id: account.clone(),
            admin_username: None,
            admin_password: None,
        };
        // Reauthenticate and pin all candidate bytes before interrupting service admission.
        let descriptor = runtime_updates::authenticate(&candidate).map_err(failure)?;
        let root = runtime_updates::root(app_data).map_err(failure)?;
        let _candidate_guard =
            runtime_package::prepare_authenticated_update(&root, descriptor.package)
                .map_err(failure)?;
        match self.process.stop_if_idle() {
            Err("SERVICE_UPDATE_BUSY") => return Ok(()),
            Err(code) => {
                self.updates.set("failed", Some(code));
                return Err(failure(code));
            }
            Ok(()) => {}
        }
        self.updates.set("applying", None);
        *self
            .updates
            .candidate
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))? = None;
        self.wait_update_state(false)?;
        let data = Path::new(&config.data_directory);
        let validation = (|| {
            let previous = runtime_updates::selection(app_data).map_err(failure)?;
            let backup = runtime_updates::backup(app_data, data).map_err(failure)?;
            let mut selected = runtime_updates::Selection {
                baseline_id: config.runtime_package_id.clone(),
                active: candidate,
                previous: previous
                    .filter(|s| s.baseline_id == config.runtime_package_id)
                    .map(|s| s.active),
                pending: true,
                backup_id: backup,
                data_directory: runtime_updates::data_identity(data).map_err(failure)?,
            };
            runtime_updates::save_json(&root, "selection.json", &selected).map_err(failure)?;
            self.start_inner(app_data, resources, request(), true)?;
            self.wait_update_state(true)?;
            self.process.verify_runtime(false).map_err(failure)?;
            // Commit before opening admission; every earlier failure is recoverable.
            selected.pending = false;
            runtime_updates::save_json(&root, "selection.json", &selected).map_err(failure)?;
            Ok::<_, config::Failure>(selected)
        })();
        let selected = match validation {
            Ok(selected) => selected,
            Err(error) => {
                self.updates.set("rolling-back", Some(error.code));
                self.process.stop().map_err(failure)?;
                self.wait_update_state(false)?;
                runtime_updates::recover(app_data, data).map_err(failure)?;
                self.start_inner(app_data, resources, request(), false)?;
                self.wait_update_state(true)?;
                runtime_updates::save_json(&root, "failed-sequence.json", &descriptor.sequence)
                    .map_err(failure)?;
                self.updates.set("rolled-back", Some(error.code));
                return Err(error);
            }
        };
        // Commit recovery state before opening admission. Never restore a backup
        // after clients could have submitted new work to the validated runtime.
        if let Err(code) = self.process.verify_runtime(true) {
            self.updates.current(descriptor.version);
            self.updates.set("activation-unconfirmed", Some(code));
            return Err(failure(code));
        }
        self.updates.set("updated", None);
        self.updates.current(descriptor.version);
        runtime_updates::prune(app_data, &selected).map_err(failure)?;
        Ok(())
    }
    /// Called by one native background loop, never by model tools or a renderer timer.
    pub fn renew_account(&self, root: &Path) -> Result<()> {
        let _gate = self.mutation()?;
        self.open()?;
        let Some((instance, id, previous, revision)) = self
            .running_account
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))?
            .clone()
        else {
            return Ok(());
        };
        let snapshot = self.snapshot();
        if snapshot.state != State::Running
            || snapshot.instance_id.as_deref() != Some(&instance)
            || !snapshot.account_updates_supported
        {
            return Ok(());
        }
        let report = model_accounts::selected(root, &id)?;
        if !report.refresh_supported {
            return Ok(());
        }
        if report.credential_source == "codex-shared" {
            let package = self
                .auth_package
                .lock()
                .map_err(|_| failure("SERVICE_STATE_FAILED"))?
                .clone()
                .ok_or_else(|| failure("MODEL_SHARED_PROCESS_FAILED"))?;
            let _ = model_accounts::shared::renew(root, &id, &package, &self.auth_cancel, false);
        } else {
            if report.renewal_state == "reauth-required" {
                return Ok(());
            }
            let _ = model_accounts::renewal::renew(root, &id);
        }
        let credential = model_accounts::load_internal(root, &id)?;
        let digest = format!("{:x}", Sha256::digest(credential.access_token().as_bytes()));
        if digest == previous {
            return Ok(());
        }
        self.open()?;
        let next = revision
            .checked_add(1)
            .ok_or_else(|| failure("SERVICE_STATE_FAILED"))?;
        self.process
            .update_account(&instance, next, &credential.as_broker_json()?)
            .map_err(failure)?;
        let mut running = self
            .running_account
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))?;
        if running
            .as_ref()
            .is_some_and(|(active, _, _, _)| active == &instance)
        {
            *running = Some((instance, id, digest, next));
        }
        Ok(())
    }
    pub fn management_target(
        &self,
        app_data: &Path,
        expected_instance: &str,
    ) -> Result<ManagementTarget> {
        self.open()?;
        let snapshot = self.snapshot();
        if snapshot.state != State::Running
            || snapshot.instance_id.as_deref() != Some(expected_instance)
        {
            return Err(failure("PEOPLE_SERVICE_UNAVAILABLE"));
        }
        let running = self
            .running_config
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))?
            .clone()
            .ok_or_else(|| failure("PEOPLE_SERVICE_UNAVAILABLE"))?;
        let saved = config::read(app_data)?
            .config
            .ok_or_else(|| failure("CONFIG_INVALID"))?;
        if serde_json::to_value(&running).ok() != serde_json::to_value(&saved).ok() {
            return Err(failure("CONFIG_REVISION_CONFLICT"));
        }
        tls::inspect_stored(app_data, &running)?;
        let ca_pem = tls::public_ca(app_data, &running.tls.certificate_id)?;
        let after = self.snapshot();
        if after.state != State::Running || after.instance_id != snapshot.instance_id {
            return Err(failure("PEOPLE_SERVICE_UNAVAILABLE"));
        }
        Ok(ManagementTarget {
            instance_id: expected_instance.to_owned(),
            config: running,
            ca_pem,
        })
    }
    fn open(&self) -> Result<()> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(failure("SERVICE_APP_CLOSING"));
        }
        Ok(())
    }
    pub fn mutation(&self) -> Result<Mutation<'_>> {
        self.open()?;
        self.mutation
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| failure("OPERATION_BUSY"))?;
        let guard = Mutation(&self.mutation);
        self.open()?;
        Ok(guard)
    }
    pub fn save_config(
        &self,
        app_data: &Path,
        request_id: String,
        expected_revision: u64,
        value: serde_json::Value,
    ) -> Result<config::SaveResponse> {
        let _gate = self.mutation()?;
        writable(&self.snapshot())?;
        config::save(app_data, request_id, expected_revision, value)
    }
    pub fn context(&self, app_data: &Path) -> Result<Context> {
        if !cfg!(any(windows, target_os = "macos")) {
            return Ok(Context {
                candidate_start_available: false,
                needs_admin: true,
                config_revision: 0,
            });
        }
        let saved = config::read(app_data)?.config;
        Ok(Context {
            candidate_start_available: cfg!(all(
                debug_assertions,
                any(windows, target_os = "macos")
            )) && !self.closing.load(Ordering::SeqCst),
            needs_admin: match &saved {
                Some(config) => needs_admin(config)?,
                None => true,
            },
            config_revision: saved.as_ref().map_or(0, |config| config.revision),
        })
    }
    fn previous(&self, root: &Path, request_id: &str, expected: &str) -> Result<bool> {
        let ids = platform_security::central_secret_store::list(root, OPERATIONS)
            .map_err(|_| failure("SERVICE_JOURNAL_UNSAFE"))?;
        let mut found = false;
        for id in ids {
            let bytes = platform_security::central_secret_store::load(root, OPERATIONS, &id)
                .map_err(|_| failure("SERVICE_JOURNAL_UNSAFE"))?;
            let intent: Intent =
                serde_json::from_slice(&bytes).map_err(|_| failure("SERVICE_JOURNAL_UNSAFE"))?;
            if intent.schema_version != 1
                || !valid_request_id(&intent.request_id)
                || intent.fingerprint.len() != 64
                || intent.session_id.len() != 32
            {
                return Err(failure("SERVICE_JOURNAL_UNSAFE"));
            }
            if intent.request_id == request_id {
                if found {
                    return Err(failure("SERVICE_JOURNAL_UNSAFE"));
                }
                found = true;
                if intent.fingerprint != expected {
                    return Err(failure("SERVICE_REQUEST_CONFLICT"));
                }
                if Some(intent.session_id.as_str()) != self.session.as_deref() {
                    return Err(failure("RECONCILE_REQUIRED"));
                }
            }
        }
        Ok(found)
    }
    fn record(&self, root: &Path, request_id: &str, hash: &str) -> Result<()> {
        let session = self
            .session
            .as_deref()
            .ok_or_else(|| failure("SERVICE_RANDOM_FAILED"))?;
        if platform_security::central_secret_store::list(root, OPERATIONS)
            .map_err(|_| failure("SERVICE_JOURNAL_UNSAFE"))?
            .len()
            >= MAX_OPERATIONS
        {
            return Err(failure("SERVICE_JOURNAL_FULL"));
        }
        let bytes = Zeroizing::new(
            serde_json::to_vec(&Intent {
                schema_version: 1,
                session_id: session.to_owned(),
                request_id: request_id.to_owned(),
                fingerprint: hash.to_owned(),
            })
            .map_err(|_| failure("SERVICE_JOURNAL_UNSAFE"))?,
        );
        platform_security::central_secret_store::create(root, OPERATIONS, &bytes)
            .map_err(|_| failure("SERVICE_JOURNAL_UNSAFE"))?;
        Ok(())
    }
    pub fn start(
        &self,
        app_data: &Path,
        resources: &Path,
        request: StartRequest,
    ) -> Result<Snapshot> {
        let _gate = self.mutation()?;
        self.start_inner(app_data, resources, request, false)
    }
    fn start_inner(
        &self,
        app_data: &Path,
        resources: &Path,
        request: StartRequest,
        update_validation: bool,
    ) -> Result<Snapshot> {
        if !cfg!(all(debug_assertions, any(windows, target_os = "macos"))) {
            return Err(failure("PACKAGE_NOT_QUALIFIED"));
        }
        if !valid_request_id(&request.request_id)
            || request.account_id.len() != 32
            || !request.account_id.bytes().all(|c| c.is_ascii_hexdigit())
            || request
                .admin_username
                .as_ref()
                .is_some_and(|name| name.len() > 64)
            || request
                .admin_password
                .as_ref()
                .is_some_and(|password| password.len() > 256)
        {
            return Err(failure("SERVICE_REQUEST_INVALID"));
        }
        #[derive(Serialize)]
        struct Parameters<'a> {
            action: &'static str,
            revision: u64,
            account: &'a str,
            admin_username: Option<&'a str>,
            admin_password: Option<&'a str>,
        }
        let hash = fingerprint(&Parameters {
            action: "start",
            revision: request.expected_revision,
            account: &request.account_id,
            admin_username: request.admin_username.as_deref(),
            admin_password: request.admin_password.as_ref().map(|p| p.as_str()),
        })?;
        let root = config::resource_root(app_data, true)?;
        if self.previous(&root, &request.request_id, &hash)? {
            return Ok(self.snapshot());
        }
        writable(&self.snapshot())?;
        let config = config::read(app_data)?
            .config
            .ok_or_else(|| failure("CONFIG_INVALID"))?;
        if config.revision != request.expected_revision {
            return Err(failure("CONFIG_REVISION_CONFLICT"));
        }
        if !update_validation {
            runtime_updates::recover(app_data, Path::new(&config.data_directory))
                .map_err(failure)?;
        }
        let package = std::sync::Arc::new(
            runtime_updates::prepare(app_data, resources, &config.runtime_package_id)
                .map_err(failure)?,
        );
        let data_path = Path::new(&config.data_directory);
        let data_guard = platform_security::central_secret_store::lock_runtime_root(data_path)
            .map_err(|_| failure("SERVICE_DATA_UNSAFE"))?;
        // Keep the validated DOS spelling for the shared Node config contract.
        // Native pins already reject aliases and remain owned through Job teardown.
        let need_admin = needs_admin(&config)?;
        let admin = if need_admin {
            let username = request
                .admin_username
                .as_deref()
                .ok_or_else(|| failure("ADMIN_AUTH_REQUIRED"))?;
            let password = request
                .admin_password
                .as_ref()
                .ok_or_else(|| failure("ADMIN_AUTH_REQUIRED"))?;
            if username.len() < 3
                || username.len() > 64
                || !username.as_bytes()[0].is_ascii_alphanumeric()
                || !username
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
            {
                return Err(failure("ADMIN_USERNAME_INVALID"));
            }
            if password.chars().count() < 12 || password.len() > 256 || password.contains('\0') {
                return Err(failure("ADMIN_PASSWORD_INVALID"));
            }
            Some(Admin { username, password })
        } else {
            if request.admin_username.is_some() || request.admin_password.is_some() {
                return Err(failure("SERVICE_ADMIN_ALREADY_CONFIGURED"));
            }
            None
        };
        // Shared logins must pass an official authentication check at startup.
        // Dedicated sessions may still use an unexpired token after a transient failure.
        self.auth_cancel.store(false, Ordering::SeqCst);
        if model_accounts::shared::is_link(app_data, &request.account_id)? {
            model_accounts::shared::renew(
                app_data,
                &request.account_id,
                &package,
                &self.auth_cancel,
                true,
            )?;
        } else {
            let _ = model_accounts::renewal::renew(app_data, &request.account_id);
        }
        let credential = model_accounts::load_internal(app_data, &request.account_id)?;
        let (cert, key) = tls::service_material(app_data, &config)?;
        #[derive(Serialize)]
        struct Tokens<'a> {
            access_token: &'a str,
            account_id: &'a str,
        }
        #[derive(Serialize)]
        struct Account<'a> {
            tokens: Tokens<'a>,
        }
        #[derive(Serialize)]
        struct Tls<'a> {
            cert: &'a str,
            key: &'a str,
        }
        #[derive(Serialize)]
        struct Admin<'a> {
            username: &'a str,
            password: &'a str,
        }
        #[derive(Serialize)]
        struct Bootstrap<'a> {
            #[serde(rename = "modelProxy")]
            model_proxy: &'a crate::model_proxy::ModelProxy,
            #[serde(rename = "updateValidation", skip_serializing_if = "Option::is_none")]
            update_validation: Option<bool>,
            config: &'a CentralConfig,
            tls: Tls<'a>,
            account: Account<'a>,
            #[serde(skip_serializing_if = "Option::is_none")]
            admin: Option<Admin<'a>>,
        }
        // Preallocate the admitted maximum: secret serialization never reallocates.
        let mut bootstrap = SecretWriter(Zeroizing::new(Vec::with_capacity(1024 * 1024)));
        let model_proxy = crate::model_proxy::resolve()?;
        serde_json::to_writer(
            &mut bootstrap,
            &Bootstrap {
                model_proxy: &model_proxy,
                update_validation: update_validation.then_some(true),
                config: &config,
                tls: Tls {
                    cert: &cert,
                    key: &key,
                },
                account: Account {
                    tokens: Tokens {
                        access_token: credential.access_token(),
                        account_id: credential.account_id(),
                    },
                },
                admin,
            },
        )
        .map_err(|_| failure("SERVICE_BOOTSTRAP_INVALID"))?;
        let mut env = vec![("CENTRAL_SERVICE_HOST".into(), "1".into())];
        #[cfg(target_os = "macos")]
        env.push(("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()));
        for name in ["SystemRoot", "WINDIR", "SystemDrive"] {
            if let Some(value) = std::env::var_os(name) {
                env.push((
                    name.into(),
                    value
                        .into_string()
                        .map_err(|_| failure("SERVICE_ENV_INVALID"))?,
                ));
            }
        }
        let stop_ms = config.shutdown.grace_ms + 5000;
        let spec = LaunchSpec {
            node: package.node.clone(),
            script: package.gateway.clone(),
            cwd: package.root.clone(),
            env,
            bootstrap: bootstrap.0,
            start_timeout: Duration::from_secs(45),
            stop_timeout: Duration::from_millis(stop_ms),
            force_timeout: Duration::from_millis(config.shutdown.force_ms),
            owner_guard: Some(Box::new((package.clone(), data_guard))),
        };
        self.open()?;
        self.record(&root, &request.request_id, &hash)?;
        let _dispatch = self
            .dispatch
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))?;
        self.open()?;
        self.shutdown_ms.store(stop_ms, Ordering::SeqCst);
        self.force_ms
            .store(config.shutdown.force_ms, Ordering::SeqCst);
        *self
            .running_config
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))? = Some(config);
        let snapshot = self.process.start(spec).map_err(failure)?;
        *self
            .auth_package
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))? = Some(package);
        *self
            .running_account
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))? =
            snapshot.instance_id.as_ref().map(|instance| {
                (
                    instance.clone(),
                    request.account_id,
                    format!("{:x}", Sha256::digest(credential.access_token().as_bytes())),
                    0,
                )
            });
        Ok(snapshot)
    }
    pub fn stop(
        &self,
        app_data: &Path,
        request_id: &str,
        expected_instance_id: &str,
    ) -> Result<Snapshot> {
        let _gate = self.mutation()?;
        if !valid_request_id(request_id) {
            return Err(failure("SERVICE_REQUEST_INVALID"));
        }
        let hash = fingerprint(&("stop", expected_instance_id))?;
        let root = config::resource_root(app_data, true)?;
        if self.previous(&root, request_id, &hash)? {
            return Ok(self.snapshot());
        }
        if self.snapshot().instance_id.as_deref() != Some(expected_instance_id) {
            return Err(failure("SERVICE_INSTANCE_MISMATCH"));
        }
        self.record(&root, request_id, &hash)?;
        self.auth_cancel.store(true, Ordering::SeqCst);
        *self
            .auth_package
            .lock()
            .map_err(|_| failure("SERVICE_STATE_FAILED"))? = None;
        self.process.stop().map_err(failure)
    }
    pub fn begin_shutdown(&self) {
        self.auth_cancel.store(true, Ordering::SeqCst);
        let _dispatch = self
            .dispatch
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.closing.store(true, Ordering::SeqCst);
    }
    /// Called only on a background thread. A preparation already in progress
    /// observes closing before actor dispatch, so it cannot launch after exit.
    pub fn shutdown(&self) -> bool {
        self.begin_shutdown();
        let _ = self.process.stop();
        let deadline =
            Instant::now() + Duration::from_millis(self.shutdown_ms.load(Ordering::SeqCst));
        while Instant::now() < deadline {
            if self.snapshot().cleanup_verified && !self.mutation.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        self.process.force_stop();
        let deadline = Instant::now() + Duration::from_millis(self.force_ms.load(Ordering::SeqCst));
        while Instant::now() < deadline {
            if self.snapshot().cleanup_verified && !self.mutation.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = failure("SHUTDOWN_INCOMPLETE");
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(windows, debug_assertions))]
    #[test]
    #[ignore = "real pinned Node package lifecycle with isolated synthetic DPAPI account/TLS only"]
    fn native_package_bootstrap_config_gate_idempotency_and_verified_stop_qa() {
        let resources = std::path::PathBuf::from(
            std::env::var_os("CENTRAL_SERVICE_QA_RESOURCES")
                .expect("CENTRAL_SERVICE_QA_RESOURCES required"),
        );
        assert!(resources.is_absolute());
        let catalog: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../harness/central-service-catalog.json"
        ))
        .unwrap();
        let package = catalog["packages"][0]["id"].as_str().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("application");
        let data = temp.path().join("gateway-data");
        // A DOS path must remain DOS through native preparation and Node validation.
        assert!(!data.to_string_lossy().starts_with(r"\\?\"));
        let certificate = tls::store_service_fixture(&app_data);
        let account = model_accounts::store_service_fixture(&app_data);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let value = serde_json::json!({"schemaVersion":1,"revision":0,"dataDirectory":data.to_string_lossy(),
            "listen":{"host":"127.0.0.1","port":port},"clientUrl":format!("wss://central-test.invalid:{port}/ws"),
            "tls":{"certificateId":certificate},"runtimePackageId":package,
            "limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},"shutdown":{"graceMs":1000,"forceMs":5000}});
        let controller = Service::new();
        struct Cleanup<'a>(&'a Service);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                self.0.shutdown();
            }
        }
        let _cleanup = Cleanup(&controller);
        controller
            .save_config(&app_data, "synthetic-config".into(), 0, value.clone())
            .unwrap();
        let request = || StartRequest {
            request_id: "synthetic-start".into(),
            expected_revision: 1,
            account_id: account.clone(),
            admin_username: Some("synthetic-admin".into()),
            admin_password: Some(Zeroizing::new("SYNTHETIC-only-passphrase-29".into())),
        };
        let start = controller.start(&app_data, &resources, request()).unwrap();
        let duplicate = controller.start(&app_data, &resources, request()).unwrap();
        assert_eq!(start.instance_id, duplicate.instance_id);
        assert_eq!(start.generation, duplicate.generation);
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let snapshot = controller.snapshot();
            if snapshot.state == State::Running {
                break;
            }
            assert!(
                snapshot.state != State::Failed,
                "service failed: {:?}",
                snapshot.failure_code
            );
            assert!(Instant::now() < deadline, "service readiness deadline");
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
        assert!(platform_security::central_secret_store::lock_runtime_root(&data).is_err());
        let error = controller
            .save_config(&app_data, "while-active".into(), 1, value)
            .err()
            .unwrap();
        assert!(matches!(
            error.code,
            "SERVICE_CLEANUP_UNVERIFIED" | "SERVICE_ALREADY_ACTIVE"
        ));
        let instance = start.instance_id.unwrap();
        let stop = controller
            .stop(&app_data, "synthetic-stop", &instance)
            .unwrap();
        let repeated = controller
            .stop(&app_data, "synthetic-stop", &instance)
            .unwrap();
        assert_eq!(stop.generation, repeated.generation);
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let snapshot = controller.snapshot();
            if snapshot.cleanup_verified {
                assert_eq!(snapshot.state, State::Stopped);
                break;
            }
            assert!(Instant::now() < deadline, "service cleanup deadline");
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(platform_security::central_secret_store::lock_runtime_root(&data).is_ok());
        println!(
            "SERVICE_SYNTHETIC_QA: running, DOS-config, duplicate-start, config-gate, data-lock, stop, duplicate-stop, cleanup passed"
        );
    }
    #[test]
    fn mutation_is_nonblocking_and_closing_refuses_new_work() {
        let service = Service::new();
        let guard = service.mutation().unwrap();
        assert_eq!(service.mutation().err().unwrap().code, "OPERATION_BUSY");
        drop(guard);
        assert!(service.mutation().is_ok());
        service.begin_shutdown();
        assert_eq!(
            service.mutation().err().unwrap().code,
            "SERVICE_APP_CLOSING"
        );
    }
    #[test]
    fn cleanup_confirmation_is_required_even_when_process_reports_failed() {
        let service = Service::new();
        let mut snapshot = service.snapshot();
        snapshot.state = State::Failed;
        snapshot.cleanup_verified = false;
        assert_eq!(
            writable(&snapshot).err().unwrap().code,
            "SERVICE_CLEANUP_UNVERIFIED"
        );
        snapshot.cleanup_verified = true;
        assert!(writable(&snapshot).is_ok());
    }
    #[test]
    fn active_service_rejects_config_changes_without_reporting_failed_cleanup() {
        let service = Service::new();
        let mut snapshot = service.snapshot();
        for state in [State::Starting, State::Running, State::Stopping] {
            snapshot.state = state;
            snapshot.cleanup_verified = false;
            assert_eq!(
                writable(&snapshot).err().unwrap().code,
                "SERVICE_ALREADY_ACTIVE"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn append_only_intents_detect_parameter_conflicts_and_restart_without_replay() {
        let temp = tempfile::tempdir().unwrap();
        let root = config::resource_root(temp.path(), true).unwrap();
        let first = Service::new();
        let secret = "SYNTHETIC_PASSWORD_NEVER_STORE";
        let hash = fingerprint(&("start", secret)).unwrap();
        assert!(!first.previous(&root, "request-1", &hash).unwrap());
        first.record(&root, "request-1", &hash).unwrap();
        assert!(first.previous(&root, "request-1", &hash).unwrap());
        assert_eq!(
            first
                .previous(&root, "request-1", &fingerprint(&"different").unwrap())
                .err()
                .unwrap()
                .code,
            "SERVICE_REQUEST_CONFLICT"
        );
        let ids = platform_security::central_secret_store::list(&root, OPERATIONS).unwrap();
        assert_eq!(ids.len(), 1);
        let bytes =
            platform_security::central_secret_store::load(&root, OPERATIONS, &ids[0]).unwrap();
        assert!(
            !bytes
                .windows(secret.len())
                .any(|part| part == secret.as_bytes())
        );
        let next = Service::new();
        assert_eq!(
            next.previous(&root, "request-1", &hash).err().unwrap().code,
            "RECONCILE_REQUIRED"
        );
        assert!(next.snapshot().cleanup_verified);
        assert_eq!(next.snapshot().generation, 0);
    }
}
