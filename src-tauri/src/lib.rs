mod clicker;

use clicker::ClickerState;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let state = ClickerState::new();
            app.manage(Arc::new(state));

            // Register default hotkey (F6)
            let handle = app.handle().clone();
            let shortcut: Shortcut = "F6".parse().expect("Failed to parse shortcut");

            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    let _ = handle.emit("toggle-clicker", ());
                }
            })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clicker::start_clicking,
            clicker::stop_clicking,
            clicker::get_cursor_position,
            clicker::set_hotkey,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
