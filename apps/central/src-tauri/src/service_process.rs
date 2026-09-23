// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Native-only owner of the central gateway process tree. This is lifecycle
//! containment, not a filesystem/network sandbox. Never expose LaunchSpec to IPC.

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

pub const PROTOCOL: &str = "central-service-host/v1";
pub(crate) fn random_control_id() -> Result<String, &'static str> {
    native::random_id()
}
const MAX_BOOTSTRAP: usize = 1024 * 1024;
const MAX_LINE: usize = 64 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetrics {
    pub online_devices: u64,
    pub active_turns: u64,
    pub workers: u64,
    pub ready_workers: u64,
    pub starting_workers: u64,
    pub stopping_workers: u64,
    pub sequence: u64,
    /// Native receipt time, never a child-provided clock. Consumers hide samples
    /// older than ten seconds; absence/staleness must not be presented as zero.
    pub observed_at: u64,
}
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetricCounts {
    online_devices: u64,
    active_turns: u64,
    workers: u64,
    ready_workers: u64,
    starting_workers: u64,
    stopping_workers: u64,
}
impl MetricCounts {
    fn valid(&self) -> bool {
        // Workers counts live bridges; starting/stopping may describe a pending
        // factory or cleanup and may overlap. These are not a partition.
        self.online_devices <= 100_000
            && self.active_turns <= 128
            && self.workers <= 128
            && self.ready_workers <= self.workers
            && self.starting_workers <= 128
            && self.stopping_workers <= 128
    }
}

/// Trusted native preparation supplies an explicit environment and already
/// serialized JSON object. No Debug/Serialize: these fields can contain secrets.
pub struct LaunchSpec {
    pub node: PathBuf,
    pub script: PathBuf,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub bootstrap: Zeroizing<Vec<u8>>,
    pub start_timeout: Duration,
    pub stop_timeout: Duration,
    pub force_timeout: Duration,
    /// Keeps pinned package/config/TLS resources alive through verified cleanup.
    pub owner_guard: Option<Box<dyn Send>>,
}

impl Drop for LaunchSpec {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        for (_, value) in &mut self.env {
            value.zeroize();
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub runtime_updates_supported: bool,
    pub account_updates_supported: bool,
    pub state: State,
    pub generation: u64,
    pub sequence: u64,
    pub instance_id: Option<String>,
    pub observed_at: u64,
    pub deadline_at: Option<u64>,
    pub pid: Option<u32>,
    pub cleanup_verified: bool,
    pub forced_stop: bool,
    pub failure_code: Option<&'static str>,
    pub metrics: Option<RuntimeMetrics>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

type Shared = Arc<Mutex<Snapshot>>;
enum Command {
    Start(u64, String, Instant, LaunchSpec),
    Stop(u64),
    Force(u64),
    Account(
        u64,
        String,
        Zeroizing<Vec<u8>>,
        Duration,
        mpsc::Sender<Result<(), &'static str>>,
    ),
    Shutdown,
}

/// Every public operation is a bounded state update/channel send. Only the actor
/// waits for native I/O, process exit, or a Job Object's descendants.
pub struct ServiceProcess {
    state: Shared,
    commands: mpsc::Sender<Command>,
}

impl Default for ServiceProcess {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceProcess {
    pub fn verify_runtime(&self, accept: bool) -> Result<(), &'static str> {
        let state = self.snapshot();
        if state.state != State::Running {
            return Err("SERVICE_UPDATE_NOT_RUNNING");
        }
        let instance = state.instance_id.ok_or("SERVICE_INSTANCE_MISMATCH")?;
        let id = native::random_id()?;
        let command = if accept {
            "update/accept"
        } else {
            "update/verify"
        };
        let frame=Zeroizing::new(format!("{{\"method\":\"central/service\",\"protocol\":\"{PROTOCOL}\",\"instanceId\":\"{instance}\",\"command\":\"{command}\",\"updateId\":\"{id}\"}}\n").into_bytes());
        let (send, receive) = mpsc::channel();
        self.commands
            .send(Command::Account(
                state.generation,
                id,
                frame,
                Duration::from_secs(50),
                send,
            ))
            .map_err(|_| "SERVICE_ACTOR_UNAVAILABLE")?;
        receive
            .recv_timeout(Duration::from_secs(55))
            .map_err(|_| "SERVICE_UPDATE_VERIFY_TIMEOUT")?
    }
    /// Gateway atomically checks activity and closes admission before acknowledging.
    pub fn stop_if_idle(&self) -> Result<(), &'static str> {
        let state = self.snapshot();
        if !state.runtime_updates_supported {
            return Err("SERVICE_UPDATE_UNSUPPORTED");
        }
        if state.state != State::Running {
            return Err("SERVICE_UPDATE_NOT_RUNNING");
        }
        let instance = state.instance_id.ok_or("SERVICE_INSTANCE_MISMATCH")?;
        let id = native::random_id()?;
        let frame = Zeroizing::new(format!("{{\"method\":\"central/service\",\"protocol\":\"{PROTOCOL}\",\"instanceId\":\"{instance}\",\"command\":\"stop/idle\",\"updateId\":\"{id}\"}}\n").into_bytes());
        let (send, receive) = mpsc::channel();
        self.commands
            .send(Command::Account(
                state.generation,
                id,
                frame,
                Duration::from_secs(8),
                send,
            ))
            .map_err(|_| "SERVICE_ACTOR_UNAVAILABLE")?;
        receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "SERVICE_UPDATE_IDLE_TIMEOUT")?
    }
    /// Secret payload goes only to the owned instance, with a bounded acknowledgement.
    pub fn update_account(
        &self,
        instance: &str,
        revision: u64,
        account: &[u8],
    ) -> Result<(), &'static str> {
        let state = self.snapshot();
        if state.state != State::Running || state.instance_id.as_deref() != Some(instance) {
            return Err("SERVICE_INSTANCE_MISMATCH");
        }
        if !state.account_updates_supported {
            return Err("SERVICE_ACCOUNT_UPDATE_UNSUPPORTED");
        }
        let update = native::random_id()?;
        let mut frame=Zeroizing::new(format!("{{\"method\":\"central/service\",\"protocol\":\"{PROTOCOL}\",\"instanceId\":\"{instance}\",\"command\":\"account/update\",\"updateId\":\"{update}\",\"revision\":{revision},\"account\":").into_bytes());
        if account.len() > 64 * 1024 {
            return Err("SERVICE_ACCOUNT_UPDATE_INVALID");
        }
        frame.extend_from_slice(account);
        frame.extend_from_slice(b"}\n");
        let (send, receive) = mpsc::channel();
        self.commands
            .send(Command::Account(
                state.generation,
                update,
                frame,
                Duration::from_secs(8),
                send,
            ))
            .map_err(|_| "SERVICE_ACTOR_UNAVAILABLE")?;
        receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "SERVICE_ACCOUNT_UPDATE_TIMEOUT")?
    }
    pub fn new() -> Self {
        let state = Arc::new(Mutex::new(Snapshot {
            account_updates_supported: false,
            state: State::Stopped,
            generation: 0,
            sequence: 0,
            instance_id: None,
            observed_at: now_ms(),
            deadline_at: None,
            pid: None,
            cleanup_verified: true,
            forced_stop: false,
            failure_code: None,
            metrics: None,
            runtime_updates_supported: false,
        }));
        let (commands, receiver) = mpsc::channel();
        let actor_state = Arc::clone(&state);
        thread::spawn(move || actor(actor_state, receiver));
        Self { state, commands }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn start(&self, spec: LaunchSpec) -> Result<Snapshot, &'static str> {
        validate_spec(&spec)?;
        let instance_id = native::random_id()?;
        let mut state = self.state.lock().map_err(|_| "SERVICE_STATE_FAILED")?;
        if !state.cleanup_verified || !matches!(state.state, State::Stopped | State::Failed) {
            return Err("SERVICE_ALREADY_ACTIVE");
        }
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or("SERVICE_GENERATION_LIMIT")?;
        state.state = State::Starting;
        state.account_updates_supported = false;
        state.runtime_updates_supported = false;
        state.instance_id = Some(instance_id.clone());
        state.cleanup_verified = false;
        state.forced_stop = false;
        state.failure_code = None;
        state.pid = None;
        state.deadline_at = Some(now_ms().saturating_add(spec.start_timeout.as_millis() as u64));
        tick(&mut state);
        let generation = state.generation;
        let deadline = Instant::now() + spec.start_timeout;
        if self
            .commands
            .send(Command::Start(generation, instance_id, deadline, spec))
            .is_err()
        {
            state.state = State::Failed;
            state.failure_code = Some("SERVICE_ACTOR_UNAVAILABLE");
            state.cleanup_verified = true; // Start was never delivered.
            state.deadline_at = None;
            tick(&mut state);
        }
        Ok(state.clone())
    }

    pub fn stop(&self) -> Result<Snapshot, &'static str> {
        let mut state = self.state.lock().map_err(|_| "SERVICE_STATE_FAILED")?;
        if state.cleanup_verified || state.state == State::Stopping {
            return Ok(state.clone());
        }
        self.commands
            .send(Command::Stop(state.generation))
            .map_err(|_| "SERVICE_ACTOR_UNAVAILABLE")?;
        state.state = State::Stopping;
        tick(&mut state);
        Ok(state.clone())
    }

    /// Native exit handling only. A forced stop is never reported as graceful.
    pub fn force_stop(&self) -> Snapshot {
        let snapshot = self.snapshot();
        let _ = self.commands.send(Command::Force(snapshot.generation));
        snapshot
    }
}

