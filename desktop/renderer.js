const form = document.querySelector("#settings");
const errorBox = document.querySelector("#error");
let busy = false;
let active = false;

function error(message) {
  errorBox.textContent = message || "";
  errorBox.hidden = !message;
}

function controls() {
  document.querySelector("#fields").disabled = busy || active;
  document.querySelector("#save").disabled = busy || active;
  document.querySelector("#refresh").disabled = busy || active;
  document.querySelector("#start").disabled = busy || active;
  document.querySelector("#stop").disabled = busy || !active;
  for (const button of ["#checkUpdates", "#downloadUpdate", "#installUpdate"]) {
    document.querySelector(button).disabled = busy;
  }
}

function applySettings(settings) {
  for (const key of ["brokerUrl", "username", "topic", "clientId", "serial", "discoveryPrefix"]) {
    form.elements[key].value = settings[key];
  }
  form.elements.interval.value = settings.intervalMs / 1000;
  form.elements.autoConnect.checked = settings.autoConnect;
  form.elements.autoUpdate.checked = settings.autoUpdate;
  form.elements.discoveryEnabled.checked = settings.discoveryEnabled;
  form.elements.password.value = "";
  form.elements.password.placeholder = settings.hasPassword ? "Saved - leave blank to keep" : "Optional";
  form.elements.clearPassword.checked = false;
}

function ethernetLink(mbps) {
  if (mbps === null) return "Unknown";
  if (mbps === 0) return "No link";
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

function ago(iso) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const relative = seconds < 60 ? `${seconds}s ago`
    : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  return `${new Date(iso).toLocaleTimeString()} (${relative})`;
}

const DOCK_LABELS = {
  connected: "Connected",
  disconnected: "Disconnected from this laptop",
  busy: "In use by another app",
  error: "Error",
};

let lastState = null;

function renderDiagnostics() {
  const mqtt = lastState?.mqtt ?? {};
  const connected = ago(mqtt.connectedAt);
  document.querySelector("#diagConnected").textContent = connected ? `Connected since ${connected}` : "Not connected";
  document.querySelector("#diagPublished").textContent = ago(mqtt.lastPublishedAt) ?? "Never";
  document.querySelector("#diagReceived").textContent = ago(mqtt.lastReceivedAt) ?? "Never";
  document.querySelector("#diagDock").textContent = DOCK_LABELS[lastState?.dock] ?? "Unknown";
}

setInterval(renderDiagnostics, 1000);

function render(state) {
  lastState = state;
  renderDiagnostics();
  active = state.running;
  const status = document.querySelector("#status");
  status.textContent = state.status;
  status.dataset.status = state.status;
  error(state.error);
  controls();
  renderUpdate(state.update);
  if (!state.snapshot) return;
  document.querySelector("#timestamp").textContent = `Last reading: ${new Date(state.snapshot.timestamp).toLocaleString()} (${state.status})`;
  document.querySelector("#telemetry").textContent = JSON.stringify(state.snapshot, null, 2);
  const ports = state.snapshot.ports;
  const metrics = [
    ["Laptop charging", `${ports.host.power_w} W`],
    ["Host USB link", ports.upstream.link],
    ["Ethernet link", ethernetLink(ports.ethernet.max_bandwidth_mbps)],
  ];
  const summary = document.querySelector("#summary");
  summary.replaceChildren();
  for (const [label, value] of metrics) {
    const card = document.createElement("div");
    card.className = "metric";
    card.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    card.append(strong);
    summary.append(card);
  }
}

