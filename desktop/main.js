import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, safeStorage, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listDocks } from "../src/dock.js";
import { runBridge, validateConnection } from "../src/service.js";
import { SettingsStore, settingsEnv } from "./settings.js";
import { loginItemState, openedAtLogin, setLoginItem } from "./login.js";
import { checkForStableUpdate, downloadAndVerifyUpdate } from "./updates.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(directory, "index.html");
if (app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", app.commandLine.getSwitchValue("user-data-dir"));
}
let window;
let tray;
let store;
let task;
let controller;
let quitting = false;
let transition = false;
let pendingUpdate;
let downloadedUpdate;
let state = { status: "stopped", snapshot: null, error: null, update: { status: "idle" } };

function update(patch) {
  state = { ...state, ...patch, running: Boolean(task) };
  if (window && !window.isDestroyed()) window.webContents.send("state", state);
  if (tray) {
    tray.setToolTip(`Dock MQTT - ${state.status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Status: ${state.status}`, enabled: false },
      { label: "Settings and telemetry", click: showWindow },
      { type: "separator" },
      { label: "Start bridge", enabled: !task && !transition, click: () => perform(start) },
      { label: "Stop bridge", enabled: Boolean(task) && !transition, click: () => perform(stop) },
      { type: "separator" },
      { label: "Quit Dock MQTT", click: () => app.quit() },
    ]));
  }
}

