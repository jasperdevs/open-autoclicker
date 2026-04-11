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

interface MacroAction {
  type: string;
  detail: string;
  delay_ms: number;
  x?: number | null;
  y?: number | null;
  button?: string | null;
}

interface AppInfo {
  version: string;
  updater_configured: boolean;
  default_toggle_hotkey: string;
}

interface PersistedSettings {
  toggleHotkey: string;
  macroHotkey: string;
  emergencyHotkey: string;
  startMinimized: boolean;
}

type ClickerState = "idle" | "starting" | "running";

const SETTINGS_KEY = "open-autoclicker.settings.v1";
const defaultSettings: PersistedSettings = {
  toggleHotkey: "F6",
  macroHotkey: "",
  emergencyHotkey: "",
  startMinimized: false,
};

let appInfo: AppInfo = {
  version: "0.1.0",
  updater_configured: false,
  default_toggle_hotkey: defaultSettings.toggleHotkey,
};

let clickerState: ClickerState = "idle";
let isMacroRunning = false;
let isMacroRecording = false;
let currentHotkey = defaultSettings.toggleHotkey;
let currentMacroHotkey = "";
let currentEmergencyHotkey = "";
let macroActions: MacroAction[] = [];
let selectedMacroItems = new Set<number>();
let lastClickedMacroItem = -1;
let countdownTimer: number | null = null;
let cancelCountdown: (() => void) | null = null;
let pendingUpdate: { version: string; downloadAndInstall: () => Promise<void> } | null = null;
let startAttemptId = 0;

const $ = (id: string) => document.getElementById(id)!;

const startBtn = $("start-btn") as HTMLButtonElement;
const startBtnLabel = $("start-btn-label");
const stopBtn = $("stop-btn") as HTMLButtonElement;
const statusDot = $("status-dot");
const statusText = $("status-text");
const clickCountEl = $("click-count");
const settingsHotkeyDisplay = $("settings-hotkey-display");
const settingsMacroHotkeyDisplay = $("settings-macro-hotkey-display");
const settingsEmergencyDisplay = $("settings-emergency-display");
const countRow = $("count-row");
const positionRow = $("position-row");
const versionValue = $("version-value");
const updateStatus = $("update-status");
const updateButton = $("check-update-btn") as HTMLButtonElement;
const startMinimizedToggle = $("start-minimized") as HTMLInputElement;

const hoursInput = $("hours") as HTMLInputElement;
const minutesInput = $("minutes") as HTMLInputElement;
const secondsInput = $("seconds") as HTMLInputElement;
const msInput = $("milliseconds") as HTMLInputElement;
const repeatCountInput = $("repeat-count") as HTMLInputElement;
const posXInput = $("pos-x") as HTMLInputElement;
const posYInput = $("pos-y") as HTMLInputElement;

const macroRecordBtn = $("macro-record-btn") as HTMLButtonElement;
const macroPlayBtn = $("macro-play-btn") as HTMLButtonElement;
const macroStopBtn = $("macro-stop-btn") as HTMLButtonElement;
const macroClearBtn = $("macro-clear-btn") as HTMLButtonElement;
const macroStatusDot = $("macro-status-dot");
const macroStatusText = $("macro-status-text");
const macroActionCount = $("macro-action-count");
const macroList = $("macro-list");
const macroCountRow = $("macro-count-row");

function formatHotkey(key: string): string {
  return key || "Not set";
}

function normalizeError(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  const fallback = String(error ?? "").trim();
  return fallback || "Unknown error";
}

function readSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return { ...defaultSettings };
    }

    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      toggleHotkey:
        typeof parsed.toggleHotkey === "string" && parsed.toggleHotkey.trim()
          ? parsed.toggleHotkey
          : defaultSettings.toggleHotkey,
      macroHotkey: typeof parsed.macroHotkey === "string" ? parsed.macroHotkey : "",
      emergencyHotkey:
        typeof parsed.emergencyHotkey === "string" ? parsed.emergencyHotkey : "",
      startMinimized: Boolean(parsed.startMinimized),
    };
  } catch {
    return { ...defaultSettings };
  }
}

