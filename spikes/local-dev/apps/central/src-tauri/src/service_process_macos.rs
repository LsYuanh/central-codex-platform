// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! A separate native guardian owns the gateway process group. Controller EOF
//! still reaches the guardian after an abrupt GUI exit; cleanup is acknowledged
//! only after the complete owned group disappears. Secrets travel over pipes.
use super::*;
use std::{
    io::{Read, Write},
    os::{fd::AsRawFd, unix::process::CommandExt},
    process::{
        Child as Process, ChildStderr, ChildStdin, ChildStdout, Command as Spawn, ExitStatus, Stdio,
    },
    sync::atomic::{AtomicBool, Ordering},
};

const FLAG: &str = "--central-service-guardian";
static FORCED: AtomicBool = AtomicBool::new(false);
extern "C" fn force_signal(_: libc::c_int) {
    FORCED.store(true, Ordering::SeqCst);
}
fn nonblocking(fd: i32) -> Result<(), &'static str> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("SERVICE_PIPE_FAILED");
    }
    Ok(())
}
fn group_exists(group: i32) -> bool {
    unsafe {
        libc::kill(-group, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}
fn kill_group(group: i32) {
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
}
pub fn random_id() -> Result<String, &'static str> {
    let mut bytes = [0u8; 16];
    if unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return Err("SERVICE_RANDOM_FAILED");
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Invoked before Tauri initialization. Arguments contain paths and a timeout,
/// never bootstrap credentials. This mode has no network or renderer endpoint.
pub fn guardian_main_if_requested() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|s| s != FLAG) {
        return;
    }
    let code = guardian(&args).unwrap_or(72);
    std::process::exit(code);
}
fn guardian(args: &[std::ffi::OsString]) -> Result<i32, &'static str> {
    if args.len() != 6 {
        return Err("SERVICE_BOOTSTRAP_INVALID");
    }
    let timeout = args[5]
        .to_str()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|v| *v <= 120_000)
        .ok_or("SERVICE_BOOTSTRAP_INVALID")?;
    unsafe {
        libc::signal(
            libc::SIGUSR1,
            force_signal as *const () as libc::sighandler_t,
        );
    }
    let mut node = Spawn::new(&args[2])
        .arg(&args[3])
        .current_dir(&args[4])
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|_| "SERVICE_SPAWN_FAILED")?;
    let group = node.id() as i32;
    // Every return after spawn must terminate the group, including setup errors.
    struct Group(i32);
    impl Drop for Group {
        fn drop(&mut self) {
            kill_group(self.0);
        }
    }
    let guard = Group(group);
    let mut input = node.stdin.take();
    nonblocking(input.as_ref().ok_or("SERVICE_PIPE_FAILED")?.as_raw_fd())?;
    let (send, receive) = mpsc::sync_channel::<Zeroizing<Vec<u8>>>(4);
    thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            let mut bytes = Zeroizing::new(vec![0u8; 8192]);
            match stdin.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) => bytes.truncate(n),
            }
            if send.send(bytes).is_err() {
                break;
            }
        }
    });
    let mut pending = Zeroizing::new(Vec::new());
    let mut offset = 0;
    let mut deadline = None;
    let mut ended = false;
    let mut status = None;
    loop {
        if pending.is_empty() && !ended {
            match receive.try_recv() {
                Ok(bytes) => {
                    pending = bytes;
                    offset = 0;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    ended = true;
                    input.take();
                    deadline = Some(Instant::now() + Duration::from_millis(timeout));
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if !pending.is_empty() {
            if let Some(pipe) = input.as_mut() {
                match pipe.write(&pending[offset..]) {
                    Ok(0) => {
                        input.take();
                        FORCED.store(true, Ordering::SeqCst);
                    }
                    Ok(n) => {
                        offset += n;
                        if offset == pending.len() {
                            pending = Zeroizing::new(Vec::new());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(_) => {
                        input.take();
                        FORCED.store(true, Ordering::SeqCst);
                    }
                }
            }
        }
        if status.is_none() {
            status = node.try_wait().map_err(|_| "SERVICE_WAIT_FAILED")?;
        }
        if FORCED.load(Ordering::SeqCst)
            || deadline.is_some_and(|d| Instant::now() >= d)
            || status.is_some()
        {
            kill_group(group);
        }
        if status.is_some() && !group_exists(group) {
            std::mem::forget(guard); // Group is empty; never signal a subsequently reused PGID.
            return Ok(if status.unwrap().success() { 0 } else { 71 });
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub struct Child {
    process: Process,
    input: Option<ChildStdin>,
    output: ChildStdout,
    error: ChildStderr,
    pending: Zeroizing<Vec<u8>>,
    offset: usize,
    line: Vec<u8>,
    output_eof: bool,
    error_eof: bool,
    status: Option<ExitStatus>,
    stopped: bool,
    _owner: Option<Box<dyn Send>>,
}
pub fn spawn(mut spec: LaunchSpec, instance: &str) -> Result<Child, &'static str> {
    let exe = std::env::current_exe().map_err(|_| "SERVICE_SPAWN_FAILED")?;
    let mut process = Spawn::new(exe)
        .arg(FLAG)
        .arg(&spec.node)
        .arg(&spec.script)
        .arg(&spec.cwd)
        .arg(spec.stop_timeout.as_millis().to_string())
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "SERVICE_SPAWN_FAILED")?;
    let input = process.stdin.take().ok_or("SERVICE_PIPE_FAILED")?;
    let output = process.stdout.take().ok_or("SERVICE_PIPE_FAILED")?;
    let error = process.stderr.take().ok_or("SERVICE_PIPE_FAILED")?;
    let mut child = Child {
        process,
        input: Some(input),
        output,
        error,
        pending: bootstrap_frame(instance, &spec.bootstrap),
        offset: 0,
        line: Vec::new(),
        output_eof: false,
        error_eof: false,
        status: None,
        stopped: false,
        _owner: spec.owner_guard.take(),
    };
    for fd in [
        child.input.as_ref().unwrap().as_raw_fd(),
        child.output.as_raw_fd(),
        child.error.as_raw_fd(),
    ] {
        if let Err(error) = nonblocking(fd) {
            child.terminate();
            return Err(error);
        }
    }
    Ok(child)
}
impl Child {
    pub fn send_account(&mut self, frame: Zeroizing<Vec<u8>>) -> Result<(), &'static str> {
        if self.stopped || self.offset != self.pending.len() {
            return Err("SERVICE_ACCOUNT_UPDATE_UNAVAILABLE");
        }
        self.pending = frame;
        self.offset = 0;
        Ok(())
    }
    pub fn pid(&self) -> u32 {
        self.process.id()
    }
    pub fn stop_sent(&self) -> bool {
        self.stopped
    }
    pub fn request_stop(&mut self, instance: &str) {
        if !self.stopped {
            // Keep an in-flight bootstrap intact; the stop frame follows it.
            self.pending.extend_from_slice(&stop_frame(instance));
            self.stopped = true;
        }
    }
    pub fn terminate(&mut self) {
        if self.status.is_none() {
            unsafe {
                libc::kill(self.process.id() as i32, libc::SIGUSR1);
            }
        }
    }
    pub fn exited(&self) -> bool {
        self.status.is_some()
    }
    pub fn exit_success(&self) -> bool {
        self.status.is_some_and(|s| s.success())
    }
    pub fn output_drained(&self) -> bool {
        self.output_eof && self.error_eof
    }
    pub fn clean(&self) -> bool {
        self.status
            .is_some_and(|s| s.code().is_some_and(|c| c == 0 || c == 71))
    }
    pub fn poll(&mut self, instance: &str) -> Result<Vec<Event>, &'static str> {
        self.status = self.process.try_wait().map_err(|_| "SERVICE_WAIT_FAILED")?;
        if self.offset < self.pending.len() {
            let pipe = self.input.as_mut().ok_or("SERVICE_PIPE_FAILED")?;
            match pipe.write(&self.pending[self.offset..]) {
                Ok(0) => {
                    self.pending = Zeroizing::new(Vec::new());
                    self.offset = 0;
                    return Err("SERVICE_PIPE_FAILED");
                }
                Ok(n) => {
                    self.offset += n;
                    if self.offset == self.pending.len() {
                        self.pending = Zeroizing::new(Vec::new());
                        self.offset = 0;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => {
                    self.pending = Zeroizing::new(Vec::new());
                    self.offset = 0;
                    return Err("SERVICE_PIPE_FAILED");
                }
            }
        }
        let mut events = Vec::new();
        let mut buffer = [0u8; 8192];
        for _ in 0..16 {
            match self.output.read(&mut buffer) {
                Ok(0) => {
                    self.output_eof = true;
                    break;
                }
                Ok(n) => {
                    for &byte in &buffer[..n] {
                        if byte == b'\n' {
                            if let Some(event) = control_event(&self.line, instance) {
                                events.push(event);
                            }
                            self.line.clear();
                        } else {
                            if self.line.len() >= MAX_LINE {
                                self.line.clear();
                                return Err("SERVICE_OUTPUT_TOO_LARGE");
                            }
                            self.line.push(byte);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return Err("SERVICE_PIPE_FAILED"),
            }
        }
        // Drain but never retain or expose the child's stderr (may contain secrets).
        for _ in 0..16 {
            match self.error.read(&mut buffer) {
                Ok(0) => {
                    self.error_eof = true;
                    break;
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return Err("SERVICE_PIPE_FAILED"),
            }
        }
        buffer.fill(0);
        self.status = self.process.try_wait().map_err(|_| "SERVICE_WAIT_FAILED")?;
        Ok(events)
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        self.input.take();
        self.terminate();
    }
}
