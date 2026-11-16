"""Connection to the optional BandoriLove desktop player."""

import json
import hashlib
import os
from pathlib import Path
from urllib.request import Request, urlopen
from zipfile import ZipFile

RUNTIMES = {
    "live2d.min.js": "e4ea1f18bdd44b65394ffd5a1bab16982e88757d45134d1bd0737c8a6b3ddd08",
    "live2dcubismcore.min.js": "913e10e881aa7abec8e65bbb8c2540db3fe9acf987c7537befa521f8a7f51009",
}


def import_runtime(archive_path, output):
    """Install the known runtime already present in a supported role ZIP."""
    scripts = {}
    with ZipFile(archive_path) as archive:
        for name, digest in RUNTIMES.items():
            suffix = "/ControlPanel/web/vendor/" + name
            candidates = [item for item in archive.infolist() if ("/" + item.filename).endswith(suffix)]
            if len(candidates) != 1 or candidates[0].file_size > 512_000:
                raise ValueError("角色 ZIP 缺少受支持的 Live2D 网页运行库，请使用完整发行包")
            data = archive.read(candidates[0])
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("角色 ZIP 的 Live2D 网页运行库版本不受支持")
            scripts[name] = data
    output.mkdir(parents=True, exist_ok=True)
    for name, data in scripts.items():
        temporary = output / (name + ".tmp")
        temporary.write_bytes(data)
        temporary.replace(output / name)


def request(operation, **payload):
    descriptor = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "BandoriLoveDesktopPet" / "connection.json"
    try:
        endpoint = json.loads(descriptor.read_bytes())
        port, token = endpoint["port"], endpoint["token"]
        if type(port) is not int or not 0 < port < 65536 or len(token) != 64:
            raise ValueError("Invalid desktop player endpoint")
        message = Request(
            f"http://127.0.0.1:{port}/{operation}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        )
        with urlopen(message, timeout=2) as response:
            return json.load(response)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ConnectionError("请先启动独立桌宠并导入当前角色的 ZIP") from error
