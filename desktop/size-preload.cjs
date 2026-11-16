const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petSize", {
  get: () => ipcRenderer.invoke("pet:size:get"),
  set: (value) => ipcRenderer.send("pet:size:set", value),
  commit: () => ipcRenderer.send("pet:size:commit"),
  close: () => ipcRenderer.send("pet:size:close"),
});
