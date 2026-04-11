mod clicker;
mod macro_recorder;

use clicker::ClickerState;
use macro_recorder::MacroState;
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconId},
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
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let clicker_state = ClickerState::new();
            app.manage(Arc::new(clicker_state));

            let macro_state = MacroState::new();
            app.manage(Arc::new(macro_state));

            // System tray
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let start_i = MenuItem::with_id(app, "start", "Start (F6)", true, None::<&str>)?;
            let stop_i = MenuItem::with_id(app, "stop", "Stop (F6)", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &start_i, &stop_i, &quit_i])?;

            let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("Failed to load tray icon");

            TrayIconBuilder::with_id("main")
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

            // Stop clicking and macro when the window is closed
            let cs = app.state::<Arc<ClickerState>>().inner().clone();
            let ms = app.state::<Arc<MacroState>>().inner().clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        cs.running.store(false, std::sync::atomic::Ordering::SeqCst);
                        ms.playing.store(false, std::sync::atomic::Ordering::SeqCst);
                        ms.recording.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clicker::start_clicking,
            clicker::stop_clicking,
            clicker::get_cursor_position,
            clicker::set_hotkey,
            clicker::set_emergency_hotkey,
            macro_recorder::start_macro_recording,
            macro_recorder::stop_macro_recording,
            macro_recorder::play_macro,
            macro_recorder::stop_macro,
            macro_recorder::set_macro_hotkey,
            show_window,
            set_tray_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn set_tray_running(app: AppHandle, running: bool) {
    let icon_bytes: &[u8] = if running {
        include_bytes!("../icons/32x32-recording.png")
    } else {
        include_bytes!("../icons/32x32.png")
    };

    if let Ok(icon) = Image::from_bytes(icon_bytes) {
        if let Some(tray) = app.tray_by_id(&TrayIconId::new("main")) {
            let _ = tray.set_icon(Some(icon));
            let _ = tray.set_tooltip(Some(if running {
                "Open Autoclicker - Running"
            } else {
                "Open Autoclicker"
            }));
        }
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