function persistCurrentSettings() {
  const settings: PersistedSettings = {
    toggleHotkey: currentHotkey || appInfo.default_toggle_hotkey,
    macroHotkey: currentMacroHotkey,
    emergencyHotkey: currentEmergencyHotkey,
    startMinimized: startMinimizedToggle.checked,
  };

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettings(settings: PersistedSettings) {
  currentHotkey = settings.toggleHotkey || appInfo.default_toggle_hotkey;
  currentMacroHotkey = settings.macroHotkey;
  currentEmergencyHotkey = settings.emergencyHotkey;

  startBtnLabel.textContent = `Start (${currentHotkey})`;
  settingsHotkeyDisplay.textContent = currentHotkey;
  settingsMacroHotkeyDisplay.textContent = formatHotkey(currentMacroHotkey);
  settingsEmergencyDisplay.textContent = formatHotkey(currentEmergencyHotkey);
  startMinimizedToggle.checked = settings.startMinimized;
}

function setClickerState(state: ClickerState) {
  clickerState = state;
  startBtn.disabled = state !== "idle";
  stopBtn.disabled = state === "idle";
  statusDot.classList.toggle("running", state === "running");
  statusText.textContent =
    state === "running" ? "Running" : state === "starting" ? "Starting..." : "Stopped";
  void invoke("set_tray_running", { running: state === "running" });
}

function setClickCount(n: number) {
  clickCountEl.textContent = `${n.toLocaleString()} click${n !== 1 ? "s" : ""}`;
}

function getSelectValue(id: string): string {
  return $(id).dataset.value || "";
}

function getIntervalMs(): number {
  return (parseInt(hoursInput.value, 10) || 0) * 3600000
    + (parseInt(minutesInput.value, 10) || 0) * 60000
    + (parseInt(secondsInput.value, 10) || 0) * 1000
    + (parseInt(msInput.value, 10) || 0);
}

function getConfig(): ClickerConfig {
  return {
    interval_ms: Math.max(1, getIntervalMs()),
    mouse_button: getSelectValue("mouse-button"),
    click_type: getSelectValue("click-type"),
    repeat_mode: getSelectValue("repeat-mode"),
    repeat_count: parseInt(repeatCountInput.value, 10) || 1,
    position_mode: getSelectValue("position-mode"),
    fixed_x: parseInt(posXInput.value, 10) || 0,
    fixed_y: parseInt(posYInput.value, 10) || 0,
  };
}

function cancelPendingStart() {
  if (!cancelCountdown) {
    return;
  }

  const cancel = cancelCountdown;
  cancelCountdown = null;
  cancel();
}

function showCountdown(seconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "countdown-overlay visible";
    const num = document.createElement("div");
    num.className = "countdown-num";
    num.textContent = String(seconds);
    overlay.appendChild(num);
    document.body.appendChild(overlay);

    let remaining = seconds;
    let settled = false;

    const finish = (didComplete: boolean) => {
      if (settled) {
        return;
      }

      settled = true;

      if (countdownTimer !== null) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }

      cancelCountdown = null;
      overlay.remove();
      resolve(didComplete);
    };

    cancelCountdown = () => finish(false);
    countdownTimer = window.setInterval(() => {
      remaining -= 1;

      if (remaining <= 0) {
        finish(true);
      } else {
        num.textContent = String(remaining);
      }
    }, 1000);
  });
}

async function start() {
  if (clickerState !== "idle") {
    return;
  }

  const attemptId = ++startAttemptId;
  const delay = parseInt(getSelectValue("start-delay"), 10) || 0;
  setClickerState("starting");

  if (delay > 0) {
    const shouldStart = await showCountdown(delay);
    if (!shouldStart) {
      setClickerState("idle");
      return;
    }
  }

  if (attemptId !== startAttemptId) {
    return;
  }

  setClickCount(0);

  try {
    await invoke("start_clicking", { config: getConfig() });

    if (attemptId !== startAttemptId) {
      try {
        await invoke("stop_clicking");
      } catch {
        // Ignore stale stop attempts.
      }
      return;
    }

    setClickerState("running");
  } catch (error) {
    setClickerState("idle");
    await showToast("Unable to start clicker", normalizeError(error));
  }
}

