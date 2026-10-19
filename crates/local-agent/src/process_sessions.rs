// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
//! Connection-scoped command sessions. Stdin is a dedicated child pipe and IDs
//! are bound to the gateway-supplied conversation owner, never a model argument.
use crate::{process, runtime};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time,
};

struct Session {
    owner: String,
    tasks: Mutex<HashSet<String>>,
    requests: Mutex<HashSet<String>>,
    cancel: watch::Sender<bool>,
    input: mpsc::Sender<Option<String>>,
    result: watch::Receiver<Option<Value>>,
    log: String,
}
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Arc<Session>>>);

impl Sessions {
    pub fn cancel(&self, request: &str, task: Option<&str>) -> bool {
        let mut accepted = false;
        for session in self.0.lock().unwrap().values() {
            if session.requests.lock().unwrap().contains(request)
                || task.is_some_and(|t| session.tasks.lock().unwrap().contains(t))
            {
                accepted |= session.cancel.send(true).is_ok();
            }
        }
        accepted
    }
    pub async fn close(&self) {
        let sessions: Vec<_> = self.0.lock().unwrap().values().cloned().collect();
        for session in &sessions {
            let _ = session.cancel.send(true);
        }
        for session in sessions {
            let mut result = session.result.clone();
            let _ = time::timeout(Duration::from_secs(5), async {
                while result.borrow().is_none() {
                    if result.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        }
        self.0.lock().unwrap().clear();
    }
    pub async fn execute(
        &self,
        root: &Path,
        params: &Value,
        request: &str,
        task: Option<&str>,
        activity: Arc<runtime::Activity>,
        cancel: watch::Receiver<bool>,
        sink: process::EventSink,
    ) -> Result<Value, process::CommandFailure> {
        let owner = params["__sessionOwner"]
            .as_str()
            .ok_or("COMMAND_SESSION_OWNER_REQUIRED")?
            .to_owned();
        let id = params["sessionId"].as_str().map(str::to_owned);
        let (id, session) = if let Some(id) = id {
            let session = self
                .0
                .lock()
                .unwrap()
                .get(&id)
                .cloned()
                .ok_or("COMMAND_SESSION_NOT_FOUND")?;
            if session.owner != owner {
                return Err("COMMAND_SESSION_OWNER_MISMATCH".into());
            }
            (id, session)
        } else {
            let program = crate::required_string(params, "program")?.to_owned();
            let args = params["args"]
                .as_array()
                .ok_or("args must be an array")?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or("every arg must be a string")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let cwd = crate::workspace::resolve(root, params["cwd"].as_str().unwrap_or("."))?;
            if !cwd.is_dir() {
                return Err("cwd must be a directory".into());
            }
            let timeout = crate::command_timeout(params)?;
            let id = uuid::Uuid::new_v4().to_string();
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let (input_tx, input_rx) = mpsc::channel(8);
            let (result_tx, result_rx) = watch::channel(None);
            let temporary = tempfile::Builder::new()
                .prefix("yuan-session-")
                .suffix(".txt")
                .tempfile()
                .map_err(|e| e.to_string())?;
            let (log, log_path) = temporary.keep().map_err(|e| e.to_string())?;
            let session = Arc::new(Session {
                owner,
                tasks: Mutex::new(HashSet::new()),
                requests: Mutex::new(HashSet::new()),
                cancel: cancel_tx,
                input: input_tx,
                result: result_rx,
                log: crate::outputs::display_path(&log_path),
            });
            // Retain lifecycle admission until the child exits, even after yielding.
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let session_cancel = session.cancel.clone();
            tokio::spawn(async move {
                let admission = activity.enter();
                match admission {
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                    Ok(_operation) => {
                        let log = Arc::new(Mutex::new(log));
                        let log_error = Arc::new(Mutex::new(None::<String>));
                        let error_sink = log_error.clone();
                        let stream: process::EventSink = Arc::new(move |event| {
                            if let Err(error) =
                                log.lock().unwrap().write_all(event.chunk.as_bytes())
                            {
                                *error_sink.lock().unwrap() = Some(error.to_string());
                            }
                            sink(event);
                        });
                        let mut command = tokio::process::Command::new(&program);
                        command.args(&args).current_dir(cwd);
                        let _ = ready_tx.send(Ok(()));
                        let result = process::run_command_session(
                            command,
                            &program,
                            &args,
                            timeout,
                            cancel_rx,
                            stream,
                            Some(input_rx),
                        )
                        .await;
                        let value = match result {
                            Ok(value) => json!({"ok":true,"result":value}),
                            Err(error) => {
                                json!({"ok":false,"error":error.message,"errorCode":error.code,"result":error.result})
                            }
                        };
                        let mut value = value;
                        if let Some(error) = log_error.lock().unwrap().take() {
                            value["outputError"] = json!(error);
                        }
                        let _ = result_tx.send(Some(value));
                        drop(session_cancel);
                    }
                }
            });
            ready_rx.await.map_err(|e| e.to_string())??;
            self.0.lock().unwrap().insert(id.clone(), session.clone());
            (id, session)
        };
        session.requests.lock().unwrap().insert(request.to_owned());
        if let Some(task) = task {
            session.tasks.lock().unwrap().insert(task.to_owned());
        }
        if *cancel.borrow() {
            let _ = session.cancel.send(true);
            return Err("COMMAND_CANCELLED".into());
        }
        if params["cancel"] == true {
            let _ = session.cancel.send(true);
        }
        if let Some(text) = params["stdin"].as_str() {
            session
                .input
                .send(Some(text.to_owned()))
                .await
                .map_err(|_| "COMMAND_STDIN_CLOSED")?;
        }
        if params["closeStdin"] == true {
            session
                .input
                .send(None)
                .await
                .map_err(|_| "COMMAND_STDIN_CLOSED")?;
        }
        let wait = params["yieldMs"].as_u64().unwrap_or(1000);
        let mut result = session.result.clone();
        if result.borrow().is_none() {
            let _ = time::timeout(Duration::from_millis(wait), result.changed()).await;
        }
        let completed = result.borrow().clone();
        let mut page = read_log(&session.log, params["offset"].as_u64().unwrap_or(0))?;
        page["sessionId"] = json!(id);
        page["running"] = json!(completed.is_none());
        page["completion"] = completed.unwrap_or(Value::Null);
        page["instructions"] = json!(
            "Continue device_exec with sessionId, program='', args=[], offset=nextOffset. Supply stdin to write, closeStdin=true for EOF, cancel=true to stop. Full stdout/stderr paths are in completion.result. Sessions end on disconnect or task interruption."
        );
        Ok(page)
    }
}

// A running log is append-only: read a byte window without hashing or requiring
// an unchanged file version. UTF-8 characters are never split between pages.
fn read_log(path: &str, offset: u64) -> Result<Value, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let total = file.metadata().map_err(|e| e.to_string())?.len();
    if offset > total {
        return Err("INVALID_OFFSET".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take((total - offset).min(64 * 1024))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let end = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => return Err("ENCODING_UNSUPPORTED".into()),
    };
    let next = offset + end as u64;
    Ok(
        json!({"source":"client","path":path,"content":std::str::from_utf8(&bytes[..end]).unwrap(),"offset":offset,"nextOffset":next,"bytes":total,"truncated":next<total}),
    )
}
