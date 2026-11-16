# BandoriLovePet

Windows 版独立 Live2D 桌宠，支持 BandoriLove 的 Garupa 与 OurNotes 单角色发行 ZIP。

1. 下载并运行 `BandoriLovePet-Setup.exe`。覆盖安装前，请从托盘退出正在运行的旧版。
2. 在开始菜单打开 BandoriLovePet，选择单角色 ZIP、Live2D 模型 JSON，或 ViewerEX 的 LPK、WPK。直接选择 JSON 时，软件会从原目录读取资源。
3. 点击「显示桌宠」。关闭面板窗口后，桌宠保持显示。

BandoriLove 角色请保留 `00_integrated.model3.json` 或 `00_integrated.model.json` 及其角色索引和素材，会加载完整的角色控制台。普通 Live2D JSON 仅提供模型预览、显示和退出桌宠。全新安装首次使用普通 JSON 前，请先导入一次完整的 BandoriLove 角色包，载入 Web 运行库。

LPK、WPK 会用包内第一个可渲染的 Live2D 模型提供同样的预览和桌宠功能。单独导入创意工坊 LPK 时，请把对应的 `config.json` 放在同目录。完整 WPK 自带配置。

按住角色用左键拖动，Shift 加滚轮缩放。右键或点击腿部菜单区打开面板。右键托盘 b* 图标后，可以直接拖动菜单里的「桌宠大小」滑杆。

托盘菜单可选「浮于最上层」或「浮于最下层」，应用会记住选择。最下层仍显示在桌面上，其他应用窗口可以盖住角色。

「退出桌宠」只关闭独立桌宠的角色窗口。可以再次点击「显示桌宠」打开。从托盘菜单选择「退出程序」可关闭整个应用。

右侧「Live2DViewerEX」用于控制 ViewerEX 里已加载的角色。先在 ViewerEX 加载同一角色包解压出的 `00_integrated` 模型，再点右侧按钮。此时控制区的指令发送给 ViewerEX，左侧仍可单独显示或退出独立桌宠。

## 已有角色包的 Control Panel

安装桌宠后，关闭该角色的 Control Panel，下载 `Update-ControlPanel.ps1` 并运行。

```powershell
pwsh -File .\Update-ControlPanel.ps1 -RoleDirectory "D:\我的角色\若叶睦"
```

重新打开角色的 Control Panel，顶部提供「显示桌宠」和「Live2DViewerEX」两个入口。连接独立桌宠前，在桌宠里导入同一角色。ViewerEX 路径继续使用原生播放器接口。

首版支持 ZIP 导入，包含位置、大小、置顶、角色触控、动作、表情和语音。Steam 创意工坊订阅、壁纸模式和 ViewerEX 专用指令仍由 ViewerEX 提供。

## 构建

使用 Windows x64、Python、PyInstaller、[Electron rcedit](https://github.com/electron/rcedit/releases) 和 Windows x64 Electron 的解包目录。

```powershell
python -m pip install pyinstaller
pwsh -File .\build.ps1 -ElectronDirectory "D:\electron-win32-x64" -ResourceEditor "D:\rcedit-x64.exe"
```

输出为 `dist/BandoriLovePet-Setup.exe`。发行包不附带角色素材或 Live2D 专有运行库。导入兼容角色 ZIP 时，会校验并使用该包随附的已知网页运行库。第三方组件信息见 [THIRD_PARTY_NOTICES.txt](panel/THIRD_PARTY_NOTICES.txt)。
