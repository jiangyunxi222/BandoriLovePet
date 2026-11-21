const { app, BrowserWindow, Tray, ipcMain, screen, dialog, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { createInterface } = require("node:readline");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const appName = app.getName();

const home = path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "BandoriLovePet");
const bundled = process.env.BANDORILOVE_PET_BUNDLE || path.join(process.resourcesPath, "panel");
const profile = path.join(home, "profile");
const statusFile = path.join(home, "preferences.json");
const startup = randomBytes(16).toString("hex");
const roleImportToken = randomBytes(32).toString("hex");
mkdirSync(home, { recursive: true });
app.setPath("userData", path.join(home, "chromium"));
app.setAppUserModelId("BandoriLovePet.Standalone");
let manager, pet, petWindowProcess, tray, backend, ownPort, wallpaper, wallpaperProcess;
let trayMenu, petScene, petDrag, saveBoundsTimer;
let quitting = false;
let preferences = {};
try { preferences = JSON.parse(readFileSync(statusFile, "utf8")); } catch { /* First launch. */ }
preferences.layer ||= preferences.onTop === false ? "bottom" : "top";

const base = (port) => `http://127.0.0.1:${port}`;
const defaultPetHeight = 470;
const windowOptions = {
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true, sandbox: true, nodeIntegration: false,
  autoplayPolicy: "no-user-gesture-required", backgroundThrottling: false,
};

function save() {
  writeFileSync(statusFile, JSON.stringify(preferences), "utf8");
}

function savePetBounds() {
  clearTimeout(saveBoundsTimer);
  if (!petScene) return;
  preferences.bounds = petBounds();
  preferences.rotation = petScene.rotation;
  save();
}

function scheduleBoundsSave() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(savePetBounds, 180);
}

function guardNavigation(win, getPort) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const check = (event, url) => {
    if (new URL(url).origin !== base(getPort())) event.preventDefault();
  };
  win.webContents.on("will-navigate", check);
  win.webContents.on("will-redirect", check);
}

function showManager() {
  if (!manager || manager.isDestroyed()) {
    manager = new BrowserWindow({
      width: 1050, height: 750, minWidth: 600, minHeight: 440,
      title: appName, autoHideMenuBar: true,
      icon: path.join(bundled, "ControlPanel.ico"), webPreferences: windowOptions,
    });
    guardNavigation(manager, () => ownPort);
    manager.on("closed", () => { manager = null; });
    manager.loadURL(base(ownPort)).catch(() => {});
  }
  manager.show();
  manager.focus();
}

function windowCommand(command) {
  if (!petWindowProcess?.stdin.writable) return false;
  petWindowProcess.stdin.write(`${command}\n`);
  return true;
}

function applyPetLayer() {
  if (!pet) return;
  pet.setAlwaysOnTop(preferences.layer === "top", "screen-saver");
  windowCommand(preferences.layer);
}

function defaultPetBounds(area) {
  return { x: area.x + area.width - 365, y: area.y + area.height - 490, width: 350, height: defaultPetHeight };
}

