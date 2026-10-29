// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use super::*;
use iroh::Watcher;

#[path = "../../tests/support/relay.rs"]
mod relay;
use relay::LocalRelay;

async fn pair(client: &Endpoint, server: &Endpoint) -> Result<(Connection, Connection)> {
    timeout(Duration::from_secs(10), async {
        tokio::join!(client.online(), server.online());
        let address = EndpointAddr::new(server.id())
            .with_relay_url(server.addr().relay_urls().next().unwrap().clone());
        let dial = async { Ok::<_, anyhow::Error>(client.connect(address, PROBE_ALPN).await?) };
        let accept = async { Ok::<_, anyhow::Error>(server.accept().await.unwrap().await?) };
        let (outgoing, incoming) = tokio::try_join!(dial, accept)?;
        Ok::<_, anyhow::Error>((outgoing, incoming))
    })
    .await?
}

#[tokio::test]
async fn sustained_echo_completes_over_direct_and_forced_relay() -> Result<()> {
    timeout(Duration::from_secs(40), async {
        for relay_only in [false, true] {
            let relay = LocalRelay::start().await?;
            let client = relay.endpoint(relay_only, true).await?;
            let server = relay.endpoint(relay_only, true).await?;
            let diagnostics = Diagnostics::new();
            let _endpoint_monitor = diagnostics.endpoint(&client);
            let (outgoing, incoming) = pair(&client, &server).await?;
            let _path_monitor = diagnostics.connection(&outgoing);
            let config = ProbeConfig {
                grace: Duration::ZERO,
                observe: Duration::from_secs(2),
                accept: Duration::from_secs(10),
                bytes: 1048593,
            };
            let listener_diagnostics = Diagnostics::new();
            let (sent, echoed) = tokio::try_join!(
                exchange(&outgoing, "dial", &config, &diagnostics),
                exchange(&incoming, "listen", &config, &listener_diagnostics)
            )?;
            assert_eq!(sent["bytes"], echoed["bytesEchoed"]);
            assert_eq!(sent["heartbeats"], echoed["heartbeats"]);
            assert!(sent["heartbeats"].as_u64().unwrap() >= 1);
            assert!(sent["observationElapsedMs"].as_u64().unwrap() >= 2000);
            assert_eq!(
                sent["routeAfter"],
                if relay_only { "Relay" } else { "Direct" }
            );
            assert_eq!(echoed["observationComplete"], true);
            let redacted = diagnostics.snapshot().to_string();
            assert!(!redacted.contains("127.0.0.1"));
            assert!(!redacted.contains(&client.id().to_string()));
            assert!(!redacted.contains(&server.id().to_string()));
            tokio::join!(client.close(), server.close());
            relay.server.shutdown().await?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await?
}

#[tokio::test]
async fn close_without_observation_marker_is_failure() -> Result<()> {
    let relay = LocalRelay::start().await?;
    let client = relay.endpoint(true, true).await?;
    let server = relay.endpoint(true, true).await?;
    let (outgoing, incoming) = pair(&client, &server).await?;
    let config = ProbeConfig {
        grace: Duration::ZERO,
        observe: Duration::from_secs(2),
        accept: Duration::from_secs(10),
        bytes: 1,
    };
    let interrupt = async {
        let (mut send, mut recv) = outgoing.open_bi().await?;
        send.write_all(b"a").await?;
        send.finish()?;
        assert_eq!(recv.read_to_end(1).await?, b"a");
        outgoing.close(0u32.into(), b"incomplete observation");
        Ok::<_, anyhow::Error>(())
    };
    let diagnostics = Diagnostics::new();
    let (sent, served) = timeout(Duration::from_secs(10), async {
        tokio::join!(
            interrupt,
            exchange(&incoming, "listen", &config, &diagnostics)
        )
    })
    .await?;
    sent?;
    assert!(served.is_err());
    assert!(
        !diagnostics
            .snapshot()
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["event"] == "observation_complete")
    );
    tokio::join!(client.close(), server.close());
    relay.server.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn qad_success_is_visible_without_disclosing_addresses() -> Result<()> {
    let relay = LocalRelay::start_with_qad(true).await?;
    let endpoint = relay.endpoint(false, true).await?;
    let diagnostics = Diagnostics::new();
    let _monitor = diagnostics.endpoint(&endpoint);
    timeout(Duration::from_secs(15), async {
        let mut reports = endpoint.net_report();
        loop {
            if reports.get().is_some_and(|report| report.udp_v4) {
                break;
            }
            reports.updated().await.unwrap();
        }
        // Wait for the independent structured monitor to consume the report too.
        loop {
            if diagnostics
                .snapshot()
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["event"] == "net_report" && event["data"]["qadIpv4"] == true)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert!(!diagnostics.snapshot().to_string().contains("127.0.0.1"));
    endpoint.close().await;
    relay.server.shutdown().await?;
    Ok(())
}

/// This runs the actual Node WAN driver and native probes against a loopback
/// relay. Build examples first, then invoke this ignored acceptance explicitly.
#[tokio::test]
#[ignore = "requires cargo build -p peer-transport --examples and Node in PATH"]
async fn native_wan_driver_reports_late_direct_and_forced_relay() -> Result<()> {
    use std::path::PathBuf;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    let directory = root.join(format!("target/peer-transport/driver-{run}"));
    std::fs::create_dir_all(&directory)?;
    let relay = LocalRelay::start_with_qad(true).await?;
    let keys = [iroh::SecretKey::generate(), iroh::SecretKey::generate()];
    let seed_paths = [directory.join("listen.seed"), directory.join("dial.seed")];
    struct Seeds([PathBuf; 2]);
    impl Drop for Seeds {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let _seeds = Seeds(seed_paths.clone());
    let ca = directory.join("ca.pem");
    std::fs::write(&ca, &relay.certificate_pem)?;
    let executable = root.join(if cfg!(windows) {
        "target/debug/examples/peer-probe.exe"
    } else {
        "target/debug/examples/peer-probe"
    });
    ensure!(executable.is_file(), "build peer-probe example first");
    let mut configs = Vec::new();
    for (index, role) in ["listen", "dial"].iter().enumerate() {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&seed_paths[index])?
            .write_all(&keys[index].to_bytes())?;
        let config = serde_json::json!({"executable":executable,"secretFile":seed_paths[index],
            "caFile":ca,"identity":keys[index].public().to_string(),
            "peerIdentity":keys[1-index].public().to_string(),"relayUrl":relay.url,
            "reportFile":directory.join(format!("{role}-report.json")),"scope":"loopback-driver-only",
            "acceptSeconds":20,"sampleBytes":4097,"observeSeconds":2,"directGraceMs":0,
            "interCaseDelayMs":1500,
            "cases":[{"name":"automatic","relayOnly":false,"expectedRoute":"Direct"},
                {"name":"forced-relay","relayOnly":true,"expectedRoute":"Relay"}]});
        let path = directory.join(format!("{role}.json"));
        std::fs::write(&path, serde_json::to_vec(&config)?)?;
        configs.push(path);
    }
    let run_driver = |index: usize, role: &'static str| {
        let mut command = tokio::process::Command::new("node");
        command.kill_on_drop(true);
        command
            .current_dir(&root)
            .arg("tests/smoke/peer-transport-wan-probe.mjs")
            .arg(&configs[index])
            .arg(role);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        async move { command.output().await }
    };
    let (listener, dialer) = timeout(Duration::from_secs(100), async {
        tokio::try_join!(run_driver(0, "listen"), run_driver(1, "dial"))
    })
    .await??;
    ensure!(
        listener.status.success() && dialer.status.success(),
        "native WAN driver failed; inspect ignored local reports"
    );
    for role in ["listen", "dial"] {
        let report: serde_json::Value = serde_json::from_slice(&std::fs::read(
            directory.join(format!("{role}-report.json")),
        )?)?;
        assert_eq!(report["passed"], true);
        assert_eq!(report["results"].as_array().unwrap().len(), 2);
        if role == "dial" {
            assert_eq!(report["results"][0]["directObserved"], true);
            assert_eq!(report["results"][1]["directObserved"], false);
        }
        let redacted = report.to_string();
        assert!(!redacted.contains(&keys[0].public().to_string()));
        assert!(!redacted.contains(&relay.url.to_string()));
    }
    relay.server.shutdown().await?;
    Ok(())
}
