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
let isMacroRunning = false;
let isMacroRecording = false;
let currentHotkey = "F6";
let currentMacroHotkey = "";
let macroActions: { type: string; detail: string; delay_ms: number }[] = [];
let selectedMacroItems = new Set<number>();
let lastClickedMacroItem = -1;
let countdownTimer: number | null = null;

const $ = (id: string) => document.getElementById(id)!;

// macOS glass detection
if (navigator.userAgent.includes("Mac")) {
  document.documentElement.classList.add("macos");
}

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
const repeatCountInput = $("repeat-count") as HTMLInputElement;
const posXInput = $("pos-x") as HTMLInputElement;
const posYInput = $("pos-y") as HTMLInputElement;

// Macro elements
const macroRecordBtn = $("macro-record-btn") as HTMLButtonElement;
const macroPlayBtn = $("macro-play-btn") as HTMLButtonElement;
const macroStopBtn = $("macro-stop-btn") as HTMLButtonElement;
const macroClearBtn = $("macro-clear-btn") as HTMLButtonElement;
const macroStatusDot = $("macro-status-dot");
const macroStatusText = $("macro-status-text");
const macroActionCount = $("macro-action-count");
const macroList = $("macro-list");
const macroCountRow = $("macro-count-row");

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

// ── Custom Select dropdowns ──
function initSelects() {
  document.querySelectorAll<HTMLElement>(".select").forEach((sel) => {
    const trigger = sel.querySelector(".select-trigger") as HTMLButtonElement;
    const drop = sel.querySelector(".select-drop")!;

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      // Close all other selects
      document.querySelectorAll(".select.open").forEach((s) => {
        if (s !== sel) s.classList.remove("open");
      });
      sel.classList.toggle("open");
    });

    drop.querySelectorAll<HTMLElement>(".select-opt").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const val = opt.dataset.val!;
        const label = opt.textContent!;
        sel.dataset.value = val;
        trigger.textContent = label;
        drop.querySelectorAll(".select-opt").forEach((o) => o.classList.remove("selected"));
        opt.classList.add("selected");
        sel.classList.remove("open");
        sel.dispatchEvent(new CustomEvent("change", { detail: val }));
      });
    });
  });

  // Close selects on outside click
  document.addEventListener("click", () => {
    document.querySelectorAll(".select.open").forEach((s) => s.classList.remove("open"));
  });
}

initSelects();

function getSelectValue(id: string): string {
  return $(id).dataset.value || "";
}

// ── Conditional rows ──
$("repeat-mode").addEventListener("change", () => {
  countRow.hidden = getSelectValue("repeat-mode") !== "count";
});
$("position-mode").addEventListener("change", () => {
  positionRow.hidden = getSelectValue("position-mode") !== "fixed";
});
$("macro-repeat").addEventListener("change", () => {
  macroCountRow.hidden = getSelectValue("macro-repeat") !== "count";
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
    mouse_button: getSelectValue("mouse-button"),
    click_type: getSelectValue("click-type"),
    repeat_mode: getSelectValue("repeat-mode"),
    repeat_count: parseInt(repeatCountInput.value) || 1,
    position_mode: getSelectValue("position-mode"),
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
  invoke("set_tray_running", { running });
}

function setClickCount(n: number) {
  clickCountEl.textContent = `${n.toLocaleString()} click${n !== 1 ? "s" : ""}`;
}

async function start() {
  if (isRunning) return;

  const delay = parseInt(getSelectValue("start-delay")) || 0;
  if (delay > 0) {
    await showCountdown(delay);
  }

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

// ── Countdown ──
function showCountdown(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "countdown-overlay visible";
    const num = document.createElement("div");
    num.className = "countdown-num";
    num.textContent = String(seconds);
    overlay.appendChild(num);
    document.body.appendChild(overlay);

    let remaining = seconds;
    countdownTimer = window.setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(countdownTimer!);
        countdownTimer = null;
        overlay.remove();
        resolve();
      } else {
        num.textContent = String(remaining);
      }
    }, 1000);
  });
}