function showPet() {
  if (pet && !pet.isDestroyed()) return;
  if (!pet || pet.isDestroyed()) {
    const primary = screen.getPrimaryDisplay();
    const { workArea: area } = primary;
    const bounds = preferences.bounds ?? defaultPetBounds(area);
    const display = screen.getDisplayMatching(bounds);
    petScene = {
      display,
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
      height: Math.min(maximumPetHeight(display.workArea), Math.max(180, bounds.height)),
      rotation: Number.isFinite(preferences.rotation) ? preferences.rotation % 360 : 0,
    };
    petScene.surface = petViewportBounds();
    pet = new BrowserWindow({
      ...petScene.surface, show: false, transparent: true, frame: false, resizable: false,
      backgroundColor: "#00000000",
      title: `${appName} 桌宠角色`, focusable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: preferences.layer === "top",
      webPreferences: windowOptions,
    });
    pet.on("page-title-updated", (event) => event.preventDefault());
    guardNavigation(pet, () => ownPort);
    const window = pet;
    const nativeWindow = spawn(path.join(bundled, "PetWindow.exe"), [
      window.getNativeWindowHandle().readBigUInt64LE().toString(), String(process.pid),
    ], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    nativeWindow.on("error", (error) => console.error(error));
    nativeWindow.stdin.on("error", (error) => console.error(error));
    petWindowProcess = nativeWindow;
    createInterface({ input: nativeWindow.stdout }).on("line", (line) => {
      if (window !== pet || !["visible 0", "visible 1"].includes(line)) return;
      window.nativeVisible = line.endsWith("1");
      void publishDesktopState();
    });
    let inside = false;
    const cursorTimer = setInterval(() => {
      if (!window.isVisible()) return;
      const cursor = screen.getCursorScreenPoint();
      const bounds = window.getContentBounds();
      const x = cursor.x - bounds.x;
      const y = cursor.y - bounds.y;
      const within = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      if (within || inside) window.webContents.send("pet:cursor", within ? { x, y } : null);
      inside = within;
    }, 40);
    pet.on("close", savePetBounds);
    pet.on("closed", () => {
      clearInterval(cursorTimer);
      clearTimeout(saveBoundsTimer);
      clearTimeout(petDrag?.timer);
      petScene = petDrag = null;
      nativeWindow.stdin.end();
      pet = petWindowProcess = null;
      void publishDesktopState();
      trayMenu?.close();
    });
  }
  const window = pet;
  petScene.navigation = 1;
  if (window.isVisible()) window.hide();
  window.setIgnoreMouseEvents(true);
  window.loadURL(base(ownPort) + "/?pet=1").catch(() => { if (window === pet) window.close(); });
  void publishDesktopState();
}

async function revealPet() {
  if (!pet || pet.isVisible()) return;
  const window = pet;
  const scene = petScene;
  const navigation = scene.navigation;
  if (scene.revealing === navigation) return;
  scene.revealing = navigation;
  const deadline = Date.now() + 450;
  try {
    while (window === pet && navigation === scene.navigation && Date.now() < deadline) {
      // Let Chromium paint for the capture while the native window remains hidden.
      const image = await Promise.race([window.capturePage(), delay(Math.max(0, deadline - Date.now()))]);
      if (!image || frameHasVisiblePixels(image)) break;
      await delay(24);
    }
  } catch { /* The renderer has already submitted its first frame. */ }
  if (window !== pet || navigation !== scene.navigation || window.isDestroyed()) return;
  applyPetLayer();
  window.showInactive();
  window.nativeVisible = true;
  void publishDesktopState();
  if (preferences.layer === "bottom") windowCommand("bottom");
}

function frameHasVisiblePixels(image) {
  const pixels = image.toBitmap();
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha] > 16) return true;
  }
  return false;
}

function maximumPetHeight(area) {
  return Math.min(1200, area.height, Math.floor(area.width / 0.745));
}

function petBounds(size = petScene.height) {
  const { x, y: foot, display: { workArea } } = petScene;
  const height = Math.round(size);
  const width = Math.round(height * 0.745);
  const y = foot - height / 2;
  // Allow the frame to overhang a screen edge while leaving its center reachable.
  const centerX = petDrag?.moved ? x : Math.max(workArea.x, Math.min(workArea.x + workArea.width - 1, x));
  const centerY = petDrag?.moved ? y : Math.max(workArea.y, Math.min(workArea.y + workArea.height - 1, y));
  return { x: Math.round(centerX - width / 2), y: Math.round(centerY - height / 2), width, height };
}

function petViewportBounds() {
  const { workArea } = petScene.display;
  // Reserve the full zoom range so changing the scale never resizes the layered HWND.
  const frame = petBounds(maximumPetHeight(workArea));
  const side = Math.min(Math.floor((workArea.width - frame.width) / 2), Math.max(52, Math.ceil(frame.width * .14)));
  return { x: frame.x - side, y: frame.y, width: frame.width + side * 2, height: frame.height };
}

