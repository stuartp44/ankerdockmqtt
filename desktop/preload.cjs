const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dockApp", {
  settings: () => ipcRenderer.invoke("settings"),
  save: settings => ipcRenderer.invoke("save", settings),
  start: () => ipcRenderer.invoke("start"),
  stop: () => ipcRenderer.invoke("stop"),
  state: () => ipcRenderer.invoke("state"),
  devices: () => ipcRenderer.invoke("devices"),
  loginItem: () => ipcRenderer.invoke("loginItem"),
  setLoginItem: enabled => ipcRenderer.invoke("setLoginItem", enabled),
  checkUpdates: () => ipcRenderer.invoke("checkUpdates"),
  downloadUpdate: () => ipcRenderer.invoke("downloadUpdate"),
  installUpdate: () => ipcRenderer.invoke("installUpdate"),
  automaticUpdates: () => ipcRenderer.invoke("automaticUpdates"),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
});
