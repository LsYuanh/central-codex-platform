// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Explicit native provisioning for the authorized formal-service migration.
//! Test binary only. Does not bind a port, rotate credentials, or replace profiles.
use crate::{config, model_accounts, tls};
use std::{fs, path::PathBuf};

/// Explicit release operation: preserve all settings and receipts, changing only
/// the pinned package after the running service has relinquished its data lock.
#[test]
#[ignore = "requires an authorized stopped formal service and verified release resources"]
fn switch_formal_macos_runtime() {
    assert_eq!(
        std::env::var("CENTRAL_MACOS_RELEASE_OPT_IN").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var_os("CENTRAL_MACOS_APP_DATA").unwrap());
    let resources = PathBuf::from(std::env::var_os("CENTRAL_MACOS_RESOURCES").unwrap());
    assert!(root.is_absolute() && resources.is_absolute());
    assert_eq!(root.file_name().unwrap(), "com.yuanzhou.central");
    if std::env::var("CENTRAL_MACOS_RELEASE_PREFLIGHT").as_deref() == Ok("1") {
        // Check the same read-only proxy resolver used at startup before the
        // operator stops a healthy service for a package switch.
        crate::model_proxy::resolve().expect("supported current model proxy settings");
        let package = std::env::var("CENTRAL_MACOS_PACKAGE_ID").unwrap();
        let _verified = crate::runtime_package::prepare_service(&resources, &package)
            .expect("verified pinned service package");
        println!("FORMAL_RUNTIME_PREFLIGHT_OK package={package}");
        return;
    }
    let previous = std::env::var("CENTRAL_MACOS_PREVIOUS_PACKAGE_ID").unwrap();
    let package = std::env::var("CENTRAL_MACOS_PACKAGE_ID").unwrap();
    let revision: u64 = std::env::var("CENTRAL_MACOS_EXPECTED_REVISION")
        .unwrap()
        .parse()
        .unwrap();
    let mut saved = config::read(&root)
        .unwrap()
        .config
        .expect("existing formal configuration");
    assert_eq!(saved.revision, revision);
    assert_eq!(saved.runtime_package_id, previous);
    let _data_lock = platform_security::central_secret_store::lock_runtime_root(
        std::path::Path::new(&saved.data_directory),
    )
    .unwrap();
    let verified = crate::runtime_package::prepare_service(&resources, &package)
        .expect("verified pinned service package");
    let shared = if std::env::var("CENTRAL_MACOS_LINK_EXISTING_LOGIN").as_deref() == Ok("1") {
        let previous_id = std::env::var("CENTRAL_MACOS_PREVIOUS_ACCOUNT_ID").unwrap();
        let previous_account = model_accounts::load_internal(&root, &previous_id).unwrap();
        let linked = model_accounts::shared::link_existing(&root).unwrap();
        let current = model_accounts::load_internal(&root, &linked.account_id).unwrap();
        assert!(
            previous_account.account_id() == current.account_id(),
            "source account changed"
        );
        model_accounts::shared::renew(
            &root,
            &linked.account_id,
            &verified,
            &std::sync::atomic::AtomicBool::new(false),
            true,
        )
        .unwrap();
        Some(linked)
    } else {
        None
    };
    saved.runtime_package_id = package;
    config::save(
        &root,
        format!("macos-release-{revision}"),
        revision,
        serde_json::to_value(saved).unwrap(),
    )
    .unwrap();
    let result = config::read(&root).unwrap().config.unwrap();
    if let Some(account) = shared {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let destination = PathBuf::from(std::env::var_os("CENTRAL_MACOS_RELEASE_REPORT").unwrap());
        assert!(destination.is_absolute());
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(destination)
            .unwrap();
        let report = serde_json::json!({"accountId": account.account_id,
            "credentialSource": account.credential_source, "revision": result.revision,
            "packageId": result.runtime_package_id});
        file.write_all(serde_json::to_vec_pretty(&report).unwrap().as_slice())
            .unwrap();
        file.sync_all().unwrap();
    }
    println!(
        "FORMAL_RUNTIME_SWITCH_OK revision={} package={}",
        result.revision, result.runtime_package_id
    );
}

#[test]
#[ignore = "explicit Mac deployment profile, TLS directory and package ID required"]
fn prepare_formal_macos_profile() {
    assert_eq!(
        std::env::var("CENTRAL_MACOS_PROVISION_OPT_IN").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(std::env::var_os("CENTRAL_MACOS_APP_DATA").unwrap());
    let tls_dir = PathBuf::from(std::env::var_os("CENTRAL_MACOS_TLS_DIRECTORY").unwrap());
    let package = std::env::var("CENTRAL_MACOS_PACKAGE_ID").unwrap();
    assert!(root.is_absolute() && tls_dir.is_absolute());
    assert_eq!(root.file_name().unwrap(), "com.yuanzhou.central");
    assert!(
        config::read(&root).unwrap().config.is_none(),
        "existing configuration must be managed through UI"
    );
    let gateway =
        std::env::var("CENTRAL_FORMAL_GATEWAY").expect("explicit formal gateway required");
    let certificate = tls::import_directory(&root, &tls_dir, &gateway).unwrap();
    let account = model_accounts::import_existing(&root).unwrap();
    let data = root.join("central-data");
    let _saved=config::save(&root,"macos-formal-first-config".into(),0,serde_json::json!({
        "schemaVersion":1,"revision":0,"dataDirectory":data,"listen":{"host":"0.0.0.0","port":4510},
        "clientUrl":gateway,"tls":{"certificateId":certificate.certificate_id},"runtimePackageId":package,
        "limits":{"maxWorkers":8,"perUserTurns":2,"totalTurns":8},"shutdown":{"graceMs":20000,"forceMs":5000}
    })).unwrap();
    let _data_lock = platform_security::central_secret_store::lock_runtime_root(&data).unwrap();
    let report = serde_json::json!({"accountId":account.account_id,"certificateId":certificate.certificate_id,"revision":1,"dataDirectory":data});
    let destination = tls_dir.join("native-profile-report.json");
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)
        .unwrap();
    file.write_all(serde_json::to_string_pretty(&report).unwrap().as_bytes())
        .unwrap();
    file.sync_all().unwrap();
}
