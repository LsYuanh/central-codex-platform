// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Opt-in, test-only Wry window over the real native service/People owners.
//! Build with `--features tauri/custom-protocol` to embed the normal frontendDist.
//! No production flag, injected renderer session, mock IPC, or fake gateway.
#![cfg(all(test, windows, debug_assertions))]

use crate::{
    model_accounts,
    people::{Mutation, People},
    service::{Service, StartRequest},
    service_process::State,
    tls,
};
use reqwest::blocking::{Body, Client};
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Read},
    net::{SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use zeroize::{Zeroize, Zeroizing};

fn reserve_profile(id: &str) -> PathBuf {
    use std::os::windows::ffi::OsStringExt;
    // Same Known Folder call as Tauri's dirs::data_dir(), before WebView2 has
    // any opportunity to create its profile. No environment path override.
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
            unsafe {
                CoTaskMemFree(self.0.cast());
            }
        }
    }
    let folder_id = windows_sys::core::GUID::from_u128(0x3eb685db_65f9_4cf6_a03a_e3ef65729f3d);
    let mut folder = Folder(std::ptr::null_mut());
    assert_eq!(
        unsafe { SHGetKnownFolderPath(&folder_id, 0, std::ptr::null_mut(), &mut folder.0) },
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
    let root = parent.join(id);
    assert!(root.is_absolute() && root.parent() == Some(parent.as_path()));
    // create_dir (not create_dir_all) atomically refuses an existing profile.
    std::fs::create_dir(&root)
        .expect("QA must reserve a wholly new profile before building the WebView");
    root
}

fn identifier() -> String {
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let mut bytes = [0u8; 16];
    assert!(
        unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } >= 0
    );
    format!(
        "com.yuanzhou.central.people-ui-qa.{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

/// Exercise public device pairing over the same CA-pinned, loopback TLS service.
/// Deliberately no Local Agent connection: these fixtures must show offline.
fn pair_fixture(
    service: &Service,
    people: &People,
    root: &Path,
    instance: &str,
    user: &str,
    index: usize,
) -> String {
    let mut pairing = people
        .mutate(
            service,
            root,
            instance,
            &format!("ui-qa-pair-{index}"),
            Mutation::PairCode {
                user_id: user.into(),
            },
        )
        .expect("synthetic pairing issuance")
        .pairing
        .expect("pairing receipt");
    let target = service
        .management_target(root, instance)
        .expect("owned management target");
    let port = target.config.listen.port as u16;
    let mut builder = Client::builder()
        .use_rustls_tls()
        .tls_built_in_root_certs(false)
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .timeout(Duration::from_secs(15))
        .http1_only()
        .pool_max_idle_per_host(0)
        .resolve(
            "central-test.invalid",
            SocketAddr::from(([127, 0, 0, 1], port)),
        );
    for certificate in
        reqwest::Certificate::from_pem_bundle(target.ca_pem.as_bytes()).expect("fixture CA")
    {
        builder = builder.add_root_certificate(certificate);
    }
    #[derive(Serialize)]
    struct PairRequest<'a> {
        code: &'a str,
        name: &'a str,
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(4096));
    serde_json::to_writer(
        &mut *bytes,
        &PairRequest {
            code: &pairing.code,
            name: if index == 1 {
                "合成 QA 工作站 · 未连接 Agent"
            } else {
                "合成 QA 已撤销设备"
            },
        },
    )
    .expect("bounded fixture request");
    pairing.code.zeroize();
    let length = bytes.len() as u64;
    let response = builder
        .build()
        .expect("pinned client")
        .post(format!(
            "https://central-test.invalid:{port}/auth/device/pair"
        ))
        .header("content-type", "application/json")
        .body(Body::sized(Cursor::new(bytes), length))
        .send()
        .expect("synthetic device pairing");
    assert!(response.status().is_success());
    assert_eq!(
        response
            .headers()
            .get("x-central-service-instance")
            .and_then(|value| value.to_str().ok()),
        Some(instance)
    );
    const MAX: usize = 64 * 1024;
    let mut body = Zeroizing::new(Vec::with_capacity(MAX + 1));
    response
        .take((MAX + 1) as u64)
        .read_to_end(&mut body)
        .expect("pairing response");
    assert!(body.len() <= MAX);
    // Device token/key are ignored during deserialization and never printed or
    // persisted by this fixture. The raw response allocation is wiped on drop.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PublicPair {
        device_id: String,
    }
    #[derive(Deserialize)]
    struct Envelope {
        ok: bool,
        data: PublicPair,
    }
    let result: Envelope = serde_json::from_slice(&body).expect("public pair response");
    assert!(result.ok);
    result.data.device_id
}

