const { app, BrowserWindow, Menu, Tray, ipcMain, screen, dialog, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { createServer, request } = require("node:http");
const { createReadStream, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } = require("node:fs");
const path = require("node:path");

const home = path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "BandoriLoveDesktopPet");
const bundled = process.env.BANDORILOVE_PET_BUNDLE || path.join(process.resourcesPath, "panel");
const profile = path.join(home, "profile");
const descriptor = path.join(home, "connection.json");
const statusFile = path.join(home, "preferences.json");
const token = randomBytes(32).toString("hex");
mkdirSync(home, { recursive: true });
app.setPath("userData", path.join(home, "chromium"));
app.setAppUserModelId("BandoriLove.DesktopPet");
let manager, pet, petWindowProcess, tray, backend, bridge, ownPort, selectedPort, managerPort;
let sizePopup, sizePreview, zoomTimer, saveBoundsTimer, zoomHeight, displayedZoomHeight;
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

function savePetBounds(window) {
  clearTimeout(saveBoundsTimer);
  preferences.bounds = sizePreview?.bounds ?? window.getBounds();
  save();
}

function guardNavigation(win, getPort) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const check = (event, url) => {
    if (new URL(url).origin !== base(getPort())) event.preventDefault();
  };
  win.webContents.on("will-navigate", check);
  win.webContents.on("will-redirect", check);
}

function showManager(port = selectedPort || ownPort) {
  if (!manager || manager.isDestroyed()) {
    manager = new BrowserWindow({
      width: 1050, height: 750, minWidth: 600, minHeight: 440,
      title: "BandoriLove 桌宠", autoHideMenuBar: true,
      icon: path.join(bundled, "ControlPanel.ico"), webPreferences: windowOptions,
    });
    guardNavigation(manager, () => managerPort);
    manager.on("close", (event) => {
      if (!quitting) { event.preventDefault(); manager.hide(); }
    });
  }
  if (managerPort !== port || !manager.webContents.getURL()) {
    managerPort = port;
    manager.loadURL(base(port)).catch(() => {});
  }
  manager.show();
  manager.focus();
}

function windowCommand(command) {
  if (petWindowProcess?.stdin.writable) petWindowProcess.stdin.write(`${command}\n`);
}

function applyPetLayer() {
  if (!pet) return;
  pet.setAlwaysOnTop(preferences.layer === "top", "screen-saver");
  windowCommand(preferences.layer);
}

function showPet(port) {
  selectedPort = port;
  if (!pet || pet.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = preferences.bounds || { x: area.x + area.width - 365, y: area.y + area.height - 490, width: 350, height: defaultPetHeight };
    if (!screen.getAllDisplays().some(({ workArea: a }) =>
      bounds.x >= a.x && bounds.x < a.x + a.width && bounds.y >= a.y && bounds.y < a.y + a.height)) {
      bounds.x = area.x;
      bounds.y = area.y;
    }
    pet = new BrowserWindow({
      ...bounds, show: false, transparent: true, frame: false, resizable: false,
      backgroundColor: "#00000000",
      title: "BandoriLove 桌宠角色", focusable: false, skipTaskbar: true, hasShadow: false,
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
    const scheduleBoundsSave = () => {
      if (sizePreview) return;
      clearTimeout(saveBoundsTimer);
      saveBoundsTimer = setTimeout(() => savePetBounds(window), 180);
    };
    pet.on("moved", scheduleBoundsSave);
    pet.on("resize", scheduleBoundsSave);
    pet.on("close", () => savePetBounds(window));
    pet.on("closed", () => {
      clearInterval(cursorTimer);
      clearTimeout(zoomTimer);
      clearTimeout(saveBoundsTimer);
      zoomTimer = null;
      zoomHeight = displayedZoomHeight = undefined;
      nativeWindow.stdin.end();
      pet = petWindowProcess = selectedPort = null;
      sizePopup?.close();
    });
  }
  pet.loadURL(base(port) + "/?pet=1").then(() => {
    if (pet && !pet.isDestroyed()) {
      pet.setIgnoreMouseEvents(true);
      pet.showInactive();
      applyPetLayer();
    }
  }).catch(() => {});
}

function maximumPetHeight(area) {
  return Math.min(1200, area.height, Math.floor(area.width / 0.745));
}

function petBoundsAtHeight(bounds, workArea, height) {
  const width = Math.round(height * 0.745);
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, bounds.x + Math.round((bounds.width - width) / 2)));
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, bounds.y + bounds.height - height));
  return { x, y, width, height };
}