// ── Events from Rust ──
listen<number>("click-count", (e) => setClickCount(e.payload));
listen("clicker-stopped", () => setRunning(false));
listen("toggle-clicker", () => isRunning ? stop() : start());

// ── Macro events ──
listen("toggle-macro", () => {
  if (isMacroRunning) {
    stopMacro();
  } else {
    playMacro();
  }
});

listen("macro-stopped", () => {
  setMacroState("idle");
});

listen("emergency-stop", () => {
  // Emergency stop handled by Rust (exits app)
});

// ── Pick position ──
$("pick-position").addEventListener("click", async () => {
  try {
    const pos = await invoke<{ x: number; y: number }>("get_cursor_position");
    posXInput.value = String(pos.x);
    posYInput.value = String(pos.y);
  } catch {}
});

// ── Macro functions ──
function setMacroState(state: "idle" | "recording" | "playing") {
  isMacroRecording = state === "recording";
  isMacroRunning = state === "playing";

  macroRecordBtn.disabled = state === "playing";
  macroPlayBtn.disabled = state !== "idle" || macroActions.length === 0;
  macroStopBtn.disabled = state === "idle";
  macroClearBtn.disabled = state !== "idle" || macroActions.length === 0;

  macroStatusDot.classList.toggle("running", state === "playing");
  macroStatusDot.classList.toggle("recording", state === "recording");
  macroStatusText.textContent =
    state === "recording" ? "Recording" : state === "playing" ? "Playing" : "Idle";
}

function renderMacroList() {
  macroActionCount.textContent = `${macroActions.length} action${macroActions.length !== 1 ? "s" : ""}`;

  if (macroActions.length === 0) {
    macroList.innerHTML = '<div class="macro-empty">No actions recorded</div>';
    macroPlayBtn.disabled = true;
    macroClearBtn.disabled = true;
    return;
  }

  macroList.innerHTML = macroActions
    .map((a, i) => `
      <div class="macro-item${selectedMacroItems.has(i) ? " selected" : ""}" data-index="${i}">
        <span class="macro-item-type">${a.type}</span>
        <span class="macro-item-detail">${a.detail}</span>
        <span class="macro-item-time">+${a.delay_ms}ms</span>
        <button class="macro-item-del" data-del="${i}" title="Delete">
          <svg width="10" height="10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
    `)
    .join("");

  // Selection bar
  const existingBar = macroList.querySelector(".macro-delete-bar");
  if (existingBar) existingBar.remove();

  if (selectedMacroItems.size > 0) {
    const bar = document.createElement("div");
    bar.className = "macro-delete-bar visible";
    bar.innerHTML = `
      <span class="macro-delete-count">${selectedMacroItems.size} selected</span>
      <button class="btn compact" id="macro-del-selected">
        <img src="/icons/trash.svg" class="btn-icon" alt="" />
        Delete
      </button>
    `;
    macroList.appendChild(bar);
    bar.querySelector("#macro-del-selected")!.addEventListener("click", deleteSelectedMacroItems);
  }

  // Click handlers
  macroList.querySelectorAll<HTMLElement>(".macro-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".macro-item-del")) return;
      const idx = parseInt(item.dataset.index!);
      handleMacroItemClick(idx, e as MouseEvent);
    });
  });

  macroList.querySelectorAll<HTMLElement>(".macro-item-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt((btn as HTMLElement).dataset.del!);
      macroActions.splice(idx, 1);
      selectedMacroItems.clear();
      renderMacroList();
    });
  });

  if (!isMacroRunning && !isMacroRecording) {
    macroPlayBtn.disabled = false;
    macroClearBtn.disabled = false;
  }
}

function handleMacroItemClick(idx: number, e: MouseEvent) {
  if (e.shiftKey && lastClickedMacroItem >= 0) {
    const start = Math.min(lastClickedMacroItem, idx);
    const end = Math.max(lastClickedMacroItem, idx);
    for (let i = start; i <= end; i++) {
      selectedMacroItems.add(i);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selectedMacroItems.has(idx)) {
      selectedMacroItems.delete(idx);
    } else {
      selectedMacroItems.add(idx);
    }
  } else {
    selectedMacroItems.clear();
    selectedMacroItems.add(idx);
  }
  lastClickedMacroItem = idx;
  renderMacroList();
}

