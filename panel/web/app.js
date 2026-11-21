"use strict";

const $ = (selector) => document.querySelector(selector);
const labels = { action: "动作", expression: "表情", costume: "衣装", voice: "语音", favorites: "收藏" };
const loopKinds = ["action", "expression", "voice", "costume"];
const directions = { body: "正面动作", left: "左向动作", right: "右向动作", other: "其他动作" };
const view = {
  catalog: null, state: null, tab: "action", importRevision: 0,
  onlyFavorites: false, favoriteCategory: "all", request: 0, model: null,
  petWindow: document.documentElement.hasAttribute("data-desktop-pet"), modelSize: null,
  wallpaper: document.documentElement.hasAttribute("data-wallpaper"),
  app: null, mouthIds: [], mouth: 0, thumbnails: new Map(), visibleVoice: null,
  currentAction: null, currentExpression: null, modelKey: null, volume: null,
  switchingCostume: false, desiredCostume: null, modelReady: Promise.resolve(),
  itemsSignature: "", listContext: "", scrollPositions: new Map(),
};
const subtitle = $("#subtitle");
const subtitleDrag = enableCaptionDrag(subtitle, () => view.sizePreview ?? {
  x: 0, y: 0, width: subtitle.parentElement.clientWidth, height: subtitle.parentElement.clientHeight,
});
const audio = new Audio();
audio.preload = "metadata";
let audioContext;
let analyser;
let audioData;
let toastTimer;
let actionTimer;
let audioGeneration = 0;
let thumbnailBusy = false;
let preferenceQueue = Promise.resolve();
const pendingPreferences = new Map();

function preferenceValue(key) {
  return pendingPreferences.has(key) ? pendingPreferences.get(key).value : view.state.settings[key];
}

async function savePreference(key, value) {
  const change = { value };
  pendingPreferences.set(key, change);
  renderState();
  const request = preferenceQueue.then(() => api("preference", { key, value }));
  preferenceQueue = request.catch(() => {});
  try {
    const state = await request;
    if (state.sequence >= view.state.sequence) view.state = state;
  } finally {
    if (pendingPreferences.get(key) === change) pendingPreferences.delete(key);
    renderState();
  }
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3300);
}

function showWallpaperResult(applied) {
  $("#wallpaper-result-title").textContent = applied ? "壁纸已应用" : "壁纸已退出";
  $("#wallpaper-result-message").textContent = applied ? "已设为主屏幕壁纸。" : "已恢复桌面的原壁纸。";
  if (!$("#wallpaper-result").open) $("#wallpaper-result").showModal();
}

async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作未能完成，请重试");
  return result;
}

function safely(callback) {
  return (...arguments_) => Promise.resolve(callback(...arguments_)).catch((error) => toast(error.message));
}

function currentCostume() {
  return view.catalog?.costumes.find((costume) => costume.id === view.state?.settings.costume);
}

