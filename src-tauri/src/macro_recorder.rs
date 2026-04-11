use enigo::{Button, Coordinate, Enigo, Mouse, Settings};
use rdev::{listen, Event, EventType};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{sleep, Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroAction {
    #[serde(rename = "type")]
    pub action_type: String,
    pub detail: String,
    pub delay_ms: u64,
    #[serde(skip)]
    pub x: Option<i32>,
    #[serde(skip)]
    pub y: Option<i32>,
    #[serde(skip)]
    pub button: Option<String>,
}

pub struct MacroState {
    pub recording: Arc<AtomicBool>,
    pub playing: Arc<AtomicBool>,
    pub actions: Arc<Mutex<Vec<MacroAction>>>,
    listener_running: Arc<AtomicBool>,
}

impl MacroState {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            playing: Arc::new(AtomicBool::new(false)),
            actions: Arc::new(Mutex::new(Vec::new())),
            listener_running: Arc::new(AtomicBool::new(false)),
        }
    }
}

fn get_actions(mutex: &Mutex<Vec<MacroAction>>) -> Vec<MacroAction> {
    match mutex.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn set_actions(mutex: &Mutex<Vec<MacroAction>>, actions: Vec<MacroAction>) {
    match mutex.lock() {
        Ok(mut guard) => *guard = actions,
        Err(poisoned) => *poisoned.into_inner() = actions,
    }
}

#[tauri::command]
pub async fn start_macro_recording(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<MacroState>>();

    if state.recording.load(Ordering::SeqCst) || state.playing.load(Ordering::SeqCst) {
        return Err("Already recording or playing".into());
    }

    set_actions(&state.actions, Vec::new());
    state.recording.store(true, Ordering::SeqCst);

    let recording = state.recording.clone();
    let actions = state.actions.clone();
    let listener_running = state.listener_running.clone();

    // Only spawn listener thread if not already running
    if !listener_running.swap(true, Ordering::SeqCst) {
        let recording_clone = recording.clone();
        let actions_clone = actions.clone();
        let listener_flag = listener_running.clone();

        std::thread::spawn(move || {
            let start_time = Arc::new(Mutex::new(Instant::now()));
            let last_time = Arc::new(Mutex::new(Instant::now()));

            let rec = recording_clone.clone();
            let acts = actions_clone.clone();
            let _st = start_time.clone();
            let lt = last_time.clone();

            let callback = move |event: Event| {
                if !rec.load(Ordering::SeqCst) {
                    return;
                }

                let now = Instant::now();
                let delay = {
                    let last = lt.lock().unwrap();
                    now.duration_since(*last).as_millis() as u64
                };

                let action = match event.event_type {
                    EventType::ButtonPress(btn) => {
                        let button_name = match btn {
                            rdev::Button::Left => "left",
                            rdev::Button::Right => "right",
                            rdev::Button::Middle => "middle",
                            _ => return,
                        };
                        Some(MacroAction {
                            action_type: "Click".to_string(),
                            detail: format!("{} click", button_name),
                            delay_ms: delay,
                            x: None,
                            y: None,
                            button: Some(button_name.to_string()),
                        })
                    }
                    EventType::MouseMove { x, y } => {
                        // Only record moves every 50ms minimum
                        if delay < 50 {
                            return;
                        }
                        Some(MacroAction {
                            action_type: "Move".to_string(),
                            detail: format!("{}, {}", x as i32, y as i32),
                            delay_ms: delay,
                            x: Some(x as i32),
                            y: Some(y as i32),
                            button: None,
                        })
                    }
                    _ => None,
                };

                if let Some(action) = action {
                    *lt.lock().unwrap() = now;
                    match acts.lock() {
                        Ok(mut guard) => { guard.push(action); },
                        Err(poisoned) => { poisoned.into_inner().push(action); },
                    }
                }
            };

            // rdev::listen blocks, so this thread stays alive
            if let Err(_) = listen(callback) {
                // Listener ended
            }
            listener_flag.store(false, Ordering::SeqCst);
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_macro_recording(app: AppHandle) -> Result<Vec<MacroAction>, String> {
    let state = app.state::<Arc<MacroState>>();
    state.recording.store(false, Ordering::SeqCst);

    let actions = get_actions(&state.actions);
    Ok(actions)
}

#[tauri::command]
pub async fn play_macro(
    app: AppHandle,
    actions: Vec<MacroAction>,
    speed: f64,
    repeat_mode: String,
    repeat_count: u64,
) -> Result<(), String> {
    let state = app.state::<Arc<MacroState>>();

    if state.playing.load(Ordering::SeqCst) || state.recording.load(Ordering::SeqCst) {
        return Err("Already playing or recording".into());
    }

    if actions.is_empty() {
        return Err("No actions to play".into());
    }

    state.playing.store(true, Ordering::SeqCst);

    let playing = state.playing.clone();
    let app_handle = app.clone();
    let actions_copy = actions.clone();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        rt.block_on(async {
            let mut enigo = match Enigo::new(&Settings::default()) {
                Ok(e) => e,
                Err(_) => {
                    playing.store(false, Ordering::SeqCst);
                    let _ = app_handle.emit("macro-stopped", ());
                    return;
                }
            };

            let is_infinite = repeat_mode == "infinite";
            let max_repeats = if repeat_mode == "count" { repeat_count } else { 1 };
            let mut iteration: u64 = 0;

            loop {
                if !playing.load(Ordering::SeqCst) {
                    break;
                }

                if !is_infinite && iteration >= max_repeats {
                    break;
                }

                for action in &actions_copy {
                    if !playing.load(Ordering::SeqCst) {
                        break;
                    }

                    let delay = (action.delay_ms as f64 / speed) as u64;
                    if delay > 0 {
                        sleep(Duration::from_millis(delay)).await;
                    }

                    if !playing.load(Ordering::SeqCst) {
                        break;
                    }

                    match action.action_type.as_str() {
                        "Click" => {
                            let button = match action.button.as_deref() {
                                Some("right") => Button::Right,
                                Some("middle") => Button::Middle,
                                _ => Button::Left,
                            };
                            let _ = enigo.button(button, enigo::Direction::Click);
                        }
                        "Move" => {
                            if let (Some(x), Some(y)) = (action.x, action.y) {
                                let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                            }
                        }
                        _ => {}
                    }
                }

                iteration += 1;
            }

            playing.store(false, Ordering::SeqCst);
            let _ = app_handle.emit("macro-stopped", ());
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_macro(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<MacroState>>();
    state.playing.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn set_macro_hotkey(app: AppHandle, key: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let shortcut: Shortcut = key.parse().map_err(|e| format!("{e:?}"))?;

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                let _ = handle.emit("toggle-macro", ());
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}
