mod clicker;
mod macro_recorder;

use clicker::ClickerState;
use macro_recorder::MacroState;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconId},
    AppHandle, Emitter, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const DEFAULT_TOGGLE_HOTKEY: &str = "F6";

#[derive(Clone, Copy)]
pub(crate) enum ShortcutBindingKind {
    Toggle,
    MacroPlayback,
    EmergencyStop,
}

#[derive(Default)]
struct ShortcutBindings(Mutex<ShortcutConfig>);

#[derive(Default)]
struct ShortcutConfig {
    toggle: Option<String>,
    macro_playback: Option<String>,
    emergency_stop: Option<String>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    updater_configured: bool,
    default_toggle_hotkey: String,
}

fn updater_pubkey() -> Option<&'static str> {
    option_env!("TAURI_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn binding_label(kind: ShortcutBindingKind) -> &'static str {
    match kind {
        ShortcutBindingKind::Toggle => "toggle",
        ShortcutBindingKind::MacroPlayback => "macro",
        ShortcutBindingKind::EmergencyStop => "emergency stop",
    }
}

fn binding_slot(config: &mut ShortcutConfig, kind: ShortcutBindingKind) -> &mut Option<String> {
    match kind {
        ShortcutBindingKind::Toggle => &mut config.toggle,
        ShortcutBindingKind::MacroPlayback => &mut config.macro_playback,
        ShortcutBindingKind::EmergencyStop => &mut config.emergency_stop,
    }
}

fn shortcut_conflict(
    config: &ShortcutConfig,
    key: &str,
    kind: ShortcutBindingKind,
) -> Option<&'static str> {
    let matches = |value: &Option<String>| {
        value
            .as_deref()
            .is_some_and(|existing| existing.eq_ignore_ascii_case(key))
    };

    match kind {
        ShortcutBindingKind::Toggle => {
            if matches(&config.macro_playback) {
                Some("macro")
            } else if matches(&config.emergency_stop) {
                Some("emergency stop")
            } else {
                None
            }
        }
        ShortcutBindingKind::MacroPlayback => {
            if matches(&config.toggle) {
                Some("toggle")
            } else if matches(&config.emergency_stop) {
                Some("emergency stop")
            } else {
                None
            }
        }
        ShortcutBindingKind::EmergencyStop => {
            if matches(&config.toggle) {
                Some("toggle")
            } else if matches(&config.macro_playback) {
                Some("macro")
            } else {
                None
            }
        }
    }
}

fn register_shortcut_binding(
    app: &AppHandle,
    kind: ShortcutBindingKind,
    key: &str,
) -> Result<(), String> {
    let shortcut: Shortcut = key.parse().map_err(|error| format!("{error:?}"))?;
    let handle = app.clone();

    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }

            match kind {
                ShortcutBindingKind::Toggle => {
                    let _ = app.emit("toggle-clicker", ());
                }
                ShortcutBindingKind::MacroPlayback => {
                    let _ = app.emit("toggle-macro", ());
                }
                ShortcutBindingKind::EmergencyStop => {
                    let _ = app.emit("emergency-stop", ());
                    handle.exit(0);
                }
            }
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn update_shortcut_binding(
    app: &AppHandle,
    kind: ShortcutBindingKind,
    key: Option<String>,
) -> Result<(), String> {
    let next_value = key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let bindings = app.state::<ShortcutBindings>();
    let mut config = bindings
        .0
        .lock()
        .map_err(|_| "Hotkey state poisoned".to_string())?;
    let current_value = binding_slot(&mut config, kind).clone();

    if current_value == next_value {
        return Ok(());
    }

    if let Some(ref next_key) = next_value {
        if let Some(conflict) = shortcut_conflict(&config, next_key, kind) {
            return Err(format!(
                "That hotkey is already assigned to the {conflict} action."
            ));
        }
    }

    if let Some(ref existing_key) = current_value {
        let _ = app.global_shortcut().unregister(existing_key.as_str());
    }

    if let Some(ref next_key) = next_value {
        if let Err(error) = register_shortcut_binding(app, kind, next_key) {
            if let Some(ref existing_key) = current_value {
                let _ = register_shortcut_binding(app, kind, existing_key);
            }

            return Err(format!(
                "Failed to set the {} hotkey: {error}",
                binding_label(kind)
            ));
        }
    }

    *binding_slot(&mut config, kind) = next_value;
    Ok(())
}

fn show_main_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    if let Some(pubkey) = updater_pubkey() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.manage(Arc::new(ClickerState::new()));
            app.manage(Arc::new(MacroState::new()));
            app.manage(ShortcutBindings::default());

            update_shortcut_binding(
                &app.handle().clone(),
                ShortcutBindingKind::Toggle,
                Some(DEFAULT_TOGGLE_HOTKEY.to_string()),
            )?;

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "Start / Stop", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &start_item, &quit_item])?;

            let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .expect("Failed to load tray icon");

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("Open Autoclicker")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                    "start" => {
                        let _ = app.emit("toggle-clicker", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            show_main_window(&window);
                        }
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let window_handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_handle.hide();
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
            app_info,
            show_window,
            set_tray_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        updater_configured: updater_pubkey().is_some(),
        default_toggle_hotkey: DEFAULT_TOGGLE_HOTKEY.to_string(),
    }
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
        show_main_window(&window);
    }
}

#[cfg(test)]
mod tests {
    use super::{shortcut_conflict, ShortcutBindingKind, ShortcutConfig};

    fn shortcut_config(
        toggle: Option<&str>,
        macro_playback: Option<&str>,
        emergency: Option<&str>,
    ) -> ShortcutConfig {
        ShortcutConfig {
            toggle: toggle.map(str::to_string),
            macro_playback: macro_playback.map(str::to_string),
            emergency_stop: emergency.map(str::to_string),
        }
    }

    #[test]
    fn detects_conflicts_across_shortcut_slots() {
        let config = shortcut_config(Some("F6"), Some("F7"), Some("F8"));

        assert_eq!(
            shortcut_conflict(&config, "F7", ShortcutBindingKind::Toggle),
            Some("macro")
        );
        assert_eq!(
            shortcut_conflict(&config, "f6", ShortcutBindingKind::MacroPlayback),
            Some("toggle")
        );
        assert_eq!(
            shortcut_conflict(&config, "F9", ShortcutBindingKind::EmergencyStop),
            None
        );
    }
}
