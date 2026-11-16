"""Read one verified role package for the local browser preview."""

import hashlib
import json
from pathlib import Path
import re
import zipfile


MAX_BYTES = 2 * 1024**3
SAFE_WEB_ASSETS = {".moc", ".moc3", ".json", ".mtn", ".png", ".jpg", ".jpeg",
                   ".webp", ".wav", ".mp3", ".ogg", ".m4a", ".flac"}


def role_id(value):
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value) is not None


def safe_parts(name):
    parts = name.split("/")
    if any(not part or part.endswith((".", " ")) or re.search(r'[\\<>:"|?*\x00-\x1f]', part)
           or part.split(".")[0].rstrip().upper() in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
           or re.fullmatch(r"(?:COM|LPT)[1-9¹²³]", part.split(".")[0].rstrip(), re.I) for part in parts):
        raise ValueError("角色包包含无效的文件路径")
    return parts


def preview_asset(relative):
    parts = safe_parts(relative)
    return len(parts) > 1 and parts[0] == "assets" and Path(relative).suffix.lower() in SAFE_WEB_ASSETS


def role_index(read_json, contains):
    manifest = read_json("manifest.json")
    files = manifest["files_sha256"]
    index = "Preview" if contains("Preview/library.json") else "ControlPanel"
    library_path = f"{index}/library.json"
    library = read_json(library_path)
    if not isinstance(library, list) or len(library) != 1:
        raise ValueError("角色包缺少单角色索引")
    role = library[0]
    identity = role["id"]
    if not role_id(identity):
        raise ValueError("角色编号无效")
    catalog_path = f"{index}/data/{identity}.json"
    catalog = read_json(catalog_path)
    if (catalog["id"] != identity or catalog["directory"] != "."
            or catalog["entry"] != role["entry"] or not catalog["costumes"]):
        raise ValueError("角色包索引无效")
    entries = {catalog["entry"], *(costume["file"] for costume in catalog["costumes"])}
    for name in entries:
        if len(safe_parts(name)) != 1 or not name.endswith((".model.json", ".model3.json")):
            raise ValueError("角色模型路径无效")
    chosen = entries | {library_path, catalog_path} | {name for name in files if name.startswith("assets/")}
    for name in chosen:
        safe_parts(name)
    return role, catalog, {name: files[name] for name in sorted(chosen)}


def folder_file(root, name):
    file = root.joinpath(*safe_parts(name)).resolve()
    if not file.is_relative_to(root) or not file.is_file():
        raise ValueError(f"角色目录缺少有效文件：{name}")
    return file


def inspect_folder(entry):
    if not entry.is_absolute() or not entry.is_file() or not entry.name.lower().endswith((".model.json", ".model3.json")):
        raise ValueError("请选择解压目录中的父模型 JSON")
    root = entry.parent.resolve()

    def read_json(name):
        file = folder_file(root, name)
        if file.stat().st_size > 12 * 1024**2:
            raise ValueError("角色包索引过大")
        return json.loads(file.read_bytes())

    role, catalog, files = role_index(read_json, lambda name: (root / name).is_file())
    if entry.name.casefold() != catalog["entry"].casefold():
        raise ValueError(f"请选择父模型 {catalog['entry']}")
    size = 0
    for name, expected in files.items():
        file = folder_file(root, name)
        size += file.stat().st_size
        if size > MAX_BYTES:
            raise ValueError("角色包超过 2 GB")
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise ValueError(f"角色包文件校验失败：{name}")
    return root, role, catalog, frozenset(name for name in files if name.startswith("assets/"))


def extract(archive_path, destination):
    with zipfile.ZipFile(archive_path) as archive:
        members = {}
        folded = set()
        for entry in archive.infolist():
            safe_parts(entry.filename.removesuffix("/"))
            if entry.is_dir():
                continue
            key = entry.filename.casefold()
            if key in folded:
                raise ValueError("角色包包含重名文件")
            folded.add(key)
            members[entry.filename] = entry
        manifests = [name for name in members if name.split("/")[-1] == "manifest.json" and name.count("/") <= 1]
        if len(manifests) != 1:
            raise ValueError("请选择只包含一个角色的 BandoriLove ZIP")
        manifest_name = manifests[0]
        prefix = manifest_name.removesuffix("manifest.json")

        def read_json(name):
            entry = members[prefix + name]
            if entry.file_size > 12 * 1024**2:
                raise ValueError("角色包索引过大")
            return json.loads(archive.read(entry))

        role, catalog, files = role_index(read_json, lambda name: prefix + name in members)
        items = [(name, members[prefix + name], expected) for name, expected in files.items()]
        if sum(entry.file_size for _, entry, _ in items) > MAX_BYTES:
            raise ValueError("解压后的角色包超过 2 GB")
        for name, entry, expected in items:
            target = destination.joinpath(*safe_parts(name))
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with archive.open(entry) as source, target.open("xb") as file:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    file.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f"角色包文件校验失败：{name}")
        return role, catalog
