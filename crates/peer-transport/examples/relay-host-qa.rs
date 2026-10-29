// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Explicit operator QA only: reuse the product forwarder without replacing a running App.
//! The private input file contains only a temporary relay admission token and endpoint seed.
use anyhow::{Result, ensure};
use peer_transport::relay::{Access, Host};
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf, time::Duration};
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    access: Access,
    seed: [u8; 32],
    gateway: SocketAddr,
    lifetime_seconds: u64,
}
impl Drop for Config {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}

#[tokio::main]
async fn main() {
    if run().await.is_err() {
        // Never print configuration, certificate data or diagnostic error chains.
        eprintln!("RELAY_HOST_QA_FAILED");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    ensure!(
        std::env::var("YUAN_RELAY_HOST_QA").as_deref() == Ok("1"),
        "opt in required"
    );
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(args.len() == 1, "private config required");
    let path = PathBuf::from(&args[0]);
    let meta = std::fs::symlink_metadata(&path)?;
    ensure!(
        path.is_absolute() && meta.is_file() && !meta.file_type().is_symlink(),
        "regular absolute input required"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(meta.mode() & 0o777 == 0o600, "private config required");
    }
    let bytes = Zeroizing::new(std::fs::read(path)?);
    let config: Config = serde_json::from_slice(&bytes)?;
    ensure!(
        (1..=7200).contains(&config.lifetime_seconds),
        "bounded QA lifetime required"
    );
    let host = Host::start(&config.access, config.seed, config.gateway).await?;
    println!(
        "{}",
        serde_json::json!({"ready":true,"centralId":host.central_id(),"relayOnly":true})
    );
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = tokio::time::sleep(Duration::from_secs(config.lifetime_seconds)) => {},
    }
    drop(host);
    // Allow the product Drop path to deliver QUIC close notifications before runtime exit.
    tokio::time::sleep(Duration::from_secs(1)).await;
    Ok(())
}
