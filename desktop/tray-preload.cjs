const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petTray", {
  state: () => ipcRenderer.invoke("tray:state"),
  action: (action) => ipcRenderer.send("tray:action", action),
  setSize: (value) => ipcRenderer.send("pet:size:set", value),
  saveSize: () => ipcRenderer.send("pet:size:commit"),
});
