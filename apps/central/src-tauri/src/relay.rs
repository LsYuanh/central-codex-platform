// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Optional relay configuration and lifecycle, separate from business gateway configuration.
use crate::{
    config::{self, Result, failure},
    service::Service,
    service_process::State,
};
use peer_transport::relay::{Access, Host, Target};
use platform_security::central_secret_store as store;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const NAMESPACE: &str = "central-relay-v1";

// Operator-only native provisioning, compiled into the Mac test binary only.
// Reuse the production store while the formal service is stopped and locked;
// never hand-write its selection, seed or private-record format.
#[cfg(all(test, target_os = "macos", debug_assertions))]
#[test]
#[ignore = "requires explicit deployment authorization and a stopped formal service"]
fn configure_formal_macos_relay() {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    assert_eq!(
        std::env::var("CENTRAL_RELAY_DEPLOY_OPT_IN").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var_os("CENTRAL_MACOS_APP_DATA").unwrap());
    assert!(root.is_absolute() && root.file_name().unwrap() == "com.yuanzhou.central");
    assert_eq!(root.canonicalize().unwrap(), root);
    let input = PathBuf::from(std::env::var_os("CENTRAL_RELAY_ACCESS_FILE").unwrap());
    let output = PathBuf::from(std::env::var_os("CENTRAL_RELAY_TARGET_FILE").unwrap());
    assert!(input.is_absolute() && output.is_absolute() && input.parent() == output.parent());
    let meta = fs::symlink_metadata(&input).unwrap();
    assert!(meta.is_file() && !meta.file_type().is_symlink() && meta.mode() & 0o777 == 0o600);
    assert_eq!(meta.uid(), unsafe { libc::geteuid() });
    let cfg = config::read(&root).unwrap().config.unwrap();
    let _lock = store::lock_runtime_root(Path::new(&cfg.data_directory)).unwrap();
    // An unrelated live gateway must also block provisioning; the new in-memory
    // Service alone cannot attest to another process's ownership.
    let _probe = std::net::TcpListener::bind(("0.0.0.0", cfg.listen.port as u16)).unwrap();
    let private = zeroize::Zeroizing::new(fs::read(&input).unwrap());
    let access: Access = serde_json::from_slice(&private).unwrap();
    let manager = Manager::new();
    assert_eq!(
        manager
            .save(&Service::new(), &root, Some(access))
            .unwrap()
            .state,
        "waiting-service"
    );
    let record = load(&root).unwrap().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let target = runtime.block_on(async {
        let host = Host::start(
            &record.access,
            record.seed,
            SocketAddr::from(([127, 0, 0, 1], cfg.listen.port as u16)),
        )
        .await;
        assert!(host.is_ok(), "RELAY_DEPLOY_PREFLIGHT_FAILED");
        let host = host.unwrap();
        let target = Target {
            access: record.access.clone(),
            central_id: host.central_id(),
        };
        drop(host);
        tokio::time::sleep(Duration::from_secs(1)).await;
        target
    });
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output)
        .unwrap();
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&target).unwrap());
    file.write_all(&bytes).unwrap();
    file.sync_all().unwrap();
    println!("FORMAL_RELAY_CONFIGURED_AND_PREFLIGHT_PASSED");
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    access: Access,
    seed: [u8; 32],
}
impl Drop for Record {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.seed.zeroize();
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    record: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub state: &'static str,
    pub error: Option<&'static str>,
    pub relay_url: Option<String>,
}
struct Runtime {
    status: Status,
    instance: Option<String>,
    target: Option<Target>,
}
pub struct Manager {
    runtime: Mutex<Runtime>,
    configuration: Mutex<()>,
    revision: AtomicU64,
}
impl Manager {
    pub fn new() -> Self {
        Self {
            configuration: Mutex::new(()),
            revision: AtomicU64::new(0),
            runtime: Mutex::new(Runtime {
                status: Status {
                    configured: false,
                    state: "disabled",
                    error: None,
                    relay_url: None,
                },
                instance: None,
                target: None,
            }),
        }
    }
    fn set(&self, status: Status, instance: Option<String>, target: Option<Target>) {
        if let Ok(mut r) = self.runtime.lock() {
            *r = Runtime {
                status,
                instance,
                target,
            };
        }
    }
    fn set_current(
        &self,
        revision: u64,
        status: Status,
        instance: Option<String>,
        target: Option<Target>,
    ) -> bool {
        let Ok(_guard) = self.configuration.lock() else {
            return false;
        };
        if self.revision.load(Ordering::SeqCst) != revision {
            return false;
        }
        self.set(status, instance, target);
        true
    }
    pub fn status(&self) -> Result<Status> {
        Ok(self
            .runtime
            .lock()
            .map_err(|_| failure("RELAY_STATE_FAILED"))?
            .status
            .clone())
    }
    pub fn target(&self, root: &Path, instance: &str) -> Result<Option<Target>> {
        let _guard = self
            .configuration
            .lock()
            .map_err(|_| failure("RELAY_STATE_FAILED"))?;
        let _ = instance;
        // Pairing remains usable on LAN while the relay is temporarily offline.
        Ok(load(root)?.map(|r| Target {
            access: r.access.clone(),
            central_id: peer_transport::relay::central_id(r.seed),
        }))
    }

