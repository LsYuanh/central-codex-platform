// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Explicit installation/upgrade acceptance fixtures; never part of the product.
//! The installer and installed GUI are exercised separately by the QA operator.
#![cfg(all(test, windows, debug_assertions))]

use crate::{
    config, model_accounts,
    people::{Mutation, People},
    service::{Service, StartRequest},
    service_process::State,
    tls,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::TcpListener,
    os::windows::{ffi::OsStringExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

const PROFILE_ID: &str = "com.yuanzhou.central.installqa20260911";
const INSTALLED_EXE: &str = "yuanzhou-central-install-qa-20260911.exe";
const ADMIN: &str = "synthetic-install-admin";
const USER: &str = "synthetic-install-user";
// Deliberately synthetic test input. Never read or reuse any real login.
const PASSWORD: &str = "SYNTHETIC-install-acceptance-admin-20260911";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    schema_version: u64,
    profile_id: String,
    account_id: String,
    user_id: String,
    port: u16,
}

fn ordinary(path: &Path, directory: bool) {
    let metadata = fs::symlink_metadata(path).expect("fixed QA path must exist");
    assert_eq!(metadata.is_dir(), directory, "QA path type");
    assert!(directory || metadata.is_file(), "regular QA file");
    assert_eq!(
        metadata.file_attributes() & 0x400,
        0,
        "QA paths cannot be reparse points"
    );
}

fn paths() -> (PathBuf, PathBuf) {
    assert_eq!(
        std::env::var("CENTRAL_INSTALL_QA_ALLOW").as_deref(),
        Ok("1"),
        "explicit installation acceptance opt-in required"
    );
    let local_dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("workspace manifest ancestry");
    assert!(local_dev.join("Cargo.toml").is_file());
    assert!(
        local_dev
            .join("apps/central/src-tauri/Cargo.toml")
            .is_file()
    );
    let acceptance = local_dev.join("target/central-install-qa");
    let installed = acceptance.join("installed");
    ordinary(&acceptance, true);
    ordinary(&installed, true);
    let supplied = PathBuf::from(
        std::env::var_os("CENTRAL_INSTALL_QA_RESOURCES")
            .expect("explicit installed QA resources required"),
    );
    assert!(
        supplied.is_absolute()
            && !supplied
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir)),
        "installed resources must be an absolute, unaliased path"
    );
    assert_eq!(
        fs::canonicalize(&supplied).expect("installed resources directory"),
        fs::canonicalize(&installed).expect("fixed installation directory"),
        "only target/central-install-qa/installed is authorized"
    );
    // Refuse a symlink/junction alias even if canonicalization reaches the
    // allowed directory. A generic target/debug build is never accepted.
    let mut ancestor = PathBuf::new();
    for component in supplied.components() {
        ancestor.push(component.as_os_str());
        if !matches!(component, Component::Prefix(_)) {
            ordinary(&ancestor, true);
        }
    }
    ordinary(&installed.join(INSTALLED_EXE), false);
    assert!(fs::metadata(installed.join(INSTALLED_EXE)).unwrap().len() > 0);
    (installed, acceptance.join("fixture-proof.json"))
}

fn profile() -> PathBuf {
    // Same RoamingAppData Known Folder API as Tauri and people_ui_qa. Never
    // accept APPDATA, an environment profile override or a caller-selected ID.
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetKnownFolderPath(
            folder: *const windows_sys::core::GUID,
            flags: u32,
            token: *mut std::ffi::c_void,
            result: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(memory: *const std::ffi::c_void);
    }
    struct Folder(*mut u16);
    impl Drop for Folder {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(self.0.cast()) };
        }
    }
    let id = windows_sys::core::GUID::from_u128(0x3eb685db_65f9_4cf6_a03a_e3ef65729f3d);
    let mut folder = Folder(std::ptr::null_mut());
    assert_eq!(
        unsafe { SHGetKnownFolderPath(&id, 0, std::ptr::null_mut(), &mut folder.0) },
        0,
        "RoamingAppData Known Folder"
    );
    assert!(!folder.0.is_null());
    let mut length = 0usize;
    while length < 32768 && unsafe { *folder.0.add(length) } != 0 {
        length += 1;
    }
    assert!(length < 32768);
    let parent = PathBuf::from(std::ffi::OsString::from_wide(unsafe {
        std::slice::from_raw_parts(folder.0, length)
    }));
    let root = parent.join(PROFILE_ID);
    assert!(root.is_absolute() && root.parent() == Some(parent.as_path()));
    root
}

