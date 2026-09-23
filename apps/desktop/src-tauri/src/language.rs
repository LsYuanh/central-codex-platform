// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use std::{path::PathBuf, sync::Mutex};
use tauri::Manager;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub enum Language {
    #[default]
    Chinese,
    English,
}
impl Language {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "zh-CN" => Ok(Self::Chinese),
            "en" => Ok(Self::English),
            _ => Err("Unsupported interface language".into()),
        }
    }
    pub fn code(self) -> &'static str {
        match self {
            Self::Chinese => "zh-CN",
            Self::English => "en",
        }
    }
    pub fn choose(self, chinese: &'static str, english: &'static str) -> &'static str {
        match self {
            Self::Chinese => chinese,
            Self::English => english,
        }
    }
}
pub struct LanguageState {
    current: Mutex<Language>,
    path: PathBuf,
}
impl LanguageState {
    pub fn load(path: PathBuf) -> Self {
        let current = std::fs::read_to_string(&path)
            .ok()
            .and_then(|value| Language::parse(value.trim()).ok())
            .unwrap_or_default();
        Self {
            current: Mutex::new(current),
            path,
        }
    }
    pub fn get(&self) -> Language {
        *self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}
#[tauri::command]
pub fn desktop_language(state: tauri::State<'_, LanguageState>) -> &'static str {
    state.get().code()
}

#[tauri::command]
pub fn set_desktop_language(
    app: tauri::AppHandle,
    state: tauri::State<'_, LanguageState>,
    language: String,
) -> Result<(), String> {
    let next = Language::parse(&language)?;
    let mut current = state.current.lock().map_err(|error| error.to_string())?;
    let parent = state
        .path
        .parent()
        .ok_or("Language preference directory unavailable")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    use std::io::Write;
    temporary
        .write_all(next.code().as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let tray = app.state::<crate::tray::TrayState>();
    if let Err(error) = tray.set_language(next) {
        let _ = tray.set_language(*current);
        return Err(error.to_string());
    }
    if let Err(error) = temporary.persist(&state.path) {
        let _ = tray.set_language(*current);
        return Err(error.to_string());
    }
    *current = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_preferences_are_validated_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("language");
        assert_eq!(LanguageState::load(path.clone()).get(), Language::Chinese);
        std::fs::write(&path, "en").unwrap();
        assert_eq!(LanguageState::load(path.clone()).get(), Language::English);
        std::fs::write(&path, "invalid").unwrap();
        assert_eq!(LanguageState::load(path).get(), Language::Chinese);
        assert!(Language::parse("fr").is_err());
    }
}
