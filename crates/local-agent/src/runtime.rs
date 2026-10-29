// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Activity(Mutex<State>);
#[derive(Default)]
struct State {
    active: usize,
    paused_until: Option<Instant>,
}
pub struct Operation<'a>(&'a Activity);
/// Private parent IPC can drain an idle socket before replacing the Agent.
/// Closing the WSS explicitly avoids waiting for a dead relay connection to expire.
#[derive(Default)]
pub struct TransportDrain(Mutex<Option<tokio::sync::oneshot::Sender<std::sync::mpsc::Sender<()>>>>);
impl TransportDrain {
    pub fn begin(&self) -> tokio::sync::oneshot::Receiver<std::sync::mpsc::Sender<()>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.0.lock().unwrap() = Some(tx);
        rx
    }
    pub fn clear(&self) {
        self.0.lock().unwrap().take();
    }
    pub fn request(&self) -> Result<(), String> {
        let Some(sender) = self.0.lock().unwrap().take() else {
            return Ok(());
        };
        let (tx, rx) = std::sync::mpsc::channel();
        if sender.send(tx).is_err() {
            return Ok(());
        }
        rx.recv_timeout(Duration::from_secs(4))
            .map_err(|_| "AGENT_TRANSPORT_DRAIN_TIMEOUT".into())
    }
}
impl Activity {
    pub fn enter(&self) -> Result<Operation<'_>, String> {
        let mut state = self.0.lock().unwrap();
        if state
            .paused_until
            .is_some_and(|until| Instant::now() < until)
        {
            return Err("AGENT_RECONFIGURING: 客户端正在应用配置，请稍后重试".into());
        }
        state.active += 1;
        Ok(Operation(self))
    }
    pub fn pause(&self, has_transfers: impl FnOnce() -> bool) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        if state.active > 0 || has_transfers() {
            return Err("AGENT_BUSY: 命令或文件传输尚未结束，请完成后再应用配置".into());
        }
        // A lost IPC response must not leave the old Agent permanently paused.
        state.paused_until = Some(Instant::now() + Duration::from_secs(10));
        Ok(())
    }
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.0.lock().unwrap().active -= 1;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_restart_during_work_and_freezes_new_work() {
        let activity = Activity::default();
        let work = activity.enter().unwrap();
        assert!(activity.pause(|| false).is_err());
        drop(work);
        assert!(activity.pause(|| true).is_err());
        assert!(activity.enter().is_ok());
        activity.pause(|| false).unwrap();
        assert!(activity.enter().is_err());
    }
}