fn close_owned(
    app: &tauri::AppHandle,
    service: &Arc<Service>,
    people: &Arc<People>,
    closing: &Arc<AtomicBool>,
    exit_allowed: &Arc<AtomicBool>,
) {
    if closing.swap(true, Ordering::SeqCst) {
        return;
    }
    people.clear_session();
    service.begin_shutdown();
    let (app, service, exit_allowed) = (app.clone(), Arc::clone(service), Arc::clone(exit_allowed));
    std::thread::spawn(move || {
        let clean = service.shutdown();
        exit_allowed.store(true, Ordering::SeqCst);
        app.exit(if clean { 0 } else { 1 });
    });
}

#[test]
#[ignore = "visible real Wry window; isolated synthetic native login; requires staged resources and tauri/custom-protocol"]
fn authenticated_people_window() {
    assert!(
        !tauri::is_dev(),
        "run this test with --features tauri/custom-protocol after building the normal frontendDist"
    );
    let resources = PathBuf::from(
        std::env::var_os("CENTRAL_SERVICE_QA_RESOURCES")
            .expect("CENTRAL_SERVICE_QA_RESOURCES required"),
    );
    assert!(resources.is_absolute());
    let display_seconds = std::env::var("CENTRAL_PEOPLE_UI_QA_SECONDS")
        .ok()
        .map(|value| value.parse::<u64>().expect("integer QA display seconds"))
        .unwrap_or(180);
    assert!(
        (30..=300).contains(&display_seconds),
        "QA display duration must be 30..=300 seconds"
    );
    let id = identifier();
    let reserved_root = reserve_profile(&id);
    let service = Arc::new(Service::new());
    let people = Arc::new(People::new());
    struct Cleanup(Arc<Service>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.shutdown();
        }
    }
    let _cleanup = Cleanup(Arc::clone(&service));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = id.clone();
    context.config_mut().build.dev_url = None;
    assert_eq!(context.config().app.windows.len(), 1);
    context.config_mut().app.windows[0].title = "中央管理 · 登录后 UI 验收".into();
    context.config_mut().app.windows[0].width = 1280.0;
    context.config_mut().app.windows[0].height = 860.0;
    context.config_mut().app.windows[0].visible = false;
    let root = reserved_root.clone();
    // Exercise the same native default directory shown by the production App,
    // including its MSIX physical-path resolution. Strict storage pins remain.
    let gateway_data = crate::default_data_directory(&root).expect("native default data directory");
    let certificate = tls::store_service_fixture(&root);
    let account = model_accounts::store_service_fixture(&root);
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("unused loopback port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../harness/central-service-catalog.json"
    ))
    .unwrap();
    let package = catalog["packages"][0]["id"]
        .as_str()
        .expect("candidate package");
    service.save_config(&root, "people-ui-qa-config".into(), 0, serde_json::json!({
        "schemaVersion":1,"revision":0,"dataDirectory":gateway_data,
        "listen":{"host":"127.0.0.1","port":port},"clientUrl":format!("wss://central-test.invalid:{port}/ws"),
        "tls":{"certificateId":certificate},"runtimePackageId":package,"limits":{"maxWorkers":1,"perUserTurns":1,"totalTurns":1},
        "shutdown":{"graceMs":1000,"forceMs":5000}
    })).expect("isolated native configuration");
    const PASSWORD: &str = "SYNTHETIC-people-window-admin-20260910";
    let start = service
        .start(
            &root,
            &resources,
            StartRequest {
                request_id: "people-ui-qa-start".into(),
                expected_revision: 1,
                account_id: account,
                admin_username: Some("synthetic-ui-admin".into()),
                admin_password: Some(Zeroizing::new(PASSWORD.into())),
            },
        )
        .expect("owned real gateway start");
    let instance = start.instance_id.expect("native instance");
    let startup_deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let snapshot = service.snapshot();
        if snapshot.state == State::Running {
            break;
        }
        assert_ne!(snapshot.state, State::Failed, "{:?}", snapshot.failure_code);
        assert!(
            Instant::now() < startup_deadline,
            "owned gateway startup deadline"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    println!("PEOPLE_UI_QA_DEFAULT_DATA defaultDataDirectoryVerified=true");
    assert!(
        people
            .login(
                &service,
                &root,
                &instance,
                "synthetic-ui-admin".into(),
                Zeroizing::new(PASSWORD.into())
            )
            .expect("real native synthetic admin login")
            .authenticated
    );
    let alice = people
        .mutate(
            &service,
            &root,
            &instance,
            "ui-qa-user-alice",
            Mutation::CreateUser {
                username: "synthetic-alice".into(),
            },
        )
        .unwrap()
        .user
        .unwrap();
    let bob = people
        .mutate(
            &service,
            &root,
            &instance,
            "ui-qa-user-disabled",
            Mutation::CreateUser {
                username: "synthetic-disabled".into(),
            },
        )
        .unwrap()
        .user
        .unwrap();
    let active_device = pair_fixture(&service, &people, &root, &instance, &alice.id, 1);
    let revoked_device = pair_fixture(&service, &people, &root, &instance, &bob.id, 2);
    people
        .mutate(
            &service,
            &root,
            &instance,
            "ui-qa-revoke",
            Mutation::RevokeDevice {
                device_id: revoked_device.clone(),
            },
        )
        .unwrap();
    people
        .mutate(
            &service,
            &root,
            &instance,
            "ui-qa-disable",
            Mutation::DisableUser { user_id: bob.id },
        )
        .unwrap();
    let inventory = people.list(&service, &root, &instance).unwrap();
    assert_eq!(inventory.users.len(), 3);
    assert_eq!(inventory.devices.len(), 2);
    assert!(
        inventory.devices.iter().all(|device| !device.online),
        "API pairing is not Local Agent connectivity"
    );
    assert!(
        inventory
            .devices
            .iter()
            .any(|device| device.id == active_device && !device.revoked)
    );
    assert!(
        inventory
            .devices
            .iter()
            .any(|device| device.id == revoked_device && device.revoked)
    );
    let metric_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = service.snapshot();
        assert_eq!(snapshot.state, State::Running);
        if let Some(metrics) = snapshot.metrics {
            assert_eq!(
                metrics.online_devices, 0,
                "registered offline devices must not count as online"
            );
            assert_eq!(metrics.active_turns, 0);
            assert_eq!(metrics.workers, 0);
            println!("PEOPLE_UI_QA_METRICS onlineDevices=0 activeTurns=0 workers=0");
            break;
        }
        assert!(
            Instant::now() < metric_deadline,
            "owned metrics must arrive"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    // Construct the actual WebView only after native fixture preparation has
    // released all configuration and People gates; hidden WebViews can run JS.
    let app = tauri::Builder::default()
        .any_thread()
        .manage(Arc::clone(&service))
        .manage(Arc::clone(&people))
        // Same production commands, including the normal App's initial overview
        // queries. No test command or alternative config_root is registered.
        .invoke_handler(tauri::generate_handler![
            crate::central_ui_context,
            crate::central_choose_directory,
            crate::central_config_read,
            crate::central_config_validate,
            crate::central_config_save,
            crate::central_runtime_inspect,
            crate::central_runtime_catalog,
            crate::central_package_inspect,
            crate::central_tls_list,
            crate::central_tls_import,
            crate::central_tls_export_ca,
            crate::central_model_accounts_list,
            crate::central_model_account_discover,
            crate::central_model_account_import,
            crate::central_service_status,
            crate::central_service_context,
            crate::central_service_start,
            crate::central_service_stop,
            crate::central_diagnostics_read,
            crate::central_diagnostics_export,
            crate::central_people_status,
            crate::central_people_login,
            crate::central_people_logout,
            crate::central_people_list,
            crate::central_people_create_user,
            crate::central_people_disable_user,
            crate::central_people_pair_code,
            crate::central_people_revoke_device
        ])
        .build(context)
        .expect("real Wry application");
    assert_eq!(
        crate::config_root(app.handle()).unwrap(),
        root,
        "real IPC and fixture use the identical normal AppData root"
    );
    let closing = Arc::new(AtomicBool::new(false));
    let exit_allowed = Arc::new(AtomicBool::new(false));
    let (cancel, deadline) = mpsc::channel::<()>();
    let deadline_app = app.handle().clone();
    let watcher = std::thread::spawn(move || {
        if deadline
            .recv_timeout(Duration::from_secs(display_seconds))
            .is_err()
        {
            deadline_app.exit(0);
        }
    });
    let (event_service, event_people) = (Arc::clone(&service), Arc::clone(&people));
    println!(
        "PEOPLE_UI_QA_READY durationSeconds={display_seconds} users=3 devices=2 allDevicesOffline=true"
    );
    let exit_code = app.run_return(move |handle, event| match event {
        tauri::RunEvent::Ready => {
            if let Some(window) = handle.get_webview_window("main") {
                window.show().expect("show QA window");
            }
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && !exit_allowed.load(Ordering::SeqCst) => {
            api.prevent_close();
            close_owned(
                handle,
                &event_service,
                &event_people,
                &closing,
                &exit_allowed,
            );
        }
        tauri::RunEvent::ExitRequested { api, .. } if !exit_allowed.load(Ordering::SeqCst) => {
            api.prevent_exit();
            close_owned(
                handle,
                &event_service,
                &event_people,
                &closing,
                &exit_allowed,
            );
        }
        _ => {}
    });
    let _ = cancel.send(());
    watcher.join().expect("QA deadline watcher");
    assert!(
        service.shutdown(),
        "owned gateway cleanup must be confirmed"
    );
    assert!(service.snapshot().cleanup_verified);
    assert_eq!(exit_code, 0);
    // Unique synthetic profile is intentionally retained for test diagnostics;
    // no recursive deletion or real application data changes occur here.
    println!("PEOPLE_UI_QA_CLOSED cleanupVerified=true syntheticProfileRetained=true");
}
