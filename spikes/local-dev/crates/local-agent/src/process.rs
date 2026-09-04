// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::watch,
    task::JoinHandle,
    time,
};

use crate::command_output;

const FINAL_OUTPUT_BYTES: usize = 64 * 1024;
const STREAM_OUTPUT_BYTES: usize = 1024 * 1024;
const EVENT_CHUNK_BYTES: usize = 16 * 1024;
const PARTIAL_FLUSH_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug)]
pub struct StreamEvent {
    pub stream: &'static str,
    pub sequence: u64,
    pub chunk: String,
    pub done: bool,
    pub truncated: bool,
}

pub type EventSink = Arc<dyn Fn(StreamEvent) + Send + Sync>;

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    source_truncated: bool,
}

#[derive(Clone, Copy)]
enum Encoding {
    Unknown,
    Text,
    Utf16Le,
    Utf16Be,
}

struct StreamEmitter {
    name: &'static str,
    encoding: Encoding,
    buffer: Vec<u8>,
    emitted_bytes: usize,
    reported_truncation: bool,
    sequence: Arc<Mutex<u64>>,
    sink: EventSink,
}

impl StreamEmitter {
    fn new(name: &'static str, sequence: Arc<Mutex<u64>>, sink: EventSink) -> Self {
        Self {
            name,
            encoding: Encoding::Unknown,
            buffer: Vec::new(),
            emitted_bytes: 0,
            reported_truncation: false,
            sequence,
            sink,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
        self.detect_encoding(false);
        self.flush_complete_lines();
        while self.buffer.len() >= EVENT_CHUNK_BYTES {
            if !self.flush_prefix(EVENT_CHUNK_BYTES, false) {
                break;
            }
        }
    }

    fn flush_partial(&mut self) {
        self.detect_encoding(false);
        if !self.buffer.is_empty() {
            self.flush_prefix(self.buffer.len().min(EVENT_CHUNK_BYTES), false);
        }
    }

    fn finish(mut self) {
        self.detect_encoding(true);
        while !self.buffer.is_empty()
            && self.flush_prefix(self.buffer.len().min(EVENT_CHUNK_BYTES), true)
        {}
        self.send(String::new(), true, self.reported_truncation);
    }

    fn detect_encoding(&mut self, final_chunk: bool) {
        if !matches!(self.encoding, Encoding::Unknown) {
            return;
        }
        if self.buffer.starts_with(&[0xff, 0xfe]) {
            self.encoding = Encoding::Utf16Le;
        } else if self.buffer.starts_with(&[0xfe, 0xff]) {
            self.encoding = Encoding::Utf16Be;
        } else if self
            .buffer
            .first()
            .is_some_and(|byte| !matches!(byte, 0xff | 0xfe))
            || self.buffer.len() >= 3
            || self.buffer.contains(&b'\n')
            || final_chunk
        {
            self.encoding = Encoding::Text;
        }
    }

    fn flush_complete_lines(&mut self) {
        loop {
            let end = match self.encoding {
                Encoding::Unknown => return,
                Encoding::Utf16Le => find_pair(&self.buffer, [0x0a, 0x00]),
                Encoding::Utf16Be => find_pair(&self.buffer, [0x00, 0x0a]),
                Encoding::Text => self
                    .buffer
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map(|i| i + 1),
            };
            let Some(end) = end else { return };
            if !self.flush_prefix(end, true) {
                return;
            }
        }
    }

    fn flush_prefix(&mut self, requested: usize, final_chunk: bool) -> bool {
        if requested == 0 || self.buffer.is_empty() || matches!(self.encoding, Encoding::Unknown) {
            return false;
        }
        let mut length = requested.min(self.buffer.len());
        match self.encoding {
            Encoding::Utf16Le | Encoding::Utf16Be => {
                length -= length % 2;
                let bom = usize::from(
                    self.buffer.starts_with(&[0xff, 0xfe])
                        || self.buffer.starts_with(&[0xfe, 0xff]),
                ) * 2;
                if length > bom + 1 {
                    let pair = [self.buffer[length - 2], self.buffer[length - 1]];
                    let unit = if matches!(self.encoding, Encoding::Utf16Le) {
                        u16::from_le_bytes(pair)
                    } else {
                        u16::from_be_bytes(pair)
                    };
                    if !final_chunk && (0xd800..=0xdbff).contains(&unit) {
                        length -= 2;
                    }
                }
            }
            Encoding::Text if !final_chunk => {
                length = command_output::complete_stream_prefix_len(&self.buffer[..length]);
            }
            _ => {}
        }
        if length == 0 {
            return false;
        }
        let fragment: Vec<u8> = self.buffer.drain(..length).collect();
        let text = match self.encoding {
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let mut with_bom = Vec::with_capacity(fragment.len() + 2);
                if !fragment.starts_with(&[0xff, 0xfe]) && !fragment.starts_with(&[0xfe, 0xff]) {
                    with_bom.extend(if matches!(self.encoding, Encoding::Utf16Le) {
                        [0xff, 0xfe]
                    } else {
                        [0xfe, 0xff]
                    });
                }
                with_bom.extend(fragment);
                command_output::decode(&with_bom, usize::MAX).text
            }
            _ => command_output::decode(&fragment, usize::MAX).text,
        };
        self.emit_bounded(text);
        true
    }

