const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("viewerMenu", {
  state: () => ipcRenderer.invoke("viewer-menu:state"),
  action: (action) => ipcRenderer.invoke("viewer-menu:action", action),
});
