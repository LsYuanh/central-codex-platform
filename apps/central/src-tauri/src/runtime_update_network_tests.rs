// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use super::*;

#[test]
fn proxy_errors_are_classified_without_exposing_configuration() {
    for (input, expected) in [
        ("MODEL_PROXY_CONFIG_INVALID", "UPDATE_PROXY_CONFIG_INVALID"),
        ("MODEL_PROXY_URL_INVALID", "UPDATE_PROXY_CONFIG_INVALID"),
        ("MODEL_PROXY_SYSTEM_UNSUPPORTED", "UPDATE_PROXY_UNSUPPORTED"),
        ("MODEL_PROXY_CONFIG_UNAVAILABLE", "UPDATE_PROXY_UNAVAILABLE"),
        ("MODEL_PROXY_SYSTEM_UNAVAILABLE", "UPDATE_PROXY_UNAVAILABLE"),
    ] {
        assert_eq!(proxy_error(config::failure(input)), expected);
    }
}

#[test]
#[ignore = "requires CENTRAL_SERVICE_QA_NODE; synthetic loopback CONNECT/TLS only"]
fn native_update_downloads_use_proxy_with_tls_redirect_and_bypass_checks() {
    use std::{
        io::BufRead,
        process::{Command, Stdio},
    };
    struct Fixture(std::process::Child);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut fixture = Fixture(
        Command::new(std::env::var_os("CENTRAL_SERVICE_QA_NODE").unwrap())
            .arg(root.join("tests/support/runtime-update-proxy-fixture.mjs"))
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    std::io::BufReader::new(fixture.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let setup: serde_json::Value = serde_json::from_str(&line).unwrap();
    let proxy = model_proxy::ModelProxy {
        https_proxy: Some(setup["proxy"].as_str().unwrap().into()),
        ..Default::default()
    };
    let ca = reqwest::Certificate::from_pem(setup["ca"].as_str().unwrap().as_bytes()).unwrap();
    let network = client_builder(&proxy)
        .unwrap()
        .add_root_certificate(ca.clone())
        .build()
        .unwrap();
    for url in [
        "https://api.github.com/version",
        "https://github.com/manifest",
        "https://github.com/signature",
        "https://github.com/redirect",
    ] {
        assert_eq!(get(&network, url, 1024).unwrap(), b"ok");
    }
    assert_eq!(
        get(&network, "https://github.com/forbidden", 1024),
        Err("UPDATE_DOWNLOAD_FAILED")
    );
    assert_eq!(
        get(&network, "https://github.com/missing", 1024),
        Err("UPDATE_CHANNEL_NOT_PUBLISHED")
    );
    assert_eq!(
        get(&network, "https://github.com/oversize", 32),
        Err("UPDATE_DOWNLOAD_TOO_LARGE")
    );
    assert_eq!(
        get(&network, "https://github.com/truncated", 1024),
        Err("UPDATE_DOWNLOAD_FAILED")
    );
    assert_eq!(
        get(&network, "https://github.com/large", 3 * 1024 * 1024).unwrap(),
        vec![7; 3 * 1024 * 1024]
    );
    assert_eq!(
        get(&network, "http://github.com/plain", 1024),
        Err("UPDATE_NETWORK_UNAVAILABLE")
    );
    assert_eq!(
        download_archive(&network, "https://github.com/ranged", 5 * 1024 * 1024 + 7).unwrap(),
        vec![9; 5 * 1024 * 1024 + 7]
    );
    assert_eq!(
        download_archive(
            &network,
            "https://github.com/ranged-wrong",
            5 * 1024 * 1024 + 7
        ),
        Err("UPDATE_DOWNLOAD_RANGE_INVALID")
    );
    assert_eq!(
        download_archive(&network, "https://github.com/small", 2).unwrap(),
        b"ok"
    );
    let stats: serde_json::Value =
        serde_json::from_slice(&get(&network, "https://github.com/stats", 8192).unwrap()).unwrap();
    let targets = stats["targets"].as_array().unwrap();
    for host in [
        "api.github.com:443",
        "github.com:443",
        "release-assets.githubusercontent.com:443",
    ] {
        assert!(targets.contains(&serde_json::json!(host)));
    }
    assert!(!targets.contains(&serde_json::json!("untrusted.invalid:443")));
    assert!(
        stats["requests"].as_array().unwrap().iter().all(
            |r| r["hasAuthorization"] == false && r["userAgent"] == "Yuan-Zhou-runtime-updates"
        )
    );
    let requests = stats["requests"].as_array().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["path"] == "/ranged" && r["range"] == "bytes=0-4194303")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["path"] == "/ranged" && r["range"] == "bytes=4194304-5242886")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["path"] == "/truncated")
            .count(),
        3
    );
    // A private fixture CA is added only to the test client, never to system trust.
    let untrusted = client_builder(&proxy).unwrap().build().unwrap();
    assert_eq!(
        get(&untrusted, "https://github.com/manifest", 1024),
        Err("UPDATE_NETWORK_UNAVAILABLE")
    );
    let stopped = model_proxy::ModelProxy {
        https_proxy: Some("http://127.0.0.1:1".into()),
        no_proxy: Some("127.0.0.0/8".into()),
        ..Default::default()
    };
    let bypass = client_builder(&stopped)
        .unwrap()
        .add_root_certificate(ca)
        .build()
        .unwrap();
    assert_eq!(
        get(
            &bypass,
            &format!("{}/small", setup["direct"].as_str().unwrap()),
            1024
        )
        .unwrap(),
        b"ok"
    );
    assert_eq!(
        get(&bypass, "https://github.com/manifest", 1024),
        Err("UPDATE_NETWORK_UNAVAILABLE")
    );
}

#[test]
#[ignore = "explicit read-only live network acceptance; downloads but never installs"]
fn live_update_network_download_and_signature_qa() {
    assert_eq!(
        std::env::var("CENTRAL_UPDATE_NETWORK_QA").as_deref(),
        Ok("1")
    );
    let network = client().unwrap();
    let release: serde_json::Value = serde_json::from_slice(
        &get(
            &network,
            "https://api.github.com/repos/openai/codex/releases/latest",
            1024 * 1024,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(release["draft"], false);
    let channel: Channel = serde_json::from_str(CHANNEL).unwrap();
    let envelope = Envelope {
        payload: String::from_utf8(get(&network, &channel.manifest_url, 2 * 1024 * 1024).unwrap())
            .unwrap(),
        signature: String::from_utf8(
            get(&network, &(channel.manifest_url + ".sig"), 4096).unwrap(),
        )
        .unwrap(),
    };
    let descriptor = authenticate(&envelope).unwrap();
    let archive =
        download_archive(&network, &descriptor.archive_url, descriptor.archive_bytes).unwrap();
    assert_eq!(archive.len() as u64, descriptor.archive_bytes);
    assert_eq!(
        format!("{:x}", Sha256::digest(&archive)),
        descriptor.archive_sha256
    );
    println!(
        "UPDATE_NETWORK_QA_OK version={} protocol={} bytes={} signature=true digest=true activation=false",
        descriptor.version,
        descriptor.host_protocol,
        archive.len()
    );
}
