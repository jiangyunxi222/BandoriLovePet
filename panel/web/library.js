"use strict";

(() => {
  if (view.petWindow || view.wallpaper) return;
  const dialog = $("#app-library");
  const list = $("#app-library-items");
  const status = $("#app-library-message");
  const add = $("#app-library-add");
  let mode;

  function report(text) {
    status.hidden = !text;
    status.textContent = text;
  }

  async function render(next = mode) {
    mode = next;
    const scenes = next === "scenes";
    $("#app-library-title").textContent = scenes ? "已保存的壁纸" : "更换模型";
    add.hidden = scenes;
    list.replaceChildren();
    report("");
    if (!dialog.open) dialog.showModal();
    try {
      const records = await api(next);
      if (next !== mode) return;
      if (!records.length) report(scenes ? "暂无已保存的壁纸。" : "暂无已导入的模型。ZIP 仅支持 BandoriLove 单角色发行包。");
      for (const record of records) {
        const row = document.createElement("li");
        if (scenes || record.preview) {
          const picture = document.createElement("img");
          picture.alt = "";
          picture.src = `/api/desk-preview/${scenes ? "scene" : "model"}/${record.id}`;
          row.append(picture);
        }
        const title = document.createElement("strong");
        title.textContent = record.name;
        if (record.available === false) title.title = "源文件已移动或删除";
        const load = button(record.active ? "当前模型" : "使用", "subtle-button", () => {
          if (record.available === false) return report("模型文件已移动或删除，请重新导入。");
          dialog.close();
          if (!scenes) return loadRolePackage("正在加载模型…", async () => { await api("model-history", { id: record.id }); return true; });
          restorePreset(record).catch(error => { toast(error.message); });
        });
        load.disabled = Boolean(record.active);
        const remove = button("删除", "subtle-button", safely(async () => {
          await api(scenes ? "scene-remove" : "model-history", { id: record.id, remove: true });
          await render(next);
        }));
        row.append(title, load, remove);
        list.append(row);
      }
    } catch (error) { report(error.message); }
  }

  async function restorePreset(preset) {
    if (preset.model && preset.model !== view.state.modelRecord) {
      await api("model-history", { id: preset.model });
      await applySelection(await api("state"), true);
    }
    window.sceneLayers.restore(preset.layers);
    await window.sceneLayers.commit();
    await window.sceneLayers.open();
  }

  async function capture(stage) {
    const rect = stage.getBoundingClientRect();
    const left = Math.max(0, Math.ceil(rect.left)), top = Math.max(0, Math.ceil(rect.top));
    const width = Math.floor(Math.min(rect.right, innerWidth)) - left;
    const height = Math.floor(Math.min(rect.bottom, innerHeight)) - top;
    const source = await window.desktopPet.captureScene({ x: left, y: top, width, height });
    if (!source) throw new Error("预览区域不可见，无法生成预览图。");
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", .85);
  }

  const captured = new Set();
  window.captureModelHistory = async () => {
    const id = view.state.modelRecord;
    if (!id || !window.desktopPet || captured.has(id)) return;
    captured.add(id);
    try { await api("model-preview", { id, image: await capture($("#stage")) }); }
    catch { captured.delete(id); }
  };

  window.openModelLibrary = async () => {
    try {
      if (!(await api("models")).length && !view.state?.role) return add.click();
      await render("models");
    } catch (error) { toast(error.message); }
  };
  add.onclick = () => {
    dialog.close();
    loadRolePackage("正在加载模型…", () => window.desktopPet.pickRole());
  };
  $("#scene-open-presets").onclick = () => render("scenes");
  $("#scene-save-preset").onclick = () => $("#scene-name").showModal();
  $("#scene-name-form").onsubmit = safely(async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value;
    $("#scene-name").close();
    const root = document.documentElement;
    root.classList.add("scene-capture");
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await api("scene-save", { name, layers: window.sceneLayers.layers, image: await capture($("#stage")) });
      form.reset();
      toast("壁纸配置已保存");
    } finally { root.classList.remove("scene-capture"); }
  });
})();