function renderUpdate(update = {}) {
  const status = document.querySelector("#updateStatus");
  const verification = document.querySelector("#updateVerification");
  const download = document.querySelector("#downloadUpdate");
  const install = document.querySelector("#installUpdate");
  download.hidden = update.status !== "available";
  install.hidden = update.status !== "verified";
  install.textContent = update.platform === "darwin" ? "Show verified ZIP in Finder" : "Install verified update";
  verification.textContent = update.sha256
    ? `Verified package SHA-256: ${update.sha256}`
    : "";
  const messages = {
    idle: "Updates are not checked yet.",
    checking: `Checking for stable updates (current version ${update.currentVersion ?? "unknown"})…`,
    current: `You are up to date. Current version: ${update.currentVersion}. Latest stable: ${update.latestVersion}.`,
    available: `Stable version ${update.version} is available for this device.`,
    downloading: `Downloading and verifying Dock MQTT ${update.version}…`,
    verified: `Dock MQTT ${update.version} is downloaded and verified. Confirm install to continue.`,
    error: `Update check failed: ${update.error}`,
  };
  status.textContent = messages[update.status] ?? "Update status unavailable.";
}

async function operation(action) {
  busy = true;
  controls();
  error(null);
  try {
    const result = await action();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  } catch (failure) {
    error(failure.message);
    return undefined;
  } finally {
    busy = false;
    controls();
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  operation(async () => {
    const settings = {};
    for (const key of ["brokerUrl", "username", "password", "topic", "clientId", "serial", "discoveryPrefix"]) {
      settings[key] = form.elements[key].value;
    }
    settings.intervalMs = Number(form.elements.interval.value) * 1000;
    settings.autoConnect = form.elements.autoConnect.checked;
    settings.autoUpdate = form.elements.autoUpdate.checked;
    settings.discoveryEnabled = form.elements.discoveryEnabled.checked;
    settings.clearPassword = form.elements.clearPassword.checked;
    const result = await window.dockApp.save(settings);
    if (result.ok) {
      applySettings(result.value);
      if (result.value.autoUpdate) void operation(() => window.dockApp.automaticUpdates());
    }
    return result;
  });
});

document.querySelector("#start").addEventListener("click", () => operation(() => window.dockApp.start()));
document.querySelector("#stop").addEventListener("click", () => operation(() => window.dockApp.stop()));
document.querySelector("#refresh").addEventListener("click", () => operation(async () => {
  const result = await window.dockApp.devices();
  if (result.ok) {
    document.querySelector("#devices").textContent = result.value.length
      ? result.value.map(device => `${device.product}: ${device.serial || "no serial"}`).join(", ")
      : "No A83B3 dock found. Check its USB connection.";
    if (result.value.length === 1) form.elements.serial.value = result.value[0].serial || "";
  }
  return result;
}));
document.querySelector("#checkUpdates").addEventListener("click", () => operation(() => window.dockApp.checkUpdates()));
document.querySelector("#downloadUpdate").addEventListener("click", () => operation(() => window.dockApp.downloadUpdate()));
document.querySelector("#installUpdate").addEventListener("click", () => operation(() => window.dockApp.installUpdate()));
const startAtLogin = document.querySelector("#startAtLogin");
const loginHint = document.querySelector("#loginHint");

function applyLoginItem(item) {
  startAtLogin.disabled = !item.supported;
  startAtLogin.checked = item.enabled;
  const hints = [];
  if (item.requiresApproval) hints.push("Approve Dock MQTT in System Settings > General > Login Items.");
  if (item.enabled && !form.elements.autoConnect.checked) {
    hints.push("Also enable \"Connect automatically\" and save, so the bridge starts after login.");
  }
  loginHint.textContent = hints.join(" ");
  loginHint.hidden = hints.length === 0;
}

startAtLogin.addEventListener("change", () => operation(async () => {
  const result = await window.dockApp.setLoginItem(startAtLogin.checked);
  if (result.ok) applyLoginItem(result.value);
  else startAtLogin.checked = !startAtLogin.checked;
  return result;
}));
form.elements.autoConnect.addEventListener("change", async () => {
  const item = await window.dockApp.loginItem();
  if (item.ok) applyLoginItem(item.value);
});
window.dockApp.onState(render);

operation(async () => {
  const settings = await window.dockApp.settings();
  if (!settings.ok) return settings;
  applySettings(settings.value);
  const item = await window.dockApp.loginItem();
  if (item.ok) applyLoginItem(item.value);
  const state = await window.dockApp.state();
  if (state.ok) render(state.value);
  return state;
});
