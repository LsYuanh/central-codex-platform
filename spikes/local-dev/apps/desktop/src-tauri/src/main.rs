// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

use std::{
    env,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct LocalAgentSupervisor(Arc<Mutex<Option<Child>>>);

impl LocalAgentSupervisor {
    fn start() -> Self {
        let supervisor = Self(Arc::new(Mutex::new(None)));
        match spawn_local_agent() {
            Ok(child) => {
                println!("Local Agent started (pid {})", child.id());
                *supervisor.0.lock().expect("local agent lock poisoned") = Some(child);
            }
            Err(error) => eprintln!("Local Agent was not started: {error}"),
        }
        supervisor
    }

    fn stop(&self) {
        let mut child = self.0.lock().expect("local agent lock poisoned");
        let Some(mut child_process) = child.take() else {
            return;
        };
        if let Err(error) = child_process.kill() {
            eprintln!("Local Agent stop failed: {error}");
        }
        let _ = child_process.wait();
    }
}

impl Drop for LocalAgentSupervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_local_agent() -> Result<Child, String> {
    let executable = env::var_os("CODEXIA_LOCAL_AGENT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(PathBuf::from))
                .unwrap_or_default()
                .join("local-agent.exe")
        });
    if !executable.is_file() {
        return Err(format!("executable not found at {}", executable.display()));
    }

    let workspace = env::var_os("CODEXIA_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(PathBuf::from))
                .unwrap_or_default()
                .join("..")
                .join("..")
                .join("fixtures")
                .join("workspace")
        });
    if !workspace.is_dir() {
        return Err(format!("workspace not found at {}", workspace.display()));
    }

    let gateway = env::var("CODEXIA_GATEWAY_AGENT_URL")
        .unwrap_or_else(|_| "ws://192.0.2.10:4510/ws/agent?deviceId=desktop-device".to_string());
    let workspace_text = workspace.to_string_lossy().into_owned();
    let mut command = Command::new(executable);
    command
        .args([
            "--workspace-root",
            workspace_text.as_str(),
            "--gateway-url",
            gateway.as_str(),
            "--allow-insecure-lan",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| error.to_string())
}

fn main() {
    let supervisor = LocalAgentSupervisor::start();
    let cleanup = supervisor.clone();
    tauri::Builder::default()
        .manage(supervisor)
        .on_window_event(move |window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                cleanup.stop();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run desktop Spike");
}