    pub fn save(&self, service: &Service, root: &Path, access: Option<Access>) -> Result<Status> {
        let _gate = service.mutation()?;
        // Private-store handles exclude concurrent writers. Serialize monitor reads
        // with saves, and invalidate delayed connection results from an older config.
        let _guard = self
            .configuration
            .lock()
            .map_err(|_| failure("RELAY_STATE_FAILED"))?;
        let snap = service.snapshot();
        if !matches!(snap.state, State::Stopped | State::Failed) || !snap.cleanup_verified {
            return Err(failure("SERVICE_ALREADY_ACTIVE"));
        }
        // Admit the existing app configuration root before writing a selection or private record.
        config::read(root)?;
        // A fresh installation may not have an app-data directory yet. Use the same
        // checked directory creation as other central stores before creating secrets.
        let root = &config::resource_root(root, true)?;
        let record = if let Some(access) = access {
            access
                .validate()
                .map_err(|_| failure("RELAY_CONFIG_INVALID"))?;
            // Preserve the central transport identity across admission-token/certificate changes.
            let seed = load(root)?
                .map(|r| r.seed)
                .unwrap_or_else(peer_transport::relay::new_seed);
            let record = Record { access, seed };
            let bytes = zeroize::Zeroizing::new(
                serde_json::to_vec(&record).map_err(|_| failure("RELAY_CONFIG_INVALID"))?,
            );
            Some(
                store::create(root, NAMESPACE, &bytes)
                    .map_err(|_| failure("RELAY_STORAGE_FAILED"))?,
            )
        } else {
            None
        };
        let path = root.join("relay-selection-v1.json");
        if path.exists() {
            selection(root)?;
        }
        let mut temp =
            tempfile::NamedTempFile::new_in(root).map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
        serde_json::to_writer(&mut temp, &Selection { record })
            .map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
        temp.flush().map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
        temp.as_file()
            .sync_all()
            .map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
        temp.persist(path)
            .map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
        let record = load(root)?;
        let status = Status {
            configured: record.is_some(),
            state: if record.is_some() {
                "waiting-service"
            } else {
                "disabled"
            },
            error: None,
            relay_url: record.map(|r| r.access.url.clone()),
        };
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.set(status.clone(), None, None);
        Ok(status)
    }
}
fn selection(root: &Path) -> Result<Selection> {
    let path = root.join("relay-selection-v1.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Selection { record: None });
        }
        Err(_) => return Err(failure("RELAY_STORAGE_FAILED")),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
        return Err(failure("RELAY_STORAGE_FAILED"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(failure("RELAY_STORAGE_FAILED"));
        }
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| failure("RELAY_STORAGE_FAILED"))?)
        .map_err(|_| failure("RELAY_STORAGE_FAILED"))
}
fn load(root: &Path) -> Result<Option<Record>> {
    let Some(id) = selection(root)?.record else {
        return Ok(None);
    };
    let bytes = store::load(root, NAMESPACE, &id).map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| failure("RELAY_STORAGE_FAILED"))?;
    record
        .access
        .validate()
        .map_err(|_| failure("RELAY_CONFIG_INVALID"))?;
    Ok(Some(record))
}

