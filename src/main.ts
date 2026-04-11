import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface ClickerConfig {
  interval_ms: number;
  mouse_button: string;
  click_type: string;
  repeat_mode: string;
  repeat_count: number;
  position_mode: string;
  fixed_x: number;
  fixed_y: number;
}

let isRunning = false;
let clickCount = 0;

// DOM elements
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const statusDot = document.getElementById("status-dot")!;
const statusText = document.getElementById("status-text")!;
const clickCountEl = document.getElementById("click-count")!;
const hotkeyDisplay = document.getElementById("hotkey-display")!;
const changeHotkeyBtn = document.getElementById("change-hotkey")!;
const pickPositionBtn = document.getElementById("pick-position")!;

// Interval inputs
const hoursInput = document.getElementById("hours") as HTMLInputElement;
const minutesInput = document.getElementById("minutes") as HTMLInputElement;
const secondsInput = document.getElementById("seconds") as HTMLInputElement;
const msInput = document.getElementById("milliseconds") as HTMLInputElement;

// Repeat inputs
const repeatCountInput = document.getElementById("repeat-count") as HTMLInputElement;

// Position inputs
const posXInput = document.getElementById("pos-x") as HTMLInputElement;
const posYInput = document.getElementById("pos-y") as HTMLInputElement;

function getIntervalMs(): number {
  const h = parseInt(hoursInput.value) || 0;
  const m = parseInt(minutesInput.value) || 0;
  const s = parseInt(secondsInput.value) || 0;
  const ms = parseInt(msInput.value) || 0;
  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

function getConfig(): ClickerConfig {
  const mouseBtn = document.querySelector('.toggle-btn.active[data-group="mouse"]') as HTMLElement;
  const clickType = document.querySelector('.toggle-btn.active[data-group="clicktype"]') as HTMLElement;
  const repeatMode = (document.querySelector('input[name="repeat"]:checked') as HTMLInputElement).value;
  const positionMode = (document.querySelector('input[name="position"]:checked') as HTMLInputElement).value;

  return {
    interval_ms: Math.max(1, getIntervalMs()),
    mouse_button: mouseBtn?.dataset.value || "left",
    click_type: clickType?.dataset.value || "single",
    repeat_mode: repeatMode,
    repeat_count: parseInt(repeatCountInput.value) || 10,
    position_mode: positionMode,
    fixed_x: parseInt(posXInput.value) || 0,
    fixed_y: parseInt(posYInput.value) || 0,
  };
}

function updateUI(running: boolean) {
  isRunning = running;
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  statusDot.classList.toggle("running", running);
  statusText.textContent = running ? "Running" : "Stopped";
}

function updateClickCount(count: number) {
  clickCount = count;
  clickCountEl.textContent = `${count.toLocaleString()} click${count !== 1 ? "s" : ""}`;
}

async function startClicking() {
  if (isRunning) return;
  const config = getConfig();
  if (config.interval_ms < 1) return;

  clickCount = 0;
  updateClickCount(0);
  updateUI(true);

  try {
    await invoke("start_clicking", { config });
  } catch (e) {
    console.error("Failed to start:", e);
    updateUI(false);
  }
}

async function stopClicking() {
  if (!isRunning) return;
  try {
    await invoke("stop_clicking");
  } catch (e) {
    console.error("Failed to stop:", e);
  }
  updateUI(false);
}

// Toggle button groups
document.querySelectorAll(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const group = (btn as HTMLElement).dataset.group;
    document.querySelectorAll(`.toggle-btn[data-group="${group}"]`).forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});

// Start/Stop
startBtn.addEventListener("click", startClicking);
stopBtn.addEventListener("click", stopClicking);

// Listen for click count updates from Rust
listen<number>("click-count", (event) => {
  updateClickCount(event.payload);
});

// Listen for autoclicker stopped (from repeat count or hotkey)
listen("clicker-stopped", () => {
  updateUI(false);
});

// Listen for hotkey toggle from Rust
listen("toggle-clicker", () => {
  if (isRunning) {
    stopClicking();
  } else {
    startClicking();
  }
});

// Pick position button
pickPositionBtn.addEventListener("click", async () => {
  try {
    const pos = await invoke<{ x: number; y: number }>("get_cursor_position");
    posXInput.value = String(pos.x);
    posYInput.value = String(pos.y);
    // Auto-select "fixed position" radio
    const fixedRadio = document.querySelector('input[name="position"][value="fixed"]') as HTMLInputElement;
    fixedRadio.checked = true;
  } catch (e) {
    console.error("Failed to get cursor position:", e);
  }
});

// Change hotkey
let listeningForHotkey = false;
changeHotkeyBtn.addEventListener("click", () => {
  if (listeningForHotkey) return;
  listeningForHotkey = true;
  hotkeyDisplay.textContent = "Press a key...";
  changeHotkeyBtn.textContent = "Listening...";

  const handler = async (e: KeyboardEvent) => {
    e.preventDefault();
    const key = e.key === " " ? "Space" : e.key;
    hotkeyDisplay.textContent = key;
    listeningForHotkey = false;
    changeHotkeyBtn.textContent = "Change";
    document.removeEventListener("keydown", handler);

    try {
      await invoke("set_hotkey", { key });
    } catch (err) {
      console.error("Failed to set hotkey:", err);
    }
  };

  document.addEventListener("keydown", handler);
});

// Prevent form submission on Enter in number inputs
document.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      (e as KeyboardEvent).preventDefault();
    }
  });
});
