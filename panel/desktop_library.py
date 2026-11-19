"""Persistent model history and wallpaper scenes for the Windows player."""

import base64
import hashlib
import json
import math
import os
import re
import tempfile
import uuid

MEDIA_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4"}
MEDIA_LIMIT = 64 * 1024 * 1024
ID = re.compile(r"[a-z0-9-]{1,64}\Z")


def document(path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError):
        return default


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def portable_layers(layers):
    if not isinstance(layers, list) or not 2 <= len(layers) <= 12:
        raise ValueError("图层数量无效")
    if any(not isinstance(layer, dict) for layer in layers):
        raise ValueError("图层格式无效")
    if sum(layer.get("kind") == "character" for layer in layers) != 1 or layers[0].get("id") != "background":
        raise ValueError("壁纸需要一个默认背景和一个角色图层")
    result, ids = [], set()
    for layer in layers:
        layer_id, kind = layer.get("id"), layer.get("kind")
        if not valid_id(layer_id) or layer_id in ids or kind not in {"background", "image", "video", "character", "effect"}:
            raise ValueError("图层格式无效")
        ids.add(layer_id)
        clean = {"id": layer_id, "kind": kind, "name": str(layer.get("name", ""))[:150], "visible": layer.get("visible") is True}
        for key, lower, upper in (("opacity", 0, 1), ("scale", .3, 3), ("x", -.8, .8), ("y", -.8, .8)):
            value = layer.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value <= upper:
                raise ValueError("图层参数无效")
            clean[key] = value
        if kind in {"image", "video"}:
            if not valid_id(layer.get("media")):
                raise ValueError("素材编号无效")
            clean["media"] = layer["media"]
        for key in ("effect", "color"):
            if valid_id(layer.get(key)):
                clean[key] = layer[key]
        result.append(clean)
    return result


class DesktopLibrary:
    def __init__(self, profile):
        self.directory = profile / ".local" / "desktop"
        self.history_file = self.directory / "models.json"
        self.scene_file = self.directory / "scene.json"
        self.presets_file = self.directory / "presets.json"
        self.media_directory = self.directory / "media"
        self.history = document(self.history_file, {})
        self.presets = document(self.presets_file, {})

    def remember(self, path, role):
        key = hashlib.sha256(os.path.normcase(str(path.resolve())).encode()).hexdigest()[:32]
        record = {"name": role["name"], "source": str(path), "role": role["id"], "kind": path.suffix.lower()[1:]}
        previous = self.history.pop(key, None)
        self.history[key] = record
        if previous != record or len(self.history) > 1:
            write(self.history_file, self.history)
        return key

    def list_models(self, current):
        from pathlib import Path

        return [{"id": key, "name": item["name"], "kind": item["kind"], "active": key == current,
                 "available": Path(item["source"]).is_file(), "preview": self.preview("model", key).is_file()}
                for key, item in reversed(self.history.items())]

    def remove_model(self, item_id):
        if item_id not in self.history:
            raise ValueError("没有找到这条模型记录")
        del self.history[item_id]
        write(self.history_file, self.history)
        self.preview("model", item_id).unlink(missing_ok=True)

    def preview(self, kind, item_id):
        if kind not in {"model", "scene"} or not valid_id(item_id):
            raise ValueError("预览编号无效")
        return self.directory / f"{kind}-{item_id}.webp"

    def save_preview(self, kind, item_id, image):
        if not isinstance(image, str) or not image.startswith("data:image/webp;base64,"):
            raise ValueError("预览图格式无效")
        picture = base64.b64decode(image.partition(",")[2], validate=True)
        if not 12 <= len(picture) <= 1024 * 1024 or picture[:4] != b"RIFF" or picture[8:12] != b"WEBP":
            raise ValueError("预览图格式无效")
        file = self.preview(kind, item_id)
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_suffix(".tmp")
        temporary.write_bytes(picture)
        temporary.replace(file)

    def media(self, media_id):
        if not valid_id(media_id):
            raise ValueError("素材编号无效")
        return next((file for file in self.media_directory.glob(media_id + ".*") if file.suffix[1:] in MEDIA_TYPES.values()), None)

    def add_media(self, source, size, mime):
        if not 0 < size <= MEDIA_LIMIT or mime not in MEDIA_TYPES:
            raise ValueError("请选择不超过 64 MB 的 PNG、JPG、WebP 或 MP4 文件")
        self.media_directory.mkdir(parents=True, exist_ok=True)
        media_id = uuid.uuid4().hex
        destination = self.media_directory / f"{media_id}.{MEDIA_TYPES[mime]}"
        with tempfile.NamedTemporaryFile(dir=self.media_directory, delete=False) as output:
            pending = destination.with_name(os.path.basename(output.name))
            try:
                remaining = size
                while remaining:
                    data = source.read(min(remaining, 1024 * 1024))
                    if not data:
                        raise ValueError("壁纸素材传输不完整")
                    output.write(data)
                    remaining -= len(data)
                output.close()
                pending.replace(destination)
            finally:
                output.close()
                pending.unlink(missing_ok=True)
        return media_id

    def current_scene(self):
        return document(self.scene_file, [])

    def save_scene(self, layers):
        layers = portable_layers(layers)
        previous = self.current_scene()
        write(self.scene_file, layers)
        self.release_media(previous)
        return layers

    def save_preset(self, name, layers, model, image):
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError("请输入 1 至 80 个字的壁纸名称")
        layers = portable_layers(layers)
        preset_id = uuid.uuid4().hex
        self.save_preview("scene", preset_id, image)
        self.presets[preset_id] = {"name": name.strip(), "layers": layers, "model": model}
        write(self.presets_file, self.presets)
        return preset_id

    def remove_scene(self, preset_id):
        item = self.presets.pop(preset_id, None)
        if not item:
            return False
        write(self.presets_file, self.presets)
        self.preview("scene", preset_id).unlink(missing_ok=True)
        self.release_media(item["layers"])
        return True

    def release_media(self, previous):
        referenced = {layer.get("media") for scene in [self.current_scene(), *(item["layers"] for item in self.presets.values())]
                      for layer in scene}
        for layer in previous:
            media_id = layer.get("media")
            if media_id and media_id not in referenced:
                file = self.media(media_id)
                if file:
                    file.unlink(missing_ok=True)