/// The monitor owns every forwarding task. Stopping/crashing/replacing the gateway drops them.
pub async fn monitor(manager: Weak<Manager>, service: Weak<Service>, root: PathBuf) {
    let mut host: Option<Host> = None;
    let mut instance = None;
    let mut next = Instant::now();
    let mut published_instance: Option<String> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let (Some(manager), Some(service)) = (manager.upgrade(), service.upgrade()) else {
            break;
        };
        let snap = service.snapshot();
        if snap.state != State::Running {
            published_instance = None;
        }
        if snap.state == State::Running
            && snap.connection_updates_supported
            && published_instance != snap.instance_id
        {
            if let Some(id) = snap.instance_id.clone() {
                if let Ok(target) = manager.target(&root, &id) {
                    let service = service.clone();
                    let sent_id = id.clone();
                    if tokio::task::spawn_blocking(move || {
                        service.update_connection(&sent_id, target.as_ref())
                    })
                    .await
                    .is_ok_and(|r| r.is_ok())
                    {
                        published_instance = Some(id);
                    }
                }
            }
        }
        if snap.state != State::Running || snap.instance_id != instance {
            if host.take().is_some() {
                if let Ok(mut r) = manager.runtime.lock() {
                    r.status.state = if r.status.configured {
                        "waiting-service"
                    } else {
                        "disabled"
                    };
                    r.status.error = None;
                    r.instance = None;
                    r.target = None;
                }
                next = Instant::now();
            }
            instance = None;
        }
        if let Some(host) = &host {
            let connected = host.online();
            if let Ok(mut r) = manager.runtime.lock() {
                r.status.state = if connected {
                    "connected"
                } else {
                    "reconnecting"
                };
                r.status.error = if connected {
                    None
                } else {
                    Some("RELAY_CONNECTION_FAILED")
                };
            }
            continue;
        }
        if Instant::now() < next {
            continue;
        }
        next = Instant::now() + Duration::from_secs(10);
        let (revision, loaded) = {
            let Ok(_guard) = manager.configuration.lock() else {
                continue;
            };
            (manager.revision.load(Ordering::SeqCst), load(&root))
        };
        let record = match loaded {
            Ok(v) => v,
            Err(_) => {
                manager.set_current(
                    revision,
                    Status {
                        configured: true,
                        state: "failed",
                        error: Some("RELAY_STORAGE_FAILED"),
                        relay_url: None,
                    },
                    None,
                    None,
                );
                continue;
            }
        };
        let Some(record) = record else {
            manager.set_current(
                revision,
                Status {
                    configured: false,
                    state: "disabled",
                    error: None,
                    relay_url: None,
                },
                None,
                None,
            );
            continue;
        };
        let mut status = Status {
            configured: true,
            state: "waiting-service",
            error: None,
            relay_url: Some(record.access.url.clone()),
        };
        if snap.state != State::Running {
            manager.set_current(revision, status, None, None);
            continue;
        }
        let Some(id) = snap.instance_id.clone() else {
            continue;
        };
        let target = match service.management_target(&root, &id) {
            Ok(v) => v,
            Err(_) => {
                status.state = "failed";
                status.error = Some("RELAY_CENTRAL_UNAVAILABLE");
                manager.set_current(revision, status, None, None);
                continue;
            }
        };
        let address = target.config.listen.host.parse::<IpAddr>();
        let ip = match address {
            Ok(ip) if ip.is_unspecified() => {
                if ip.is_ipv4() {
                    IpAddr::from([127, 0, 0, 1])
                } else {
                    IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
                }
            }
            Ok(ip) => ip,
            _ => {
                status.state = "failed";
                status.error = Some("RELAY_TARGET_NOT_LOCAL");
                manager.set_current(revision, status, None, None);
                continue;
            }
        };
        status.state = "connecting";
        if !manager.set_current(revision, status.clone(), None, None) {
            continue;
        }
        match Host::start(
            &record.access,
            record.seed,
            SocketAddr::new(ip, target.config.listen.port as u16),
        )
        .await
        {
            Ok(value) => {
                let after = service.snapshot();
                if after.state != State::Running || after.instance_id.as_ref() != Some(&id) {
                    continue;
                }
                status.state = "connected";
                let peer = Target {
                    access: record.access.clone(),
                    central_id: value.central_id(),
                };
                if manager.set_current(revision, status, Some(id.clone()), Some(peer)) {
                    host = Some(value);
                    instance = Some(id);
                }
            }
            Err(_) => {
                status.state = "failed";
                status.error = Some("RELAY_CONNECTION_FAILED");
                manager.set_current(revision, status, None, None);
            }
        }
    }
}