async function stop() {
  if (clickerState === "starting") {
    startAttemptId += 1;
    cancelPendingStart();
    setClickerState("idle");
    return;
  }

  if (clickerState !== "running") {
    return;
  }

  try {
    await invoke("stop_clicking");
  } catch {
    // Ignore stop errors and resync the UI.
  }

  setClickerState("idle");
}

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
    .map((action, index) => `
      <div class="macro-item${selectedMacroItems.has(index) ? " selected" : ""}" data-index="${index}">
        <span class="macro-item-type">${action.type}</span>
        <span class="macro-item-detail">${action.detail}</span>
        <span class="macro-item-time">+${action.delay_ms}ms</span>
        <button class="macro-item-del" data-del="${index}" title="Delete">
          <svg width="10" height="10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </div>
    `)
    .join("");

  const existingBar = macroList.querySelector(".macro-delete-bar");
  if (existingBar) {
    existingBar.remove();
  }

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

  macroList.querySelectorAll<HTMLElement>(".macro-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".macro-item-del")) {
        return;
      }

      const index = parseInt(item.dataset.index || "-1", 10);
      handleMacroItemClick(index, event as MouseEvent);
    });
  });

  macroList.querySelectorAll<HTMLElement>(".macro-item-del").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const index = parseInt(button.dataset.del || "-1", 10);
      macroActions.splice(index, 1);
      selectedMacroItems.clear();
      renderMacroList();
    });
  });

  if (!isMacroRunning && !isMacroRecording) {
    macroPlayBtn.disabled = false;
    macroClearBtn.disabled = false;
  }
}