fn package() -> String {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../harness/central-service-catalog.json"
    ))
    .expect("complete service package catalog");
    catalog["packages"][0]["id"]
        .as_str()
        .expect("complete service candidate")
        .to_owned()
}

struct Owned {
    service: Service,
    people: People,
}
impl Owned {
    fn new() -> Self {
        Self {
            service: Service::new(),
            people: People::new(),
        }
    }
    fn start(&self, root: &Path, resources: &Path, account: &str, initial: bool) -> String {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let snapshot = self
            .service
            .start(
                root,
                resources,
                StartRequest {
                    request_id: format!(
                        "install-qa-{}-{millis}",
                        if initial { "prepare" } else { "verify" }
                    ),
                    expected_revision: 1,
                    account_id: account.into(),
                    admin_username: initial.then(|| ADMIN.into()),
                    admin_password: initial.then(|| Zeroizing::new(PASSWORD.into())),
                },
            )
            .expect("start owned gateway from installed resources");
        let instance = snapshot.instance_id.expect("native service instance");
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let snapshot = self.service.snapshot();
            assert_ne!(snapshot.state, State::Failed, "{:?}", snapshot.failure_code);
            assert!(
                Instant::now() < deadline,
                "owned startup and metrics deadline"
            );
            if snapshot.state == State::Running {
                if let Some(metrics) = snapshot.metrics {
                    assert_eq!(
                        (
                            metrics.online_devices,
                            metrics.active_turns,
                            metrics.workers
                        ),
                        (0, 0, 0)
                    );
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            self.people
                .login(
                    &self.service,
                    root,
                    &instance,
                    ADMIN.into(),
                    Zeroizing::new(PASSWORD.into())
                )
                .expect("synthetic administrator login through pinned TLS")
                .authenticated
        );
        instance
    }
    fn stop(&self, port: u16) {
        self.people.clear_session();
        assert!(self.service.shutdown(), "owned process cleanup");
        let snapshot = self.service.snapshot();
        assert!(snapshot.cleanup_verified);
        assert_eq!(snapshot.state, State::Stopped);
        assert!(snapshot.metrics.is_none());
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "QA listener released"
        );
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.people.clear_session();
        self.service.shutdown();
    }
}

#[test]
#[ignore = "explicit installed Windows QA resources and new fixed synthetic profile required"]
fn prepare_installed_profile() {
    let (resources, proof_path) = paths();
    assert!(
        !proof_path.try_exists().expect("proof existence check"),
        "proof must be new"
    );
    let root = profile();
    fs::create_dir(&root).expect("reserve a wholly new fixed installation QA profile");
    ordinary(&root, true);
    let data =
        crate::default_data_directory(&root).expect("native physical default data directory");
    let certificate = tls::store_service_fixture(&root);
    let account = model_accounts::store_service_fixture(&root);
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("unused loopback port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let owned = Owned::new();
    owned
        .service
        .save_config(
            &root,
            "install-qa-config".into(),
            0,
            serde_json::json!({
                "schemaVersion":1,"revision":0,"dataDirectory":data,
                "listen":{"host":"127.0.0.1","port":port},
                "clientUrl":format!("wss://central-test.invalid:{port}/ws"),
                "tls":{"certificateId":certificate},"runtimePackageId":package(),
                "limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},
                "shutdown":{"graceMs":1000,"forceMs":5000}
            }),
        )
        .expect("save isolated synthetic configuration");
    let instance = owned.start(&root, &resources, &account, true);
    let user = owned
        .people
        .mutate(
            &owned.service,
            &root,
            &instance,
            "install-qa-user",
            Mutation::CreateUser {
                username: USER.into(),
            },
        )
        .expect("create persistent synthetic user")
        .user
        .expect("public user receipt");
    let inventory = owned
        .people
        .list(&owned.service, &root, &instance)
        .expect("native inventory");
    assert_eq!(inventory.users.len(), 2);
    assert!(inventory.devices.is_empty());
    assert!(
        inventory
            .users
            .iter()
            .any(|entry| entry.id == user.id && entry.username == USER && !entry.disabled)
    );
    owned.stop(port);
    let proof = Proof {
        schema_version: 1,
        profile_id: PROFILE_ID.into(),
        account_id: account,
        user_id: user.id,
        port,
    };
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&proof_path)
        .expect("new public fixture proof only");
    serde_json::to_writer_pretty(&mut output, &proof).expect("public proof serialization");
    output.write_all(b"\n").unwrap();
    output.sync_all().unwrap();
    println!(
        "INSTALL_QA_PREPARED profileId={PROFILE_ID} users=2 realModelCalled=false cleanupVerified=true fixtureRetained=true"
    );
}

