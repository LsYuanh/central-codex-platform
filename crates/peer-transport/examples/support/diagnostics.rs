// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Probe-only diagnostics. Structured events never contain addresses or identities.
use std::{
    fs::OpenOptions,
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::Result;
use futures_util::StreamExt;
use iroh::{
    Endpoint, TransportAddr, Watcher,
    endpoint::{Connection, PathEvent},
};
use peer_transport::selected_route;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

#[derive(Clone)]
pub struct Diagnostics {
    started: Instant,
    events: Arc<Mutex<Vec<Value>>>,
}

impl Diagnostics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            events: Arc::default(),
        }
    }

    pub fn event(&self, name: &str, data: Value) {
        // Serialize under one lock so monotonic timestamps and output order agree.
        let mut events = self.events.lock().unwrap();
        let event =
            json!({"event": name, "atMs": self.started.elapsed().as_millis(), "data": data});
        eprintln!("PEER_DIAGNOSTIC {event}");
        events.push(event);
    }

    pub fn snapshot(&self) -> Value {
        json!(self.events.lock().unwrap().clone())
    }

    pub fn endpoint(&self, endpoint: &Endpoint) -> Monitor {
        let endpoint = endpoint.clone();
        let diagnostics = self.clone();
        Monitor(tokio::spawn(async move {
            let mut addresses = endpoint.watch_addr();
            let mut reports = endpoint.net_report();
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
            let mut previous_metrics = Value::Null;
            loop {
                let addr = addresses.get();
                diagnostics.event(
                    "candidates",
                    json!({
                        "ipv4": addr.ip_addrs().filter(|ip| ip.is_ipv4()).count(),
                        "ipv6": addr.ip_addrs().filter(|ip| ip.is_ipv6()).count(),
                        "relayCount": addr.relay_urls().count()
                    }),
                );
                // A missing report is unknown, not proof of blocked UDP. A single
                // discovery server also cannot reliably classify destination mapping.
                diagnostics.event(
                    "net_report",
                    match reports.get() {
                        Some(report) => json!({"available": true, "qadIpv4": report.udp_v4,
                        "qadIpv6": report.udp_v6, "publicIpv4Candidate": report.global_v4.is_some(),
                        "publicIpv6Candidate": report.global_v6.is_some(),
                        "mappingVariesIpv4": report.mapping_varies_by_dest_ipv4,
                        "mappingVariesIpv6": report.mapping_varies_by_dest_ipv6}),
                        None => json!({"available": false}),
                    },
                );
                loop {
                    tokio::select! {
                        _ = endpoint.closed() => return,
                        next = addresses.updated() => { if next.is_err() { return; } break; },
                        next = reports.updated() => { if next.is_err() { return; } break; },
                        _ = tick.tick() => {
                            let metrics = metrics(&endpoint);
                            if metrics != previous_metrics {
                                diagnostics.event("transport_counters", metrics.clone());
                                previous_metrics = metrics;
                            }
                        }
                    }
                }
            }
        }))
    }

    pub fn connection(&self, connection: &Connection) -> Monitor {
        let mut events = connection.path_events();
        let connection = connection.clone();
        let diagnostics = self.clone();
        diagnostics.path_snapshot(&connection);
        Monitor(tokio::spawn(async move {
            while let Some(event) = events.next().await {
                // Raw library traces remain in the explicitly selected private file.
                let (kind, route, missed) = match event {
                    PathEvent::Opened { remote_addr, .. } => {
                        ("opened", route_type(&remote_addr), 0)
                    }
                    PathEvent::Closed { remote_addr, .. } => {
                        ("closed", route_type(&remote_addr), 0)
                    }
                    PathEvent::Selected { remote_addr, .. } => {
                        ("selected", route_type(&remote_addr), 0)
                    }
                    PathEvent::Lagged { missed, .. } => ("lagged", "Unknown", missed),
                    _ => ("unknown", "Unknown", 0),
                };
                diagnostics.event(
                    "path_event",
                    json!({"kind":kind,"route":route,"missed":missed}),
                );
                diagnostics.path_snapshot(&connection);
            }
        }))
    }

    pub fn path_snapshot(&self, connection: &Connection) {
        let paths = connection.paths();
        self.event(
            "path_snapshot",
            json!({
                "selected": format!("{:?}", selected_route(connection)),
                "directPaths": paths.iter().filter(|path| path.is_ip()).count(),
                "relayPaths": paths.iter().filter(|path| path.is_relay()).count()
            }),
        );
    }
}

fn route_type(address: &TransportAddr) -> &'static str {
    match address {
        TransportAddr::Ip(_) => "Direct",
        TransportAddr::Relay(_) => "Relay",
        _ => "Other",
    }
}

pub fn metrics(endpoint: &Endpoint) -> Value {
    let socket = &endpoint.metrics().socket;
    json!({"holepunchAttempts":socket.holepunch_attempts.get(),
        "directPathsOpened":socket.paths_direct.get(),"relayPathsOpened":socket.paths_relay.get(),
        "connectionsOpened":socket.num_conns_opened.get(),
        "connectionsEverDirect":socket.num_conns_direct.get(),
        "netReports":endpoint.metrics().net_report.reports.get()})
}

// Aborting on every exit path prevents diagnostic tasks from retaining connections.
pub struct Monitor(JoinHandle<()>);
impl Drop for Monitor {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub fn private_trace() -> Result<bool> {
    let Ok(path) = std::env::var("PEER_PROBE_TRACE_FILE") else {
        return Ok(false);
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    // No global RUST_LOG: only fixed transport modules are traced. These raw logs
    // can include network addresses and must never be copied into public evidence.
    tracing_subscriber::fmt()
        .with_env_filter(
            "warn,iroh::net_report=trace,iroh::socket::remote_map=trace,iroh_relay::quic=debug",
        )
        .with_timer(tracing_subscriber::fmt::time::uptime())
        .with_ansi(false)
        .with_writer(Mutex::new(file))
        .try_init()
        .map_err(|error| anyhow::anyhow!("trace initialization failed: {error}"))?;
    Ok(true)
}
