"""Read one verified role package for the local browser preview."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import zipfile
from urllib.parse import quote


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
    checks = []
    for name, expected in files.items():
        file = folder_file(root, name)
        size += file.stat().st_size
        if size > MAX_BYTES:
            raise ValueError("角色包超过 2 GB")
        checks.append((name, file, expected))

    def verify(check):
        name, file, expected = check
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise ValueError(f"角色包文件校验失败：{name}")

    if len(checks) >= 128:
        with ThreadPoolExecutor(max_workers=4) as workers:
            for _ in workers.map(verify, checks):
                pass
    else:
        for check in checks:
            verify(check)
    return root, role, catalog, frozenset(name for name in files if name.startswith("assets/"))


def is_indexed_folder(root):
    return any((root / name).is_file() for name in ("Preview/library.json", "ControlPanel/library.json"))


def inspect_plain_model(entry):
    if not entry.is_absolute() or entry.suffix.lower() != ".json":
        raise ValueError("请选择 Live2D 模型 JSON")
    root = entry.parent.resolve()
    file = folder_file(root, entry.name)
    if file.stat().st_size > 12 * 1024**2:
        raise ValueError("模型 JSON 文件过大")
    source = json.loads(file.read_bytes())
    if not isinstance(source, dict):
        raise ValueError("Live2D 模型 JSON 格式无效")
    modern = "FileReferences" in source or entry.name.lower().endswith(".model3.json")
    refs = source.get("FileReferences") if modern else source
    if not isinstance(refs, dict):
        raise ValueError("模型 JSON 缺少 Live2D 文件引用")
    reference = "Moc" if modern else "model"
    textures_key = "Textures" if modern else "textures"
    textures = refs.get(textures_key)
    if not refs.get(reference) or not isinstance(textures, list) or not textures:
        raise ValueError("请选择包含模型和贴图引用的 Live2D JSON")

    identity = "model-" + hashlib.sha256(str(file).casefold().encode()).hexdigest()[:20]
    assets = set()
    size = 0

    def resource(value, extensions):
        nonlocal size
        if not isinstance(value, str) or not value:
            raise ValueError("模型资源路径无效")
        value = value.replace("\\", "/")
        while value.startswith("./"):
            value = value[2:]
        if Path(value).suffix.lower() not in extensions:
            raise ValueError(f"不支持的模型资源：{value}")
        if value not in assets:
            size += folder_file(root, value).stat().st_size
            if size > MAX_BYTES:
                raise ValueError("模型资源超过 2 GB")
            assets.add(value)
        return "/assets/" + identity + "/" + quote(value, safe="/")

    model_refs = {
        reference: resource(refs[reference], {".moc3"} if modern else {".moc"}),
        textures_key: [resource(texture, {".png", ".jpg", ".jpeg", ".webp"}) for texture in textures],
    }
    for key in (("Physics", "Pose") if modern else ("physics", "pose")):
        if refs.get(key):
            model_refs[key] = resource(refs[key], {".json"})
    preview = {"Version": 3, "FileReferences": model_refs} if modern else model_refs
    name = re.sub(r"(?:\.model3?)?\.json$", "", entry.name, flags=re.IGNORECASE)
    role = {"id": identity, "name": name.strip() or entry.stem, "game": "Live2D",
            "group": "", "entry": entry.name, "directory": ".", "renderOnly": True}
    costume = {"id": 1, "name": role["name"], "file": entry.name, "cubism3": modern,
               "actions": [], "expressions": [], "hitRegions": {}}
    catalog = {**role, "costumes": [costume], "voices": []}
    return root, role, catalog, frozenset(assets), preview


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
        created = set()
        for name, entry, expected in items:
            target = destination.joinpath(*safe_parts(name))
            if target.parent not in created:
                target.parent.mkdir(parents=True, exist_ok=True)
                created.add(target.parent)
            digest = hashlib.sha256()
            with archive.open(entry) as source, target.open("xb") as file:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    file.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f"角色包文件校验失败：{name}")
        return role, catalog
