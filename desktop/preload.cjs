const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopPet", {
  showPanel: () => ipcRenderer.send("pet:panel"),
  hit: (active) => ipcRenderer.send("pet:hit", active),
  watchCursor: (callback) => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on("pet:cursor", listener);
    return () => ipcRenderer.removeListener("pet:cursor", listener);
  },
  getFrame: () => ipcRenderer.invoke("pet:frame"),
  watchSize: (callback) => { ipcRenderer.on("pet:size-preview", (_event, bounds, animate) => callback(bounds, animate)); },
  drag: (operation, x, y) => ipcRenderer.send("pet:drag", operation, x, y),
  zoom: (direction) => ipcRenderer.send("pet:zoom", direction),
  pickRole: () => ipcRenderer.invoke("pet:pick-role"),
  rememberPackage: (file) => ipcRenderer.invoke("pet:remember", webUtils.getPathForFile(file)),
});
