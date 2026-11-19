"""Known Live2D runtimes used by the Windows player."""

import hashlib
from urllib.request import Request, urlopen
from zipfile import ZipFile

from role_package import folder_file

RUNTIMES = {
    "live2d.min.js": "e4ea1f18bdd44b65394ffd5a1bab16982e88757d45134d1bd0737c8a6b3ddd08",
    "live2dcubismcore.min.js": "913e10e881aa7abec8e65bbb8c2540db3fe9acf987c7537befa521f8a7f51009",
}
CUBISM_CORE = "live2dcubismcore.min.js"
LEGACY_CORE = "live2d.min.js"
CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"
CORE_DOWNLOAD_SHA256 = "25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f"
RUNTIME_LIMIT = 512_000


def import_runtime(archive_path, output):
    """Install the known runtime already present in a supported role ZIP."""
    scripts = {}
    with ZipFile(archive_path) as archive:
        for name in RUNTIMES:
            suffix = "/ControlPanel/web/vendor/" + name
            candidates = [item for item in archive.infolist() if ("/" + item.filename).endswith(suffix)]
            if len(candidates) != 1 or candidates[0].file_size > RUNTIME_LIMIT:
                raise ValueError("角色 ZIP 缺少受支持的 Live2D 网页运行库，请使用完整发行包")
            scripts[name] = archive.read(candidates[0])
    install_runtime(scripts, output)


def import_folder_runtime(root, output):
    scripts = {}
    for name in RUNTIMES:
        file = folder_file(root, f"ControlPanel/web/vendor/{name}")
        with file.open("rb") as stream:
            scripts[name] = stream.read(RUNTIME_LIMIT + 1)
    install_runtime(scripts, output)


def install_runtime(scripts, output):
    for name, digest in RUNTIMES.items():
        data = scripts[name]
        if len(data) > RUNTIME_LIMIT or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("角色包的 Live2D 网页运行库版本不受支持")
    for name, data in scripts.items():
        save_runtime(output, name, data)


def save_runtime(output, name, data):
    output.mkdir(parents=True, exist_ok=True)
    installed = output / name
    if installed.is_file():
        with installed.open("rb") as stream:
            if stream.read(len(data) + 1) == data:
                return
    temporary = output / (name + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(installed)


def valid_runtime(folder, name):
    try:
        with (folder / name).open("rb") as stream:
            data = stream.read(RUNTIME_LIMIT + 1)
    except OSError:
        return False
    digest = hashlib.sha256(data).hexdigest()
    return digest == RUNTIMES[name] or (name == CUBISM_CORE and digest == CORE_DOWNLOAD_SHA256)


def require_runtime(folder, *, modern):
    if not modern and not valid_runtime(folder, LEGACY_CORE):
        raise ValueError("这个模型使用经典 Cubism 2。请先导入一次完整的 BandoriLove 发行包以载入运行库。")
    if valid_runtime(folder, CUBISM_CORE):
        return
    try:
        request = Request(CORE_URL, headers={"User-Agent": "BandoriLovePet", "Accept": "*/*"})
        with urlopen(request, timeout=8) as response:
            data = response.read(RUNTIME_LIMIT + 1)
    except OSError as error:
        raise ValueError("无法下载 Live2D 官方运行库。请联网重试，或先导入一个完整的 BandoriLove 发行包。") from error
    if hashlib.sha256(data).hexdigest() != CORE_DOWNLOAD_SHA256:
        raise ValueError("Live2D 官方运行库版本已变化。可以先导入一个完整的 BandoriLove 发行包。")
    save_runtime(folder, CUBISM_CORE, data)
