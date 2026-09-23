// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::updates::UpdateState;

pub struct TrayState {
    new_conversation: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

impl TrayState {
    pub fn set_language(&self, language: crate::language::Language) -> tauri::Result<()> {
        self.new_conversation
            .set_text(language.choose("新对话", "New chat"))?;
        self.quit
            .set_text(language.choose("退出远舟", "Quit YuanZhou"))
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let result = window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus());
        if let Err(error) = result {
            eprintln!("无法恢复远舟窗口：{error}");
        }
    }
}

#[tauri::command]
pub fn set_tray_new_conversation_enabled(
    state: tauri::State<'_, TrayState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .new_conversation
        .set_enabled(enabled)
        .map_err(|e| e.to_string())
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let language = app.state::<crate::language::LanguageState>().get();
    // Enable only after the WebView has registered its listener and is ready.
    let new_conversation = MenuItem::with_id(
        app,
        "new-conversation",
        language.choose("新对话", "New chat"),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        language.choose("退出远舟", "Quit YuanZhou"),
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&new_conversation, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("远舟")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new-conversation" => {
                show_main_window(app);
                if app.state::<UpdateState>().ensure_idle().is_ok() {
                    if let Err(error) = app.emit_to("main", "desktop-new-conversation", ()) {
                        eprintln!("无法打开新对话：{error}");
                    }
                }
            }
            "quit" => {
                if app.state::<UpdateState>().ensure_idle().is_ok() {
                    app.exit(0);
                } else {
                    // Make the existing installation status visible when exit is blocked.
                    show_main_window(app);
                }
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(TrayState {
        new_conversation,
        quit,
    });
    Ok(())
}