function itemSymbol(item, kind) {
  const faces = {
    neutral: '<path d="M8 10h.01M16 10h.01M8 16h8"/>',
    smile: '<path d="M8 10h.01M16 10h.01M7 14q5 6 10 0"/>',
    laugh: '<path d="m6 10 2-2 2 2m4 0 2-2 2 2M7 14h10q-5 9-10 0Z"/>',
    angry: '<path d="m6 8 4 2m8-2-4 2M8 12h.01M16 12h.01M8 17q4-4 8 0"/>',
    sad: '<path d="M8 10h.01M16 10h.01M8 17q4-4 8 0m-3-4 1 2-1 1-1-1Z"/>',
    surprise: '<path d="M8 9h.01M16 9h.01"/><ellipse cx="12" cy="16" rx="2" ry="3"/>',
    shy: '<path d="M8 10h.01M16 10h.01M10 16q2 2 4 0M6 13l1 1m10-1 1 1"/>',
    think: '<path d="M7 9h3m4 1h3M8 16h7m2-10 1-2"/>',
    tired: '<path d="M6 10h4m4 0h4M10 16h4"/>',
    confident: '<path d="m6 9 4 1m4 0 4-1M8 15q5 4 9-1"/>',
    wink: '<path d="m6 10 4 1M16 10h.01M8 15q4 4 8 0"/>',
    dizzy: '<path d="M9 9c-4-3-5 4-1 3 2-1 0-3-1-2m9-1c-4-3-5 4-1 3 2-1 0-3-1-2M9 17h6"/>',
    singing: '<path d="M7 9h.01M15 9h.01"/><ellipse cx="11" cy="16" rx="2" ry="3"/><path d="M18 3v5l3-1V2Zm0 5-1 1m4-2-1 1"/>',
    sparkle: '<path d="m8 8 1 2 2 1-2 1-1 2-1-2-2-1 2-1Zm8 0 1 2 2 1-2 1-1 2-1-2-2-1 2-1ZM9 17h6"/>',
    heart: '<path d="M8 10h.01M16 10h.01M8 15q4 4 8 0M19 5c-4-2-1-5 1-3 2-2 5 1 1 3l-1 1Z"/>',
    special: '<path d="M8 10h.01M16 10h.01M9 16h6M20 2v4m-2-2h4"/>',
  };
  const categories = [
    [/眩晕/, 'dizzy'], [/歌唱/, 'singing'], [/眨眼/, 'wink'], [/开怀大笑|大笑|咧嘴笑/, 'laugh'],
    [/生气|气愤|愤怒|不满|厌恶/, 'angry'], [/哭|难过|悲|绝望|寂寞|痛苦/, 'sad'],
    [/惊|震|慌/, 'surprise'], [/害羞|脸红|尴尬/, 'shy'],
    [/自信|得意|冷笑|轻蔑|偷笑|窃笑/, 'confident'], [/微笑|浅笑|笑容|含笑|开心|安心/, 'smile'],
    [/困倦|疲惫|叹气|无聊|泄气/, 'tired'], [/思|困惑|疑|不安|担心|出神|犹豫|忐忑/, 'think'],
    [/心动/, 'heart'], [/爱心眼|闪亮眼/, 'sparkle'], [/特殊|专属|高光|隐藏|阴影|苍白|面具/, 'special'],
  ];
  let paths;
  if (kind === 'expression') {
    const category = categories.find(([pattern]) => pattern.test(item.name))?.[1] || 'neutral';
    paths = '<circle cx="12" cy="12" r="9"/>' + faces[category];
  } else {
    paths = {
      body: '<circle cx="12" cy="5" r="2"/><path d="M12 7v7m-6-4 6 2 6-2m-6 4-4 7m4-7 4 7"/>',
      left: '<path d="m9 6-5 5 5 5M4 11h9q7 0 7 8"/>',
      right: '<path d="m15 6 5 5-5 5m5-5h-9q-7 0-7 8"/>',
      other: '<path d="m4 5 16-2 1 5-16 2ZM5 10v10h16V9M8 5l3 4m3-5 3 4M5 14h16"/>',
    }[item.category || 'other'];
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function favoriteSet() {
  return new Set(view.state?.settings.favorites || []);
}

function itemList(kind) {
  if (!view.catalog) return [];
  if (kind === "voice") return view.catalog.voices.filter(voice => !voice.costumeIds || voice.costumeIds.includes(currentCostume()?.id));
  if (kind === "costume") return view.catalog.costumes;
  return currentCostume()?.[kind === "action" ? "actions" : "expressions"] || [];
}

function asset(path) {
  return `/assets/${view.catalog.id}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function makeItem(item, kind, favorites) {
  const card = document.createElement("article");
  card.className = "item-card";
  card.dataset.kind = kind;
  card.dataset.item = String(item.id);
  const playing = kind === "voice" ? view.visibleVoice?.id === item.id : kind === "action" ? view.currentAction?.id === item.id : kind === "expression" ? view.currentExpression === item.id : false;
  card.classList.toggle("playing", playing);
  const wearing = kind === "costume" && item.id === currentCostume().id;
  card.classList.toggle("wearing", wearing);
  const main = document.createElement("button");
  main.className = "item-main";
  main.disabled = Boolean(view.switchingCostume && kind !== "costume");
  main.title = item.name;
  main.setAttribute("aria-label", (kind === "costume" ? "换上" : kind === "expression" ? "应用" : "播放") + item.name);
  main.addEventListener("click", safely(() => playItem(kind, item)));
  const title = document.createElement("strong");
  title.textContent = item.name || `语音 ${item.id + 1}`;
  if (kind === "voice") {
    const play = document.createElement("span");
    play.className = "voice-play";
    play.textContent = playing ? "Ⅱ" : "▶";
    const copy = document.createElement("span");
    copy.className = "voice-copy";
    const detail = document.createElement("small");
    detail.textContent = `${Math.round(item.duration)} 秒`;
    copy.append(title, detail);
    main.append(play, copy);
  } else if (kind === "costume") {
    const picture = document.createElement("span");
    picture.className = "costume-picture";
    picture.dataset.costume = String(item.id);
    const thumbnail = view.thumbnails.get(`${view.catalog.id}:${item.id}`) || item.thumbnail;
    if (thumbnail) {
      const image = document.createElement("img");
      image.src = thumbnail;
      image.alt = item.name;
      image.loading = "lazy";
      image.addEventListener("error", () => {
        item.thumbnail = null;
        view.thumbnails.delete(`${view.catalog.id}:${item.id}`);
        picture.replaceChildren();
        queueVisibleThumbnails();
      }, { once: true });
      picture.append(image);
    } else {
      const symbol = document.createElement("span");
      symbol.className = "item-symbol";
      symbol.textContent = "♧";
      picture.append(symbol);
    }
    main.append(picture, title);
    if (wearing) {
      const tag = document.createElement("span");
      tag.className = "wearing-tag";
      tag.textContent = "当前";
      card.append(tag);
    }
  } else {
    const symbol = document.createElement("span");
    symbol.className = "item-symbol";
    symbol.innerHTML = itemSymbol(item, kind);
    main.append(symbol, title);
    if (kind === "action") {
      const direction = document.createElement("small");
      direction.textContent = directions[item.category];
      main.append(direction);
    }
  }
  const heart = document.createElement("button");
  const enabled = favorites.has(item.flag);
  heart.className = "heart-button" + (enabled ? " favorited" : "");
  heart.textContent = enabled ? "♥" : "♡";
  heart.title = enabled ? "取消收藏" : "添加收藏";
  heart.setAttribute("aria-label", heart.title + " " + item.name);
  heart.setAttribute("aria-pressed", String(enabled));
  heart.addEventListener("click", safely(async () => {
    heart.disabled = true;
    try {
      view.state = await api("favorite", { flag: item.flag, enabled: !favoriteSet().has(item.flag) });
      renderItems();
    } finally { heart.disabled = false; }
  }));
  if (view.tab === "favorites") {
    const type = document.createElement("span");
    type.className = "item-kind";
    type.textContent = labels[kind];
    card.append(type);
  }
  card.append(main, heart);

  return card;
}

function refreshCards(entries, favorites) {
  const cards = $("#items").children;
  entries.forEach(({ item, kind }, index) => {
    const card = cards[index];
    const playing = kind === "voice" ? view.visibleVoice?.id === item.id : kind === "action" ? view.currentAction?.id === item.id : kind === "expression" && view.currentExpression === item.id;
    card.classList.toggle("playing", Boolean(playing));
    const wearing = kind === "costume" && item.id === currentCostume().id;
    card.classList.toggle("wearing", wearing);
    const main = card.querySelector(".item-main");
    main.disabled = Boolean(view.switchingCostume && kind !== "costume");
    let tag = card.querySelector(".wearing-tag");
    if (wearing && !tag) {
      tag = document.createElement("span");
      tag.className = "wearing-tag";
      tag.textContent = "当前";
      card.append(tag);
    } else if (!wearing) tag?.remove();
    const heart = card.querySelector(".heart-button");
    const enabled = favorites.has(item.flag);
    heart.classList.toggle("favorited", enabled);
    heart.textContent = enabled ? "♥" : "♡";
    heart.title = enabled ? "取消收藏" : "添加收藏";
    heart.setAttribute("aria-label", heart.title + " " + item.name);
    heart.setAttribute("aria-pressed", String(enabled));
    const voice = card.querySelector(".voice-play");
    if (voice) voice.textContent = playing ? "Ⅱ" : "▶";
  });
}

function renderItems() {
  if (!view.catalog || !view.state) return;
  const hasLoop = loopKinds.includes(view.tab);
  if (hasLoop) view.onlyFavorites = Boolean(preferenceValue(view.tab + "Scope"));
  const favorites = favoriteSet();
  let entries;
  if (view.tab === "favorites") {
    entries = ["action", "expression", "costume", "voice"].flatMap((kind) => itemList(kind).map((item) => ({ item, kind })))
      .filter(({ item, kind }) => favorites.has(item.flag) && (view.favoriteCategory === "all" || kind === view.favoriteCategory));
  } else entries = itemList(view.tab).map((item) => ({ item, kind: view.tab }));
  if (view.onlyFavorites) entries = entries.filter(({ item }) => favorites.has(item.flag));
  const query = $("#item-search").value.trim().toLocaleLowerCase();
  if (query) entries = entries.filter(({ item }) => `${item.name} ${item.caption || ""} ${directions[item.category] || ""}`.toLocaleLowerCase().includes(query));
  const list = $("#items");
  const costumeKey = ["action", "expression", "favorites"].includes(view.tab) ? currentCostume().id : "";
  const context = [view.catalog.id, view.tab, costumeKey, query, view.onlyFavorites, view.favoriteCategory].join("|");
  const signature = context + "|" + entries.map(({ item, kind }) => kind + ":" + item.id + ":" + item.flag).join(",");
  if (view.itemsSignature !== signature) {
    if (view.listContext) view.scrollPositions.set(view.listContext, list.scrollTop);
    list.className = "items " + ({ action: "action-grid", expression: "expression-grid", costume: "costume-grid", voice: "voice-list", favorites: "action-grid" }[view.tab]);
    list.setAttribute("aria-labelledby", "tab-" + view.tab);
    list.replaceChildren(...entries.map(({ item, kind }) => makeItem(item, kind, favorites)));
    list.scrollTop = view.scrollPositions.get(context) || 0;
    view.itemsSignature = signature;
    view.listContext = context;
  } else refreshCards(entries, favorites);
  if (view.tab === "costume") requestAnimationFrame(queueVisibleThumbnails);
  $("#empty").hidden = entries.length > 0;
  $("#items").hidden = entries.length === 0;
  const searching = Boolean(query);
  const favoritesEmpty = view.tab === "favorites" || view.onlyFavorites;
  $("#empty-icon").textContent = searching ? "⌕" : favoritesEmpty ? "♡" : "◇";
  $("#empty-title").textContent = searching ? "无结果" : favoritesEmpty ? "暂无收藏" : `暂无${labels[view.tab]}`;
  $("#empty-reset").hidden = !searching;
  $("#item-search").placeholder = `搜索${labels[view.tab]}`;
  $("#favorites-filter").hidden = view.tab === "favorites";
  $("#favorite-categories").hidden = view.tab !== "favorites";
  $("#clear-expression").hidden = view.tab !== "expression";
  $("#favorites-filter").classList.toggle("selected", view.onlyFavorites);
  $("#favorites-filter").setAttribute("aria-pressed", String(view.onlyFavorites));
  $("#favorites-filter span").textContent = view.onlyFavorites ? "♥" : "♡";
  $("#favorites-filter").title = hasLoop ? "收藏列表与循环范围" : "收藏表情";
  $("#playback-bar").hidden = !hasLoop;
  const scope = hasLoop && view.onlyFavorites;
  const looping = Boolean(view.state.looping[view.tab]);
  $("#loop").classList.toggle("active", looping);
  $("#loop").setAttribute("aria-pressed", String(looping));
  const performanceLoop = view.tab === "action" && Boolean(preferenceValue("performanceEnabled"));
  $("#loop-label").textContent = looping ? "停止循环" : performanceLoop ? "循环演出" : view.tab === "costume" ? "循环换装" : "循环播放";
  const order = preferenceValue(view.tab + "Order") || "random";
  document.querySelectorAll("[data-order]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.order === order);
    button.setAttribute("aria-pressed", String(button.dataset.order === order));
  });
  if (document.activeElement !== $("#loop-interval")) $("#loop-interval").value = preferenceValue(view.tab + "Interval") ?? 0;
  $("#loop-interval").min = ["costume", "expression"].includes(view.tab) ? "1" : "0";
  $("#interval-label").textContent = view.tab === "costume" ? "每套停留" : view.tab === "expression" ? "每个表情停留" : "结束后等待";
  const playable = performanceLoop ? outfitPerformances(view.state.settings.performanceGroups[currentCostume().flag]).length > 0
    : itemList(view.tab).some((item) => !scope || favorites.has(item.flag));
  $("#loop").disabled = !playable && !looping;
}

function renderState() {
  if (!view.state || !view.catalog) return;
  const renderOnly = view.catalog.renderOnly === true;
  document.documentElement.toggleAttribute("data-render-only", renderOnly);
  $("#open-performance").hidden = renderOnly || view.petWindow || view.wallpaper;
  $("#performance-toggle").hidden = renderOnly || view.petWindow || view.wallpaper;
  $("#performance-toggle").setAttribute("aria-pressed", String(Boolean(view.state.settings.performanceEnabled)));
  $("#pet-visibility").setAttribute("aria-pressed", String(view.state.petShowing));
  $("#pet-visibility").title = view.state.petShowing ? "退出桌宠" : "显示桌宠";
  $("#apply-wallpaper").setAttribute("aria-pressed", String(view.state.wallpaperShowing));
  $("#apply-wallpaper").title = view.state.wallpaperShowing ? "退出壁纸" : "应用壁纸";
  const menuEnabled = renderOnly ? view.state.thirdPartyMenuEnabled : view.state.touchMenuEnabled !== false;
  $("#touch-menu").checked = menuEnabled;
  $("#touch-menu").closest("label").title = renderOnly ? "从右下角三点打开菜单" : "点击角色腿部打开菜单";
  if (!menuEnabled && !$("#pet-menu").hidden) showPetMenu(false);
  updateThirdPartyMenuButton();
  document.title = view.catalog.name.replace(/（Garupa）/g, "") + " · LovePet";
  const settings = view.state.settings;
  $("#captions-toggle").checked = Boolean(settings.captions);
  if (renderOnly) { updateSubtitle(); return; }
  $("#body-toggle").checked = Boolean(settings.bodyOnly);
  $("#click-through-toggle").checked = settings.preventClickThrough !== false;
  syncVoiceVolume();
  $("#game-name").textContent = view.catalog.game;
  $("#band-name").textContent = view.catalog.group.replace(/（Garupa）/g, "");
  renderItems();
  updatePlaying();
  updateSubtitle();
}

function setTab(tab) {
  view.tab = tab;
  view.onlyFavorites = false;
  $("#item-search").value = "";
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.setAttribute("aria-controls", "items");
  });
  renderItems();
  updateTabIndicator();
}

function updateTabIndicator() {
  const tab = document.querySelector("[data-tab].selected");
  const indicator = $("#tab-indicator");
  if (!tab || !indicator) return;
  indicator.style.width = tab.offsetWidth + "px";
  indicator.style.transform = `translateX(${tab.offsetLeft}px)`;
}

async function applySelection(state, imported = false) {
  imported ||= view.modelRecord !== undefined && view.modelRecord !== state.modelRecord;
  view.modelRecord = state.modelRecord;
  view.state = state;
  const roleChanged = view.catalog?.id !== state.role;
  if (imported || roleChanged || (view.catalog.voiceLibraryRevision || 0) !== (state.voiceLibraryRevision || 0)) {
    const revision = view.importRevision;
    const catalog = await api("catalog/" + state.role);
    if (revision !== view.importRevision || view.state.role !== state.role) return;
    view.catalog = catalog;
    view.viewer = null;
    view.viewerOutfit = null;
    view.viewerCostume = null;
    if (roleChanged) view.currentExpression = null;
    view.itemsSignature = "";
    if (roleChanged) $("#item-search").value = "";
  }
  if (imported) setTab("action");
  renderState();
  const key = view.catalog.id + ":" + currentCostume().id;
  if (imported || view.modelKey !== key) view.modelReady = loadModel(key, imported);
  await view.modelReady;
}

function resetModelView() {
  if (!view.model) return;
  const { model, modelSize } = view;
  const host = $("#canvas-host");
  const { x, y, width, height } = view.sizePreview ?? { x: 0, y: 0, width: host.clientWidth, height: host.clientHeight };
  if (!width || !height) return;
  if (!view.petWindow) {
    // Reusing the preview renderer can change its host size without a window resize.
    syncRendererSize(width, height);
  }
  const scene = view.wallpaper || document.documentElement.matches(".scene-edit, .immersive-preview");
  const layer = scene ? view.sceneCharacter : null;
  const angle = view.petWindow ? view.petRotation ?? 0 : layer?.rotation ?? 0;
  const radians = angle * Math.PI / 180;
  const sin = Math.sin(radians), cos = Math.cos(radians);
  const zoom = layer?.scale ?? 1;
  let scale = Math.min(width * .9 / modelSize.width, height * .94 / modelSize.height) * zoom;
  let offset = height * .48 * zoom;
  if (view.petWindow && angle) {
    const modelWidth = scale * modelSize.width, modelHeight = scale * modelSize.height;
    const fit = Math.min(1, width * .98 / (Math.abs(cos) * modelWidth + Math.abs(sin) * modelHeight),
      height * .98 / (Math.abs(sin) * modelWidth + Math.abs(cos) * modelHeight));
    scale *= fit;
    offset *= fit;
  }
  model.scale.set(scale);
  model.anchor.set(.5, 1);
  model.angle = angle;
  model.position.set(x + width * (.5 + (layer?.x ?? 0)) - sin * offset,
    y + height * (.5 + (layer?.y ?? 0)) + cos * offset);
  if (view.petWindow) {
    const style = host.parentElement.style;
    style.setProperty("--pet-left", `${x}px`);
    style.setProperty("--pet-width", `${width}px`);
    style.setProperty("--pet-bottom", `${y + height}px`);
  }
  subtitleDrag.layout();
  placePetMenu();
}

function setSceneCharacterTransform(layer) {
  view.sceneCharacter = layer;
  resetModelView();
}

function button(text, className, action) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = text;
  node.className = className;
  node.onclick = action;
  return node;
}

function rectContains(rect, point) {
  return point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function placePetMenu() {
  if (!view.model || (!view.petWindow && !view.wallpaper)) return;
  const bounds = view.model.getBounds();
  const stage = $("#canvas-host").getBoundingClientRect();
  const frame = view.sizePreview;
  const hint = $("#pet-menu-button");
  const right = frame ? frame.x + frame.width : stage.right;
  const bottom = frame ? frame.y + frame.height : stage.bottom;
  const anchorX = Math.max(22, Math.min(innerWidth - 22, right - 22));
  const anchorY = Math.max(22, Math.min(innerHeight - 22, bottom - 22));
  hint.style.left = anchorX + "px";
  hint.style.top = anchorY + "px";
  const menu = $("#pet-menu");
  const thirdParty = view.catalog?.renderOnly;
  const x = thirdParty ? anchorX + 16 - menu.offsetWidth : stage.left + bounds.x + bounds.width * .73;
  const y = thirdParty ? anchorY - menu.offsetHeight - 12 : stage.top + bounds.y + bounds.height * .36;
  menu.style.left = Math.max(6, Math.min(innerWidth - menu.offsetWidth - 6, x)) + "px";
  menu.style.top = Math.max(6, Math.min(innerHeight - menu.offsetHeight - 6, y)) + "px";
}

function updateThirdPartyMenuButton() {
  const visible = (view.petWindow || view.wallpaper) && view.model && view.catalog?.renderOnly &&
    view.state?.thirdPartyMenuEnabled && $("#pet-menu").hidden;
  $("#pet-menu-button").hidden = !visible;
  if (visible) placePetMenu();
}

function showPetMenu(show = $("#pet-menu").hidden) {
  const menu = $("#pet-menu");
  menu.hidden = !show;
  $("#pet-menu-button").hidden = true;
  for (const button of menu.querySelectorAll("[data-menu]")) {
    const action = button.dataset.menu;
    const loop = loopKinds.includes(action);
    button.hidden = view.catalog?.renderOnly && (loop || action === "reset");
    if (loop) button.textContent = (view.state.looping[action] ? "停止循环" : "循环") +
      (action === "action" && view.state.settings.performanceEnabled ? "演出" : action === "costume" ? "换装" : labels[action]);
    if (action === "stop") button.textContent = view.wallpaper ? "退出壁纸" : "退出桌宠";
  }
  if (show) placePetMenu();
  else updateThirdPartyMenuButton();
}

$("#pet-menu-button").onclick = () => showPetMenu(true);
$("#pet-menu").onclick = safely(async (event) => {
  const action = event.target.closest("button")?.dataset.menu;
  if (!action) return;
  showPetMenu(false);
  if (action === "panel") window.desktopPet.showPanel();
  else if (action === "stop") window.desktopPet.stopDisplay();
  else if (action === "reset") await stopAll();
  else if (loopKinds.includes(action)) {
    if (view.state.looping[action]) await api("stop", { kind: action });
    else await api("operate", { kind: action, loop: true, random: true });
  }
});

if (view.wallpaper) {
  let holdTimer, press, following;
  function focus(point) {
    const model = view.model;
    const internal = model?.internalModel;
    if (!internal) return;
    if (!point) { internal.focusController.focus(0, 0); return; }
    const stage = $("#canvas-host").getBoundingClientRect();
    const target = model.toModelPosition(new PIXI.Point(point.x - stage.left, point.y - stage.top));
    internal.focusController.focus(target.x / internal.originalWidth * 2 - 1, 1 - target.y / internal.originalHeight * 2);
  }
  window.desktopPet.watchWallpaperPointer(({ action, x, y }) => {
    const point = { x: x * innerWidth, y: y * innerHeight };
    if (action === "down") {
      press = point;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { following = true; focus(point); }, 300);
    } else if (action === "move" && press) {
      if (following) focus(point);
      else if (Math.hypot(point.x - press.x, point.y - press.y) > 8) { clearTimeout(holdTimer); press = null; }
    } else if (action === "up" || action === "cancel") {
      clearTimeout(holdTimer);
      if (following) focus(null);
      else if (press && action === "up") {
        const target = document.elementFromPoint(point.x, point.y)?.closest("#pet-menu button, #pet-menu-button");
        if (target) target.click();
        else view.interactAt?.({ clientX: point.x, clientY: point.y });
      }
      following = false;
      press = null;
    }
  });
}

function setImmersive(active) {
  document.documentElement.classList.toggle("immersive-preview", active);
  $("#immersive-preview").textContent = active ? "退出纯享" : "纯享";
  window.desktopPet?.fullscreen?.(active);
  resetModelView();
}

function renderResolution(width, height) {
  const limits = view.drawableLimit;
  return limits ? Math.min(devicePixelRatio || 1, limits.width / width, limits.height / height) : devicePixelRatio || 1;
}

function syncRendererSize(width, height) {
  const renderer = view.app?.renderer;
  if (!renderer || !width || !height) return false;
  const resolution = renderResolution(width, height);
  const previous = view.rendererSize;
  if (previous?.width === width && previous.height === height && previous.resolution === resolution) return false;
  if (renderer.resolution !== resolution) renderer.resolution = resolution;
  renderer.resize(width, height);
  view.rendererSize = { width, height, resolution };
  return true;
}

function watchScreenDensity(update) {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => {
    update();
    watchScreenDensity(update);
  }, { once: true });
}

function disposeModels(models) {
  for (const model of models) {
    model.internalModel?.off("beforeModelUpdate", updateMouth);
    model.destroy({ children: true });
  }
}

function synchronizeMotionFades(model, metadata = {}) {
  const manager = model.internalModel.motionManager;
  if (metadata.pageMotionFadePolicy === "source" && !metadata.FileReferences && manager.queueManager) {
    // Keep the outgoing SDK2 motion until its source fade finishes, matching
    // Bestdori's MotionQueueManager instead of discarding it at each switch.
    manager._startMotion = (motion, onFinish) => {
      motion.onFinishHandler = onFinish;
      return manager.queueManager.startMotion(motion);
    };
  }
  const apply = (group, index, motion) => {
    if (!motion) return;
    if (metadata.pageMotionFadePolicy === "source") {
      const definitions = metadata.FileReferences?.Motions || metadata.motions;
      const definition = definitions?.[group]?.[index];
      if (!definition) return;
      motion.setFadeIn?.(definition.fade_in);
      motion.setFadeOut?.(definition.fade_out);
      motion.setFadeInTime?.(definition.FadeInTime);
      motion.setFadeOutTime?.(definition.FadeOutTime);
      return;
    }
    motion.setFadeIn?.(0);
    motion.setFadeOut?.(0);
    motion.setFadeInTime?.(0);
    motion.setFadeOutTime?.(0);
  };
  manager.on("motionLoaded", apply);
  for (const [group, motions] of Object.entries(manager.motionGroups)) {
    motions.forEach((motion, index) => apply(group, index, motion));
  }
}

async function previewConfig(url, revision) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("模型配置加载失败");
  const metadata = await response.json();
  metadata.url = location.origin + url;
  if (revision) {
    const refs = metadata.FileReferences || metadata;
    const textures = metadata.FileReferences ? "Textures" : "textures";
    // Chromium can keep decoded images for the lifetime of the document.
    refs[textures] = refs[textures].map((texture) => texture + "?import=" + revision);
  }
  return metadata;
}

async function loadModel(key, keepCurrent = false) {
  const token = ++view.request;
  view.modelKey = key;
  stopLocal("action");
  stopLocal("voice");
  view.currentExpression = null;
  $("#model-loading").hidden = false;
  $("#stage-error").hidden = true;
  const host = $("#canvas-host");
  if (!view.petWindow && !view.wallpaper && !keepCurrent) {
    view.model = null;
    if (view.app) {
      disposeModels(view.app.stage.removeChildren());
      view.app.renderer.clear();
    }
  }
  try {
    if (!window.PIXI?.live2d) throw new Error("Live2D 预览组件未载入");
    if (!view.app) {
      const width = view.sizePreview?.surfaceWidth ?? host.clientWidth;
      const height = view.sizePreview?.surfaceHeight ?? host.clientHeight;
      view.app = new PIXI.Application({
        width: 1, height: 1,
        backgroundAlpha: 0, clearBeforeRender: true, antialias: true,
        resolution: 1, autoDensity: true, preserveDrawingBuffer: true,
      });
      const gl = view.app.renderer.gl;
      const maxSide = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
      const [maxWidth, maxHeight] = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      view.drawableLimit = { width: Math.min(maxSide, maxWidth), height: Math.min(maxSide, maxHeight) };
      syncRendererSize(width, height);
      host.append(view.app.view);
      view.app.renderer.textureGC.maxIdle = 300;
      view.app.renderer.textureGC.checkCountMax = 300;
    }
    const costume = currentCostume();
    const url = `/api/preview/${view.catalog.id}/${costume.id}`;
    let packed = null;
    if (view.catalog.viewerPackage) {
      const viewer = view.viewer || await window.viewerInteraction.load(asset("viewer.json"));
      if (token !== view.request) return;
      view.viewer = viewer;
      packed = await viewer.prepare(view.viewerOutfit || viewer.initial);
    }
    const metadata = packed?.metadata || await previewConfig(url, view.importRevision);
    if (token !== view.request) return;
    const model = await PIXI.live2d.Live2DModel.from(metadata, { autoInteract: false, motionPreload: "NONE" });
    if (!packed) synchronizeMotionFades(model, metadata);
    if (token !== view.request) { model.destroy({ children: true }); return; }
    if (model.internalModel.coreModel.isUsingMasking?.()) {
      const gl = view.app.renderer.gl;
      // The default 256-pixel mask atlas leaks lip textures at high zoom.
      model.internalModel.renderer.setClippingMaskBufferSize(Math.min(1024, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    }
    const outgoing = view.app.stage.removeChildren();
    view.model = model;
    view.modelCostumeId = costume.id;
    view.viewerCostume = packed;
    const { width, height } = model.getLocalBounds();
    view.modelSize = { width, height };
    view.mouthIds = metadata.pageMouthIds || [];
    view.app.stage.addChild(model);
    model.autoInteract = false;
    resetModelView();
    updateThirdPartyMenuButton();
    model.internalModel.on("beforeModelUpdate", updateMouth);
    view.app.renderer.render(view.app.stage, { clear: true });
    if (view.petWindow) window.desktopPet?.firstFrame?.();
    disposeModels(outgoing);
    host.onpointermove = (event) => {
      if (!view.model || view.wallpaper || !$("#model-loading").hidden) return;
      const hostBounds = host.getBoundingClientRect();
      const { x, y, width, height } = view.sizePreview ?? { x: 0, y: 0, width: hostBounds.width, height: hostBounds.height };
      const horizontal = (event.clientX - hostBounds.left - x) / width;
      const vertical = (event.clientY - hostBounds.top - y) / height;
      if (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) {
        view.model.internalModel.focusController.focus(0, 0);
        return;
      }
      view.model.internalModel.focusController.focus(horizontal * 2 - 1, 1 - vertical * 2);
    };
    host.onpointerleave = () => view.model?.internalModel.focusController.focus(0, 0);
    host.onpointercancel = host.onpointerleave;
    const regions = costume.hitRegions || {};
    let desktopMenu = regions.menu;
    if (view.petWindow && !costume.cubism3 && desktopMenu && regions.wardrobe &&
        desktopMenu[3] > model.internalModel.originalHeight) {
      const [left, top, right, bottom] = desktopMenu;
      const [, waistTop, , waistBottom] = regions.wardrobe;
      const extension = (right - left) * .12;
      // Match the Workshop adjustment for models cropped below the knee.
      desktopMenu = [left - extension, Math.min(top, waistTop + (waistBottom - waistTop) * .62), right + extension, bottom];
    }
    function hitRegion(event) {
      if (!view.model || !$("#model-loading").hidden) return;
      const rectangle = host.getBoundingClientRect();
      const x = event.clientX - rectangle.left;
      const y = event.clientY - rectangle.top;
      const frame = view.sizePreview;
      if (frame && !view.petRotation && (x < frame.x || x > frame.x + frame.width || y < frame.y || y > frame.y + frame.height)) return;
      if (packed) return packed.hit(view.model, x, y);
      const point = view.model.toModelPosition(new PIXI.Point(x, y));
      const internal = view.model.internalModel;
      if (costume.cubism3) {
        point.x = (point.x - internal.originalWidth / 2) / internal.pixelsPerUnit;
        point.y = (point.y - internal.originalHeight / 2) / internal.pixelsPerUnit;
      }
      const contains = (box) => box && point.x >= box[0] && point.x <= box[2] && point.y >= box[1] && point.y <= box[3];
      if (desktopMenu !== regions.menu && contains(desktopMenu)) return "menu";
      return ["expression", "voice", "left", "right", "body", "wardrobe", "menu"].find((name) => contains(regions[name]));
    }
    let suppressClick = false;
    if (view.petWindow) {
      let drag, previousHit, previousPoint, lastPixelRead = 0, zoomActiveUntil = 0;
      const pixel = new Uint8Array(4);
      const setHit = (hit) => {
        if (hit === previousHit) return;
        previousHit = hit;
        window.desktopPet.hit(hit);
      };
      const cursor = (point) => {
        const { gl } = view.app.renderer;
        if (drag || view.petRotationGesture || subtitleDrag.dragging || performance.now() < zoomActiveUntil ||
            [$("#pet-menu"), $("#pet-menu-button")].some(node => !node.hidden && rectContains(node.getBoundingClientRect(), point))) return setHit(true);
        if (!point || !view.model || !gl) {
          previousPoint = undefined;
          return setHit(false);
        }
        if (!subtitle.hidden) {
          const card = subtitle.getBoundingClientRect();
          if (point.x >= card.left && point.x <= card.right && point.y >= card.top && point.y <= card.bottom) {
            previousPoint = undefined;
            return setHit(true);
          }
        }
        const now = performance.now();
        const x = Math.floor(point.x * view.app.renderer.resolution);
        const y = gl.drawingBufferHeight - 1 - Math.floor(point.y * view.app.renderer.resolution);
        if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) return setHit(false);
        if (previousPoint?.x === x && previousPoint.y === y && now - lastPixelRead < 150) return;
        previousPoint = { x, y };
        lastPixelRead = now;
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        setHit(pixel[3] > 8 || Boolean(hitRegion({ clientX: point.x, clientY: point.y })));
      };
      view.stopPetCursor?.();
      view.stopPetCursor = window.desktopPet.watchCursor(cursor);
      host.onpointerdown = (event) => {
        if (!event.isPrimary || event.altKey || event.button !== 0) return;
        suppressClick = false;
        drag = { x: event.screenX, y: event.screenY, touch: event.pointerType === "touch" };
        window.desktopPet.drag("begin", Math.round(drag.x), Math.round(drag.y), drag.touch);
      };
      const track = host.onpointermove;
      host.onpointermove = (event) => {
        if (!drag || !(event.buttons & 1)) return track(event);
        const dx = event.screenX - drag.x;
        const dy = event.screenY - drag.y;
        if (!suppressClick && Math.hypot(dx, dy) < 4) return;
        if (!suppressClick) host.setPointerCapture(event.pointerId);
        suppressClick = true;
        window.desktopPet.drag("move", Math.round(event.screenX), Math.round(event.screenY), drag.touch);
      };
      const endDrag = () => {
        if (!drag) return;
        drag = null;
        window.desktopPet.drag("end");
      };
      view.endPetDrag = endDrag;
      host.onpointerup = host.onpointercancel = host.onlostpointercapture = endDrag;
      host.onpointerleave = () => {
        if (!suppressClick) endDrag();
        view.model?.internalModel.focusController.focus(0, 0);
      };
      host.onwheel = (event) => {
        if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        event.preventDefault();
        const delta = event.deltaY || event.deltaX;
        if (drag || !delta) return;
        zoomActiveUntil = performance.now() + 180;
        const steps = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? delta / 100 :
          event.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta / 3 : delta;
        window.desktopPet.zoom(-steps);
      };
      host.oncontextmenu = (event) => {
        event.preventDefault();
        if (!view.catalog.renderOnly) window.desktopPet.showPanel();
      };
    }
    view.interactAt = safely(async (event) => {
      if (document.documentElement.classList.contains("scene-edit") && !document.documentElement.classList.contains("scene-preview")) return;
      if (!view.model || !$("#model-loading").hidden) return;
      const region = hitRegion(event);
      if (view.catalog.renderOnly) {
        if (!packed) return;
        const rect = host.getBoundingClientRect();
        const onModel = view.model.getBounds().contains(event.clientX - rect.left, event.clientY - rect.top);
        const action = region || onModel ? packed.choose(region) : null;
        if (!action) return;
        if (action.outfit) {
          view.viewerOutfit = action.outfit;
          await loadModel(view.modelKey, true);
        } else {
          if (action.sound) await applyPlay({ kind: "voice", item: { url: action.sound, caption: action.text, name: action.text } });
          if (action.expression) await view.model.expression(action.expression);
          if (action.motion) await view.model.motion(action.motion, 0, 3);
        }
        return;
      }
      if (!region) return;
      if (region === "menu") {
        if (view.state.touchMenuEnabled !== false && (view.petWindow || view.wallpaper)) showPetMenu();
        return;
      }
      if (region === "body" && costume.flag) {
        if (view.state.settings.performanceEnabled) await enableAudio();
        await api("performance/touch", { role: view.catalog.id, costume: costume.flag });
        return;
      }
      if (region === "voice") await enableAudio();
      const kind = region === "wardrobe" ? "costume" : ["body", "left", "right"].includes(region) ? "action" : region;
      view.state = await api("operate", { kind, random: true, body: true, direction: region });
      if (kind === "costume") await applySelection(view.state);
      else renderState();
    });
    host.onclick = (event) => {
      if (event.target === view.app.view && !suppressClick) return view.interactAt(event);
    };
    if (view.wallpaper) window.sceneLayers?.firstFrame();
    setTimeout(() => {
      if (token !== view.request || !view.model) return;
      if (!view.petWindow && !view.wallpaper) {
        if (!view.catalog.renderOnly) captureThumbnail(key);
        window.captureModelHistory?.();
      }
      if (view.tab === "costume") renderItems();
    }, 1000);
  } catch (error) {
    if (token === view.request) {
      if (keepCurrent && view.app) {
        view.model = null;
        disposeModels(view.app.stage.removeChildren());
        view.app.renderer.clear();
      }
      $("#stage-error").hidden = false;
      if (view.petWindow && !view.model) window.desktopPet?.firstFrame?.();
      console.error("Model preview", error);
    }
  } finally {
    if (token === view.request) $("#model-loading").hidden = true;
  }
}

function captureThumbnail(key) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 220;
    canvas.height = 330;
    const source = view.app.view;
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/webp", .8);
    view.thumbnails.set(key, image);
    const [role, costume] = key.split(":");
    api("thumbnail", { role, costume: Number(costume), image }).catch((error) => console.debug("Thumbnail cache", error));
    if (view.catalog.id === role) {
      const picture = $("#items").querySelector(`.costume-picture[data-costume="${costume}"]`);
      if (picture) {
        const thumbnail = document.createElement("img");
        thumbnail.src = image;
        thumbnail.alt = currentCostume().name;
        picture.replaceChildren(thumbnail);
      }
    }
    if (view.thumbnails.size > 80) view.thumbnails.delete(view.thumbnails.keys().next().value);
  } catch (error) { console.debug("Thumbnail", error); }
}

async function queueVisibleThumbnails() {
  if (thumbnailBusy || view.switchingCostume || view.tab !== "costume" || !view.app || !view.model || !$("#model-loading").hidden) return;
  const list = $("#items");
  const viewport = list.getBoundingClientRect();
  const candidates = [...list.querySelectorAll(".costume-picture")].filter((element) => {
    const costume = view.catalog.costumes.find((item) => item.id === Number(element.dataset.costume));
    return !costume.thumbnail && !view.thumbnails.has(`${view.catalog.id}:${element.dataset.costume}`);
  });
  const picture = candidates.find((element) => {
    const rectangle = element.getBoundingClientRect();
    return rectangle.bottom > viewport.top && rectangle.top < viewport.bottom + 120;
  });
  if (!picture) return;
  thumbnailBusy = true;
  const revision = view.importRevision;
  const role = view.catalog.id;
  const id = Number(picture.dataset.costume);
  let model;
  let texture;
  try {
    const url = `/api/preview/${role}/${id}`;
    const metadata = await previewConfig(url, revision);
    if (revision !== view.importRevision) return;
    model = await PIXI.live2d.Live2DModel.from(metadata, { autoUpdate: false, autoInteract: false, motionPreload: "NONE" });
    if (revision !== view.importRevision) return;
    synchronizeMotionFades(model, metadata);
    const bounds = model.getLocalBounds();
    model.anchor.set(.5, 1);
    model.scale.set(Math.min(208 / bounds.width, 315 / bounds.height));
    model.position.set(110, 325);
    model.update(0);
    texture = PIXI.RenderTexture.create({ width: 220, height: 330 });
    view.app.renderer.render(model, { renderTexture: texture });
    const imageUrl = await view.app.renderer.extract.base64(texture, "image/webp", .8);
    if (revision !== view.importRevision) return;
    view.thumbnails.set(`${role}:${id}`, imageUrl);
    api("thumbnail", { role, costume: id, image: imageUrl }).catch((error) => console.debug("Thumbnail cache", error));
    if (view.thumbnails.size > 80) view.thumbnails.delete(view.thumbnails.keys().next().value);
    if (view.catalog.id === role) {
      const target = list.querySelector(`.costume-picture[data-costume="${id}"]`);
      if (target) {
        const image = document.createElement("img");
        image.src = imageUrl;
        image.alt = view.catalog.costumes.find((costume) => costume.id === id).name;
        target.replaceChildren(image);
      }
    }
  } catch (error) {
    if (revision === view.importRevision) view.thumbnails.set(`${role}:${id}`, null);
    console.debug("Costume thumbnail", error);
  }
  finally {
    model?.destroy({ children: true });
    texture?.destroy(true);
    thumbnailBusy = false;
    if (view.tab === "costume") setTimeout(queueVisibleThumbnails, 350);
  }
}

function syncVoiceVolume() {
  if (!view.volume) return;
  const { petVisible, wallpaperActive } = view.state;
  const audible = view.catalog?.renderOnly || (petVisible ? view.petWindow : wallpaperActive ? view.wallpaper : !view.petWindow && !view.wallpaper);
  view.volume.gain.value = Number(audible);
}

function enableAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
    const source = audioContext.createMediaElementSource(audio);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioData = new Uint8Array(analyser.fftSize);
    view.volume = audioContext.createGain();
    source.connect(analyser);
    analyser.connect(view.volume);
    view.volume.connect(audioContext.destination);
    syncVoiceVolume();
  }
  return audioContext.resume();
}

function updateMouth() {
  const core = view.model?.internalModel.coreModel;
  if (!core || !view.mouthIds.length) return;
  if (audio.paused || audio.ended || !analyser) { view.mouth = 0; return; }
  let target = 0;
  if (analyser && !audio.paused) {
    analyser.getByteTimeDomainData(audioData);
    target = Math.min(1, audioData.reduce((total, value) => total + Math.abs(value - 128) / 128, 0) / audioData.length * 10);
  }
  view.mouth += (target - view.mouth) * .35;
  for (const id of view.mouthIds) {
    if (core.addParameterValueById) core.addParameterValueById(id, view.mouth);
    else if (core.addToParamFloat) core.addToParamFloat(id, view.mouth);
  }
}

async function playItem(kind, item) {
  if (kind === "voice") await enableAudio();
  if (kind === "voice" && view.visibleVoice?.id === item.id && !audio.paused) {
    view.state = await api("stop", { kind });
    stopLocal(kind);
    return;
  }
  if (kind === "costume" && currentCostume().id === item.id) return;
  if (kind === "costume") return chooseCostume(item.id);
  view.state = await api("operate", { kind, id: item.id });
  if (kind === "costume") await applySelection(view.state);
  else renderState();
}

async function chooseCostume(id) {
  view.desiredCostume = id;
  if (view.switchingCostume) return;
  view.switchingCostume = true;
  const revision = view.importRevision;
  document.body.dataset.switching = "true";
  $("#model-loading").textContent = "正在换装";
  $("#model-loading").hidden = false;
  renderItems();
  try {
    while (view.desiredCostume !== view.state.settings.costume) {
      const target = view.desiredCostume;
      const result = await api("select", { role: view.catalog.id, costume: target });
      if (revision !== view.importRevision) return;
      view.state = result;
      if (view.desiredCostume === target) await applySelection(result);
    }
  } finally {
    view.switchingCostume = false;
    delete document.body.dataset.switching;
    $("#model-loading").hidden = true;
    renderState();
  }
}

async function applyPlay(data) {
  const { kind, item } = data;
  if (data.costume !== undefined && data.costume !== currentCostume().id) return;
  await view.modelReady;
  if (data.costume !== undefined && (data.costume !== currentCostume().id || data.costume !== view.modelCostumeId)) return;
  if (kind === "voice") {
    const generation = ++audioGeneration;
    audio.pause();
    audio.src = item.url ?? asset(item.file);
    view.visibleVoice = item;
    updateSubtitle();
    try {
      await enableAudio();
      if (generation !== audioGeneration) return;
      await audio.play();
    } catch (error) {
      if (generation === audioGeneration) toast("浏览器已阻止声音播放");
    }
  } else if (kind === "action") {
    clearTimeout(actionTimer);
    view.currentAction = item;
    await view.model?.motion("page_" + item.id, 0, 3);
    const key = view.modelKey;
    actionTimer = setTimeout(() => {
      if (key !== view.modelKey || view.currentAction?.id !== item.id) return;
      view.currentAction = null;
      renderItems();
      updatePlaying();
    }, item.duration * 1000);
  } else if (kind === "expression") {
    if (item.file) {
      const model = view.model;
      const manager = model?.internalModel.motionManager.expressionManager;
      if (!manager) return;
      const applied = await model.expression(String(item.id));
      if (view.model !== model) return;
      const index = manager.getExpressionIndex(String(item.id));
      if (!applied && manager.currentExpression !== manager.expressions[index]) throw new Error("表情加载失败");
      manager.restoreExpression();
      view.currentExpression = item.id;
    } else resetExpression();
  }
  renderItems();
  updatePlaying();
}

function resetExpression() {
  view.currentExpression = null;
  const manager = view.model?.internalModel.motionManager.expressionManager;
  if (manager) {
    manager.reserveExpressionIndex = -1;
    manager.currentExpression = manager.defaultExpression;
    manager.resetExpression();
  }
  renderItems();
}

function stopLocal(kind) {
  if (kind === "voice") {
    ++audioGeneration;
    audio.pause();
    view.visibleVoice = null;
    view.mouth = 0;
    updateSubtitle();
  } else if (kind === "action") {
    clearTimeout(actionTimer);
    view.currentAction = null;
    const manager = view.model?.internalModel.motionManager;
    manager?.stopAllMotions();
  } else if (kind === "expression") resetExpression();
  updatePlaying();
  if (view.catalog) renderItems();
}


function enableCaptionDrag(card, bounds, report = () => {}) {
  let position;
  let drag;
  const clamp = (point, size, extent) => {
    const inset = Math.min(size, extent) / 2;
    return Math.max(inset, Math.min(extent - inset, point));
  };

  function layout() {
    if (!card.hidden && position) {
      const area = bounds();
      if (area.width && area.height) {
        const x = clamp(position.x * area.width, card.offsetWidth, area.width);
        const y = clamp(position.y * area.height, card.offsetHeight, area.height);
        card.style.left = (area.x + x) + "px";
        card.style.top = (area.y + y) + "px";
        card.style.bottom = "auto";
        card.style.transform = "translate(-50%, -50%)";
      }
    }
    report(card.hidden ? null : card.getBoundingClientRect());
  }

  card.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    const rect = card.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2 };
    card.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  card.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId || card.hidden) return;
    const parent = card.offsetParent.getBoundingClientRect();
    const area = bounds();
    if (!area.width || !area.height) return;
    const x = event.clientX - parent.left - card.offsetParent.clientLeft - drag.x - area.x;
    const y = event.clientY - parent.top - card.offsetParent.clientTop - drag.y - area.y;
    position = { x: clamp(x, card.offsetWidth, area.width) / area.width,
      y: clamp(y, card.offsetHeight, area.height) / area.height };
    layout();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    card.addEventListener(type, (event) => {
      if (drag?.id === event.pointerId) drag = null;
    });
  }
  new ResizeObserver(layout).observe(card.parentElement);
  return { layout, get dragging() { return Boolean(drag) && !card.hidden; } };
}

function updateSubtitle() {
  const visible = Boolean((view.visibleVoice?.caption || view.visibleVoice?.name) && view.state?.settings.captions && !audio.ended);
  subtitle.hidden = !visible;
  if (visible) {
    $("#subtitle-text").textContent = view.visibleVoice.caption || view.visibleVoice.name;
  }
  subtitleDrag.layout();
}

function updatePlaying() {
  const item = view.visibleVoice || view.currentAction || (view.state?.looping.costume ? currentCostume() : null);
  $("#playing-title").textContent = item?.name || "待机";
  $("#playing-detail").textContent = item ? (view.visibleVoice ? "语音播放中" : view.currentAction ? "动作播放中" : "循环换装中") : "";
  $("#equalizer").classList.toggle("playing", Boolean(item));
}

async function stopAll() {
  view.state = await api("reset", {});
  for (const kind of ["action", "voice", "costume"]) stopLocal(kind);
  resetExpression();
  renderState();
}

async function boot() {
  if (window.desktopPet) {
    document.title = "LovePet";
    $(".brand span").textContent = "LovePet";
  }
  if (view.petWindow && window.desktopPet.getFrame) {
    const frame = await window.desktopPet.getFrame();
    view.sizePreview ??= frame;
    view.petRotation = view.sizePreview?.rotation ?? 0;
  }
  view.standalone = true;
  view.state = await api("state");
  updateRoleVisibility();
  if (!view.state.role) return;
  await applySelection(view.state);
  watchRoleEvents();
}

function updateRoleVisibility() {
  const desktopControls = !view.petWindow && !view.wallpaper && Boolean(window.desktopPet) && Boolean(view.state.role);
  $("#pet-visibility").hidden = !desktopControls;
  $("#apply-wallpaper").hidden = !desktopControls;
  $("#open-settings").hidden = view.petWindow || view.wallpaper || !window.desktopPet;
  document.documentElement.toggleAttribute("data-no-model", !view.state.role);
  $("#immersive-preview").hidden = !desktopControls;
  if (view.standalone) {
    document.body.classList.add("standalone-preview");
    $("#exit-preview").hidden = Boolean(window.desktopPet);
    $(".breadcrumb").hidden = !view.state.role;
    $("#import-role").hidden = !view.state.role;
    $(".content").hidden = !view.state.role;
    $("#role-welcome").hidden = Boolean(view.state.role);
    if (window.desktopPet?.pickRole) {
      $("#import-formats").textContent = "选择 Live2D 模型 JSON、LPK 或 WPK。ZIP 仅支持 BandoriLove 单角色发行包。";
      $("#import-first-role").textContent = "选择文件";
    }
  }
}

function watchRoleEvents() {
  const events = new EventSource("/api/events");
  view.events = events;
  let eventQueue = Promise.resolve();
  const handleEvent = async (message) => {
    if (view.events !== events) return;
    const event = JSON.parse(message.data);
    if (event.state.role !== view.state?.role && event.type !== "selection") return;
    if (event.state.sequence < view.state.sequence) {
      if (event.type === "selection" && !view.switchingCostume &&
          event.state.settings.costume === view.state.settings.costume) await applySelection(view.state);
      return;
    }
    view.state = event.state;
    if (event.type === "selection") {
      if (!view.switchingCostume || event.state.settings.costume === view.desiredCostume) await applySelection(event.state);
    }
    else if (event.type === "play") await applyPlay(event.data);
    else if (event.type === "performance") {
      const { costume, tracks } = event.data;
      await Promise.all(Object.entries(tracks).map(([kind, item]) => applyPlay({ kind, item, costume })));
    }
    else if (event.type === "scene") window.sceneLayers?.receive(event.data);
    else if (event.type === "stop" || (event.type === "ended" && event.data !== "voice")) stopLocal(event.data);
    else if (event.type === "clear-expression") resetExpression();
    else if (event.type === "reset") { for (const kind of loopKinds) stopLocal(kind); }
    else if (event.type === "notice") toast(event.data);
    renderState();
  };
  events.onmessage = (message) => {
    eventQueue = eventQueue.then(() => handleEvent(message)).catch((error) => toast(error.message));
  };
  events.onopen = safely(async () => {
    const state = await api("state");
    if (view.events === events) await applySelection(state);
  });

}

for (const id of ["#import-first-role", "#import-role"]) {
  $(id).addEventListener("click", () => {
    if (window.desktopPet?.pickRole) window.openModelLibrary?.();
    else $("#role-zip").click();
  });
}
$("#exit-preview").addEventListener("click", safely(async () => {
  await api("exit", {});
  view.events?.close();
  audio.pause();
  view.app?.stop();
  $(".content").hidden = $("#role-welcome").hidden = $("#import-role").hidden = $("#exit-preview").hidden = true;
  const status = $("#role-import-status");
  status.hidden = false;
  status.textContent = "控制台已退出，可以关闭此页面。";
}));
async function loadRolePackage(message, load) {
  const status = $("#role-import-status");
  delete status.dataset.error;
  status.hidden = false;
  status.textContent = message;
  $("#import-first-role").disabled = $("#import-role").disabled = true;
  const content = $(".content");
  content.inert = true;
  try {
    await preferenceQueue;
    if (await load()) {
      if (!window.PIXI?.live2d) {
        location.replace("/");
        return;
      }
      view.events?.close();
      view.events = null;
      ++view.importRevision;
      ++view.request;
      PIXI.utils.clearTextureCache();
      view.thumbnails.clear();
      view.scrollPositions.clear();
      view.state = await api("state");
      if (!window.Live2D && !view.state.renderOnly) {
        location.replace("/");
        return;
      }
      updateRoleVisibility();
      await applySelection(view.state, true);
      watchRoleEvents();
    }
    status.hidden = true;
  } catch (error) {
    status.dataset.error = "";
    status.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") || "角色包加载失败";
  } finally {
    content.inert = false;
    $("#import-first-role").disabled = $("#import-role").disabled = false;
  }
}

$("#role-zip").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = "";
  loadRolePackage(`正在加载 ${file.name}…`, async () => {
    const response = await fetch("/api/import", {
      method: "POST", headers: { "Content-Type": "application/zip", "X-Studio-Request": "1" }, body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return true;
  });
});

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  view.favoriteCategory = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((entry) => entry.classList.toggle("selected", entry === button));
  renderItems();
}));
$("#item-search").addEventListener("input", renderItems);
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => {
  const dialog = button.closest("dialog");
  if (!dialog.dataset.busy) dialog.close();
}));
document.querySelectorAll(".voice-dialog").forEach(dialog => dialog.addEventListener("cancel", event => {
  if (dialog.dataset.busy) event.preventDefault();
}));
$("#items").addEventListener("scroll", queueVisibleThumbnails, { passive: true });
$("#favorites-filter").addEventListener("click", safely(async () => {
  if (loopKinds.includes(view.tab)) {
    await savePreference(view.tab + "Scope", view.onlyFavorites ? 0 : 1);
  } else { view.onlyFavorites = !view.onlyFavorites; renderItems(); }
}));
$("#empty-reset").addEventListener("click", () => { $("#item-search").value = ""; renderItems(); });
$("#loop").addEventListener("click", safely(async () => {
  const kind = view.tab;
  await preferenceQueue;
  if (view.state.looping[kind]) {
    view.state = await api("stop", { kind });
    stopLocal(kind);
  } else {
    if (kind === "voice") await enableAudio();
    view.state = await api("operate", { kind, random: true, loop: true });
  }
  renderState();
}));
document.querySelectorAll("[data-order]").forEach((button) => button.addEventListener("click", safely(() =>
  savePreference(view.tab + "Order", button.dataset.order)
)));
$("#loop-interval").addEventListener("change", safely((event) =>
  savePreference(view.tab + "Interval", Number(event.target.value))
));
for (const [id, key] of [["#captions-toggle", "captions"], ["#body-toggle", "bodyOnly"], ["#click-through-toggle", "preventClickThrough"], ["#touch-menu", "touchMenuEnabled"]]) {
  $(id).addEventListener("change", safely(async (event) => {
    const preference = id === "#touch-menu" && view.catalog?.renderOnly ? "thirdPartyMenuEnabled" : key;
    try { view.state = await api("preference", { key: preference, value: event.target.checked }); }
    finally { renderState(); }
  }));
}
$("#open-performance").onclick = createPerformanceEditor({
  read: () => view.catalog && view.standalone && !view.catalog.renderOnly && {
    catalog: view.catalog,
    costume: currentCostume(),
    enabled: Boolean(view.state.settings.performanceEnabled),
    groups: view.state.settings.performanceGroups,
  },
  setEnabled: (role, value) => {
    if (role !== view.catalog?.id) throw new Error("已切换角色，请重新打开演出设置");
    return api("preference", { key: "performanceEnabled", value });
  },
  save: (role, costume, preset, group) => api("performance/save", { role, costume, preset, group }),
});
$("#open-settings").onclick = safely(async () => {
  $("#settings").showModal();
  if (window.desktopPet) $("#pet-placement").value = await window.desktopPet.placement();
});
$("#pet-placement").onchange = safely(async (event) => window.desktopPet.placement(event.target.value));
$("#performance-toggle").onclick = safely(() => savePreference("performanceEnabled", !view.state.settings.performanceEnabled));
$("#immersive-preview").onclick = () => setImmersive(!document.documentElement.classList.contains("immersive-preview"));
window.addEventListener("scene-editor-change", () => { showPetMenu(false); resetModelView(); });
$("#pet-visibility").addEventListener("click", safely(async () => {
  const button = $("#pet-visibility");
  button.disabled = true;
  try {
    await window.desktopPet.togglePet();
    view.state = await api("state");
  } finally { button.disabled = false; renderState(); }
}));
$("#stop-all").addEventListener("click", safely(stopAll));
document.querySelectorAll(".control-panel, .bottom-bar").forEach((element) => {
  element.addEventListener("pointerdown", (event) => event.stopPropagation());
  element.addEventListener("pointerup", (event) => event.stopPropagation());
  element.addEventListener("click", (event) => event.stopPropagation());
});
$("#clear-expression").addEventListener("click", safely(async () => {
  resetExpression();
  await api("operate", { kind: "expression", id: -1 });
}));
$("#reload-preview").addEventListener("click", safely(() => loadModel(view.modelKey)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.documentElement.classList.contains("immersive-preview")) setImmersive(false);
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { event.preventDefault(); $("#item-search").focus(); }
  if (event.target.matches("[role=tab]") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[role=tab]")];
    const next = tabs[(tabs.indexOf(event.target) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.tab);
    next.focus();
  }
});
audio.addEventListener("ended", () => { view.visibleVoice = null; updateSubtitle(); updatePlaying(); renderItems(); });
audio.addEventListener("error", () => { if (audio.src) toast("语音载入失败，请重试"); });
const canvasHost = $("#canvas-host");
if (view.petWindow) {
  bindRotationGestures(canvasHost, {
    target: () => view.model && canvasHost,
    readAngle: () => view.petRotation ?? 0,
    rotate: (_host, angle) => { view.petRotation = angle; resetModelView(); },
    reset: () => {
      view.petRotation = 0;
      resetModelView();
      window.desktopPet.transform(0, true);
    },
    start: () => { view.petRotationGesture = true; view.endPetDrag?.(); },
    readHeight: () => view.sizePreview?.height,
    pinch: height => window.desktopPet.pinch(height),
    finish: rotated => {
      view.petRotationGesture = false;
      if (rotated) window.desktopPet.transform(view.petRotation, false);
    },
  });
  let nextFrame, animate, pendingSizeFrame;
  const dimensions = ["x", "y", "width", "height"];
  function scheduleDraw() {
    if (!pendingSizeFrame) pendingSizeFrame = requestAnimationFrame(drawFrame);
  }
  function drawFrame() {
    pendingSizeFrame = null;
    const target = nextFrame ?? view.sizePreview;
    if (!target) return;
    // Keep the last painted canvas while Windows is still resizing the host.
    const viewportChanged = view.sizePreview?.surfaceWidth !== target.surfaceWidth ||
      view.sizePreview?.surfaceHeight !== target.surfaceHeight;
    if (viewportChanged && target.surfaceWidth != null && (Math.abs(canvasHost.clientWidth - target.surfaceWidth) > 6 ||
        Math.abs(canvasHost.clientHeight - target.surfaceHeight) > 6)) return;
    if (target.rotation !== view.sizePreview?.rotation && !view.petRotationGesture) view.petRotation = target.rotation ?? 0;
    const previous = view.sizePreview && {
      ...view.sizePreview,
      x: view.sizePreview.x + (view.sizePreview.originX ?? 0) - (target.originX ?? 0),
      y: view.sizePreview.y + (view.sizePreview.originY ?? 0) - (target.originY ?? 0),
    };
    const moving = animate && previous && dimensions.some(key => Math.abs(target[key] - previous[key]) >= .5);
    view.sizePreview = moving ? {
      ...target,
      ...Object.fromEntries(dimensions.map(key => [key, previous[key] + (target[key] - previous[key]) * .38])),
    } : target;
    const resized = syncRendererSize(target.surfaceWidth ?? canvasHost.clientWidth, target.surfaceHeight ?? canvasHost.clientHeight);
    resetModelView();
    if (resized && view.model) view.app.renderer.render(view.app.stage, { clear: true });
    if (moving) scheduleDraw();
  }
  new ResizeObserver(scheduleDraw).observe(canvasHost);
  addEventListener("resize", scheduleDraw);
  watchScreenDensity(scheduleDraw);
  window.desktopPet.watchSize((bounds, animated) => {
    nextFrame = bounds;
    animate = animated;
    scheduleDraw();
  });
} else {
  new ResizeObserver(resetModelView).observe(canvasHost);
  watchScreenDensity(resetModelView);
}
new ResizeObserver(updateTabIndicator).observe($(".tabs"));
document.fonts.ready.then(updateTabIndicator);
window.desktopPet?.watchWallpaperResult?.((applied) => {
  if (!document.hidden) showWallpaperResult(applied);
});
boot().catch((error) => toast(error.message)).finally(() => {
  if (!document.documentElement.hasAttribute("data-starting")) return;
  requestAnimationFrame(() => requestAnimationFrame(() => delete document.documentElement.dataset.starting));
});
