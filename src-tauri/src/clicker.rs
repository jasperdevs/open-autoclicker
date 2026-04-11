use enigo::{Button, Coordinate, Enigo, Mouse, Settings};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{sleep, Duration};

#[derive(Debug, Deserialize)]
pub struct ClickerConfig {
    interval_ms: u64,
    mouse_button: String,
    click_type: String,
    repeat_mode: String,
    repeat_count: u64,
    position_mode: String,
    fixed_x: i32,
    fixed_y: i32,
}

pub struct ClickerState {
    pub running: Arc<AtomicBool>,
}

impl ClickerState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn get_button(name: &str) -> Button {
    match name {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}

#[tauri::command]
pub async fn start_clicking(app: AppHandle, config: ClickerConfig) -> Result<(), String> {
    let state = app.state::<Arc<ClickerState>>();

    if state.running.load(Ordering::SeqCst) {
        return Err("Already running".into());
    }

    state.running.store(true, Ordering::SeqCst);

    let running = state.running.clone();
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        rt.block_on(async {
            let mut enigo = Enigo::new(&Settings::default()).unwrap();
            let button = get_button(&config.mouse_button);
            let is_double = config.click_type == "double";
            let is_infinite = config.repeat_mode == "infinite";
            let max_clicks = config.repeat_count;
            let interval = Duration::from_millis(config.interval_ms);
            let use_fixed = config.position_mode == "fixed";

            let mut count: u64 = 0;

            while running.load(Ordering::SeqCst) {
                if !is_infinite && count >= max_clicks {
                    break;
                }

                if use_fixed {
                    let _ = enigo.move_mouse(config.fixed_x, config.fixed_y, Coordinate::Abs);
                }

                let _ = enigo.button(button, enigo::Direction::Click);
                if is_double {
                    let _ = enigo.button(button, enigo::Direction::Click);
                }

                count += 1;

                if count % 10 == 0 || config.interval_ms >= 50 {
                    let _ = app_handle.emit("click-count", count);
                }

                sleep(interval).await;
            }

            let _ = app_handle.emit("click-count", count);
            running.store(false, Ordering::SeqCst);
            let _ = app_handle.emit("clicker-stopped", ());
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_clicking(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<ClickerState>>();
    state.running.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_cursor_position() -> Result<CursorPos, String> {
    let enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let (x, y) = enigo.location().map_err(|e| e.to_string())?;
    Ok(CursorPos { x, y })
}

#[derive(serde::Serialize)]
pub struct CursorPos {
    x: i32,
    y: i32,
}

#[tauri::command]
pub async fn set_hotkey(app: AppHandle, key: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let global_shortcut = app.global_shortcut();

    global_shortcut.unregister_all().map_err(|e| e.to_string())?;

    let shortcut: Shortcut = key.parse().map_err(|e| format!("{e:?}"))?;

    let handle = app.clone();
    global_shortcut
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                let _ = handle.emit("toggle-clicker", ());
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn set_emergency_hotkey(app: AppHandle, key: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let shortcut: Shortcut = key.parse().map_err(|e| format!("{e:?}"))?;

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                let _ = handle.emit("emergency-stop", ());
                handle.exit(0);
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}