function drawPetSize() {
  zoomTimer = null;
  if (!pet || zoomHeight === undefined) return;
  const bounds = pet.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  zoomHeight = Math.min(maximumPetHeight(workArea), Math.max(180, zoomHeight));
  const target = Math.round(zoomHeight);
  const current = displayedZoomHeight ?? bounds.height;
  const height = Math.abs(target - current) <= 3 ? target : Math.round(current + (target - current) * 0.55);
  displayedZoomHeight = height;
  const next = petBoundsAtHeight(bounds, workArea, height);
  if (next.width !== bounds.width || height !== bounds.height) pet.setBounds(next);
  if (height !== target) zoomTimer = setTimeout(drawPetSize, 20);
}

function previewPetHeight(height) {
  if (!pet) return;
  if (!sizePreview) {
    clearTimeout(zoomTimer);
    clearTimeout(saveBoundsTimer);
    zoomTimer = null;
    const original = pet.getBounds();
    const { workArea } = screen.getDisplayMatching(original);
    const envelope = petBoundsAtHeight(original, workArea, maximumPetHeight(workArea));
    sizePreview = { original, workArea, envelope, bounds: original };
    pet.setBounds(envelope);
  }
  const { original, workArea, envelope } = sizePreview;
  const bounds = petBoundsAtHeight(original, workArea, Math.round(Math.min(envelope.height, Math.max(180, height))));
  sizePreview.bounds = bounds;
  pet.webContents.send("pet:size-preview", { ...bounds, x: bounds.x - envelope.x, y: bounds.y - envelope.y });
}

function finishSizePreview() {
  if (!sizePreview) return;
  const { bounds } = sizePreview;
  sizePreview = null;
  if (!pet || pet.isDestroyed()) return;
  zoomHeight = displayedZoomHeight = bounds.height;
  pet.setBounds(bounds);
  pet.webContents.send("pet:size-preview", null);
  savePetBounds(pet);
}

function setPetHeight(height) {
  if (!pet) return;
  const { workArea } = screen.getDisplayMatching(pet.getBounds());
  zoomHeight = Math.min(maximumPetHeight(workArea), Math.max(180, height));
  if (!zoomTimer) zoomTimer = setTimeout(drawPetSize, 16);
}

