import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
let currentHotkey = "F6";

const $ = (id: string) => document.getElementById(id)!;

// Elements
const startBtn = $("start-btn") as HTMLButtonElement;
const stopBtn = $("stop-btn") as HTMLButtonElement;
const statusDot = $("status-dot");
const statusText = $("status-text");
const clickCountEl = $("click-count");
const hotkeyDisplay = $("hotkey-display");
const settingsHotkeyDisplay = $("settings-hotkey-display");
const countRow = $("count-row");
const positionRow = $("position-row");

const hoursInput = $("hours") as HTMLInputElement;
const minutesInput = $("minutes") as HTMLInputElement;
const secondsInput = $("seconds") as HTMLInputElement;
const msInput = $("milliseconds") as HTMLInputElement;
const mouseButtonSelect = $("mouse-button") as HTMLSelectElement;
const clickTypeSelect = $("click-type") as HTMLSelectElement;
const repeatModeSelect = $("repeat-mode") as HTMLSelectElement;
const repeatCountInput = $("repeat-count") as HTMLInputElement;
const positionModeSelect = $("position-mode") as HTMLSelectElement;
const posXInput = $("pos-x") as HTMLInputElement;
const posYInput = $("pos-y") as HTMLInputElement;

// ── Init ──
invoke("show_window");

// ── Window controls ──
$("btn-minimize").addEventListener("click", () => getCurrentWindow().minimize());
$("btn-close").addEventListener("click", () => getCurrentWindow().close());

// ── Navigation ──
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const page = (btn as HTMLElement).dataset.page!;
    $(`page-${page}`).classList.add("active");
  });
});

// ── Conditional rows ──
repeatModeSelect.addEventListener("change", () => {
  countRow.hidden = repeatModeSelect.value !== "count";
});
positionModeSelect.addEventListener("change", () => {
  positionRow.hidden = positionModeSelect.value !== "fixed";
});

// ── Config ──
function getIntervalMs(): number {
  return (parseInt(hoursInput.value) || 0) * 3600000
       + (parseInt(minutesInput.value) || 0) * 60000
       + (parseInt(secondsInput.value) || 0) * 1000
       + (parseInt(msInput.value) || 0);
}

function getConfig(): ClickerConfig {
  return {
    interval_ms: Math.max(1, getIntervalMs()),
    mouse_button: mouseButtonSelect.value,
    click_type: clickTypeSelect.value,
    repeat_mode: repeatModeSelect.value,
    repeat_count: parseInt(repeatCountInput.value) || 1,
    position_mode: positionModeSelect.value,
    fixed_x: parseInt(posXInput.value) || 0,
    fixed_y: parseInt(posYInput.value) || 0,
  };
}

// ── State ──
function setRunning(running: boolean) {
  isRunning = running;
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  statusDot.classList.toggle("running", running);
  statusText.textContent = running ? "Running" : "Stopped";
}

function setClickCount(n: number) {
  clickCountEl.textContent = `${n.toLocaleString()} click${n !== 1 ? "s" : ""}`;
}

async function start() {
  if (isRunning) return;
  setClickCount(0);
  setRunning(true);
  try { await invoke("start_clicking", { config: getConfig() }); }
  catch { setRunning(false); }
}

async function stop() {
  if (!isRunning) return;
  try { await invoke("stop_clicking"); } catch {}
  setRunning(false);
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

// ── Events from Rust ──
listen<number>("click-count", (e) => setClickCount(e.payload));
listen("clicker-stopped", () => setRunning(false));
listen("toggle-clicker", () => isRunning ? stop() : start());

// ── Pick position ──
$("pick-position").addEventListener("click", async () => {
  try {
    const pos = await invoke<{ x: number; y: number }>("get_cursor_position");
    posXInput.value = String(pos.x);
    posYInput.value = String(pos.y);
  } catch {}
});

// ── Set hotkey (settings page) ──
$("set-hotkey-btn").addEventListener("click", () => {
  settingsHotkeyDisplay.textContent = "...";

  const handler = async (e: KeyboardEvent) => {
    e.preventDefault();
    document.removeEventListener("keydown", handler);

    if (e.key === "Escape") {
      settingsHotkeyDisplay.textContent = currentHotkey;
      return;
    }

    const key = e.key === " " ? "Space" : e.key;
    try {
      await invoke("set_hotkey", { key });
      currentHotkey = key;
      hotkeyDisplay.textContent = key;
      settingsHotkeyDisplay.textContent = key;
    } catch {
      settingsHotkeyDisplay.textContent = currentHotkey;
    }
  };

  document.addEventListener("keydown", handler);
});

// ── Check for updates ──
$("check-update-btn").addEventListener("click", async () => {
  const btn = $("check-update-btn") as HTMLButtonElement;
  const status = $("update-status");
  btn.textContent = "Checking...";
  btn.disabled = true;
  status.textContent = "Checking for updates...";
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      status.textContent = `Version ${update.version} available`;
      btn.textContent = `Install ${update.version}`;
      btn.disabled = false;
      btn.addEventListener("click", async () => {
        btn.textContent = "Downloading...";
        btn.disabled = true;
        status.textContent = "Downloading update...";
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }, { once: true });
    } else {
      status.textContent = "You're on the latest version";
      btn.textContent = "Check for updates";
      btn.disabled = false;
    }
  } catch {
    status.textContent = "Could not check for updates";
    btn.textContent = "Try again";
    btn.disabled = false;
  }
});

// ── Prevent Enter on number inputs ──
document.querySelectorAll('input[type="number"]').forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") (e as KeyboardEvent).preventDefault();
  });
});