    fn emit_bounded(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        let remaining = STREAM_OUTPUT_BYTES.saturating_sub(self.emitted_bytes);
        if remaining == 0 {
            self.report_truncation();
            return;
        }
        let mut end = text.len().min(remaining);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let visible = &text[..end];
        let mut offset = 0;
        while offset < visible.len() {
            let mut next = (offset + EVENT_CHUNK_BYTES).min(visible.len());
            while !visible.is_char_boundary(next) {
                next -= 1;
            }
            self.send(visible[offset..next].to_owned(), false, false);
            offset = next;
        }
        self.emitted_bytes += visible.len();
        if end < text.len() {
            self.report_truncation();
        }
    }

    fn report_truncation(&mut self) {
        if self.reported_truncation {
            return;
        }
        self.reported_truncation = true;
        self.send(String::new(), false, true);
    }

    fn send(&self, chunk: String, done: bool, truncated: bool) {
        let mut sequence = self.sequence.lock().unwrap();
        *sequence += 1;
        (self.sink)(StreamEvent {
            stream: self.name,
            sequence: *sequence,
            chunk,
            done,
            truncated,
        });
    }
}

fn find_pair(bytes: &[u8], pair: [u8; 2]) -> Option<usize> {
    (0..bytes.len().saturating_sub(1))
        .step_by(2)
        .find(|index| bytes[*index..*index + 2] == pair)
        .map(|index| index + 2)
}

async fn capture_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    name: &'static str,
    sequence: Arc<Mutex<u64>>,
    sink: EventSink,
) -> Capture {
    let mut capture = Capture::default();
    let mut emitter = StreamEmitter::new(name, sequence, sink);
    let mut input = [0u8; 8192];
    let mut flush = time::interval(PARTIAL_FLUSH_INTERVAL);
    flush.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            read = reader.read(&mut input) => match read {
                Ok(0) => break,
                Ok(count) => {
                    let room = FINAL_OUTPUT_BYTES.saturating_sub(capture.bytes.len());
                    capture.bytes.extend_from_slice(&input[..count.min(room)]);
                    if count > room { capture.source_truncated = true; }
                    emitter.push(&input[..count]);
                }
                Err(_) => break,
            },
            _ = flush.tick() => emitter.flush_partial(),
        }
    }
    emitter.finish();
    capture
}