function showPetSize() {
  if (sizePopup && !sizePopup.isDestroyed()) { sizePopup.focus(); return; }
  const anchor = tray.getBounds();
  const { workArea } = screen.getDisplayMatching(anchor);
  const width = 288, height = 108;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, anchor.x + anchor.width - width));
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height - 8, anchor.y - height - 8));
  const popup = new BrowserWindow({
    x, y, width, height, show: false, frame: false, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, backgroundColor: "#faf7fa",
    webPreferences: { preload: path.join(__dirname, "size-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  sizePopup = popup;
  popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  popup.webContents.on("will-navigate", (event) => event.preventDefault());
  popup.on("blur", () => popup.close());
  popup.on("closed", () => {
    if (sizePopup !== popup) return;
    sizePopup = null;
    finishSizePreview();
  });
  popup.once("ready-to-show", () => { popup.setAlwaysOnTop(true, "pop-up-menu"); popup.show(); });
  popup.loadFile(path.join(__dirname, "size.html")).catch(() => { if (!popup.isDestroyed()) popup.close(); });
}

function panelState(port) {
  return fetch(base(port) + "/api/state", { signal: AbortSignal.timeout(1500) }).then((response) => {
    if (!response.ok) throw new Error("控制台尚未就绪");
    return response.json();
  });
}

function restorePackage(file) {
  return new Promise((resolve, reject) => {
    const size = statSync(file).size;
    const upload = request(base(ownPort) + "/api/import", {
      method: "POST", headers: { "Content-Type": "application/zip", "X-Studio-Request": "1", "Content-Length": size },
    }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("上次的角色包无法打开")));
    });
    upload.on("error", reject);
    const input = createReadStream(file);
    input.on("error", (error) => upload.destroy(error));
    input.pipe(upload);
  });
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
  ipcMain.handle("pet:remember", (event, file) => {
    if (event.sender !== manager?.webContents || typeof file !== "string" || path.extname(file).toLowerCase() !== ".zip") return;
    preferences.package = file;
    save();
  });
  ipcMain.on("pet:panel", (event) => {
    if (event.sender === pet?.webContents) showManager();
  });
  ipcMain.on("pet:hit", (event, hit) => {
    if (event.sender === pet?.webContents) pet.setIgnoreMouseEvents(hit !== true);
  });
  ipcMain.on("pet:drag", (event, operation, x, y) => {
    if (event.sender !== pet?.webContents) return;
    if (operation === "end") { windowCommand("end"); return; }
    if (!["begin", "move"].includes(operation) || !Number.isInteger(x) || !Number.isInteger(y)) return;
    if (operation === "begin") {
      clearTimeout(zoomTimer);
      zoomTimer = null;
      zoomHeight = displayedZoomHeight = undefined;
    }
    const pointer = screen.dipToScreenPoint({ x, y });
    windowCommand(`${operation} ${pointer.x} ${pointer.y}`);
  });
  ipcMain.on("pet:zoom", (event, steps) => {
    if (event.sender !== pet?.webContents || sizePreview || !Number.isFinite(steps)) return;
    const factor = 1.12 ** Math.max(-3, Math.min(3, steps));
    setPetHeight((zoomHeight ?? pet.getBounds().height) * factor);
  });
  ipcMain.handle("pet:size:get", (event) => {
    if (event.sender !== sizePopup?.webContents || !pet) return null;
    const bounds = pet.getBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    return {
      min: Math.ceil(180 / defaultPetHeight * 100),
      max: Math.floor(maximumPetHeight(workArea) / defaultPetHeight * 100),
      value: Math.round((zoomHeight ?? bounds.height) / defaultPetHeight * 100),
    };
  });
  ipcMain.on("pet:size:set", (event, percent) => {
    if (event.sender === sizePopup?.webContents && Number.isFinite(percent)) previewPetHeight(percent / 100 * defaultPetHeight);
  });
  ipcMain.on("pet:size:commit", (event) => {
    if (event.sender === sizePopup?.webContents) finishSizePreview();
  });
  ipcMain.on("pet:size:close", (event) => {
    if (event.sender === sizePopup?.webContents) sizePopup.close();
  });
}

async function start() {
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, "standalone.mode"), "");
  const endpoint = path.join(profile, ".local", "endpoint.json");
  rmSync(endpoint, { force: true });
  backend = spawn(path.join(bundled, "ControlPanel.exe"), ["--panel-dir", profile, "--no-browser"], {
    windowsHide: true, env: { ...process.env, BANDORILOVE_WEB_DIR: path.join(bundled, "web") },
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
  startBridge();
  tray = new Tray(nativeImage.createFromPath(path.join(bundled, "ControlPanel.ico")));
  tray.setToolTip("BandoriLove 桌宠");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制台", click: () => showManager() },
    { label: "导入或更换角色", click: () => showManager(ownPort) },
    { label: "退出桌宠", click: () => pet?.close() },
    ...[["top", "浮于最上层"], ["bottom", "浮于最下层"]].map(([layer, label]) => ({
      label, type: "radio", checked: preferences.layer === layer, click: () => {
        preferences.layer = layer;
        save();
        applyPetLayer();
      },
    })),
    { label: "桌宠大小…", click: showPetSize },
    { type: "separator" },
    { label: "退出程序", click: () => app.quit() },
  ]));
  tray.on("click", () => showManager());
  if (preferences.package) {
    try { await restorePackage(preferences.package); } catch { /* The original ZIP may have been moved. */ }
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
    dialog.showErrorBox("BandoriLove 桌宠", error.message);
    app.quit();
  });
}