function movePetSurface(bounds, publish = true) {
  const previous = petScene.surface;
  petScene.surface = bounds;
  if (publish) sendPetFrame();
  if (previous.width !== bounds.width || previous.height !== bounds.height) {
    pet.setBounds(bounds);
  } else if (previous.x !== bounds.x || previous.y !== bounds.y) {
    const point = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
    if (!windowCommand(`move ${point.x} ${point.y}`)) pet.setPosition(bounds.x, bounds.y);
  }
}

function fitPetSurface() {
  if (!petScene || petDrag?.moved) return;
  movePetSurface(petViewportBounds());
}

function petFrame() {
  const { surface } = petScene;
  const { x, y, width, height } = petBounds();
  return {
    x: x - surface.x, y: y - surface.y, width, height,
    originX: surface.x, originY: surface.y, surfaceWidth: surface.width, surfaceHeight: surface.height,
    rotation: petScene.rotation,
  };
}

function sendPetFrame(animate = false) {
  if (pet && petScene) pet.webContents.send("pet:size-preview", petFrame(), animate);
}

function setPetHeight(height, animate) {
  if (!petScene || petDrag?.moved) return;
  petScene.height = Math.min(maximumPetHeight(petScene.display.workArea), Math.max(180, height));
  sendPetFrame(animate);
  scheduleBoundsSave();
}

function usePetDisplay(display) {
  petScene.display = display;
  petScene.height = Math.min(petScene.height, maximumPetHeight(display.workArea));
}

function finishPetDrag() {
  clearTimeout(petDrag?.timer);
  if (petDrag?.pending) movePet(petDrag.pending);
  const finalFrame = petDrag?.moved ? petBounds() : null;
  petDrag = null;
  if (!finalFrame) return;
  usePetDisplay(screen.getDisplayNearestPoint({
    x: Math.round(finalFrame.x + finalFrame.width / 2),
    y: Math.round(finalFrame.y + finalFrame.height / 2),
  }));
  const { x, y, width, height } = petBounds();
  petScene.x = x + width / 2;
  petScene.y = y + height;
  fitPetSurface();
  scheduleBoundsSave();
}

function queuePetMove(point) {
  const drag = petDrag;
  drag.pending = point;
  if (drag.timer) return;
  drag.timer = setTimeout(() => {
    drag.timer = null;
    if (petDrag !== drag) return;
    movePet(drag.pending);
    drag.pending = null;
  }, 16);
}

function movePet({ x, y }) {
  const dx = x - petDrag.pointerX;
  const dy = y - petDrag.pointerY;
  petDrag.moved = true;
  petScene.x = petDrag.x + dx;
  petScene.y = petDrag.y + dy;
  const { surface } = petDrag;
  movePetSurface({ ...surface, x: surface.x + dx, y: surface.y + dy }, false);
}