impl Drop for ServiceProcess {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        // Do not join on a Tauri/UI thread. On process death the non-inherited,
        // kill-on-close Job handle also enforces descendant termination.
    }
}

fn tick(state: &mut Snapshot) {
    if state.state != State::Running
        || state.cleanup_verified
        || state.forced_stop
        || state.failure_code.is_some()
    {
        state.metrics = None;
    }
    state.sequence = state.sequence.saturating_add(1);
    state.observed_at = now_ms();
}

fn update(state: &Shared, generation: u64, change: impl FnOnce(&mut Snapshot)) {
    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
    if state.generation == generation {
        change(&mut state);
        tick(&mut state);
    }
}

fn validate_spec(spec: &LaunchSpec) -> Result<(), &'static str> {
    if !spec.node.is_absolute()
        || !spec.script.is_absolute()
        || !spec.cwd.is_absolute()
        || [&spec.node, &spec.script, &spec.cwd]
            .iter()
            .any(|p| p.to_string_lossy().contains('\0'))
        || spec.start_timeout < Duration::from_millis(100)
        || spec.start_timeout > Duration::from_secs(120)
        || spec.stop_timeout > Duration::from_secs(120)
        || spec.force_timeout < Duration::from_secs(1)
        || spec.force_timeout > Duration::from_secs(15)
        || spec.bootstrap.is_empty()
        || spec.bootstrap.len() > MAX_BOOTSTRAP
        || spec
            .bootstrap
            .iter()
            .any(|byte| matches!(byte, b'\n' | b'\r'))
        || spec.env.len() > 128
    {
        return Err("SERVICE_SPEC_INVALID");
    }
    let first = spec
        .bootstrap
        .iter()
        .copied()
        .find(|v| !v.is_ascii_whitespace());
    let mut de = serde_json::Deserializer::from_slice(&spec.bootstrap);
    if first != Some(b'{')
        || serde::de::IgnoredAny::deserialize(&mut de).is_err()
        || de.end().is_err()
    {
        return Err("SERVICE_BOOTSTRAP_INVALID");
    }
    let mut keys = std::collections::HashSet::new();
    let mut total = 0usize;
    for (key, value) in &spec.env {
        total = total.saturating_add(key.len() + value.len() + 2);
        if key.is_empty()
            || key.contains(['=', '\0'])
            || value.contains('\0')
            || !keys.insert(key.to_ascii_uppercase())
            || total > 64 * 1024
        {
            return Err("SERVICE_ENV_INVALID");
        }
    }
    Ok(())
}

fn bootstrap_frame(instance_id: &str, config: &[u8]) -> Zeroizing<Vec<u8>> {
    // instance_id is native-generated lowercase hex, never renderer input.
    let prefix = format!(
        "{{\"method\":\"central/service\",\"protocol\":\"{PROTOCOL}\",\"instanceId\":\"{instance_id}\",\"command\":\"bootstrap\",\"config\":"
    );
    // Reserve the complete envelope before copying any secret bytes: realloc
    // would release an old plaintext allocation without Zeroizing seeing it.
    let mut frame = Zeroizing::new(Vec::with_capacity(prefix.len() + config.len() + 2));
    frame.extend_from_slice(prefix.as_bytes());
    frame.extend_from_slice(config);
    frame.extend_from_slice(b"}\n");
    frame
}

