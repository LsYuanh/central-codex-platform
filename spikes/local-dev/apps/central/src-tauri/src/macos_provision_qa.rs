// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Explicit native provisioning for the authorized formal-service migration.
//! Test binary only. Does not bind a port, rotate credentials, or replace profiles.
use crate::{config, model_accounts, tls};
use std::{fs, path::PathBuf};
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
    let certificate =
        tls::import_directory(&root, &tls_dir, "wss://192.0.2.10:4510/ws").unwrap();
    let account = model_accounts::import_existing(&root).unwrap();
    let data = root.join("central-data");
    let _saved=config::save(&root,"macos-formal-first-config".into(),0,serde_json::json!({
        "schemaVersion":1,"revision":0,"dataDirectory":data,"listen":{"host":"0.0.0.0","port":4510},
        "clientUrl":"wss://192.0.2.10:4510/ws","tls":{"certificateId":certificate.certificate_id},"runtimePackageId":package,
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
