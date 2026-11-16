const { app, BrowserWindow, Tray, ipcMain, screen, dialog, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");

const home = path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "BandoriLoveDesktopPet");
const bundled = process.env.BANDORILOVE_PET_BUNDLE || path.join(process.resourcesPath, "panel");
const profile = path.join(home, "profile");
const descriptor = path.join(home, "connection.json");
const statusFile = path.join(home, "preferences.json");
const token = randomBytes(32).toString("hex");
const roleImportToken = randomBytes(32).toString("hex");
mkdirSync(home, { recursive: true });
app.setPath("userData", path.join(home, "chromium"));
app.setAppUserModelId("BandoriLove.DesktopPet");
let manager, pet, petWindowProcess, tray, backend, bridge, ownPort, selectedPort, managerPort;
let trayMenu, viewerMenu, petScene, petDrag, saveBoundsTimer;
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

function showManager(port = selectedPort || ownPort, viewer = false) {
  if (!manager || manager.isDestroyed()) {
    manager = new BrowserWindow({
      width: 1050, height: 750, minWidth: 600, minHeight: 440,
      title: "BandoriLovePet", autoHideMenuBar: true,
      icon: path.join(bundled, "ControlPanel.ico"), webPreferences: windowOptions,
    });
    guardNavigation(manager, () => managerPort);
    manager.on("close", (event) => {
      if (!quitting) { event.preventDefault(); manager.hide(); }
    });
  }
  const url = base(port) + (viewer ? "/?viewerex=1" : "/");
  const current = manager.webContents.getURL();
  if (managerPort !== port || !current || (viewer && current !== url)) {
    managerPort = port;
    manager.loadURL(url).catch(() => {});
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

function showPet(port) {
  if (selectedPort === port && pet && !pet.isDestroyed() && pet.webContents.getURL()) return;
  selectedPort = port;
  if (!pet || pet.isDestroyed()) {
    const primary = screen.getPrimaryDisplay();
    const { workArea: area } = primary;
    const bounds = preferences.bounds ?? { x: area.x + area.width - 365, y: area.y + area.height - 490, width: 350, height: defaultPetHeight };
    const display = screen.getDisplayMatching(bounds);
    petScene = {
      display,
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
      height: Math.min(maximumPetHeight(display.workArea), Math.max(180, bounds.height)),
    };
    petScene.surface = petViewportBounds();
    pet = new BrowserWindow({
      ...petScene.surface, show: false, transparent: true, frame: false, resizable: false,
      backgroundColor: "#00000000",
      title: "BandoriLovePet 桌宠角色", focusable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: preferences.layer === "top",
      webPreferences: windowOptions,
    });
    pet.on("page-title-updated", (event) => event.preventDefault());
    guardNavigation(pet, () => selectedPort);
    const window = pet;
    const nativeWindow = spawn(path.join(bundled, "PetWindow.exe"), [
      window.getNativeWindowHandle().readBigUInt64LE().toString(), String(process.pid),
    ], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    nativeWindow.on("error", (error) => console.error(error));
    nativeWindow.stdin.on("error", (error) => console.error(error));
    petWindowProcess = nativeWindow;
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
      pet = petWindowProcess = selectedPort = null;
      trayMenu?.close();
    });
  }
  const window = pet;
  const navigation = (petScene.navigation ?? 0) + 1;
  petScene.navigation = navigation;
  if (window.isVisible()) window.hide();
  window.setIgnoreMouseEvents(true);
  window.loadURL(base(port) + "/?pet=1").then(() => {
    // Legacy role panels do not send the first-frame notification.
    if (window === pet && port !== ownPort && petScene.navigation === navigation) void revealPet();
  }).catch((error) => {
    if (window === pet && port === selectedPort && error.code !== "ERR_ABORTED") window.close();
  });
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
  const width = 236, height = 290;
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

function showViewerMenu() {
  if (viewerMenu && !viewerMenu.isDestroyed()) { viewerMenu.focus(); return; }
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const width = 192, height = 206;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, cursor.x + 8));
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, cursor.y + 8));
  const popup = new BrowserWindow({
    x, y, width, height, show: false, frame: false, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, transparent: true, backgroundColor: "#00000000",
    webPreferences: { ...windowOptions, preload: path.join(__dirname, "viewer-menu-preload.cjs") },
  });
  viewerMenu = popup;
  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.webContents.on("will-navigate", (event) => event.preventDefault());
  popup.on("blur", () => popup.close());
  popup.on("closed", () => { viewerMenu = null; });
  popup.once("ready-to-show", () => { popup.setAlwaysOnTop(true, "pop-up-menu"); popup.show(); });
  popup.loadFile(path.join(__dirname, "viewer-menu.html")).catch(() => { if (!popup.isDestroyed()) popup.close(); });
}

