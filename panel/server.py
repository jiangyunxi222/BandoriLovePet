"""Local model storage and playback for BandoriLovePet."""

import argparse
import base64
import copy
import json
import mimetypes
import math
import os
import random
import secrets
import tempfile
import threading
import time
import sys
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import role_package
import viewer_package
import live2d_runtime
from desktop_library import DesktopLibrary, MEDIA_TYPES

HERE = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
WEB = Path(os.environ.get("BANDORILOVE_WEB_DIR", HERE / "web"))
PORT = 25000
KINDS = ("action", "expression", "costume", "voice")
LOOP_INTERVALS = {"costume": 35, "voice": 22, "expression": 16, "action": 12}


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))



def panel_directory(root):
    current = root / "ControlPanel"
    return current if current.is_dir() else root / "控制台"



def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)



class Studio:
    def __init__(self):
        self.lock = threading.RLock()
        self.import_lock = threading.Lock()
        self.active_package = None
        self.folder_assets = None
        self.plain_preview = None
        self.changed = threading.Condition(self.lock)
        self.events = []
        self.sequence = 0
        self.roles = {}
        self.roots = {}
        self.catalogs = {}
        self.pet_showing = False
        self.pet_visible = False
        self.wallpaper_showing = False
        self.wallpaper_active = False
        self.state_path = HERE / ".local/state.json"
        try:
            self.saved = read(self.state_path)
        except (OSError, ValueError):
            self.saved = {"roles": {}}
        if not isinstance(self.saved, dict):
            self.saved = {}
        if not isinstance(self.saved.get("roles"), dict):
            self.saved["roles"] = {}
        self.current = None
        self.library = DesktopLibrary(HERE)
        self.model_record = None
        self.jobs = {kind: 0 for kind in LOOP_INTERVALS}
        self.looping = {kind: False for kind in self.jobs}
        self.cursors = {}
        self.timers = {}
        self.repeat_at = {}
        self.playing = {}

    def import_role(self, source, length):
        if not 0 < length <= role_package.MAX_BYTES:
            raise ValueError("请选择不超过 2 GB 的角色 ZIP")
        if not self.import_lock.acquire(blocking=False):
            raise ValueError("另一个角色包正在加载")
        staged = None
        try:
            staged = tempfile.TemporaryDirectory(prefix="BandoriLove-role-", ignore_cleanup_errors=True)
            folder = Path(staged.name)
            archive = folder / "role.zip"
            with archive.open("wb") as stream:
                remaining = length
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ValueError("角色包传输不完整")
                    stream.write(chunk)
                    remaining -= len(chunk)
            root = folder / "role"
            role, catalog = self.read_role_archive(archive, root)
            archive.unlink()
            previous = self.activate_role(root, role, catalog, temporary=staged)
            staged = None
            if previous is not None:
                previous.cleanup()
        finally:
            if staged is not None:
                staged.cleanup()
            self.import_lock.release()


    def read_role_archive(self, archive, root):
        role, catalog = role_package.extract(archive, root)
        if WEB != HERE / "web":
            live2d_runtime.import_runtime(archive, HERE / ".local/runtime")
        return role, catalog


    def import_selected_model(self, entry):
        if not self.import_lock.acquire(blocking=False):
            raise ValueError("另一个角色包正在加载")
        staged = None
        try:
            if not entry.is_absolute() or not entry.is_file():
                raise ValueError("请选择本机的 Live2D 模型文件")
            runtime = HERE / ".local/runtime"
            assets = None
            plain_preview = None
            suffix = entry.suffix.lower()
            if suffix == ".zip":
                if not 0 < entry.stat().st_size <= role_package.MAX_BYTES:
                    raise ValueError("请选择不超过 2 GB 的角色 ZIP")
                staged = tempfile.TemporaryDirectory(prefix="BandoriLove-role-", ignore_cleanup_errors=True)
                root = Path(staged.name) / "role"
                role, catalog = self.read_role_archive(entry, root)
            elif suffix in {".lpk", ".wpk"}:
                staged = tempfile.TemporaryDirectory(prefix="BandoriLove-viewer-package-", ignore_cleanup_errors=True)
                destination = Path(staged.name) / "preview"
                loader = viewer_package.wpk_preview if suffix == ".wpk" else viewer_package.lpk_preview
                preview_entry, title = loader(entry, destination)
                root, role, catalog, assets, plain_preview = role_package.inspect_plain_model(preview_entry)
                catalog["viewerPackage"] = True
                assets = frozenset(file.name for file in destination.iterdir() if file.is_file())
                name = title.strip()[:120] if title and title.strip() else entry.stem
                role["name"] = catalog["name"] = catalog["costumes"][0]["name"] = name
            elif suffix == ".json" and role_package.is_indexed_folder(entry.parent):
                root, role, catalog, assets = role_package.inspect_folder(entry)
                live2d_runtime.import_folder_runtime(root, runtime)
            else:
                root, role, catalog, assets, plain_preview = role_package.inspect_plain_model(entry)
            if plain_preview is not None:
                live2d_runtime.require_runtime(runtime, modern=catalog["costumes"][0]["cubism3"])
            with self.lock:
                record = self.library.remember(entry, role)
                self.saved["sourceModel"] = record
                self.saved["current"] = role["id"]
                atomic_write(self.state_path, self.saved)
                previous = self.activate_role(root, role, catalog, temporary=staged, folder_assets=assets,
                                              plain_preview=plain_preview, record=record)
            staged = None
            if previous is not None:
                previous.cleanup()
        finally:
            if staged is not None:
                staged.cleanup()
            self.import_lock.release()


    def activate_role(self, root, role, catalog, *, temporary=None, folder_assets=None, plain_preview=None, record=None):
        with self.lock:
            previous = self.active_package
            for kind in self.jobs:
                self.jobs[kind] += 1
                self.looping[kind] = False
            for timer in self.timers.values():
                timer.cancel()
            self.timers.clear()
            self.cursors.clear()
            self.playing.clear()
            self.repeat_at.clear()
            self.current = role["id"]
            self.model_record = record
            self.roles = {self.current: role}
            self.roots = {self.current: root}
            self.catalogs = {self.current: catalog}
            self.active_package = temporary
            self.folder_assets = folder_assets
            self.plain_preview = plain_preview
            self.emit("selection")
            return previous


    def catalog(self, role_id=None):
        role_id = role_id or self.current
        if role_id not in self.roles:
            raise ValueError("角色不存在")
        if role_id not in self.catalogs:
            self.catalogs[role_id] = read(
                panel_directory(self.roots[role_id]) / "data" / (role_id + ".json")
            )
        return self.catalogs[role_id]


    def root(self, role_id=None):
        role = self.catalog(role_id)
        return (self.roots[role["id"]] / role["directory"]).resolve()


    def settings(self, role_id=None):
        role_id = role_id or self.current
        if not isinstance(self.saved["roles"].get(role_id), dict):
            self.saved["roles"][role_id] = {}
        settings = self.saved["roles"][role_id]
        for key, default in (("costume", 1), ("captions", True), ("bodyOnly", False),
                             ("preventClickThrough", True),
                             ("performanceEnabled", False),
                             ("actionScope", 0), ("voiceScope", 0), ("costumeScope", 0), ("expressionScope", 0)):
            settings.setdefault(key, default)
            if key != "costume" and settings[key] not in (True, False, 0, 1):
                settings[key] = default
        if not isinstance(settings.get("performanceGroups"), dict):
            settings["performanceGroups"] = {}
        for key in ("favorites",):
            values = settings.get(key, [])
            settings[key] = list(dict.fromkeys(value for value in values if isinstance(value, str))) if isinstance(values, list) else []
        if "expressionInterval" not in settings:
            for kind, old_default in (("voice", 2.5), ("costume", 15)):
                if settings.get(kind + "Interval") == old_default:
                    settings[kind + "Interval"] = LOOP_INTERVALS[kind]
        for kind, interval in LOOP_INTERVALS.items():
            if settings.get(kind + "Order") not in ("random", "sequence"):
                settings[kind + "Order"] = "random"
            value = settings.get(kind + "Interval")
            minimum = 1 if kind in ("costume", "expression") else 0
            if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= 3600:
                settings[kind + "Interval"] = interval
        valid = {costume["id"] for costume in self.catalog(role_id)["costumes"]}
        if type(settings["costume"]) is not int or settings["costume"] not in valid:
            settings["costume"] = min(valid)
        return settings


    def costume(self):
        return next(
            costume
            for costume in self.catalog()["costumes"]
            if costume["id"] == self.settings()["costume"]
        )


    def save(self):
        self.saved["current"] = self.current
        atomic_write(self.state_path, self.saved)


    def snapshot(self):
        return {
            "role": self.current,
            "modelRecord": self.model_record,
            "renderOnly": self.plain_preview is not None,
            "settings": copy.deepcopy(self.settings()) if self.current else {},
            "touchMenuEnabled": self.saved.get("touchMenuEnabled", True) is not False,
            "thirdPartyMenuEnabled": self.saved.get("thirdPartyMenuEnabled") is True,
            "petShowing": self.pet_showing,
            "petVisible": self.pet_visible,
            "wallpaperShowing": self.wallpaper_showing,
            "wallpaperActive": self.wallpaper_active,
            "looping": self.looping.copy(),
            "playing": self.playing.copy(),
            "sequence": self.sequence,
        }

    def desktop_state(self, data):
        state = tuple(data.get(key) is True for key in ("pet", "petVisible", "wallpaper", "wallpaperActive"))
        if (self.pet_showing, self.pet_visible, self.wallpaper_showing, self.wallpaper_active) != state:
            self.pet_showing, self.pet_visible, self.wallpaper_showing, self.wallpaper_active = state
            self.emit("desktop")
        return self.snapshot()

    def emit(self, kind, data=None):
        with self.changed:
            self.sequence += 1
            event = {
                "id": self.sequence,
                "type": kind,
                "data": data,
                "state": self.snapshot(),
            }
            self.events.append(event)
            self.events = self.events[-80:]
            self.changed.notify_all()


    def thumbnail_path(self, role_id, costume_id):
        costume = next(
            (
                item
                for item in self.catalog(role_id)["costumes"]
                if item["id"] == costume_id
            ),
            None,
        )
        if costume is None:
            raise ValueError("衣装不存在")
        stamp = (self.root(role_id) / costume["file"]).stat().st_mtime_ns
        return HERE / ".local/thumbnails" / f"{role_id}-{costume_id}-{stamp}.webp"


    def page_catalog(self, role_id):
        catalog = copy.deepcopy(self.catalog(role_id))
        for costume in catalog["costumes"]:
            if self.thumbnail_path(role_id, costume["id"]).is_file():
                costume["thumbnail"] = f'/api/thumbnail/{role_id}/{costume["id"]}'
        return catalog


    def save_thumbnail(self, role_id, costume_id, image):
        if not isinstance(image, str) or not image.startswith(
            "data:image/webp;base64,"
        ):
            raise ValueError("预览图片格式无效")
        data = base64.b64decode(image.partition(",")[2], validate=True)
        if (
            not 12 <= len(data) <= 1024 * 1024
            or data[:4] != b"RIFF"
            or data[8:12] != b"WEBP"
        ):
            raise ValueError("预览图片格式无效")
        path = self.thumbnail_path(role_id, costume_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(data)
        os.replace(temporary, path)
        return {"saved": True}


    def stop(self, kind):
        if kind not in self.jobs:
            raise ValueError("操作类型无效")
        self.jobs[kind] += 1
        timer = self.timers.pop(kind, None)
        if timer:
            timer.cancel()
        self.repeat_at.pop(kind, None)
        self.looping[kind] = False
        self.playing.pop(kind, None)
        self.emit("stop", kind)


    def select(self, role_id, costume_id=None, from_loop=False):
        if not isinstance(role_id, str) or role_id not in self.roles:
            raise ValueError("角色不存在")
        catalog = self.catalog(role_id)
        if costume_id is not None and costume_id not in {
            costume["id"] for costume in catalog["costumes"]
        }:
            raise ValueError("衣装不存在")
        if role_id == self.current and (
            costume_id is None or costume_id == self.settings()["costume"]
        ):
            return self.snapshot()
        if not from_loop:
            self.stop("costume")
        for kind in ("action", "voice", "expression"):
            if not self.looping[kind]:
                self.jobs[kind] += 1
                timer = self.timers.pop(kind, None)
                if timer:
                    timer.cancel()
            self.playing.pop(kind, None)
            self.emit("stop", kind)
        self.current = role_id
        if costume_id is not None:
            self.settings()["costume"] = costume_id
        self.save()
        self.emit("selection")
        return self.snapshot()


    def entries(self, kind, costume=None):
        if kind == "costume":
            return self.catalog()["costumes"]
        costume = costume or self.costume()
        if kind == "voice":
            return [voice for voice in self.catalog()["voices"]
                    if "costumeIds" not in voice or costume["id"] in voice["costumeIds"]]
        return costume["actions" if kind == "action" else "expressions"]


    def favorite(self, flag, enabled):
        catalog = self.catalog()
        flags = {voice["flag"] for voice in catalog["voices"]}
        for costume in catalog["costumes"]:
            flags.add(costume["flag"])
            flags.update(
                entry["flag"]
                for kind in ("actions", "expressions")
                for entry in costume[kind]
            )
        if flag not in flags:
            raise ValueError("收藏条目不存在")
        favorites = set(self.settings()["favorites"])
        if enabled:
            favorites.add(flag)
        else:
            favorites.discard(flag)
        self.settings()["favorites"] = sorted(favorites)
        self.save()
        self.emit("settings")
        return self.snapshot()


    def preference(self, key, value):
        if key in {"touchMenuEnabled", "thirdPartyMenuEnabled"}:
            if type(value) is not bool:
                raise ValueError("设置无效")
            self.saved[key] = value
            self.save()
            self.emit("settings")
            return self.snapshot()
        switches = {"captions", "bodyOnly", "actionScope", "voiceScope", "costumeScope", "expressionScope", "preventClickThrough", "performanceEnabled"}
        orders = {kind + "Order" for kind in self.jobs}
        intervals = {kind + "Interval" for kind in self.jobs}
        if key in orders:
            if value not in ("random", "sequence"):
                raise ValueError("播放顺序无效")
        elif key in intervals:
            minimum = 1 if key in ("costumeInterval", "expressionInterval") else 0
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not minimum <= value <= 3600
            ):
                raise ValueError("间隔需在" + str(minimum) + "至3600秒之间")
        elif key not in switches or value not in (True, False, 0, 1):
            raise ValueError("设置无效")
        self.settings()[key] = value
        if key in intervals:
            kind = key.removesuffix("Interval")
            if self.looping[kind]:
                self.jobs[kind] += 1
                playing = self.playing.get(kind, {})
                elapsed = time.time() - playing.get("startedAt", time.time())
                remaining = max(0, value + playing.get("duration", 0) - elapsed)
                self.schedule(kind, remaining, self.repeat, self.jobs[kind])
        self.save()
        self.emit("settings")
        return self.snapshot()


    def performance_tracks(self, costume, selection):
        if not isinstance(selection, dict):
            raise ValueError("演出配置无效")
        tracks = {}
        for kind, flag in selection.items():
            if kind not in ("action", "expression", "voice") or not isinstance(flag, str) or not flag:
                raise ValueError("演出素材无效")
            item = next((entry for entry in self.entries(kind, costume) if entry.get("flag") == flag), None)
            if item is None:
                raise ValueError("演出素材已变更，请重新选择")
            tracks[kind] = item
        return tracks


    def outfit_performances(self, outfit):
        value = self.settings()["performanceGroups"].get(outfit)
        if isinstance(value, list):
            return [group for group in value if isinstance(group, dict)
                    and group.get("id") and group.get("name") and isinstance(group.get("tracks"), dict)]
        if isinstance(value, dict) and value:
            return [{"id": "first", "name": "演出 1", "tracks": value}]
        return []


    def save_performance(self, role, outfit, preset_id, group):
        if role != self.current:
            raise ValueError("已切换角色，请重新打开演出设置")
        costume = next((item for item in self.catalog()["costumes"] if item.get("flag") == outfit), None)
        if not outfit or costume is None:
            raise ValueError("演出衣装不存在")
        if not isinstance(preset_id, str) or not 1 <= len(preset_id) <= 64:
            raise ValueError("演出编号无效")
        list_for_outfit = self.outfit_performances(outfit)
        index = next((i for i, item in enumerate(list_for_outfit) if item["id"] == preset_id), len(list_for_outfit))
        if group is None:
            if index < len(list_for_outfit):
                list_for_outfit.pop(index)
        else:
            name = group.get("name") if isinstance(group, dict) else None
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
                raise ValueError("请输入 1 至 60 个字符的演出名称")
            tracks = self.performance_tracks(costume, group.get("tracks"))
            if not tracks:
                raise ValueError("请选择至少一项动作、表情或语音")
            list_for_outfit[index:index + 1] = [{
                "id": preset_id, "name": name.strip(),
                "tracks": {kind: item["flag"] for kind, item in tracks.items()},
            }]
        groups = self.settings()["performanceGroups"]
        if list_for_outfit:
            groups[outfit] = list_for_outfit
        else:
            groups.pop(outfit, None)
        self.save()
        self.emit("settings")
        return self.snapshot()


    def touch_performance(self, role, outfit):
        if role != self.current:
            return self.snapshot()
        costume = self.costume()
        if outfit != costume.get("flag"):
            return self.snapshot()
        settings = self.settings()
        if not settings["performanceEnabled"]:
            return self.operate("action", randomize=True, body=True, direction="body")
        show = self.next_performance(costume)
        if show:
            self.play_performance(costume, show)
        return self.snapshot()


    def next_performance(self, costume):
        groups = self.outfit_performances(costume.get("flag"))
        key = ("performance", self.current, costume.get("flag"))
        last = self.cursors.get(key)
        index = next((i for i, group in enumerate(groups) if group["id"] == last), -1)
        for group in groups[index + 1:] + groups[:index + 1]:
            try:
                tracks = self.performance_tracks(costume, group["tracks"])
            except ValueError:
                continue
            if tracks:
                return key, group["id"], tracks
        return None


    def play_performance(self, costume, show):
        key, group_id, tracks = show
        self.cursors[key] = group_id
        for kind, item in tracks.items():
            duration = item.get("duration", 4) if kind in ("action", "voice") else 0
            self.playing[kind] = {"id": item["id"], "name": item["name"],
                                  "startedAt": time.time(), "duration": duration}
            if not self.looping[kind] and kind in ("action", "voice"):
                self.jobs[kind] += 1
                self.schedule(kind, duration, self.finish, self.jobs[kind])
        self.emit("performance", {"costume": costume["id"], "tracks": tracks})


    def playback_remaining(self, kind):
        playing = self.playing.get(kind)
        if playing:
            return max(0, playing.get("duration", 0) - (time.time() - playing["startedAt"]))
        return 0


    def loop_performance(self):
        costume = self.costume()
        show = self.next_performance(costume)
        self.jobs["action"] += 1
        self.looping["action"] = True
        interval = self.settings()["actionInterval"]
        if show:
            tracks = show[2]
            voice_remaining = self.playback_remaining("voice") if "voice" in tracks else 0
            if voice_remaining:
                delay = voice_remaining + 0.05
                self.emit("loop")
            else:
                self.play_performance(costume, show)
                delay = max(1, interval + tracks.get("action", {}).get("duration", 0),
                            tracks.get("voice", {}).get("duration", 0) + 0.6)
        else:
            delay = max(1, interval)
            self.emit("loop")
        self.schedule("action", delay, self.repeat, self.jobs["action"])
        return self.snapshot()


    def operate(
        self,
        kind,
        item_id=None,
        loop=False,
        randomize=False,
        body=False,
        direction=None,
    ):
        if kind not in KINDS:
            raise ValueError("操作类型无效")
        if kind == "expression" and item_id == -1:
            self.playing.pop("expression", None)
            self.emit("clear-expression")
            return self.snapshot()
        if kind == "action" and loop and randomize and self.settings()["performanceEnabled"]:
            return self.loop_performance()
        entries = self.entries(kind)
        if body and kind == "action":
            categories = {entry["category"] for entry in entries}
            direction = (
                direction
                if direction in categories
                else "body" if "body" in categories else "other"
            )
            entries = [entry for entry in entries if entry["category"] == direction]
        if randomize:
            only = (
                self.settings().get(kind + "Scope", 0)
                if kind in self.jobs and not body
                else self.settings()["bodyOnly"]
            )
            entries = [
                entry
                for entry in entries
                if not only or entry["flag"] in self.settings()["favorites"]
            ]
            if kind == "costume" and (
                not loop
                or (
                    len(entries) > 1 and self.settings().get(kind + "Order") == "random"
                )
            ):
                entries = [
                    entry
                    for entry in entries
                    if entry["id"] != self.settings()["costume"]
                ]
            if not entries:
                if body:
                    return self.snapshot()
                raise ValueError(
                    "当前范围为空，请先添加❤收藏" if only else "当前没有可播放的内容"
                )
            if loop and self.settings()[kind + "Order"] == "sequence":
                cursor_key = (kind, self.costume()["id"] if kind != "costume" else 0)
                last_id = self.cursors.get(cursor_key, -1)
                item = next(
                    (entry for entry in entries if entry["id"] > last_id), entries[0]
                )
                self.cursors[cursor_key] = item["id"]
            else:
                item = random.choice(entries)
        else:
            item = next((entry for entry in entries if entry["id"] == item_id), None)
        if item is None:
            raise ValueError("条目不存在")
        if kind == "costume" and loop and not self.looping[kind]:
            self.jobs[kind] += 1
            self.looping[kind] = True
            self.cursors[(kind, 0)] = self.settings()["costume"]
            self.playing[kind] = {
                "id": self.costume()["id"],
                "name": self.costume()["name"],
                "startedAt": time.time(),
            }
            self.schedule(
                kind, self.settings()["costumeInterval"], self.repeat, self.jobs[kind]
            )
            self.emit("loop")
            return self.snapshot()
        self.jobs[kind] += 1
        generation = self.jobs[kind]
        self.looping[kind] = bool(loop)
        if kind == "costume":
            self.select(self.current, item["id"], from_loop=loop)
        duration = item.get("duration", 4) if kind in ("action", "voice") else 0
        self.playing[kind] = {
            "id": item["id"],
            "startedAt": time.time(),
            "name": item["name"],
            "duration": duration,
        }
        if kind != "costume":
            self.emit(
                "play",
                {
                    "kind": kind,
                    "item": item,
                    "generation": generation,
                    "costume": self.costume()["id"],
                },
            )
        if loop:
            self.schedule(kind, duration + self.settings()[kind + "Interval"], self.repeat, generation)
        elif kind in ("action", "voice"):
            self.schedule(kind, duration, self.finish, generation)
        else:
            self.repeat_at.pop(kind, None)
            previous = self.timers.pop(kind, None)
            if previous:
                previous.cancel()
        return self.snapshot()


    def schedule(self, kind, delay, callback, generation):
        previous = self.timers.pop(kind, None)
        if previous:
            previous.cancel()
        if callback == self.repeat:
            self.repeat_at[kind] = (time.monotonic() + delay, generation)
        else:
            self.repeat_at.pop(kind, None)
        timer = threading.Timer(delay, callback, args=(kind, generation))
        timer.daemon = True
        self.timers[kind] = timer
        timer.start()


    def reset(self):
        for kind in self.jobs:
            self.stop(kind)
        self.operate("expression", item_id=-1)
        self.playing.clear()
        self.emit("reset")
        return self.snapshot()


    def finish(self, kind, generation):
        with self.lock:
            if self.jobs[kind] != generation:
                return
            self.timers.pop(kind, None)
            self.playing.pop(kind, None)
            self.emit("ended", kind)


    def repeat(self, kind, generation):
        with self.lock:
            scheduled = self.repeat_at.get(kind)
            if not scheduled or scheduled[1] != generation or self.jobs[kind] != generation:
                return
            now = time.monotonic()
            # Take due tracks in order while the same lock protects costume selection.
            for track in LOOP_INTERVALS:
                pending = self.repeat_at.get(track)
                if not pending or pending[0] > now + 0.04:
                    continue
                voice_remaining = self.playback_remaining("voice") if track == "voice" else 0
                if voice_remaining > 0.01:
                    self.jobs[track] += 1
                    self.schedule(track, voice_remaining + 0.05, self.repeat, self.jobs[track])
                    continue
                self.repeat_at.pop(track)
                timer = self.timers.pop(track, None)
                if timer:
                    timer.cancel()
                try:
                    self.operate(track, loop=True, randomize=True)
                except (ValueError, ConnectionError) as error:
                    self.stop(track)
                    self.emit("notice", str(error))


    def preview(self, role_id, costume_id):
        role = self.catalog(role_id)
        costume = next(c for c in role["costumes"] if c["id"] == costume_id)
        if role.get("renderOnly"):
            return self.plain_preview
        root = self.root(role_id)
        path = role_package.folder_file(root, costume["file"]) if self.folder_assets is not None else root / costume["file"]
        model = read(path)
        c3 = "FileReferences" in model
        refs = model["FileReferences"] if c3 else model
        groups = refs.get("Motions" if c3 else "motions", {})
        startup = groups["Start" if c3 else "start"][0]
        import re

        textures = refs.get("Textures" if c3 else "textures", []).copy()
        for index, path in re.findall(
            r"replace_tex (\d+) ([^;\s]+)",
            startup.get("PostCommand" if c3 else "post_command", ""),
        ):
            textures[int(index)] = path
        base = "/assets/" + role_id + "/"
        motions = {}
        source_fades = role.get("motionFadePolicy") == "source"
        fade_in_key, fade_out_key = ("FadeInTime", "FadeOutTime") if c3 else ("fade_in", "fade_out")
        fade_unit = 1000 if c3 else 1
        for item in costume["actions"]:
            definition = {"File" if c3 else "file": base + item["file"]}
            if source_fades:
                definition.update({fade_in_key: item["fadeIn"] / fade_unit,
                                   fade_out_key: item["fadeOut"] / fade_unit})
            motions["page_" + str(item["id"])] = [definition]
        idle = groups.get("Idle" if c3 else "idle", [])
        if idle:
            motions["Idle" if c3 else "idle"] = [
                {
                    "File" if c3 else "file": base
                    + idle[0]["File" if c3 else "file"]
                }
            ]
            if source_fades:
                motions["Idle" if c3 else "idle"][0].update({
                    fade_in_key: idle[0]["FadeIn" if c3 else "fade_in"] / fade_unit,
                    fade_out_key: idle[0]["FadeOut" if c3 else "fade_out"] / fade_unit,
                })
        expressions = [
            {
                "Name" if c3 else "name": str(item["id"]),
                "File" if c3 else "file": base + item["file"],
            }
            for item in costume["expressions"]
            if item["file"]
        ]
        if c3:
            result = {
                "Version": 3,
                "FileReferences": {
                    "Moc": base + refs["Moc"],
                    "Textures": [base + path for path in textures],
                    "Motions": motions,
                    "Expressions": expressions,
                },
            }
            for key in ("Physics", "Pose"):
                if refs.get(key):
                    result["FileReferences"][key] = base + refs[key]
        else:
            result = {
                "version": "1.0.0",
                "model": base + refs["model"],
                "textures": [base + path for path in textures],
                "motions": motions,
                "expressions": expressions,
            }
            for key in ("physics", "pose"):
                if refs.get(key):
                    result[key] = base + refs[key]
        controller = model.get("Controllers" if c3 else "controllers", {}).get(
            "LipSync" if c3 else "lip_sync", {}
        )
        result["pageMouthIds"] = [
            item.get("Id", item.get("id"))
            for item in controller.get("Items", controller.get("items", []))
        ]
        if source_fades:
            result["pageMotionFadePolicy"] = "source"
        return result



