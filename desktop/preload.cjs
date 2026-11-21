const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopPet", {
  showPanel: () => ipcRenderer.send("pet:panel"),
  firstFrame: () => ipcRenderer.send("pet:first-frame"),
  hit: (active) => ipcRenderer.send("pet:hit", active),
  watchCursor: (callback) => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on("pet:cursor", listener);
    return () => ipcRenderer.removeListener("pet:cursor", listener);
  },
  getFrame: () => ipcRenderer.invoke("pet:frame"),
  watchSize: (callback) => { ipcRenderer.on("pet:size-preview", (_event, bounds, animate) => callback(bounds, animate)); },
  drag: (operation, x, y, touch) => ipcRenderer.send("pet:drag", operation, x, y, touch),
  zoom: (direction) => ipcRenderer.send("pet:zoom", direction),
  pinch: (height) => ipcRenderer.send("pet:pinch", height),
  transform: (rotation, reset) => ipcRenderer.send("pet:transform", rotation, reset),
  pickRole: () => ipcRenderer.invoke("pet:pick-role"),
  togglePet: () => ipcRenderer.invoke("pet:toggle"),
  toggleWallpaper: () => ipcRenderer.invoke("wallpaper:toggle"),
  watchWallpaperResult: (callback) => ipcRenderer.on("wallpaper:result", (_event, applied) => callback(applied)),
  wallpaperFirstFrame: () => ipcRenderer.send("wallpaper:first-frame"),
  watchWallpaperPointer: (callback) => ipcRenderer.on("wallpaper:pointer", (_event, pointer) => callback(pointer)),
  captureScene: (rect) => ipcRenderer.invoke("manager:capture", rect),
  fullscreen: (active) => ipcRenderer.send("manager:fullscreen", active),
  placement: (layer) => ipcRenderer.invoke("pet:placement", layer),
  stopDisplay: () => ipcRenderer.send("desktop:stop"),
  theme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (theme) => ipcRenderer.send("theme:set", theme),
  watchTheme: (callback) => ipcRenderer.on("theme:changed", (_event, theme) => callback(theme)),
});