function showTrayMenu(bounds) {
  if (trayMenu && !trayMenu.isDestroyed()) { trayMenu.focus(); return; }
  const anchor = bounds?.width && bounds?.height ? bounds : { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
  const { workArea } = screen.getDisplayMatching(anchor);
  const width = 236, height = 328;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, anchor.x + anchor.width - width));
  const preferredY = anchor.y - height - 6 >= workArea.y ? anchor.y - height - 6 : anchor.y + anchor.height + 6;
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, preferredY));
  const popup = new BrowserWindow({
    x, y, width, height, show: false, frame: false, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, transparent: true, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "tray-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  trayMenu = popup;
  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.webContents.on("will-navigate", (event) => event.preventDefault());
  popup.on("blur", () => popup.close());
  popup.on("closed", () => {
    if (trayMenu === popup) trayMenu = null;
  });
  popup.once("ready-to-show", () => { popup.setAlwaysOnTop(true, "pop-up-menu"); popup.show(); });
  popup.loadFile(path.join(__dirname, "tray-menu.html")).catch(() => { if (!popup.isDestroyed()) popup.close(); });
}

function panelState(port) {
  return fetch(base(port) + "/api/state", { signal: AbortSignal.timeout(1500) }).then((response) => {
    if (!response.ok) throw new Error("控制台尚未就绪");
    return response.json();
  });
}

function showWallpaper() {
  if (wallpaper) return wallpaper.ready;
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    ...display.bounds, show: false, frame: false, focusable: false, skipTaskbar: true, resizable: false,
    backgroundColor: "#fbf5f9", opacity: 0, title: `${appName} 壁纸`, webPreferences: windowOptions,
  });
  wallpaper = win;
  guardNavigation(win, () => ownPort);
  win.on("page-title-updated", (event) => event.preventDefault());
  win.setIgnoreMouseEvents(true);
  win.on("closed", () => {
    if (wallpaper !== win) return;
    wallpaper = null;
    wallpaperProcess?.stdin.end();
    wallpaperProcess = null;
    void publishDesktopState();
  });
  win.webContents.on("render-process-gone", () => {
    if (wallpaper === win && !quitting) win.webContents.reload();
  });
  win.ready = new Promise((resolve, reject) => {
    win.resolveReady = resolve;
    win.rejectReady = reject;
    const timeout = setTimeout(() => reject(new Error("壁纸模型或素材加载超时")), 20000);
    win.once("closed", () => reject(new Error("壁纸已关闭")));
    win.loadURL(base(ownPort) + "/?wallpaper=1").catch(reject);
    win.finishReady = () => clearTimeout(timeout);
  }).catch((error) => {
    if (!win.isDestroyed()) win.close();
    throw error;
  }).finally(() => win.finishReady());
  return win.ready;
}

function wallpaperBounds() {
  const display = screen.getPrimaryDisplay();
  const { x, y } = screen.dipToScreenPoint(display.bounds);
  const width = Math.round(display.bounds.width * display.scaleFactor);
  const height = Math.round(display.bounds.height * display.scaleFactor);
  return { x, y, width, height };
}

function fitWallpaperDisplay() {
  if (!wallpaper?.attached || !wallpaperProcess?.stdin.writable) return;
  const { x, y, width, height } = wallpaper.deviceBounds = wallpaperBounds();
  wallpaperProcess.stdin.write(`bounds ${x} ${y} ${width} ${height}\n`);
}

