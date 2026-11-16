"""Install the bundled desktop player for the current Windows user."""

import argparse
import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile


def install(target):
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = Path(sys._MEIPASS) / "player.zip"
    with tempfile.TemporaryDirectory(prefix="BandoriLoveSetup-", dir=target.parent) as temporary:
        staging = Path(temporary) / "player"
        with zipfile.ZipFile(payload) as archive:
            archive.extractall(staging)
        assert (staging / "BandoriLoveDesktopPet.exe").is_file()
        backup = Path(temporary) / "previous"
        if target.exists():
            target.rename(backup)
        try:
            staging.rename(target)
        except OSError:
            if backup.exists():
                backup.rename(target)
            raise


def shortcuts(executable):
    env = {**os.environ, "BANDORILOVE_INSTALLED_PLAYER": str(executable)}
    subprocess.run([
        "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
        "$shell = New-Object -ComObject WScript.Shell",
        "; $menu = $shell.SpecialFolders.Item('Programs')",
        "; $shortcut = $shell.CreateShortcut((Join-Path $menu 'BandoriLove Desktop Pet.lnk'))",
        "; $shortcut.TargetPath = $env:BANDORILOVE_INSTALLED_PLAYER",
        "; $shortcut.WorkingDirectory = Split-Path $shortcut.TargetPath",
        "; $shortcut.Save()",
    ], env=env, creationflags=subprocess.CREATE_NO_WINDOW, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path)
    parser.add_argument("--silent", action="store_true")
    parser.add_argument("--no-launch", action="store_true")
    args = parser.parse_args()
    default = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "BandoriLoveDesktopPet"
    target = (args.target or default).resolve()
    try:
        install(target)
        executable = target / "BandoriLoveDesktopPet.exe"
        if args.target is None:
            shortcuts(executable)
        if not args.no_launch:
            subprocess.Popen([str(executable)], cwd=target)
    except (OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        if not args.silent:
            ctypes.windll.user32.MessageBoxW(None, str(error), "BandoriLove 安装失败", 0x10)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
