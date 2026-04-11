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
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub button: Option<String>,
}

pub struct MacroState {
    pub recording: Arc<AtomicBool>,
    pub playing: Arc<AtomicBool>,
    pub actions: Arc<Mutex<Vec<MacroAction>>>,
    listener_running: Arc<AtomicBool>,
    last_recorded_at: Arc<Mutex<Option<Instant>>>,
}

impl MacroState {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            playing: Arc::new(AtomicBool::new(false)),
            actions: Arc::new(Mutex::new(Vec::new())),
            listener_running: Arc::new(AtomicBool::new(false)),
            last_recorded_at: Arc::new(Mutex::new(None)),
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
    match state.last_recorded_at.lock() {
        Ok(mut guard) => *guard = Some(Instant::now()),
        Err(poisoned) => *poisoned.into_inner() = Some(Instant::now()),
    }

    let recording = state.recording.clone();
    let actions = state.actions.clone();
    let listener_running = state.listener_running.clone();
    let last_recorded_at = state.last_recorded_at.clone();

    // Only spawn listener thread if not already running
    if !listener_running.swap(true, Ordering::SeqCst) {
        let recording_clone = recording.clone();
        let actions_clone = actions.clone();
        let listener_flag = listener_running.clone();
        let last_recorded_at_clone = last_recorded_at.clone();
        let error_app = app.clone();

        std::thread::spawn(move || {
            let rec = recording_clone.clone();
            let acts = actions_clone.clone();
            let lt = last_recorded_at_clone.clone();

            let callback = move |event: Event| {
                if !rec.load(Ordering::SeqCst) {
                    return;
                }

                let now = Instant::now();
                let delay = {
                    match lt.lock() {
                        Ok(mut last) => {
                            let delay = last
                                .map(|previous| now.duration_since(previous).as_millis() as u64)
                                .unwrap_or(0);
                            *last = Some(now);
                            delay
                        }
                        Err(poisoned) => {
                            let mut last = poisoned.into_inner();
                            let delay = last
                                .map(|previous| now.duration_since(previous).as_millis() as u64)
                                .unwrap_or(0);
                            *last = Some(now);
                            delay
                        }
                    }
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
                    match acts.lock() {
                        Ok(mut guard) => {
                            guard.push(action);
                        }
                        Err(poisoned) => {
                            poisoned.into_inner().push(action);
                        }
                    }
                }
            };

            // rdev::listen blocks, so this thread stays alive
            if let Err(error) = listen(callback) {
                recording_clone.store(false, Ordering::SeqCst);
                let _ = error_app.emit("macro-recording-error", format!("{error:?}"));
                let _ = error_app.emit("macro-stopped", ());
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
    match state.last_recorded_at.lock() {
        Ok(mut guard) => *guard = None,
        Err(poisoned) => *poisoned.into_inner() = None,
    }

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
            let max_repeats = if repeat_mode == "count" {
                repeat_count
            } else {
                1
            };
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
                            if let Err(error) = enigo.button(button, enigo::Direction::Click) {
                                let _ = app_handle.emit("macro-playback-error", error.to_string());
                                playing.store(false, Ordering::SeqCst);
                                break;
                            }
                        }
                        "Move" => {
                            if let (Some(x), Some(y)) = (action.x, action.y) {
                                if let Err(error) = enigo.move_mouse(x, y, Coordinate::Abs) {
                                    let _ = app_handle.emit(
                                        "macro-playback-error",
                                        error.to_string(),
                                    );
                                    playing.store(false, Ordering::SeqCst);
                                    break;
                                }
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
    crate::update_shortcut_binding(&app, crate::ShortcutBindingKind::MacroPlayback, Some(key))
}

#[cfg(test)]
mod tests {
    use super::MacroAction;

    #[test]
    fn macro_actions_keep_playback_metadata_when_serialized() {
        let action = MacroAction {
            action_type: "Move".to_string(),
            detail: "120, 340".to_string(),
            delay_ms: 42,
            x: Some(120),
            y: Some(340),
            button: Some("left".to_string()),
        };

        let value = serde_json::to_value(&action).expect("macro action should serialize");
        assert_eq!(value["type"], "Move");
        assert_eq!(value["x"], 120);
        assert_eq!(value["y"], 340);
        assert_eq!(value["button"], "left");

        let decoded: MacroAction =
            serde_json::from_value(value).expect("macro action should deserialize");
        assert_eq!(decoded.x, Some(120));
        assert_eq!(decoded.y, Some(340));
        assert_eq!(decoded.button.as_deref(), Some("left"));
    }
}