function attachWallpaper(win) {
  if (win !== wallpaper || wallpaperProcess) return;
  const { x, y, width, height } = win.deviceBounds = wallpaperBounds();
  win.showInactive();
  const host = spawn(path.join(bundled, "WallpaperHost.exe"), [
    win.getNativeWindowHandle().readBigUInt64LE().toString(), process.pid, x, y, width, height,
  ].map(String), { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  wallpaperProcess = host;
  host.stdin.on("error", () => {});
  host.on("error", () => win.rejectReady(new Error("无法启动 Windows 壁纸服务")));
  host.on("close", () => {
    if (win !== wallpaper) return;
    win.rejectReady(new Error("无法挂载到 Windows 桌面图标下方"));
    if (!win.isDestroyed()) win.close();
  });
  createInterface({ input: host.stdout }).on("line", (line) => {
    if (win !== wallpaper || win.isDestroyed()) return;
    if (line === "ready") {
      win.attached = true;
      fitWallpaperDisplay();
      publishDesktopState().then(() => win.resolveReady(true), win.rejectReady);
      return;
    }
    if (line === "active 1" || line === "active 0") {
      win.desktopActive = line.endsWith("1");
      void publishDesktopState();
      return;
    }
    const [action, rawX, rawY] = line.split(" ");
    if (!["down", "move", "up", "cancel"].includes(action)) return;
    win.webContents.send("wallpaper:pointer", {
      action, x: Number(rawX) / win.deviceBounds.width, y: Number(rawY) / win.deviceBounds.height,
    });
  });
}

let wallpaperToggle;
function toggleWallpaper() {
  wallpaperToggle ??= changeWallpaper().finally(() => { wallpaperToggle = null; });
  return wallpaperToggle;
}

async function changeWallpaper() {
  if (wallpaper) {
    const current = wallpaper;
    await new Promise(resolve => {
      current.once("closed", resolve);
      current.close();
    });
    await desktopUpdates;
    if (!wallpaper) manager?.webContents.send("wallpaper:result", false);
    return false;
  }
  if (!(await panelState(ownPort)).role) throw new Error("请先导入一个模型");
  const applied = await showWallpaper();
  if (wallpaper?.attached) manager?.webContents.send("wallpaper:result", true);
  return applied;
}

async function togglePet() {
  if (pet) pet.close();
  else if ((await panelState(ownPort)).role) showPet();
  else showManager();
  return Boolean(pet && !pet.isDestroyed());
}

let desktopUpdates = Promise.resolve();
function publishDesktopState() {
  const state = { pet: Boolean(pet), petVisible: Boolean(pet?.nativeVisible),
    wallpaper: Boolean(wallpaper?.attached), wallpaperActive: Boolean(wallpaper?.desktopActive) };
  desktopUpdates = desktopUpdates.catch(() => {}).then(async () => {
    if (quitting) return;
    const response = await fetch(base(ownPort) + "/api/desktop-state", {
      method: "POST", signal: AbortSignal.timeout(2000),
      headers: { "Content-Type": "application/json", "X-Studio-Request": "1", Authorization: `Bearer ${roleImportToken}` },
      body: JSON.stringify(state),
    });
    if (!response.ok) throw new Error("桌面状态更新失败");
  });
  desktopUpdates.catch(console.error);
  return desktopUpdates;
}

async function importRole(file) {
  const response = await fetch(`${base(ownPort)}/api/import-folder`, {
    method: "POST",
    headers: {
      "X-Studio-Request": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${roleImportToken}`,
    },
    body: JSON.stringify({ entry: file }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "无法导入角色包");
}

function installHandlers() {
  ipcMain.on("manager:fullscreen", (event, active) => {
    if (event.sender === manager?.webContents && typeof active === "boolean") manager.setFullScreen(active);
  });
  ipcMain.handle("pet:placement", (event, layer) => {
    if (event.sender !== manager?.webContents) return null;
    if (["top", "bottom", "home"].includes(layer)) {
      preferences.layer = layer;
      save();
      applyPetLayer();
    }
    return preferences.layer;
  });
  ipcMain.on("desktop:stop", (event) => {
    if (event.sender === pet?.webContents) pet.close();
    if (event.sender === wallpaper?.webContents) void toggleWallpaper().catch(error => {
      dialog.showErrorBox(appName, error.message);
    });
  });
  ipcMain.handle("pet:toggle", (event) => event.sender === manager?.webContents && togglePet());
  ipcMain.handle("wallpaper:toggle", (event) => event.sender === manager?.webContents && toggleWallpaper());
  ipcMain.handle("theme:get", (event) => [manager, pet, wallpaper].some(win => win?.webContents === event.sender)
    ? preferences.theme : undefined);
  ipcMain.on("theme:set", (event, theme) => {
    if (event.sender !== manager?.webContents || typeof theme !== "string" || !/^[a-z]{3,12}$/.test(theme)) return;
    preferences.theme = theme;
    save();
    for (const win of [manager, pet, wallpaper]) {
      if (win && !win.isDestroyed()) win.webContents.send("theme:changed", theme);
    }
  });
  ipcMain.on("wallpaper:first-frame", (event) => {
    if (event.sender !== wallpaper?.webContents || event.senderFrame?.url !== base(ownPort) + "/?wallpaper=1") return;
    attachWallpaper(wallpaper);
  });
  ipcMain.handle("manager:capture", async (event, rect) => {
    if (event.sender !== manager?.webContents || !rect ||
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)) return null;
    const { width, height } = manager.getContentBounds();
    if (rect.x < 0 || rect.y < 0 || rect.width < 16 || rect.height < 16 || rect.x + rect.width > width + 1 || rect.y + rect.height > height + 1) return null;
    const image = await manager.webContents.capturePage(rect);
    return image.resize({ width: Math.min(420, image.getSize().width) }).toDataURL();
  });
  ipcMain.handle("pet:pick-role", async (event) => {
    if (event.sender !== manager?.webContents) return false;
    const { canceled, filePaths } = await dialog.showOpenDialog(manager, {
      title: "选择模型",
      properties: ["openFile"],
      filters: [
        { name: "角色包和模型", extensions: ["zip", "json", "lpk", "wpk"] },
        { name: "BandoriLove 单角色发行 ZIP", extensions: ["zip"] },
        { name: "Live2D 模型 JSON", extensions: ["json"] },
        { name: "Live2D 模型包", extensions: ["lpk", "wpk"] },
      ],
    });
    if (canceled) return false;
    const [file] = filePaths;
    await importRole(file);
    return true;
  });
  ipcMain.on("pet:panel", (event) => {
    if (event.sender === pet?.webContents || event.sender === wallpaper?.webContents) showManager();
  });
  ipcMain.on("pet:first-frame", (event) => {
    if (event.sender === pet?.webContents && event.senderFrame?.url === base(ownPort) + "/?pet=1") void revealPet();
  });
  ipcMain.on("pet:hit", (event, hit) => {
    if (event.sender === pet?.webContents) pet.setIgnoreMouseEvents(hit !== true);
  });
  ipcMain.on("pet:drag", (event, operation, x, y, touch) => {
    if (event.sender !== pet?.webContents || !petScene) return;
    if (operation === "end") {
      finishPetDrag();
      return;
    }
    if (!["begin", "move"].includes(operation)) return;
    const point = touch === true && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : screen.getCursorScreenPoint();
    if (operation === "begin") {
      const bounds = petBounds();
      petDrag = {
        pointerX: point.x, pointerY: point.y, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height,
        surface: petScene.surface, moved: false,
      };
    }
    if (operation === "move" && petDrag) queuePetMove(point);
  });
  ipcMain.on("pet:zoom", (event, steps) => {
    if (event.sender !== pet?.webContents || !petScene || !Number.isFinite(steps)) return;
    const factor = 1.12 ** Math.max(-3, Math.min(3, steps));
    setPetHeight(petScene.height * factor, true);
  });
  ipcMain.on("pet:pinch", (event, height) => {
    if (event.sender === pet?.webContents && Number.isFinite(height)) setPetHeight(height, false);
  });
  ipcMain.on("pet:transform", (event, rotation, reset) => {
    if (event.sender !== pet?.webContents || !petScene || !Number.isFinite(rotation)) return;
    finishPetDrag();
    petScene.rotation = reset === true ? 0 : rotation % 360;
    if (reset === true) {
      const area = petScene.display.workArea;
      const bounds = defaultPetBounds(area);
      petScene.height = Math.min(maximumPetHeight(area), bounds.height);
      petScene.x = bounds.x + bounds.width / 2;
      petScene.y = bounds.y + bounds.height;
      fitPetSurface();
    } else sendPetFrame();
    scheduleBoundsSave();
  });
  ipcMain.handle("pet:frame", (event) => event.sender === pet?.webContents && petScene ? petFrame() : null);
  ipcMain.handle("tray:state", (event) => {
    if (event.sender !== trayMenu?.webContents) return null;
    return {
      layer: preferences.layer,
      wallpaper: Boolean(wallpaper?.attached),
      size: petScene ? {
        min: Math.ceil(180 / defaultPetHeight * 100),
        max: Math.floor(maximumPetHeight(petScene.display.workArea) / defaultPetHeight * 100),
        value: Math.round(petScene.height / defaultPetHeight * 100),
      } : null,
    };
  });
  ipcMain.on("pet:size:set", (event, percent) => {
    if (event.sender === trayMenu?.webContents && Number.isFinite(percent)) setPetHeight(percent / 100 * defaultPetHeight, false);
  });
  ipcMain.on("pet:size:commit", (event) => {
    if (event.sender !== trayMenu?.webContents) return;
    savePetBounds();
  });
  ipcMain.on("tray:action", (event, action) => {
    if (event.sender !== trayMenu?.webContents) return;
    trayMenu.close();
    switch (action) {
      case "open": showManager(); break;
      case "import": showManager(); break;
      case "toggle-pet":
        togglePet().catch(error => dialog.showErrorBox(appName, error.message));
        break;
      case "toggle-wallpaper":
        toggleWallpaper().catch(error => dialog.showErrorBox(appName, error.message));
        break;
      case "top":
      case "bottom":
      case "home":
        preferences.layer = action;
        save();
        applyPetLayer();
        break;
      case "quit": app.quit(); break;
    }
  });
}

async function start() {
  mkdirSync(profile, { recursive: true });
  const endpoint = path.join(profile, ".local", "endpoint.json");
  backend = spawn(path.join(bundled, "ControlPanel.exe"), ["--panel-dir", profile, "--no-browser"], {
    windowsHide: true, env: {
      ...process.env, BANDORILOVE_WEB_DIR: path.join(bundled, "web"), BANDORILOVE_ROLE_IMPORT_TOKEN: roleImportToken, BANDORILOVE_STARTUP: startup,
    },
  });
  let failed = false;
  backend.on("error", () => { failed = true; });
  backend.on("exit", () => { if (!quitting) app.quit(); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (failed) throw new Error("无法启动 ControlPanel.exe");
    try {
      const connection = JSON.parse(readFileSync(endpoint, "utf8"));
      if (connection.startup !== startup) throw new Error("Backend is still starting");
      ownPort = connection.port;
      await panelState(ownPort);
      break;
    } catch {
      ownPort = null;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
  if (!ownPort) throw new Error("本地控制台未启动");
  installHandlers();
  const updateDesktopDisplays = () => {
    fitWallpaperDisplay();
    if (!petScene) return;
    usePetDisplay(screen.getDisplayMatching(petBounds()));
    fitPetSurface();
    scheduleBoundsSave();
  };
  screen.on("display-metrics-changed", updateDesktopDisplays);
  screen.on("display-added", updateDesktopDisplays);
  screen.on("display-removed", updateDesktopDisplays);
  tray = new Tray(nativeImage.createFromPath(path.join(bundled, "ControlPanel.ico")));
  tray.setToolTip(appName);
  tray.on("right-click", (_event, bounds) => showTrayMenu(bounds));
  tray.on("click", () => { trayMenu?.close(); showManager(); });
  try {
    const response = await fetch(base(ownPort) + "/api/model-restore", {
      method: "POST", headers: { "X-Studio-Request": "1", Authorization: `Bearer ${roleImportToken}` },
    });
    if (response.ok && !(await response.json()).restored && preferences.package) await importRole(preferences.package);
  } catch { /* Model history remains available when its original file has moved. */ }
  if (preferences.package) { delete preferences.package; save(); }
  showManager();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (ownPort) showManager(); });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    wallpaper?.close();
    pet?.close();
    if (!ownPort) { backend?.kill(); app.quit(); return; }
    fetch(base(ownPort) + "/api/exit", {
      method: "POST", headers: { "X-Studio-Request": "1" }, signal: AbortSignal.timeout(1000),
    }).catch(() => backend?.kill()).finally(() => app.quit());
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(appName, error.message);
    app.quit();
  });
}