function showWindow() {
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      title: "Dock MQTT",
      width: 800,
      height: 820,
      minWidth: 640,
      minHeight: 560,
      show: false,
      webPreferences: {
        preload: path.join(directory, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.on("close", event => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.once("ready-to-show", () => window.show());
    window.loadFile(page).catch(error => {
      update({ status: "error", error: error.message });
      dialog.showErrorBox("Cannot open Dock MQTT", error.message);
    });
  } else {
    window.show();
    window.focus();
  }
}

// macOS uses a "Template" image (with @2x variant) so the menu bar tints it for light and dark modes.
function trayImage() {
  const name = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const image = nativeImage.createFromPath(path.join(directory, "assets", name));
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

async function stop() {
  controller?.abort();
  if (task) await task;
}

async function start() {
  if (task) return;
  const env = settingsEnv(store.settings, store.password);
  validateConnection(env);
  controller = new AbortController();
  task = runBridge({ env, signal: controller.signal, onState: update })
    .catch(error => {
      console.error(error);
      update({ status: "error", error: error.message });
    })
    .finally(() => {
      task = undefined;
      controller = undefined;
      update({});
    });
  update({});
}

function setUpdateState(update) {
  state = { ...state, update };
  updateStateBroadcast();
}

function updateStateBroadcast() {
  if (window && !window.isDestroyed()) window.webContents.send("state", state);
}

async function downloadUpdate() {
  if (!pendingUpdate?.available) throw new Error("Check for updates before downloading");
  setUpdateState({ status: "downloading", currentVersion: app.getVersion(), version: pendingUpdate.version });
  try {
    downloadedUpdate = await downloadAndVerifyUpdate(
      pendingUpdate.asset,
      path.join(app.getPath("userData"), "updates"),
    );
    setUpdateState({
      status: "verified",
      currentVersion: app.getVersion(),
      version: pendingUpdate.version,
      sha256: pendingUpdate.asset.sha256,
      platform: process.platform,
    });
    return { version: pendingUpdate.version, sha256: pendingUpdate.asset.sha256 };
  } catch (error) {
    setUpdateState({ status: "error", currentVersion: app.getVersion(), error: error.message });
    throw error;
  }
}

async function installVerifiedUpdate() {
  if (!downloadedUpdate) throw new Error("Download and verify an update before installing");
  if (process.platform === "darwin") {
    shell.showItemInFolder(downloadedUpdate);
    return { platform: process.platform, manualInstall: true };
  }
  if (process.platform !== "win32") throw new Error(`Updates are not supported on ${process.platform}`);
  await stop();
  const installer = spawn(downloadedUpdate, [], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    installer.once("error", reject);
    installer.once("spawn", resolve);
  });
  installer.unref();
  app.quit();
  return { platform: process.platform, manualInstall: false };
}

async function checkUpdates() {
  setUpdateState({ status: "checking", currentVersion: app.getVersion() });
  try {
    const publicKey = await readFile(path.join(directory, "update-signing-public.pem"), "utf8");
    pendingUpdate = await checkForStableUpdate({
      currentVersion: app.getVersion(),
      publicKey,
    });
    if (!pendingUpdate.available) {
      downloadedUpdate = undefined;
      setUpdateState({
        status: "current",
        currentVersion: pendingUpdate.currentVersion,
        latestVersion: pendingUpdate.latestVersion,
      });
      return pendingUpdate;
    }
    downloadedUpdate = undefined;
    setUpdateState({
      status: "available",
      currentVersion: pendingUpdate.currentVersion,
      version: pendingUpdate.version,
      asset: pendingUpdate.asset.name,
    });
    return pendingUpdate;
  } catch (error) {
    setUpdateState({ status: "error", currentVersion: app.getVersion(), error: error.message });
    throw error;
  }
}

async function checkAndDownloadUpdates() {
  try {
    const result = await checkUpdates();
    if (!result.available) return;
    await downloadUpdate();
    const update = state.update;
    if (process.platform === "win32") {
      const answer = await dialog.showMessageBox({
        type: "info",
        title: "Verified Dock MQTT update",
        message: `Dock MQTT ${update.version} is ready to install.`,
        detail: `The downloaded package SHA-256 matches the signed release manifest:\n${update.sha256}`,
        buttons: ["Install now", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response === 0) await installVerifiedUpdate();
    } else if (process.platform === "darwin") {
      const answer = await dialog.showMessageBox({
        type: "info",
        title: "Verified Dock MQTT update",
        message: `Dock MQTT ${update.version} has been downloaded and verified.`,
        detail: `The package SHA-256 matches the signed release manifest:\n${update.sha256}\n\nOpen the verified ZIP in Finder to install it manually.`,
        buttons: ["Show in Finder", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response === 0) await installVerifiedUpdate();
    }
  } catch (error) {
    console.error("Automatic update check failed:", error);
  }
}

async function perform(action) {
  if (transition || quitting) return { ok: false, error: "Another operation is in progress" };
  transition = true;
  update({});
  try {
    const value = await action();
    update({ error: null });
    return { ok: true, value };
  } catch (error) {
    console.error(error);
    update({ error: error.message });
    return { ok: false, error: error.message };
  } finally {
    transition = false;
    update({});
  }
}

function handle(channel, action) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(page).href) {
      throw new Error("Untrusted application request");
    }
    return perform(() => action(...args));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {});
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => app.quit());
  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stop().catch(error => {
      console.error(error);
      dialog.showErrorBox("Dock MQTT shutdown error", error.message);
    }).finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    store = new SettingsStore(app.getPath("userData"), safeStorage);
    let loaded = false;
    try {
      await store.load();
      loaded = true;
    } catch (error) {
      console.error(error);
      state.error = `Could not load settings: ${error.message}`;
      dialog.showErrorBox("Dock MQTT settings error", state.error);
    }
    tray = new Tray(trayImage());
    tray.on("click", showWindow);
    update({});
    handle("settings", () => store.publicSettings());
    handle("state", () => state);
    handle("devices", async () => {
      if (task) throw new Error("Stop the bridge before refreshing USB devices");
      return (await listDocks()).map(device => ({
        serial: device.serialNumber,
        product: device.product,
      }));
    });
    handle("save", async input => {
      if (task) throw new Error("Stop the bridge before changing settings");
      return store.save(input);
    });
    handle("start", start);
    handle("stop", stop);
    handle("loginItem", () => loginItemState(app));
    handle("setLoginItem", enabled => setLoginItem(app, enabled));
    handle("checkUpdates", checkUpdates);
    handle("downloadUpdate", downloadUpdate);
    handle("installUpdate", installVerifiedUpdate);
    handle("automaticUpdates", checkAndDownloadUpdates);
    if (!openedAtLogin(app)) showWindow();
    if (loaded && store.settings.autoConnect && store.settings.brokerUrl) {
      await perform(start);
    }
    if (loaded && store.settings.autoUpdate) void checkAndDownloadUpdates();
  }).catch(error => {
    console.error(error);
    dialog.showErrorBox("Dock MQTT startup error", error.message);
    app.quit();
  });
}