pub async fn run_command(
    mut command: Command,
    program: &str,
    args: &[String],
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
    sink: EventSink,
) -> Result<Value, String> {
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or("failed to capture command stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("failed to capture command stderr")?;
    let event_sequence = Arc::new(Mutex::new(0));
    let mut stdout_task = tokio::spawn(capture_stream(
        stdout,
        "stdout",
        event_sequence.clone(),
        sink.clone(),
    ));
    let mut stderr_task = tokio::spawn(capture_stream(stderr, "stderr", event_sequence, sink));

    enum End {
        Exited(std::process::ExitStatus),
        Cancelled,
        TimedOut,
        Failed(String),
    }
    let end = tokio::select! {
        status = child.wait() => match status { Ok(status) => End::Exited(status), Err(error) => End::Failed(error.to_string()) },
        changed = cancel.changed() => if changed.is_ok() && *cancel.borrow() { End::Cancelled } else { End::Failed("command cancellation channel closed".into()) },
        _ = time::sleep(timeout) => End::TimedOut,
    };
    if !matches!(end, End::Exited(_)) {
        terminate_process_tree(pid, &mut child).await;
        let _ = child.wait().await;
    }

    let stdout = finish_capture(&mut stdout_task).await;
    let stderr = finish_capture(&mut stderr_task).await;
    let stdout_text = command_output::decode(&stdout.bytes, FINAL_OUTPUT_BYTES);
    let stderr_text = command_output::decode(&stderr.bytes, FINAL_OUTPUT_BYTES);
    let truncated = stdout.source_truncated
        || stderr.source_truncated
        || stdout_text.truncated
        || stderr_text.truncated;

    match end {
        End::Exited(status) if status.success() => Ok(json!({
            "program": program,
            "args": args,
            "exitCode": status.code(),
            "stdout": stdout_text.text,
            "stderr": stderr_text.text,
            "truncated": truncated
        })),
        End::Exited(status) => Err(format!(
            "COMMAND_FAILED (exit {:?}): {}{}",
            status.code(),
            stderr_text.text,
            stdout_text.text
        )),
        End::Cancelled => Err("COMMAND_CANCELLED: 用户已中断本机命令".into()),
        End::TimedOut => Err(format!(
            "COMMAND_TIMEOUT: 本机命令超过 {} 秒",
            timeout.as_secs()
        )),
        End::Failed(error) => Err(error),
    }
}

async fn finish_capture(handle: &mut JoinHandle<Capture>) -> Capture {
    match time::timeout(Duration::from_secs(2), &mut *handle).await {
        Ok(Ok(capture)) => capture,
        _ => {
            handle.abort();
            Capture {
                source_truncated: true,
                ..Capture::default()
            }
        }
    }
}

async fn terminate_process_tree(pid: Option<u32>, child: &mut Child) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        let _ = time::timeout(
            Duration::from_secs(3),
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status(),
        )
        .await;
    }
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
        time::sleep(Duration::from_millis(500)).await;
        if child.try_wait().ok().flatten().is_none() {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
    }
    let _ = child.start_kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn streams_lines_before_process_exit() {
        let events = Arc::new(Mutex::new(Vec::<StreamEvent>::new()));
        let received = events.clone();
        let sink: EventSink = Arc::new(move |event| received.lock().unwrap().push(event));
        let command = if cfg!(windows) {
            let mut command = Command::new("powershell");
            command.args([
                "-NoProfile",
                "-Command",
                "Write-Output first; Start-Sleep -Milliseconds 100; Write-Output second",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "printf 'first\\n'; sleep 0.1; printf 'second\\n'"]);
            command
        };
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let result = run_command(
            command,
            "test",
            &[],
            Duration::from_secs(5),
            cancel_rx,
            sink,
        )
        .await
        .unwrap();
        assert_eq!(result["exitCode"], 0);
        let output = events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.chunk.as_str())
            .collect::<String>();
        assert!(output.contains("first"));
        assert!(output.contains("second"));
    }

    #[tokio::test]
    async fn flushes_partial_output_and_cancels_the_process() {
        let events = Arc::new(Mutex::new(Vec::<StreamEvent>::new()));
        let received = events.clone();
        let sink: EventSink = Arc::new(move |event| received.lock().unwrap().push(event));
        let command = if cfg!(windows) {
            let mut command = Command::new("powershell");
            command.args([
                "-NoProfile",
                "-Command",
                "[Console]::Out.Write('partial'); [Console]::Out.Flush(); Start-Sleep -Seconds 30",
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "printf partial; sleep 30"]);
            command
        };
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let runner = tokio::spawn(run_command(
            command,
            "test",
            &[],
            Duration::from_secs(60),
            cancel_rx,
            sink,
        ));
        time::sleep(Duration::from_millis(700)).await;
        let visible = events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.chunk.as_str())
            .collect::<String>();
        assert!(visible.contains("partial"));
        cancel_tx.send(true).unwrap();
        let error = runner.await.unwrap().unwrap_err();
        assert!(error.contains("COMMAND_CANCELLED"));
    }
}