fn stop_frame(instance_id: &str) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(format!(
        "{{\"method\":\"central/service\",\"protocol\":\"{PROTOCOL}\",\"instanceId\":\"{instance_id}\",\"command\":\"stop\"}}\n"
    ).into_bytes())
}

#[derive(Debug, PartialEq, Eq)]
enum Event {
    RuntimeUpdatesReady,
    AccountUpdatesReady,
    Ready,
    Stopped,
    Failed,
    AccountUpdated(String),
    IdleStopResult(String, bool),
    RuntimeVerified(String, bool),
    Metrics { sequence: u64, counts: MetricCounts },
}

fn control_event(line: &[u8], instance_id: &str) -> Option<Event> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    if value.get("method")?.as_str()? != "central/service"
        || value.get("protocol")?.as_str()? != PROTOCOL
        || value.get("instanceId")?.as_str()? != instance_id
    {
        return None;
    }
    match value.get("event")?.as_str()? {
        "ready" if value.get("listening").and_then(|v| v.as_bool()) == Some(true) => {
            Some(Event::Ready)
        }
        "stopped" => Some(Event::Stopped),
        // Node's arbitrary failure text/code is deliberately not propagated.
        "failed" => Some(Event::Failed),
        "accountUpdatesReady" => Some(Event::AccountUpdatesReady),
        "runtimeUpdatesReady" => Some(Event::RuntimeUpdatesReady),
        "accountUpdated" => value
            .get("updateId")
            .and_then(|v| v.as_str())
            .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|s| Event::AccountUpdated(s.into())),
        "idleStopResult" => {
            let id = value.get("updateId")?.as_str()?;
            if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(Event::IdleStopResult(
                id.into(),
                value.get("accepted")?.as_bool()?,
            ))
        }
        "runtimeVerified" => {
            let id = value.get("updateId")?.as_str()?;
            if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(Event::RuntimeVerified(
                id.into(),
                value.get("accepted")?.as_bool()?,
            ))
        }
        "metrics" => {
            let sequence = value.get("sequence")?.as_u64()?;
            if sequence == 0 || sequence > MAX_SAFE_INTEGER {
                return None;
            }
            let counts: MetricCounts =
                serde_json::from_value(value.get("metrics")?.clone()).ok()?;
            counts
                .valid()
                .then_some(Event::Metrics { sequence, counts })
        }
        _ => None,
    }
}

fn record_metrics(
    state: &Shared,
    generation: u64,
    instance: &str,
    ready: bool,
    sequence: u64,
    counts: MetricCounts,
) {
    let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
    if !ready
        || state.generation != generation
        || state.instance_id.as_deref() != Some(instance)
        || state.state != State::Running
        || state.cleanup_verified
        || state.forced_stop
        || state.failure_code.is_some()
        || sequence == 0
        || sequence > MAX_SAFE_INTEGER
        || !counts.valid()
        || state
            .metrics
            .as_ref()
            .is_some_and(|previous| sequence <= previous.sequence)
    {
        return;
    }
    state.metrics = Some(RuntimeMetrics {
        online_devices: counts.online_devices,
        active_turns: counts.active_turns,
        workers: counts.workers,
        ready_workers: counts.ready_workers,
        starting_workers: counts.starting_workers,
        stopping_workers: counts.stopping_workers,
        sequence,
        observed_at: now_ms(),
    });
    tick(&mut state);
}

fn actor(state: Shared, commands: mpsc::Receiver<Command>) {
    while let Ok(command) = commands.recv() {
        match command {
            Command::Start(generation, instance, start_deadline, spec) => {
                let stop_timeout = spec.stop_timeout;
                let force_timeout = spec.force_timeout;
                // Cancellation before creation has no process or tree to clean.
                if state.lock().unwrap_or_else(|e| e.into_inner()).state == State::Stopping {
                    update(&state, generation, |s| {
                        s.state = State::Stopped;
                        s.cleanup_verified = true;
                        s.deadline_at = None;
                    });
                    continue;
                }
                match native::spawn(spec, &instance) {
                    Ok(mut child) => {
                        update(&state, generation, |s| s.pid = Some(child.pid()));
                        let shutdown = supervise(
                            &state,
                            &commands,
                            generation,
                            &instance,
                            &mut child,
                            start_deadline,
                            stop_timeout,
                            force_timeout,
                        );
                        if shutdown {
                            return;
                        }
                    }
                    Err(code) => update(&state, generation, |s| {
                        s.state = State::Failed;
                        s.failure_code = Some(code);
                        s.cleanup_verified = true;
                        s.deadline_at = None;
                    }),
                }
            }
            Command::Shutdown => return,
            Command::Stop(_) | Command::Force(_) => {}
            Command::Account(_, _, _, _, reply) => {
                let _ = reply.send(Err("SERVICE_INSTANCE_MISMATCH"));
            }
        }
    }
}

