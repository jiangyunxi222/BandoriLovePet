const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopPet", {
  showPanel: () => ipcRenderer.send("pet:panel"),
  hit: (active) => ipcRenderer.send("pet:hit", active),
  watchCursor: (callback) => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on("pet:cursor", listener);
    return () => ipcRenderer.removeListener("pet:cursor", listener);
  },
  move: (dx, dy) => ipcRenderer.send("pet:move", dx, dy),
  zoom: (direction) => ipcRenderer.send("pet:zoom", direction),
  rememberPackage: (file) => ipcRenderer.invoke("pet:remember", webUtils.getPathForFile(file)),
});
