mod clicker;

use clicker::ClickerState;
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut: Shortcut = "F6".parse().expect("Failed to parse shortcut");

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut(shortcut)
                .expect("Failed to register shortcut")
                .with_handler(move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("toggle-clicker", ());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
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

            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let start_i = MenuItem::with_id(app, "start", "Start (F6)", true, None::<&str>)?;
            let stop_i = MenuItem::with_id(app, "stop", "Stop (F6)", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &start_i, &stop_i, &quit_i])?;

            let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("Failed to load tray icon");

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Open Autoclicker")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "start" | "stop" => {
                        let _ = app.emit("toggle-clicker", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clicker::start_clicking,
            clicker::stop_clicking,
            clicker::get_cursor_position,
            clicker::set_hotkey,
            show_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
