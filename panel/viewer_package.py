"""Read the Live2D preview assets declared in a local ViewerEX package."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
from zipfile import ZipFile

from role_package import MAX_BYTES, folder_file, safe_parts


META = hashlib.md5(b"config.mlve").hexdigest()
JSON_LIMIT = 12 * 1024**2
CHUNK = 1024 * 1024
START_SUBMODEL = re.compile(r"(?:^|;)\s*add_submodel\s+([0-9a-f]{32}\.bin3?)(?=\s|;|$)")
START_TEXTURE = re.compile(r"(?:^|;)\s*replace_tex\s+(\d{1,5})\s+([0-9a-f]{32}\.bin3?)(?=\s|;|$)")


def members(archive):
    result = {}
    seen = set()
    for member in archive.infolist():
        name = member.filename.removesuffix("/")
        safe_parts(name)
        if member.is_dir():
            continue
        key = name.casefold()
        if key in seen or len(seen) >= 20000:
            raise ValueError("模型包包含重复或过多的文件")
        seen.add(key)
        result[name] = member
    return result


def reference(value):
    if not isinstance(value, str) or not value:
        raise ValueError("模型包包含无效的资源引用")
    return "/".join(safe_parts(value.replace("\\", "/").removeprefix("./")))


def json_data(data):
    value = json.loads(data.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("模型包的配置格式无效")
    return value


def archive_json(archive, member):
    if member.file_size > JSON_LIMIT:
        raise ValueError("模型包配置过大")
    return json_data(archive.read(member))


def wpk_preview(source, destination):
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("模型包超过 2 GB")
    with ZipFile(source) as archive:
        files = members(archive)
        indexes = [path for path in files if PurePosixPath(path).name == "config.json"]
        if "config.json" in files:
            indexes = ["config.json"]
        if len(indexes) != 1:
            raise ValueError("WPK 缺少唯一的创意工坊模型配置")
        index = indexes[0]
        config = archive_json(archive, files[index])
        name = reference(config.get("lpkFile"))
        member = files.get((PurePosixPath(index).parent / name).as_posix()) or files.get(name)
        if member is None or not name.lower().endswith(".lpk") or member.file_size > MAX_BYTES:
            raise ValueError("WPK 缺少有效的 LPK 模型文件")
        destination.mkdir(parents=True)
        embedded = destination / "embedded.lpk"
        with archive.open(member) as packed, embedded.open("xb") as output:
            shutil.copyfileobj(packed, output, CHUNK)
    try:
        return lpk_preview(embedded, destination, config)
    finally:
        embedded.unlink()


def member_mask(seed):
    # Same repeating STD2_0/STM_1_0 member encoding as tools/process_lpk.py.
    key = 0
    for character in seed:
        key = (key * 31 + ord(character)) & 0xFFFFFFFF
    stream = bytearray()
    for _ in range(1024):
        key = ((2531011 + 214013 * key) >> 16) & 0xFFFF
        stream.append(key & 255)
    return bytes(stream)


def decode_chunk(data, mask):
    if not mask:
        return data
    repeated = (mask * ((len(data) + 1023) // 1024))[:len(data)]
    return (int.from_bytes(data, "little") ^ int.from_bytes(repeated, "little")).to_bytes(len(data), "little")


def packed_resources(source, metadata, workshop):
    kind = metadata.get("type")
    if kind not in {"STD2_0", "STM_1_0"}:
        raise ValueError(f"暂不支持此 LPK 类型：{kind or '未知'}")
    encrypted = str(metadata.get("encrypt", "true")).lower() == "true"
    if not encrypted:
        return lambda _: b""
    identity = str(metadata.get("id", ""))
    if not identity or len(identity) > 128:
        raise ValueError("LPK 缺少有效的模型编号")
    if kind != "STM_1_0":
        return lambda name: member_mask(identity + name)
    if workshop is None:
        sidecar = source.parent / "config.json"
        if not sidecar.is_file() or sidecar.stat().st_size > JSON_LIMIT:
            raise ValueError("创意工坊 LPK 缺少同目录的 config.json，请直接导入完整 WPK")
        workshop = json_data(folder_file(source.parent.resolve(), "config.json").read_bytes())
    item = str(workshop.get("fileId") or "")
    if not item:
        item = PurePosixPath(reference(workshop.get("lpkFile"))).stem
    tag = workshop.get("metaData")
    if not item.isdecimal() or len(item) > 24 or not isinstance(tag, str) or not tag or len(tag) > 256:
        raise ValueError("创意工坊模型配置缺少有效的物品编号或元数据")
    return lambda name: member_mask(identity + item + name + tag)


def entry_names(metadata, files):
    declared = []
    for role in metadata.get("list", []):
        for costume in role.get("costume", []):
            if costume.get("path"):
                declared.append(reference(costume["path"]))
    if not declared:
        declared = [name for name in files if name.lower().endswith((".model3.json", ".model.json"))]
    return dict.fromkeys(declared)


def model_parts(model):
    modern = "FileReferences" in model
    refs = model.get("FileReferences") if modern else model
    if not isinstance(refs, dict):
        return None
    moc = "Moc" if modern else "model"
    textures = "Textures" if modern else "textures"
    if not isinstance(refs.get(moc), str) or not isinstance(refs.get(textures), list) or not refs[textures]:
        return None
    return modern, refs, moc, textures


def commands(refs, modern, group):
    groups = refs.get("Motions" if modern else "motions", {})
    for event in groups.get(group, []):
        for key in (("Command", "PostCommand") if modern else ("command", "post_command")):
            text = event.get(key)
            if isinstance(text, str):
                yield text


def lpk_preview(source, destination, workshop=None):
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("模型包超过 2 GB")
    with ZipFile(source) as archive:
        files = members(archive)
        config = files.get(META) or files.get("config.mlve")
        if config is None:
            raise ValueError("LPK 缺少模型配置")
        metadata = archive_json(archive, config)
        mask_for = packed_resources(source, metadata, workshop)

        def load(name):
            member = files.get(name)
            if member is None or member.file_size > JSON_LIMIT:
                raise ValueError(f"LPK 缺少有效的模型配置：{name}")
            return json_data(decode_chunk(archive.read(member), mask_for(name)))

        # Some workshop exports use the zero seed for a package flagged as unencrypted.
        names = entry_names(metadata, files)
        if metadata.get("type") == "STM_1_0" and names and not mask_for(next(iter(names))):
            first = files.get(next(iter(names)))
            if first is not None:
                with archive.open(first) as file:
                    raw = file.read(1024).lstrip(b"\xef\xbb\xbf \r\n\t")
                if not raw.startswith(b"{"):
                    mask_for = lambda _: member_mask("")

        picked = None
        for entry in names:
            model = load(entry)
            parts = model_parts(model)
            if parts is None:
                continue
            modern, refs, _, _ = parts
            options = model.get("Options" if modern else "options", {})
            identity = str(options.get("Id" if modern else "id", ""))
            if "l2d_carrier_" in identity:
                startup = "Start" if modern else "start"
                for text in (*commands(refs, modern, startup), *commands(refs, modern, "carrier_switch_001")):
                    command = START_SUBMODEL.search(text)
                    if command and command[1] in files:
                        child = model_parts(load(command[1]))
                        if child:
                            parts = child
                            break
            picked = parts
            break
        if picked is None:
            raise ValueError("模型包里没有可预览的 Live2D 模型")
        modern, refs, moc, textures = picked
        texture_files = refs[textures].copy()
        for text in commands(refs, modern, "Start" if modern else "start"):
            for replacement in START_TEXTURE.finditer(text):
                index = int(replacement[1])
                if index < len(texture_files) and replacement[2] in files:
                    texture_files[index] = replacement[2]
        destination.mkdir(parents=True, exist_ok=True)
        total = 0

        def asset(name, label, kind):
            nonlocal total
            name = reference(name)
            member = files.get(name)
            if member is None:
                raise ValueError(f"模型包缺少资源：{name}")
            total += member.file_size
            if total > MAX_BYTES:
                raise ValueError("模型包的渲染资源超过 2 GB")
            stream_mask = mask_for(name)
            with archive.open(member) as incoming:
                first = decode_chunk(incoming.read(CHUNK), stream_mask)
                suffix = asset_suffix(first, kind)
                file = destination / (label + suffix)
                with file.open("xb") as output:
                    output.write(first)
                    while chunk := incoming.read(CHUNK):
                        output.write(decode_chunk(chunk, stream_mask))
            return file.name

        model = {
            moc: asset(refs[moc], "model", "moc3" if modern else "moc"),
            textures: [asset(value, f"texture-{index}", "texture") for index, value in enumerate(texture_files)],
        }
        for key in (("Physics", "Pose") if modern else ("physics", "pose")):
            if refs.get(key):
                model[key] = asset(refs[key], key.lower(), "json")
        entry = destination / ("model.model3.json" if modern else "model.model.json")
        preview = {"Version": 3, "FileReferences": model} if modern else model
        entry.write_text(json.dumps(preview), "utf-8")
        title = (workshop or {}).get("title") or metadata.get("name")
        return entry, title if isinstance(title, str) else None


def asset_suffix(data, kind):
    if kind == "moc3" and data.startswith(b"MOC3"):
        return ".moc3"
    if kind == "moc" and data.startswith(b"moc"):
        return ".moc"
    if kind == "json" and data.lstrip(b"\xef\xbb\xbf \r\n\t").startswith(b"{"):
        return ".json"
    if kind == "texture":
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return ".png"
        if data.startswith(b"\xff\xd8\xff"):
            return ".jpg"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return ".webp"
    raise ValueError("模型资源格式不支持，或与模型包配置不匹配")