function handleMacroItemClick(index: number, event: MouseEvent) {
  if (event.shiftKey && lastClickedMacroItem >= 0) {
    const startIndex = Math.min(lastClickedMacroItem, index);
    const endIndex = Math.max(lastClickedMacroItem, index);
    for (let current = startIndex; current <= endIndex; current += 1) {
      selectedMacroItems.add(current);
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (selectedMacroItems.has(index)) {
      selectedMacroItems.delete(index);
    } else {
      selectedMacroItems.add(index);
    }
  } else {
    selectedMacroItems.clear();
    selectedMacroItems.add(index);
  }

  lastClickedMacroItem = index;
  renderMacroList();
}

function deleteSelectedMacroItems() {
  const indices = Array.from(selectedMacroItems).sort((a, b) => b - a);
  for (const index of indices) {
    macroActions.splice(index, 1);
  }
  selectedMacroItems.clear();
  renderMacroList();
}

async function showToast(title: string, body: string) {
  try {
    const { sendNotification, isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    let permitted = await isPermissionGranted();
    if (!permitted) {
      permitted = (await requestPermission()) === "granted";
    }
    if (permitted) {
      sendNotification({ title, body });
    }
  } catch {
    // Best-effort only.
  }
}

async function startMacroRecording() {
  if (isMacroRecording || isMacroRunning) {
    return;
  }

  macroActions = [];
  selectedMacroItems.clear();
  renderMacroList();
  setMacroState("recording");

  try {
    await invoke("start_macro_recording");
  } catch (error) {
    setMacroState("idle");
    await showToast("Unable to start recording", normalizeError(error));
  }
}

async function stopMacroRecording() {
  if (!isMacroRecording) {
    return;
  }

  try {
    macroActions = await invoke<MacroAction[]>("stop_macro_recording");
    renderMacroList();
  } catch (error) {
    await showToast("Unable to stop recording", normalizeError(error));
  }

  setMacroState("idle");
}

async function playMacro() {
  if (isMacroRunning || macroActions.length === 0) {
    return;
  }

  const repeatMode = getSelectValue("macro-repeat");
  if ((repeatMode === "count" || repeatMode === "infinite") && !currentMacroHotkey) {
    await showToast(
      "Macro hotkey required",
      "Set a macro hotkey in Settings before using repeat modes.",
    );
    return;
  }

  setMacroState("playing");

  try {
    await invoke("play_macro", {
      actions: macroActions,
      speed: parseFloat(getSelectValue("macro-speed")) || 1,
      repeatMode,
      repeatCount: parseInt(($("macro-repeat-count") as HTMLInputElement).value, 10) || 1,
    });
  } catch (error) {
    setMacroState("idle");
    await showToast("Unable to play macro", normalizeError(error));
  }
}

async function stopMacro() {
  try {
    await invoke("stop_macro");
  } catch {
    // Ignore stop errors and resync the UI.
  }
  setMacroState("idle");
}

function setupHotkeyPicker(
  buttonId: string,
  displayId: string,
  onSet: (key: string) => Promise<void>,
  getCurrentKey: () => string,
) {
  $(buttonId).addEventListener("click", () => {
    const display = $(displayId);
    display.textContent = "...";

    const handler = async (event: KeyboardEvent) => {
      event.preventDefault();
      document.removeEventListener("keydown", handler);

      if (event.key === "Escape") {
        display.textContent = formatHotkey(getCurrentKey());
        return;
      }

      const key = event.key === " " ? "Space" : event.key;

      try {
        await onSet(key);
        display.textContent = formatHotkey(key);
      } catch (error) {
        display.textContent = formatHotkey(getCurrentKey());
        await showToast("Unable to set hotkey", normalizeError(error));
      }
    };

    document.addEventListener("keydown", handler);
  });
}

async function syncHotkeys(settings: PersistedSettings) {
  const fallbackToggle = appInfo.default_toggle_hotkey;
  const requestedToggle = settings.toggleHotkey || fallbackToggle;

  try {
    await invoke("set_hotkey", { key: requestedToggle });
    currentHotkey = requestedToggle;
  } catch {
    currentHotkey = fallbackToggle;
    await invoke("set_hotkey", { key: fallbackToggle });
    await showToast(
      "Toggle hotkey reset",
      `The saved toggle hotkey could not be restored. Reset to ${fallbackToggle}.`,
    );
  }

  if (settings.macroHotkey) {
    try {
      await invoke("set_macro_hotkey", { key: settings.macroHotkey });
      currentMacroHotkey = settings.macroHotkey;
    } catch (error) {
      currentMacroHotkey = "";
      await showToast("Macro hotkey not restored", normalizeError(error));
    }
  }

  if (settings.emergencyHotkey) {
    try {
      await invoke("set_emergency_hotkey", { key: settings.emergencyHotkey });
      currentEmergencyHotkey = settings.emergencyHotkey;
    } catch (error) {
      currentEmergencyHotkey = "";
      await showToast("Emergency hotkey not restored", normalizeError(error));
    }
  }

  startBtnLabel.textContent = `Start (${currentHotkey})`;
  settingsHotkeyDisplay.textContent = currentHotkey;
  settingsMacroHotkeyDisplay.textContent = formatHotkey(currentMacroHotkey);
  settingsEmergencyDisplay.textContent = formatHotkey(currentEmergencyHotkey);
  persistCurrentSettings();
}

function configureUpdaterUi() {
  if (appInfo.updater_configured) {
    updateButton.disabled = false;
    updateButton.textContent = "Check for updates";
    updateStatus.textContent = "Auto-update from GitHub Releases";
    return;
  }

  updateButton.disabled = true;
  updateButton.textContent = "Unavailable";
  updateStatus.textContent = "Updater not configured for this build";
}

function initSelects() {
  document.querySelectorAll<HTMLElement>(".select").forEach((select) => {
    const trigger = select.querySelector(".select-trigger") as HTMLButtonElement;
    const dropdown = select.querySelector(".select-drop")!;

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      document.querySelectorAll(".select.open").forEach((openSelect) => {
        if (openSelect !== select) {
          openSelect.classList.remove("open");
        }
      });
      select.classList.toggle("open");
    });

    dropdown.querySelectorAll<HTMLElement>(".select-opt").forEach((option) => {
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        const value = option.dataset.val || "";
        select.dataset.value = value;
        trigger.textContent = option.textContent || "";
        dropdown.querySelectorAll(".select-opt").forEach((entry) => entry.classList.remove("selected"));
        option.classList.add("selected");
        select.classList.remove("open");
        select.dispatchEvent(new CustomEvent("change", { detail: value }));
      });
    });
  });

  document.addEventListener("click", () => {
    document.querySelectorAll(".select.open").forEach((select) => select.classList.remove("open"));
  });
}

async function initializeApp() {
  try {
    appInfo = await invoke<AppInfo>("app_info");
  } catch {
    // Fallback to the bundled defaults when the backend metadata is unavailable.
  }

  versionValue.textContent = appInfo.version;
  const settings = readSettings();
  applySettings(settings);
  await syncHotkeys(settings);
  configureUpdaterUi();

  if (!startMinimizedToggle.checked) {
    await invoke("show_window");
  }
}

initSelects();
setClickerState("idle");
setClickCount(0);
setMacroState("idle");

$("btn-minimize").addEventListener("click", () => void getCurrentWindow().minimize());
$("btn-close").addEventListener("click", () => void getCurrentWindow().hide());

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((entry) => entry.classList.remove("active"));
    document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
    button.classList.add("active");
    const page = (button as HTMLElement).dataset.page || "home";
    $(`page-${page}`).classList.add("active");
  });
});

