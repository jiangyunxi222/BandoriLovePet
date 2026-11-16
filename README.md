# BandoriLove Desktop Pet

Windows 版独立 Live2D 桌宠，支持 BandoriLove 的 Garupa 与 OurNotes 单角色发行 ZIP。

1. 下载并运行 `setup.exe`。
2. 在开始菜单打开 BandoriLove Desktop Pet，选择原始角色 ZIP。
3. 点击「连接桌面」。关闭面板窗口后，桌宠保持显示。

按住角色用左键拖动。Ctrl 加滚轮缩放。右键或点击腿部菜单区打开面板。系统托盘提供置顶、缩放、导入另一角色和退出。

## 已有角色包的 Control Panel

安装桌宠后，关闭该角色的 Control Panel，下载 `Update-ControlPanel.ps1` 并运行。

```powershell
pwsh -File .\Update-ControlPanel.ps1 -RoleDirectory "D:\我的角色\若叶睦"
```

重新打开角色的 Control Panel，在「连接桌面」旁选择「独立桌宠」或「Live2DViewerEX」。连接独立桌宠前，在桌宠里导入同一角色。ViewerEX 路径继续使用原生播放器接口。

首版支持 ZIP 导入，包含位置、大小、置顶、角色触控、动作、表情和语音。Steam 创意工坊订阅、壁纸模式和 ViewerEX 专用指令仍由 ViewerEX 提供。

## 构建

使用 Windows x64、Python、PyInstaller、[Electron rcedit](https://github.com/electron/rcedit/releases) 和 Windows x64 Electron 的解包目录。

```powershell
python -m pip install pyinstaller
pwsh -File .\build.ps1 -ElectronDirectory "D:\electron-win32-x64" -ResourceEditor "D:\rcedit-x64.exe"
```

输出为 `dist/setup.exe`。发行包不附带角色素材或 Live2D 专有运行库。导入兼容角色 ZIP 时，会校验并使用该包随附的已知网页运行库。第三方组件信息见 [THIRD_PARTY_NOTICES.txt](panel/THIRD_PARTY_NOTICES.txt)。