STUDIO = None


class Handler(BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except ConnectionError:
            self.close_connection = True


    def log_message(self, *args):
        pass


    def respond(self, status, value, content_type="application/json; charset=utf-8"):
        data = (
            value
            if isinstance(value, bytes)
            else json.dumps(value, ensure_ascii=False).encode()
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


    def do_GET(self):
        request = urlsplit(self.path)
        path = unquote(request.path)
        try:
            if WEB != HERE / "web" and path.startswith("/vendor/"):
                name = path.removeprefix("/vendor/")
                if name == "index.min.js" and not (HERE / ".local/runtime/live2d.min.js").is_file():
                    if (HERE / ".local/runtime/live2dcubismcore.min.js").is_file():
                        return self.respond(200, (WEB / "vendor/cubism4.min.js").read_bytes(), "application/javascript")
                    return self.respond(200, b"", "application/javascript")
                if name in live2d_runtime.RUNTIMES:
                    script = HERE / ".local/runtime" / name
                    if script.is_file():
                        return self.respond(200, script.read_bytes(), "application/javascript")
                    return self.respond(200, b"", "application/javascript")
            if path == "/api/library":
                return self.respond(200, list(STUDIO.roles.values()))
            if path == "/api/state":
                return self.respond(200, STUDIO.snapshot())
            if path == "/api/models":
                with STUDIO.lock:
                    return self.respond(200, STUDIO.library.list_models(STUDIO.model_record))
            if path == "/api/scene":
                return self.respond(200, STUDIO.library.current_scene())
            if path == "/api/scenes":
                with STUDIO.lock:
                    return self.respond(200, [{"id": key, **item} for key, item in reversed(STUDIO.library.presets.items())])
            if path.startswith("/api/desk-preview/"):
                _, _, _, kind, item_id = path.split("/")
                return self.respond(200, STUDIO.library.preview(kind, item_id).read_bytes(), "image/webp")
            if path.startswith("/api/scene-media/"):
                file = STUDIO.library.media(path.rsplit("/", 1)[-1])
                if file is None:
                    return self.respond(404, {"error": "壁纸素材已失效"})
                mime = next(kind for kind, extension in MEDIA_TYPES.items() if file.suffix[1:] == extension)
                with file.open("rb") as stream:
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    while chunk := stream.read(256 * 1024):
                        self.wfile.write(chunk)
                return
            if path == "/api/mode":
                return self.respond(200, {"standalone": True})
            if path.startswith("/api/catalog/"):
                return self.respond(200, STUDIO.page_catalog(path.rsplit("/", 1)[1]))
            if path.startswith("/api/thumbnail/"):
                _, _, _, role_id, costume_id = path.split("/")
                return self.respond(
                    200,
                    STUDIO.thumbnail_path(role_id, int(costume_id)).read_bytes(),
                    "image/webp",
                )
            if path == "/api/events":
                return self.events(STUDIO)
            if path.startswith("/api/preview/"):
                _, _, _, role_id, costume_id = path.split("/")
                return self.respond(200, STUDIO.preview(role_id, int(costume_id)))
            if path.startswith("/assets/"):
                _, _, role_id, relative = path.split("/", 3)
                with STUDIO.lock:
                    if STUDIO.plain_preview is None and not role_package.preview_asset(relative):
                        raise ValueError("资源不存在")
                    if STUDIO.folder_assets is not None and relative not in STUDIO.folder_assets:
                        raise ValueError("资源不存在")
                    root = STUDIO.root(role_id)
                    file = (root / relative).resolve()
                    if not file.is_relative_to(root) or not file.is_file():
                        raise ValueError("资源不存在")
                    mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
                    data = file.read_bytes()
                return self.respond(200, data, mime)
            else:
                root = WEB
                file = (root / (path.lstrip("/") or "index.html")).resolve()
                if not file.is_relative_to(root) or not file.is_file():
                    return self.respond(404, {"error": "页面不存在"})
            mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            data = file.read_bytes()
            self.respond(200, data, mime)
        except ConnectionError:
            raise
        except (ValueError, KeyError, StopIteration, OSError) as error:
            self.respond(404, {"error": str(error)})


    def events(self, studio):
        try:
            sequence = min(
                int(self.headers.get("Last-Event-ID", str(studio.sequence))),
                studio.sequence,
            )
        except ValueError:
            return self.respond(400, {"error": "事件编号无效"})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                with studio.changed:
                    pending = [
                        event for event in studio.events if event["id"] > sequence
                    ]
                    if not pending:
                        studio.changed.wait(timeout=15)
                if not pending:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                for event in pending:
                    self.wfile.write(
                        (
                            "id: "
                            + str(event["id"])
                            + "\ndata: "
                            + json.dumps(event, ensure_ascii=False)
                            + "\n\n"
                        ).encode()
                    )
                    sequence = event["id"]
                self.wfile.flush()
        except (OSError, ConnectionError):
            return


    def do_POST(self):
        request = urlsplit(self.path)
        path = request.path
        origin = self.headers.get("Origin")
        if self.headers.get("X-Studio-Request") != "1" or origin not in (
            None,
            f"http://127.0.0.1:{PORT}",
            f"http://localhost:{PORT}",
        ):
            return self.respond(403, {"error": "请求来源无效"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                self.close_connection = True
                raise ValueError("请求长度无效")
            if path == "/api/import":
                self.close_connection = True
                try:
                    STUDIO.import_role(self.rfile, length)
                except (zipfile.BadZipFile, NotImplementedError, RuntimeError, AttributeError, IndexError,
                        KeyError, TypeError, json.JSONDecodeError) as error:
                    raise ValueError("无法读取角色 ZIP，请重新下载角色包") from error
                return self.respond(200, {"imported": True})
            if path == "/api/import-folder":
                self.close_connection = True
                token = os.environ.get("BANDORILOVE_ROLE_IMPORT_TOKEN", "")
                supplied = self.headers.get("Authorization", "")
                if (origin is not None or not token
                        or not secrets.compare_digest(supplied.encode(), f"Bearer {token}".encode())):
                    return self.respond(403, {"error": "请通过桌宠程序选择模型文件"})
                if not 0 < length <= 131072:
                    raise ValueError("模型文件路径无效")
                try:
                    entry = json.loads(self.rfile.read(length))["entry"]
                    STUDIO.import_selected_model(Path(entry))
                except (zipfile.BadZipFile, NotImplementedError, RuntimeError, AttributeError, IndexError,
                        KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ValueError("无法读取模型文件，或模型包与其配置不匹配") from error
                return self.respond(200, {"imported": True})
            if path == "/api/exit":
                self.close_connection = True
                self.respond(200, {"closed": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if path == "/api/desktop-state":
                token = os.environ.get("BANDORILOVE_ROLE_IMPORT_TOKEN", "")
                supplied = self.headers.get("Authorization", "")
                if origin is not None or not token or not secrets.compare_digest(supplied, f"Bearer {token}"):
                    return self.respond(403, {"error": "请求来源无效"})
                if not 0 < length <= 1024:
                    raise ValueError("桌面状态无效")
                state = json.loads(self.rfile.read(length))
                if not isinstance(state, dict):
                    raise ValueError("桌面状态无效")
                with STUDIO.lock:
                    return self.respond(200, STUDIO.desktop_state(state))
            if path == "/api/scene-media":
                self.close_connection = True
                media = STUDIO.library.add_media(self.rfile, length, self.headers.get("Content-Type", ""))
                return self.respond(200, {"media": media})
            if path == "/api/model-restore":
                if length > 1024 or not self.authorized_host(origin):
                    return self.respond(403, {"error": "请求来源无效"})
                self.close_connection = True
                source = STUDIO.library.history.get(STUDIO.saved.get("sourceModel"))
                if source:
                    STUDIO.import_selected_model(Path(source["source"]))
                return self.respond(200, {"restored": bool(source)})
            if path in {"/api/model-history", "/api/model-preview", "/api/scene", "/api/scene-save", "/api/scene-remove"}:
                if not 0 < length <= 1_500_000:
                    raise ValueError("请求过大")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("请求格式无效")
                return self.respond(200, self.update_library(path, data))
            if not STUDIO.current:
                return self.respond(400, {"error": "请先导入角色包"})
            if length > (1500000 if path == "/api/thumbnail" else 65536):
                self.close_connection = True
                raise ValueError("请求过大")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("请求格式无效")
            with STUDIO.lock:
                if STUDIO.plain_preview is not None and path in (
                    "/api/select", "/api/operate", "/api/favorite", "/api/stop", "/api/reset",
                    "/api/performance/save", "/api/performance/touch",
                ):
                    raise ValueError("普通 Live2D 模型仅支持预览和独立桌宠")
                if path == "/api/select":
                    result = STUDIO.select(data["role"], data.get("costume"))
                elif path == "/api/favorite":
                    result = STUDIO.favorite(data["flag"], bool(data["enabled"]))
                elif path == "/api/preference":
                    if STUDIO.plain_preview is not None and data["key"] not in {"thirdPartyMenuEnabled", "captions"}:
                        raise ValueError("此设置仅用于角色发行包")
                    result = STUDIO.preference(data["key"], data["value"])
                elif path == "/api/performance/save":
                    result = STUDIO.save_performance(data["role"], data["costume"], data["preset"], data["group"])
                elif path == "/api/performance/touch":
                    result = STUDIO.touch_performance(data["role"], data["costume"])
                elif path == "/api/operate":
                    result = STUDIO.operate(
                        data["kind"],
                        data.get("id"),
                        bool(data.get("loop")),
                        bool(data.get("random")),
                        bool(data.get("body")),
                        data.get("direction"),
                    )
                elif path == "/api/stop":
                    STUDIO.stop(data["kind"])
                    result = STUDIO.snapshot()
                elif path == "/api/thumbnail":
                    result = STUDIO.save_thumbnail(
                        data["role"], int(data["costume"]), data["image"]
                    )
                elif path == "/api/reset":
                    result = STUDIO.reset()
                else:
                    return self.respond(404, {"error": "操作不存在"})
            self.respond(200, result)
        except (ValueError, TypeError, KeyError, ConnectionError, OSError) as error:
            self.respond(400, {"error": str(error)})

    def authorized_host(self, origin):
        token = os.environ.get("BANDORILOVE_ROLE_IMPORT_TOKEN", "")
        return origin is None and token and secrets.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}")

    def update_library(self, path, data):
        library = STUDIO.library
        if path == "/api/model-history" and not data.get("remove"):
            with STUDIO.lock:
                record = library.history.get(data.get("id"))
            if not record or not Path(record["source"]).is_file():
                raise ValueError("模型文件已移动或删除，请重新导入")
            STUDIO.import_selected_model(Path(record["source"]))
            return STUDIO.snapshot()
        with STUDIO.lock:
            if path == "/api/model-history":
                item = data.get("id")
                library.remove_model(item)
                if STUDIO.saved.get("sourceModel") == item:
                    STUDIO.saved.pop("sourceModel")
                    STUDIO.save()
                return {"removed": True}
            if path == "/api/model-preview":
                item = data.get("id")
                if item == STUDIO.model_record and item in library.history:
                    library.save_preview("model", item, data.get("image"))
                return {"saved": True}
            if path == "/api/scene":
                value = library.save_scene(data.get("layers"))
                STUDIO.emit("scene", value)
                return value
            if path == "/api/scene-save":
                return {"id": library.save_preset(data.get("name"), data.get("layers"), STUDIO.model_record, data.get("image"))}
            return {"removed": library.remove_scene(data.get("id"))}



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--panel-dir", type=Path)
    args = parser.parse_args()
    if args.panel_dir:
        HERE = args.panel_dir.resolve()
        if "BANDORILOVE_WEB_DIR" not in os.environ:
            WEB = HERE / "web"
    STUDIO = Studio()
    endpoint = HERE / ".local/endpoint.json"
    try:
        previous = read(endpoint).get("port", 0)
        previous = previous if type(previous) is int and 1024 <= previous <= 65535 else 0
    except (OSError, ValueError, AttributeError):
        previous = 0
    try:
        server = ThreadingHTTPServer(("127.0.0.1", previous), Handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    PORT = server.server_port
    atomic_write(endpoint, {"port": PORT, "pid": os.getpid(), "startup": os.environ.get("BANDORILOVE_STARTUP", "")})
    with server:
        server.serve_forever()