$("repeat-mode").addEventListener("change", () => {
  countRow.hidden = getSelectValue("repeat-mode") !== "count";
});

$("position-mode").addEventListener("change", () => {
  positionRow.hidden = getSelectValue("position-mode") !== "fixed";
});

$("macro-repeat").addEventListener("change", () => {
  macroCountRow.hidden = getSelectValue("macro-repeat") !== "count";
});

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", () => void stop());

$("pick-position").addEventListener("click", async () => {
  try {
    const pos = await invoke<{ x: number; y: number }>("get_cursor_position");
    posXInput.value = String(pos.x);
    posYInput.value = String(pos.y);
  } catch (error) {
    await showToast("Unable to read cursor position", normalizeError(error));
  }
});

macroRecordBtn.addEventListener("click", () => {
  void (isMacroRecording ? stopMacroRecording() : startMacroRecording());
});
macroPlayBtn.addEventListener("click", () => void playMacro());
macroStopBtn.addEventListener("click", () => void stopMacro());
macroClearBtn.addEventListener("click", () => {
  macroActions = [];
  selectedMacroItems.clear();
  renderMacroList();
});

setupHotkeyPicker(
  "set-hotkey-btn",
  "settings-hotkey-display",
  async (key) => {
    await invoke("set_hotkey", { key });
    currentHotkey = key;
    startBtnLabel.textContent = `Start (${key})`;
    persistCurrentSettings();
  },
  () => currentHotkey || appInfo.default_toggle_hotkey,
);

setupHotkeyPicker(
  "set-macro-hotkey-btn",
  "settings-macro-hotkey-display",
  async (key) => {
    await invoke("set_macro_hotkey", { key });
    currentMacroHotkey = key;
    persistCurrentSettings();
  },
  () => currentMacroHotkey,
);

setupHotkeyPicker(
  "set-emergency-btn",
  "settings-emergency-display",
  async (key) => {
    await invoke("set_emergency_hotkey", { key });
    currentEmergencyHotkey = key;
    persistCurrentSettings();
  },
  () => currentEmergencyHotkey,
);

updateButton.addEventListener("click", async () => {
  if (!appInfo.updater_configured) {
    return;
  }

  if (pendingUpdate) {
    updateButton.textContent = "Downloading...";
    updateButton.disabled = true;
    updateStatus.textContent = `Downloading ${pendingUpdate.version}...`;

    try {
      await pendingUpdate.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      updateStatus.textContent = "Update failed";
      updateButton.textContent = `Install ${pendingUpdate.version}`;
      updateButton.disabled = false;
      await showToast("Update failed", normalizeError(error));
    }

    return;
  }

  updateButton.textContent = "Checking...";
  updateButton.disabled = true;
  updateStatus.textContent = "Checking for updates...";

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (update) {
      pendingUpdate = update;
      updateStatus.textContent = `Version ${update.version} available`;
      updateButton.textContent = `Install ${update.version}`;
      updateButton.disabled = false;
    } else {
      updateStatus.textContent = "You're on the latest version";
      updateButton.textContent = "Check for updates";
      updateButton.disabled = false;
    }
  } catch (error) {
    updateStatus.textContent = "Could not check for updates";
    updateButton.textContent = "Try again";
    updateButton.disabled = false;
    await showToast("Updater unavailable", normalizeError(error));
  }
});

startMinimizedToggle.addEventListener("change", () => {
  persistCurrentSettings();
});

listen<number>("click-count", (event) => setClickCount(event.payload));
listen("clicker-stopped", () => {
  cancelPendingStart();
  setClickerState("idle");
});
listen<string>("clicker-error", async (event) => {
  await showToast("Clicker blocked", normalizeError(event.payload));
});
listen("toggle-clicker", () => {
  void (clickerState === "idle" ? start() : stop());
});

listen("toggle-macro", () => {
  void (isMacroRunning ? stopMacro() : playMacro());
});
listen("macro-stopped", () => {
  setMacroState("idle");
});
listen<string>("macro-recording-error", async (event) => {
  setMacroState("idle");
  await showToast("Macro recording blocked", normalizeError(event.payload));
});
listen<string>("macro-playback-error", async (event) => {
  setMacroState("idle");
  await showToast("Macro playback blocked", normalizeError(event.payload));
});

document.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") {
      (event as KeyboardEvent).preventDefault();
    }
  });
});

void initializeApp();