#[test]
#[ignore = "explicit installed Windows QA resources and previously prepared fixed profile required"]
fn verify_installed_profile() {
    let (resources, proof_path) = paths();
    ordinary(&proof_path, false);
    let mut bytes = Vec::with_capacity(4097);
    fs::File::open(&proof_path)
        .expect("existing proof")
        .take(4097)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 4096, "bounded public proof");
    let proof: Proof = serde_json::from_slice(&bytes).expect("structured public proof");
    assert_eq!(proof.schema_version, 1);
    assert_eq!(proof.profile_id, PROFILE_ID);
    assert!(
        proof.account_id.len() == 32
            && proof
                .account_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
    );
    assert!(!proof.user_id.is_empty() && proof.user_id.len() <= 128);
    assert!(proof.port >= 1024);
    let root = profile();
    ordinary(&root, true);
    let saved = config::read(&root)
        .expect("read retained configuration")
        .config
        .expect("configuration must survive installation");
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.listen.host, "127.0.0.1");
    assert_eq!(saved.listen.port, u64::from(proof.port));
    assert_eq!(
        saved.client_url,
        format!("wss://central-test.invalid:{}/ws", proof.port)
    );
    assert_eq!(saved.runtime_package_id, package());
    let physical = config::resource_root(&root, false).expect("existing physical profile");
    assert_eq!(
        saved.data_directory,
        crate::public_directory_text(&physical.join("central-data")).unwrap()
    );
    let before = serde_json::to_value(&saved).unwrap();
    // No import/save/fixture creation on this path: these calls decrypt the
    // retained DPAPI account and certificate, and start consumes the same stores.
    let accounts = model_accounts::list(&root).expect("read retained account store");
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_id, proof.account_id);
    assert!(accounts[0].report.is_some() && accounts[0].failure.is_none());
    tls::inspect_stored(&root, &saved).expect("retained certificate decrypts and verifies");
    let owned = Owned::new();
    assert!(
        !owned
            .service
            .context(&root)
            .expect("retained administrator context")
            .needs_admin
    );
    let instance = owned.start(&root, &resources, &proof.account_id, false);
    let inventory = owned
        .people
        .list(&owned.service, &root, &instance)
        .expect("retained native inventory");
    assert_eq!(inventory.users.len(), 2);
    assert!(inventory.devices.is_empty());
    assert!(
        inventory
            .users
            .iter()
            .any(|user| user.id == proof.user_id && user.username == USER && !user.disabled)
    );
    owned.stop(proof.port);
    let after = config::read(&root)
        .expect("retained configuration after verification")
        .config
        .unwrap();
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        before,
        "verification cannot replace saved configuration"
    );
    assert_eq!(
        fs::read(&proof_path).unwrap(),
        bytes,
        "public proof remains unchanged"
    );
    println!(
        "INSTALL_QA_VERIFIED profileId={PROFILE_ID} configPreserved=true tlsPreserved=true accountPreserved=true userPreserved=true realModelCalled=false cleanupVerified=true"
    );
}