async function viewerRequest(route, payload) {
  const response = await fetch(`${base(ownPort)}/api/${route}?viewerex=1`, {
    signal: AbortSignal.timeout(2500),
    ...(payload === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
      body: JSON.stringify(payload),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Live2DViewerEX 操作未完成");
  return result;
}

function panelState(port) {
  return fetch(base(port) + "/api/state", { signal: AbortSignal.timeout(1500) }).then((response) => {
    if (!response.ok) throw new Error("控制台尚未就绪");
    return response.json();
  });
}

async function toggleTrayPet() {
  const current = pet;
  const port = current ? selectedPort : ownPort;
  if (!current && !(await panelState(port)).role) {
    showManager(port);
    return;
  }
  const route = current ? "disconnect-pet" : "connect";
  try {
    const response = await fetch(`${base(port)}/api/${route}`, {
      method: "POST", signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
      body: JSON.stringify(current ? {} : { provider: "pet" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "桌宠操作未完成");
  } catch (error) {
    if (!current) throw error;
  }
  if (current && pet === current && !current.isDestroyed()) current.close();
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

function startBridge() {
  bridge = createServer(async (incoming, response) => {
    const send = (data, code = 200) => {
      response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(data));
    };
    const received = Buffer.from(incoming.headers.authorization || "");
    const expected = Buffer.from("Bearer " + token);
    if (incoming.method !== "POST" || incoming.headers.origin ||
        received.length !== expected.length || !timingSafeEqual(received, expected)) {
      send({ error: "拒绝连接" }, 403);
      return;
    }
    if (Number(incoming.headers["content-length"]) > 4096) { send({ error: "请求过长" }, 413); return; }
    try {
      let body = "";
      for await (const chunk of incoming) {
        body += chunk;
        if (body.length > 4096) { send({ error: "请求过长" }, 413); return; }
      }
      const { port, role } = JSON.parse(body);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { send({ error: "无效端口" }); return; }
      if (incoming.url === "/attach") {
        if (!role || (port !== ownPort && (await panelState(ownPort)).role !== role)) {
          send({ error: "请先在独立桌宠中导入同一个角色" });
          return;
        }
        showPet(port);
        send({ connected: true });
      } else if (incoming.url === "/detach") {
        if (selectedPort === port) pet?.close();
        send({ connected: false });
      } else if (incoming.url === "/status") {
        send({ connected: Boolean(pet && selectedPort === port) });
      } else if (incoming.url === "/viewer-menu" && port === ownPort) {
        showViewerMenu();
        send({ shown: true });
      } else if (incoming.url === "/viewer-menu-close" && port === ownPort) {
        viewerMenu?.close();
        send({ shown: false });
      } else {
        send({ error: "未知操作" }, 404);
      }
    } catch { send({ error: "桌宠无法读取连接请求" }, 400); }
  });
  bridge.listen(0, "127.0.0.1", () => {
    writeFileSync(descriptor, JSON.stringify({ port: bridge.address().port, token }), "utf8");
  });
}

function installHandlers() {
  ipcMain.handle("viewer-menu:state", (event) => {
    if (event.sender === viewerMenu?.webContents) return viewerRequest("state");
  });
  ipcMain.handle("viewer-menu:action", async (event, action) => {
    const popup = viewerMenu;
    if (event.sender !== popup?.webContents) return;
    if (action === "open" || action === "close") {
      popup.close();
      if (action === "open") showManager(ownPort, true);
      return;
    }
    if (!["action", "voice", "costume", "reset"].includes(action)) return;
    try {
      const state = await viewerRequest("state");
      if (!state.viewerLinked) throw new Error("Live2DViewerEX 已断开连接");
      if (action === "reset") await viewerRequest("reset", {});
      else if (state.looping[action]) await viewerRequest("stop", { kind: action });
      else await viewerRequest("operate", { kind: action, loop: true, random: true });
      if (!popup.isDestroyed()) popup.close();
    } catch (error) {
      dialog.showErrorBox("Live2DViewerEX", error.message);
    }
  });
  ipcMain.handle("pet:pick-role", async (event) => {
    if (event.sender !== manager?.webContents || managerPort !== ownPort) return false;
    const { canceled, filePaths } = await dialog.showOpenDialog(manager, {
      title: "选择模型",
      properties: ["openFile"],
      filters: [
        { name: "角色包和模型", extensions: ["zip", "json", "lpk", "wpk"] },
        { name: "BandoriLove 单角色发行 ZIP", extensions: ["zip"] },
        { name: "Live2D 模型 JSON", extensions: ["json"] },
        { name: "ViewerEX 模型包", extensions: ["lpk", "wpk"] },
      ],
    });
    if (canceled) return false;
    const [file] = filePaths;
    await importRole(file);
    preferences.package = file;
    save();
    return true;
  });
  ipcMain.handle("pet:remember", (event, file) => {
    if (event.sender !== manager?.webContents || typeof file !== "string" || path.extname(file).toLowerCase() !== ".zip") return;
    preferences.package = file;
    save();
  });
  ipcMain.on("pet:panel", (event) => {
    if (event.sender === pet?.webContents) showManager();
  });
  ipcMain.on("pet:first-frame", (event) => {
    if (event.sender === pet?.webContents && event.senderFrame?.url === base(selectedPort) + "/?pet=1") void revealPet();
  });
  ipcMain.on("pet:hit", (event, hit) => {
    if (event.sender === pet?.webContents) pet.setIgnoreMouseEvents(hit !== true);
  });
  ipcMain.on("pet:drag", (event, operation) => {
    if (event.sender !== pet?.webContents || !petScene) return;
    if (operation === "end") {
      finishPetDrag();
      return;
    }
    if (!["begin", "move"].includes(operation)) return;
    const point = screen.getCursorScreenPoint();
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
  ipcMain.handle("pet:frame", (event) => event.sender === pet?.webContents && petScene ? petFrame() : null);
  ipcMain.handle("tray:state", (event) => {
    if (event.sender !== trayMenu?.webContents) return null;
    return {
      layer: preferences.layer,
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
      case "import": showManager(ownPort); break;
      case "toggle-pet":
        toggleTrayPet().catch(error => dialog.showErrorBox("BandoriLovePet", error.message));
        break;
      case "top":
      case "bottom":
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
  writeFileSync(path.join(profile, "standalone.mode"), "");
  const endpoint = path.join(profile, ".local", "endpoint.json");
  rmSync(endpoint, { force: true });
  backend = spawn(path.join(bundled, "ControlPanel.exe"), ["--panel-dir", profile, "--no-browser"], {
    windowsHide: true, env: {
      ...process.env, BANDORILOVE_WEB_DIR: path.join(bundled, "web"), BANDORILOVE_ROLE_IMPORT_TOKEN: roleImportToken,
    },
  });
  let failed = false;
  backend.on("error", () => { failed = true; });
  backend.on("exit", () => { if (!quitting) app.quit(); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (failed) throw new Error("无法启动 ControlPanel.exe");
    try {
      ownPort = JSON.parse(readFileSync(endpoint, "utf8")).port;
      await panelState(ownPort);
      break;
    } catch {
      ownPort = null;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }
  if (!ownPort) throw new Error("本地控制台未启动");
  installHandlers();
  const updatePetDisplay = () => {
    if (!petScene) return;
    usePetDisplay(screen.getDisplayMatching(petBounds()));
    fitPetSurface();
    scheduleBoundsSave();
  };
  screen.on("display-metrics-changed", updatePetDisplay);
  screen.on("display-removed", updatePetDisplay);
  startBridge();
  tray = new Tray(nativeImage.createFromPath(path.join(bundled, "ControlPanel.ico")));
  tray.setToolTip("BandoriLovePet");
  tray.on("right-click", (_event, bounds) => showTrayMenu(bounds));
  tray.on("click", () => { trayMenu?.close(); showManager(); });
  if (preferences.package) {
    try { await importRole(preferences.package); } catch { /* The original package may have been moved. */ }
  }
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
    bridge?.close();
    try { rmSync(descriptor, { force: true }); } catch { /* Already gone. */ }
    if (!ownPort) { backend?.kill(); app.quit(); return; }
    fetch(base(ownPort) + "/api/exit", {
      method: "POST", headers: { "X-Studio-Request": "1" }, signal: AbortSignal.timeout(1000),
    }).catch(() => backend?.kill()).finally(() => app.quit());
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox("BandoriLovePet", error.message);
    app.quit();
  });
}