function deleteSelectedMacroItems() {
  const indices = Array.from(selectedMacroItems).sort((a, b) => b - a);
  for (const idx of indices) {
    macroActions.splice(idx, 1);
  }
  selectedMacroItems.clear();
  renderMacroList();
}

async function startMacroRecording() {
  if (isMacroRecording || isMacroRunning) return;
  macroActions = [];
  selectedMacroItems.clear();
  renderMacroList();
  setMacroState("recording");
  try {
    await invoke("start_macro_recording");
  } catch {
    setMacroState("idle");
  }
}

async function stopMacroRecording() {
  if (!isMacroRecording) return;
  try {
    const actions = await invoke<{ type: string; detail: string; delay_ms: number }[]>("stop_macro_recording");
    macroActions = actions;
    renderMacroList();
  } catch {}
  setMacroState("idle");
}

async function showToast(title: string, body: string) {
  try {
    const { sendNotification, isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    let permitted = await isPermissionGranted();
    if (!permitted) {
      const result = await requestPermission();
      permitted = result === "granted";
    }
    if (permitted) {
      sendNotification({ title, body });
    }
  } catch {}
}

async function playMacro() {
  if (isMacroRunning || macroActions.length === 0) return;

  const repeatMode = getSelectValue("macro-repeat");

  // Safety: require macro hotkey for count/infinite repeat
  if ((repeatMode === "count" || repeatMode === "infinite") && !currentMacroHotkey) {
    showToast("Macro hotkey required", "Set a macro hotkey in Settings before using repeat modes.");
    return;
  }

  setMacroState("playing");

  const speed = parseFloat(getSelectValue("macro-speed")) || 1;
  const repeatCount = parseInt(($("macro-repeat-count") as HTMLInputElement).value) || 1;

  try {
    await invoke("play_macro", {
      actions: macroActions,
      speed,
      repeatMode,
      repeatCount,
    });
  } catch {}
}

async function stopMacro() {
  try { await invoke("stop_macro"); } catch {}
  setMacroState("idle");
}

macroRecordBtn.addEventListener("click", () => {
  if (isMacroRecording) {
    stopMacroRecording();
  } else {
    startMacroRecording();
  }
});

macroPlayBtn.addEventListener("click", playMacro);
macroStopBtn.addEventListener("click", stopMacro);
macroClearBtn.addEventListener("click", () => {
  macroActions = [];
  selectedMacroItems.clear();
  renderMacroList();
});

// ── Set hotkey (settings page) ──
function setupHotkeyPicker(btnId: string, displayId: string, onSet: (key: string) => Promise<void>, getCurrentKey: () => string) {
  $(btnId).addEventListener("click", () => {
    const display = $(displayId);
    display.textContent = "...";

    const handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      document.removeEventListener("keydown", handler);

      if (e.key === "Escape") {
        display.textContent = getCurrentKey() || "Not set";
        return;
      }

      const key = e.key === " " ? "Space" : e.key;
      try {
        await onSet(key);
        display.textContent = key;
      } catch {
        display.textContent = getCurrentKey() || "Not set";
      }
    };

    document.addEventListener("keydown", handler);
  });
}

// Toggle hotkey
setupHotkeyPicker("set-hotkey-btn", "settings-hotkey-display", async (key) => {
  await invoke("set_hotkey", { key });
  currentHotkey = key;
  hotkeyDisplay.textContent = key;
}, () => currentHotkey);

// Macro hotkey
setupHotkeyPicker("set-macro-hotkey-btn", "settings-macro-hotkey-display", async (key) => {
  await invoke("set_macro_hotkey", { key });
  currentMacroHotkey = key;
}, () => currentMacroHotkey);

// Emergency hotkey
setupHotkeyPicker("set-emergency-btn", "settings-emergency-display", async (key) => {
  await invoke("set_emergency_hotkey", { key });
}, () => "");

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