fn supervise(
    state: &Shared,
    commands: &mpsc::Receiver<Command>,
    generation: u64,
    instance: &str,
    child: &mut native::Child,
    start_deadline: Instant,
    stop_timeout: Duration,
    force_timeout: Duration,
) -> bool {
    let mut ready = false;
    let mut ack = false;
    let mut stopping: Option<Instant> = None;
    let mut forcing: Option<Instant> = None;
    let mut failure: Option<&'static str> = None;
    let mut shutdown = false;
    let mut account_update: Option<(String, Instant, mpsc::Sender<Result<(), &'static str>>)> =
        None;
    loop {
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Account(g, id, frame, timeout, reply) => {
                    if g != generation
                        || !ready
                        || stopping.is_some()
                        || forcing.is_some()
                        || account_update.is_some()
                    {
                        let _ = reply.send(Err("SERVICE_ACCOUNT_UPDATE_UNAVAILABLE"));
                    } else if let Err(code) = child.send_account(frame) {
                        let _ = reply.send(Err(code));
                    } else {
                        account_update = Some((id, Instant::now() + timeout, reply));
                    }
                }
                Command::Stop(g) if g == generation => {
                    if stopping.is_none() {
                        stopping = Some(Instant::now() + stop_timeout);
                    }
                }
                Command::Force(g) if g == generation => {
                    failure.get_or_insert("SERVICE_FORCED_STOP");
                    forcing.get_or_insert(Instant::now() + force_timeout);
                }
                Command::Shutdown => {
                    shutdown = true;
                    if stopping.is_none() {
                        stopping = Some(Instant::now() + stop_timeout);
                    }
                }
                _ => {}
            }
        }
        match child.poll(instance) {
            Ok(events) => {
                for event in events {
                    match event {
                        Event::RuntimeUpdatesReady if ready => {
                            update(state, generation, |s| s.runtime_updates_supported = true);
                        }
                        Event::AccountUpdatesReady if ready => {
                            update(state, generation, |s| s.account_updates_supported = true);
                        }
                        Event::RuntimeVerified(id, accepted) => {
                            if account_update
                                .as_ref()
                                .is_some_and(|(expected, _, _)| expected == &id)
                            {
                                if let Some((_, _, reply)) = account_update.take() {
                                    let _ = reply.send(if accepted {
                                        Ok(())
                                    } else {
                                        Err("SERVICE_UPDATE_VERIFY_FAILED")
                                    });
                                }
                            }
                        }
                        Event::IdleStopResult(id, accepted) => {
                            if account_update
                                .as_ref()
                                .is_some_and(|(expected, _, _)| expected == &id)
                            {
                                if accepted {
                                    stopping = Some(Instant::now() + stop_timeout);
                                }
                                if let Some((_, _, reply)) = account_update.take() {
                                    let _ = reply.send(if accepted {
                                        Ok(())
                                    } else {
                                        Err("SERVICE_UPDATE_BUSY")
                                    });
                                }
                            }
                        }
                        Event::AccountUpdated(id) => {
                            if account_update
                                .as_ref()
                                .is_some_and(|(expected, _, _)| expected == &id)
                            {
                                if let Some((_, _, reply)) = account_update.take() {
                                    let _ = reply.send(Ok(()));
                                }
                            }
                        }
                        Event::Ready
                            if !ready
                                && failure.is_none()
                                && stopping.is_none()
                                && forcing.is_none() =>
                        {
                            if Instant::now() >= start_deadline {
                                failure.get_or_insert("SERVICE_START_TIMEOUT");
                                continue;
                            }
                            ready = true;
                            update(state, generation, |s| {
                                if s.state == State::Starting {
                                    s.state = State::Running;
                                    s.deadline_at = None;
                                }
                            });
                        }
                        Event::Stopped if stopping.is_some() => ack = true,
                        Event::Stopped => {
                            failure.get_or_insert("SERVICE_UNEXPECTED_EXIT");
                        }
                        Event::Failed => {
                            failure.get_or_insert("SERVICE_GATEWAY_FAILED");
                        }
                        Event::Metrics { sequence, counts }
                            if ready
                                && failure.is_none()
                                && stopping.is_none()
                                && forcing.is_none() =>
                        {
                            record_metrics(state, generation, instance, ready, sequence, counts);
                        }
                        _ => {}
                    }
                }
            }
            Err(code) => {
                failure.get_or_insert(code);
            }
        }
        if !ready && stopping.is_none() && Instant::now() >= start_deadline {
            failure.get_or_insert("SERVICE_START_TIMEOUT");
        }
        if account_update.as_ref().is_some_and(|(_, deadline, _)| {
            Instant::now() >= *deadline || stopping.is_some() || forcing.is_some()
        }) {
            if let Some((_, _, reply)) = account_update.take() {
                let _ = reply.send(Err("SERVICE_ACCOUNT_UPDATE_TIMEOUT"));
            }
        }
        if failure.is_some() && stopping.is_none() && forcing.is_none() {
            stopping = Some(Instant::now() + stop_timeout);
        }
        if let Some(deadline) = stopping {
            if !child.stop_sent() {
                child.request_stop(instance);
                update(state, generation, |s| {
                    s.state = State::Stopping;
                    s.failure_code = failure;
                    s.deadline_at = Some(
                        now_ms().saturating_add(
                            deadline
                                .saturating_duration_since(Instant::now())
                                .as_millis() as u64,
                        ),
                    );
                });
            }
            if Instant::now() >= deadline && forcing.is_none() {
                failure.get_or_insert("SERVICE_STOP_TIMEOUT");
                forcing = Some(Instant::now() + force_timeout);
            }
        }
        if forcing.is_some() {
            child.terminate();
            update_if_not_forced(state, generation);
        }
        if child.exited() && child.output_drained() {
            // Process exit alone is insufficient: the gateway may have left a
            // host/AppServer descendant alive. Reap the owned tree before reuse.
            if !ack {
                failure.get_or_insert("SERVICE_UNEXPECTED_EXIT");
            }
            if !child.exit_success() {
                failure.get_or_insert("SERVICE_EXIT_FAILED");
            }
            if !child.clean() {
                failure.get_or_insert("SERVICE_DESCENDANTS_REMAINED");
                forcing.get_or_insert(Instant::now() + force_timeout);
                child.terminate();
            } else {
                update(state, generation, |s| {
                    s.state = if failure.is_none() && ack {
                        State::Stopped
                    } else {
                        State::Failed
                    };
                    s.failure_code = failure;
                    s.cleanup_verified = true;
                    s.deadline_at = None;
                    s.pid = None;
                });
                return shutdown;
            }
        }
        if forcing.is_some_and(|deadline| Instant::now() >= deadline) {
            update(state, generation, |s| {
                s.state = State::Failed;
                s.failure_code = Some("SERVICE_CLEANUP_UNCONFIRMED");
                s.deadline_at = None;
                s.cleanup_verified = false;
            });
            // Keep the session and resource guard, rejecting overlapping starts.
            // Continue trying bounded native queries; only verified Job empty
            // can release this generation. No false stopped state on timeout.
            forcing = Some(Instant::now() + force_timeout);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn update_if_not_forced(state: &Shared, generation: u64) {
    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
    if state.generation == generation && !state.forced_stop {
        state.forced_stop = true;
        tick(&mut state);
    }
}

#[cfg(target_os = "macos")]
#[path = "service_process_macos.rs"]
mod native;
#[cfg(target_os = "macos")]
pub use native::guardian_main_if_requested;

#[cfg(not(any(windows, target_os = "macos")))]
mod native {
    use super::*;
    pub fn random_id() -> Result<String, &'static str> {
        Err("SERVICE_PLATFORM_UNSUPPORTED")
    }
    pub fn spawn(_: LaunchSpec, _: &str) -> Result<Child, &'static str> {
        Err("SERVICE_PLATFORM_UNSUPPORTED")
    }
    pub struct Child;
    impl Child {
        pub fn send_account(&mut self, _: Zeroizing<Vec<u8>>) -> Result<(), &'static str> {
            Err("SERVICE_PLATFORM_UNSUPPORTED")
        }
        pub fn pid(&self) -> u32 {
            0
        }
        pub fn poll(&mut self, _: &str) -> Result<Vec<Event>, &'static str> {
            Ok(vec![])
        }
        pub fn stop_sent(&self) -> bool {
            true
        }
        pub fn request_stop(&mut self, _: &str) {}
        pub fn terminate(&mut self) {}
        pub fn exited(&self) -> bool {
            true
        }
        pub fn exit_success(&self) -> bool {
            false
        }
        pub fn output_drained(&self) -> bool {
            true
        }
        pub fn clean(&self) -> bool {
            true
        }
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        fs::File,
        io::{Read, Write},
        mem::{size_of, size_of_val, zeroed},
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{
            ERROR_BROKEN_PIPE, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation,
            WAIT_OBJECT_0,
        },
        Security::{
            Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
            SECURITY_ATTRIBUTES,
        },
        System::{
            IO::CancelSynchronousIo,
            JobObjects::*,
            Pipes::{CreatePipe, PeekNamedPipe},
            Threading::*,
        },
    };

    pub fn random_id() -> Result<String, &'static str> {
        let mut bytes = [0u8; 16];
        if unsafe {
            BCryptGenRandom(
                null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } < 0
        {
            return Err("SERVICE_RANDOM_FAILED");
        }
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn owned(handle: HANDLE) -> Result<OwnedHandle, &'static str> {
        if handle.is_null() || handle == (-1isize) as HANDLE {
            Err("SERVICE_NATIVE_HANDLE_FAILED")
        } else {
            Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
        }
    }

    fn pipe(parent_reads: bool) -> Result<(File, OwnedHandle), &'static str> {
        let mut read = null_mut();
        let mut write = null_mut();
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
            return Err("SERVICE_PIPE_FAILED");
        }
        let read = owned(read)?;
        let write = owned(write)?;
        let (parent, child) = if parent_reads {
            (read, write)
        } else {
            (write, read)
        };
        if unsafe { SetHandleInformation(parent.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err("SERVICE_PIPE_FAILED");
        }
        Ok((File::from(parent), child))
    }

    struct Attributes {
        storage: Vec<usize>,
    }
    impl Attributes {
        fn new() -> Result<Self, &'static str> {
            let mut bytes = 0;
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err("SERVICE_JOB_ATTACH_FAILED");
            }
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            if unsafe {
                InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
            } == 0
            {
                return Err("SERVICE_JOB_ATTACH_FAILED");
            }
            Ok(Self { storage })
        }
        fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            self.storage.as_mut_ptr().cast()
        }
    }
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr());
            }
        }
    }

    pub struct Child {
        process: OwnedHandle,
        job: OwnedHandle,
        pid: u32,
        stdout: File,
        stderr: File,
        line: Zeroizing<Vec<u8>>,
        writer: Option<thread::JoinHandle<()>>,
        input: Option<mpsc::SyncSender<Zeroizing<Vec<u8>>>>,
        writer_failed: mpsc::Receiver<()>,
        stop_sent: bool,
        startup_error: Option<&'static str>,
        force_timeout: Duration,
        owner_guard: Option<Box<dyn Send>>,
    }

    pub fn spawn(mut spec: LaunchSpec, instance: &str) -> Result<Child, &'static str> {
        let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // Deliberately no ACTIVE_PROCESS_LIMIT: gateway owns hosts + AppServers.
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err("SERVICE_JOB_FAILED");
        }
        let (stdin, child_stdin) = pipe(false)?;
        let (stdout, child_stdout) = pipe(true)?;
        let (stderr, child_stderr) = pipe(true)?;
        let mut attributes = Attributes::new()?;
        let handles = [
            child_stdin.as_raw_handle(),
            child_stdout.as_raw_handle(),
            child_stderr.as_raw_handle(),
        ];
        let jobs = [job.as_raw_handle()];
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(&handles),
                null_mut(),
                null(),
            )
        } == 0
            || unsafe {
                UpdateProcThreadAttribute(
                    attributes.ptr(),
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                    jobs.as_ptr().cast(),
                    size_of_val(&jobs),
                    null_mut(),
                    null(),
                )
            } == 0
        {
            return Err("SERVICE_JOB_ATTACH_FAILED");
        }
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.ptr();
        let exe = wide(spec.node.as_os_str());
        let cwd = wide(spec.cwd.as_os_str());
        let mut command = quote(spec.node.as_os_str());
        command.push(b' ' as u16);
        command.extend(quote(spec.script.as_os_str()));
        command.push(0);
        let mut environment = Zeroizing::new(Vec::<u16>::new());
        spec.env.sort_by_key(|(key, _)| key.to_ascii_uppercase());
        for (key, value) in &spec.env {
            environment.extend(key.encode_utf16());
            environment.push(b'=' as u16);
            environment.extend(value.encode_utf16());
            environment.push(0);
        }
        environment.push(0);
        if environment.len() == 1 {
            environment.push(0);
        }
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        if unsafe {
            CreateProcessW(
                exe.as_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW
                    | CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        } == 0
        {
            return Err("SERVICE_SPAWN_FAILED");
        }
        // Creation and Job membership are atomic, including App death before resume.
        // Successful CreateProcessW guarantees both handles. From this point
        // onward retain a Child even if resume/writer setup fails: the actor,
        // not an error return, must verify cleanup of the created process.
        let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
        let initial_thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
        let (input, receiver) = mpsc::sync_channel::<Zeroizing<Vec<u8>>>(1);
        let (failed_sender, writer_failed) = mpsc::channel();
        let frame = bootstrap_frame(instance, &spec.bootstrap);
        let mut child = Child {
            process,
            job,
            pid: info.dwProcessId,
            stdout,
            stderr,
            line: Zeroizing::new(Vec::new()),
            writer: None,
            input: Some(input),
            writer_failed,
            stop_sent: false,
            startup_error: None,
            force_timeout: spec.force_timeout,
            owner_guard: spec.owner_guard.take(),
        };
        // Drop unused child-side handles before relying on pipe EOF.
        drop(child_stdin);
        drop(child_stdout);
        drop(child_stderr);
        if unsafe { ResumeThread(initial_thread.as_raw_handle()) } == u32::MAX {
            child.startup_error = Some("SERVICE_RESUME_FAILED");
        }
        match thread::Builder::new()
            .name("central-service-stdin".into())
            .spawn(move || {
                let mut stdin = stdin;
                if stdin.write_all(&frame).is_err() {
                    let _ = failed_sender.send(());
                    return;
                }
                drop(frame); // wipes the secret envelope immediately after bootstrap.
                while let Ok(frame) = receiver.recv() {
                    if stdin.write_all(&frame).is_err() {
                        let _ = failed_sender.send(());
                        break;
                    }
                }
                // EOF is also a graceful stop request in the gateway controller.
            }) {
            Ok(writer) => child.writer = Some(writer),
            Err(_) => child.startup_error = Some("SERVICE_WRITER_FAILED"),
        }
        Ok(child)
    }

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    pub(super) fn quote(value: &std::ffi::OsStr) -> Vec<u16> {
        let mut result = vec![b'"' as u16];
        let mut slashes = 0;
        for unit in value.encode_wide() {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            result.extend(std::iter::repeat_n(
                b'\\' as u16,
                if unit == b'"' as u16 {
                    slashes * 2 + 1
                } else {
                    slashes
                },
            ));
            slashes = 0;
            result.push(unit);
        }
        result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        result.push(b'"' as u16);
        result
    }

    fn available(file: &File) -> Result<usize, &'static str> {
        let mut count = 0;
        if unsafe {
            PeekNamedPipe(
                file.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                &mut count,
                null_mut(),
            )
        } == 0
        {
            if unsafe { GetLastError() } == ERROR_BROKEN_PIPE {
                return Ok(0);
            }
            return Err("SERVICE_PIPE_FAILED");
        }
        Ok(count as usize)
    }

    impl Child {
        pub fn pid(&self) -> u32 {
            self.pid
        }
        pub fn send_account(&mut self, frame: Zeroizing<Vec<u8>>) -> Result<(), &'static str> {
            if self.stop_sent {
                return Err("SERVICE_ACCOUNT_UPDATE_UNAVAILABLE");
            }
            self.input
                .as_ref()
                .ok_or("SERVICE_PIPE_FAILED")?
                .try_send(frame)
                .map_err(|_| "SERVICE_PIPE_FAILED")
        }
        pub fn stop_sent(&self) -> bool {
            self.stop_sent
        }
        pub fn request_stop(&mut self, instance: &str) {
            self.stop_sent = true;
            if let Some(input) = self.input.take() {
                let _ = input.try_send(stop_frame(instance));
            }
        }
        pub fn terminate(&mut self) {
            self.input.take();
            unsafe {
                TerminateJobObject(self.job.as_raw_handle(), 1);
            }
            if let Some(writer) = &self.writer {
                unsafe {
                    CancelSynchronousIo(writer.as_raw_handle());
                }
            }
        }
        pub fn exited(&self) -> bool {
            unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) == WAIT_OBJECT_0 }
        }
        pub fn exit_success(&self) -> bool {
            let mut exit_code = 1;
            unsafe {
                GetExitCodeProcess(self.process.as_raw_handle(), &mut exit_code) != 0
                    && exit_code == 0
            }
        }
        pub fn output_drained(&self) -> bool {
            available(&self.stdout).map_or(true, |count| count == 0)
        }
        pub fn clean(&self) -> bool {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            unsafe {
                QueryInformationJobObject(
                    self.job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                ) != 0
                    && info.ActiveProcesses == 0
            }
        }
        pub fn poll(&mut self, instance: &str) -> Result<Vec<Event>, &'static str> {
            if let Some(code) = self.startup_error.take() {
                return Err(code);
            }
            let mut events = Vec::new();
            let mut buffer = Zeroizing::new([0u8; 8192]);
            // Fair budgets: a noisy child cannot prevent stop/deadline processing.
            for _ in 0..32 {
                let count = available(&self.stdout)?.min(buffer.len());
                if count == 0 {
                    break;
                }
                let count = self
                    .stdout
                    .read(&mut buffer[..count])
                    .map_err(|_| "SERVICE_PIPE_FAILED")?;
                for byte in &buffer[..count] {
                    if *byte == b'\n' {
                        if let Some(event) = control_event(&self.line, instance) {
                            events.push(event);
                        }
                        use zeroize::Zeroize;
                        self.line.zeroize();
                        self.line.clear();
                    } else {
                        if self.line.len() >= MAX_LINE {
                            return Err("SERVICE_CONTROL_FRAME_LIMIT");
                        }
                        self.line.push(*byte);
                    }
                }
            }
            for _ in 0..32 {
                let count = available(&self.stderr)?.min(buffer.len());
                if count == 0 {
                    break;
                }
                self.stderr
                    .read(&mut buffer[..count])
                    .map_err(|_| "SERVICE_PIPE_FAILED")?;
                // Raw stderr never reaches renderer, state, errors, or logs.
            }
            if self.writer_failed.try_recv().is_ok() && !self.stop_sent {
                return Err("SERVICE_BOOTSTRAP_WRITE_FAILED");
            }
            Ok(events)
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            self.terminate();
            let deadline = Instant::now() + self.force_timeout;
            while (!self.exited() || !self.clean()) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            if !self.exited() || !self.clean() {
                // Do not release pinned resources while an owned process might
                // still use them. The App's eventual death releases this leak.
                if let Some(guard) = self.owner_guard.take() {
                    std::mem::forget(guard);
                }
            }
            if let Some(writer) = self.writer.take() {
                if writer.is_finished() {
                    let _ = writer.join();
                }
                // Detached writer owns all its buffers and handles: no borrowed
                // session memory survives Drop, even on a stuck kernel write.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn counts() -> MetricCounts {
        MetricCounts {
            online_devices: 2,
            active_turns: 1,
            workers: 1,
            ready_workers: 1,
            starting_workers: 1,
            stopping_workers: 1,
        }
    }
    fn metric_frame(
        sequence: serde_json::Value,
        metrics: serde_json::Value,
        instance: &str,
    ) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"method":"central/service","protocol":PROTOCOL,"instanceId":instance,"event":"metrics","sequence":sequence,"metrics":metrics,"listening":true})).unwrap()
    }
    #[test]
    fn metric_frames_reject_bad_numbers_bounds_and_instances_without_becoming_lifecycle_events() {
        let metrics = serde_json::json!({"onlineDevices":2,"activeTurns":1,"workers":0,"readyWorkers":0,"startingWorkers":1,"stoppingWorkers":1});
        assert!(matches!(
            control_event(
                &metric_frame(serde_json::json!(1), metrics.clone(), "current"),
                "current"
            ),
            Some(Event::Metrics { sequence: 1, .. })
        ));
        assert_eq!(
            control_event(
                &metric_frame(serde_json::json!(1), metrics.clone(), "old"),
                "current"
            ),
            None
        );
        for sequence in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!(MAX_SAFE_INTEGER + 1),
        ] {
            assert_eq!(
                control_event(
                    &metric_frame(sequence, metrics.clone(), "current"),
                    "current"
                ),
                None
            );
        }
        for (field, value) in [
            ("onlineDevices", serde_json::json!(-1)),
            ("activeTurns", serde_json::json!(129)),
            ("workers", serde_json::json!(1.5)),
            ("readyWorkers", serde_json::json!(1)),
            ("startingWorkers", serde_json::json!(129)),
            ("stoppingWorkers", serde_json::json!(null)),
        ] {
            let mut invalid = metrics.clone();
            invalid[field] = value;
            assert_eq!(
                control_event(
                    &metric_frame(serde_json::json!(1), invalid, "current"),
                    "current"
                ),
                None
            );
        }
        let mut unknown = metrics;
        unknown["unexpectedSecret"] = serde_json::json!("suppressed");
        assert_eq!(
            control_event(
                &metric_frame(serde_json::json!(1), unknown, "current"),
                "current"
            ),
            None
        );
    }
    #[test]
    fn metrics_require_ready_and_current_generation_and_strictly_increasing_sequence() {
        let service = ServiceProcess::new();
        {
            let mut state = service.state.lock().unwrap();
            state.state = State::Running;
            state.generation = 7;
            state.instance_id = Some("current".into());
            state.cleanup_verified = false;
        }
        record_metrics(&service.state, 7, "current", false, 1, counts());
        assert!(service.snapshot().metrics.is_none());
        record_metrics(&service.state, 7, "current", true, 1, counts());
        let first = service.snapshot();
        let sample = first.metrics.clone().unwrap();
        assert_eq!(sample.sequence, 1);
        assert!(sample.observed_at > 0);
        for (generation, instance, sequence) in [
            (7, "current", 1),
            (7, "current", 0),
            (6, "current", 2),
            (7, "old", 2),
        ] {
            record_metrics(
                &service.state,
                generation,
                instance,
                true,
                sequence,
                counts(),
            );
            assert_eq!(service.snapshot().sequence, first.sequence);
            assert_eq!(service.snapshot().metrics, first.metrics);
        }
        record_metrics(&service.state, 7, "current", true, 2, counts());
        assert_eq!(service.snapshot().metrics.unwrap().sequence, 2);
        update(&service.state, 7, |state| state.state = State::Stopping);
        assert!(service.snapshot().metrics.is_none());
        record_metrics(&service.state, 7, "current", true, 3, counts());
        assert!(service.snapshot().metrics.is_none());
        {
            let mut state = service.state.lock().unwrap();
            state.generation = 8;
            state.state = State::Starting;
            state.instance_id = Some("next".into());
            tick(&mut state);
        }
        record_metrics(&service.state, 7, "current", true, 3, counts());
        assert!(service.snapshot().metrics.is_none());
        update(&service.state, 8, |state| state.state = State::Running);
        record_metrics(&service.state, 8, "next", true, 1, counts());
        assert_eq!(service.snapshot().metrics.unwrap().sequence, 1);
    }
    #[test]
    fn every_nonrunning_or_failed_cleanup_transition_clears_metrics() {
        let service = ServiceProcess::new();
        let mut baseline = service.snapshot();
        baseline.state = State::Running;
        baseline.cleanup_verified = false;
        baseline.metrics = Some(RuntimeMetrics {
            online_devices: 0,
            active_turns: 0,
            workers: 0,
            ready_workers: 0,
            starting_workers: 0,
            stopping_workers: 0,
            sequence: 1,
            observed_at: now_ms(),
        });
        for state in [
            State::Starting,
            State::Stopping,
            State::Stopped,
            State::Failed,
        ] {
            let mut next = baseline.clone();
            next.state = state;
            tick(&mut next);
            assert!(next.metrics.is_none());
        }
        for field in ["cleanup", "failure", "forced"] {
            let mut next = baseline.clone();
            match field {
                "cleanup" => next.cleanup_verified = true,
                "failure" => next.failure_code = Some("SERVICE_GATEWAY_FAILED"),
                _ => next.forced_stop = true,
            };
            tick(&mut next);
            assert!(next.metrics.is_none());
        }
    }

    #[test]
    fn control_requires_protocol_instance_and_actual_listening() {
        let frame = |event: &str, listening: bool, id: &str| {
            serde_json::to_vec(&serde_json::json!({
            "method":"central/service","protocol":PROTOCOL,"instanceId":id,"event":event,"listening":listening
        })).unwrap()
        };
        assert_eq!(
            control_event(&frame("ready", true, "a"), "a"),
            Some(Event::Ready)
        );
        assert_eq!(control_event(&frame("ready", false, "a"), "a"), None);
        assert_eq!(control_event(&frame("stopped", false, "old"), "a"), None);
        assert_eq!(
            control_event(br#"{"event":"ready","listening":true}"#, "a"),
            None
        );
        assert_eq!(control_event(b"secret-bearing stderr-like text", "a"), None);
    }

    #[test]
    fn bootstrap_is_one_json_frame_and_stop_has_no_secret() {
        let frame = bootstrap_frame(
            "0123456789abcdef0123456789abcdef",
            br#"{"synthetic":"value"}"#,
        );
        let value: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["config"]["synthetic"], "value");
        assert_eq!(value["command"], "bootstrap");
        let stop: serde_json::Value = serde_json::from_slice(&stop_frame("a")).unwrap();
        assert!(stop.get("config").is_none());
    }

    #[test]
    fn stale_actor_update_cannot_change_new_generation() {
        let service = ServiceProcess::new();
        let state = service.snapshot();
        update(&service.state, state.generation + 1, |s| {
            s.state = State::Running
        });
        assert_eq!(service.snapshot().state, State::Stopped);
        assert_eq!(service.snapshot().sequence, state.sequence);
    }

    #[cfg(windows)]
    #[test]
    fn windows_argument_quoting_preserves_trailing_slashes_and_quotes() {
        use std::ffi::OsStr;
        let quote = |s: &str| String::from_utf16(&native::quote(OsStr::new(s))).unwrap();
        assert_eq!(quote("C:\\a b\\"), "\"C:\\a b\\\\\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }

    /// Synthetic child only: no gateway, TLS key, account, port or user data.
    /// Root explicitly supplies a trusted Node executable for this opt-in test.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires CENTRAL_SERVICE_QA_NODE and permission to create owned child processes"]
    fn native_lifecycle_qa() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let node = PathBuf::from(
            std::env::var_os("CENTRAL_SERVICE_QA_NODE").expect("explicit QA Node path"),
        );
        assert!(node.is_absolute() && node.is_file());
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("service-process-synthetic.cjs");
        std::fs::write(&script, r#"
const readline = require('node:readline');
const {spawn} = require('node:child_process');
let bootstrap;
let descendant;
const emit = (event,done) => process.stdout.write(JSON.stringify({method:'central/service',protocol:'central-service-host/v1',instanceId:bootstrap.instanceId,event,listening:true})+'\n',done);
const metric = (sequence,onlineDevices,instanceId=bootstrap.instanceId) => process.stdout.write(JSON.stringify({method:'central/service',protocol:'central-service-host/v1',instanceId,event:'metrics',sequence,metrics:{onlineDevices,activeTurns:1,workers:1,readyWorkers:1,startingWorkers:1,stoppingWorkers:1}})+'\n');
const keepAlive = setInterval(()=>{},1000);
readline.createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  if(message.command==='bootstrap') {
    bootstrap=message;
    process.stderr.write('SYNTHETIC_SECRET_MUST_NOT_ESCAPE\n');
    process.stdout.write('SYNTHETIC_SECRET_MUST_NOT_ESCAPE\n');
    metric(99,99); // Before ready: must not advance the accepted metrics sequence.
    if(message.config.mode==='never-ready') return;
    if(message.config.mode==='crash') { process.exit(9); return; }
    if(message.config.mode==='ignore-stop') descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    emit('ready');
    emit('accountUpdatesReady');
    emit('runtimeUpdatesReady');
    metric(1,2); metric(1,99); metric(2,3); metric(3,99,'stale-instance');
  } else if(message.command==='account/update') {
    process.stdout.write(JSON.stringify({method:'central/service',protocol:'central-service-host/v1',instanceId:bootstrap.instanceId,event:'accountUpdated',updateId:message.updateId})+'\n');
  } else if(['stop/idle','update/verify','update/accept'].includes(message.command)) {
    const result={method:'central/service',protocol:'central-service-host/v1',instanceId:bootstrap.instanceId,event:message.command==='stop/idle'?'idleStopResult':'runtimeVerified',updateId:message.updateId,accepted:bootstrap.config.mode==='normal'};
    process.stdout.write(JSON.stringify({...result,updateId:'0'.repeat(32),accepted:!result.accepted})+'\n');
    process.stdout.write(JSON.stringify({...result,instanceId:'stale-instance',accepted:!result.accepted})+'\n');
    process.stdout.write(JSON.stringify(result)+'\n');
  } else if(message.command==='stop' && bootstrap.config.mode==='normal') {
    clearInterval(keepAlive); emit('stopped',()=>process.exit(0));
  }
});
"#).unwrap();
        struct Guard(Arc<AtomicUsize>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let releases = Arc::new(AtomicUsize::new(0));
        let spec = |mode: &str| LaunchSpec {
            node: node.clone(),
            script: script.clone(),
            cwd: directory.path().to_path_buf(),
            env: ["SystemRoot", "WINDIR", "TEMP", "TMP"]
                .iter()
                .filter_map(|key| {
                    std::env::var(key)
                        .ok()
                        .map(|value| ((*key).to_string(), value))
                })
                .collect(),
            bootstrap: Zeroizing::new(
                serde_json::to_vec(&serde_json::json!({"mode":mode})).unwrap(),
            ),
            start_timeout: Duration::from_secs(3),
            stop_timeout: Duration::from_millis(300),
            force_timeout: Duration::from_secs(5),
            owner_guard: Some(Box::new(Guard(Arc::clone(&releases)))),
        };
        let service = ServiceProcess::new();
        let wait = |predicate: &dyn Fn(&Snapshot) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(12);
            loop {
                let snapshot = service.snapshot();
                assert!(
                    !serde_json::to_string(&snapshot)
                        .unwrap()
                        .contains("SYNTHETIC_SECRET")
                );
                if predicate(&snapshot) {
                    break snapshot;
                }
                assert!(
                    Instant::now() < deadline,
                    "native lifecycle did not reach its bounded terminal state: {snapshot:?}"
                );
                thread::sleep(Duration::from_millis(20));
            }
        };
        let first = service.start(spec("normal")).unwrap();
        let running = wait(&|s| {
            s.state == State::Running && s.metrics.as_ref().is_some_and(|m| m.sequence == 2)
        });
        assert_eq!(running.metrics.as_ref().unwrap().online_devices, 3);
        assert!(running.account_updates_supported);
        assert!(running.runtime_updates_supported);
        service.verify_runtime(false).unwrap();
        service.verify_runtime(true).unwrap();
        service
            .update_account(
                running.instance_id.as_deref().unwrap(),
                1,
                br#"{"tokens":{"access_token":"SYNTHETIC_UPDATED","account_id":"fixture"}}"#,
            )
            .unwrap();
        assert_eq!(service.snapshot().pid, running.pid);
        assert!(service.update_account("stale-instance", 2, b"{}").is_err());
        assert_eq!(
            service.start(spec("normal")).unwrap_err(),
            "SERVICE_ALREADY_ACTIVE"
        );
        service.stop_if_idle().unwrap();
        let stopped = wait(&|s| s.cleanup_verified);
        assert_eq!(stopped.state, State::Stopped);
        assert!(!stopped.forced_stop);
        assert!(stopped.metrics.is_none());
        let next = service.start(spec("ignore-stop")).unwrap();
        assert!(next.generation > first.generation);
        assert_ne!(next.instance_id, first.instance_id);
        wait(&|s| s.state == State::Running);
        assert_eq!(service.stop_if_idle(), Err("SERVICE_UPDATE_BUSY"));
        assert_eq!(service.snapshot().state, State::Running);
        assert!(service.verify_runtime(false).is_err());
        service.stop().unwrap();
        let forced = wait(&|s| s.cleanup_verified);
        assert_eq!(forced.state, State::Failed);
        assert!(forced.forced_stop);
        assert_eq!(forced.failure_code, Some("SERVICE_STOP_TIMEOUT"));
        service.start(spec("never-ready")).unwrap();
        let timeout = wait(&|s| s.cleanup_verified);
        assert_eq!(timeout.state, State::Failed);
        assert_eq!(timeout.failure_code, Some("SERVICE_START_TIMEOUT"));
        service.start(spec("crash")).unwrap();
        let crash = wait(&|s| s.cleanup_verified);
        assert_eq!(crash.state, State::Failed);
        assert_eq!(crash.failure_code, Some("SERVICE_UNEXPECTED_EXIT"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while releases.load(Ordering::SeqCst) != 5 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(releases.load(Ordering::SeqCst), 5); // four sessions + rejected overlap.
    }
}
