# LovePet Windows

![LovePet · Windows 与 Android 的 Live2D 桌宠](docs/media/cover.png)

BanG Dream! Live2D 桌宠和动态壁纸。导入 Garupa 或 OurNotes 的单角色 ZIP，即可预览、换装、播放动作和语音，还可以为不同衣装配置演出组。

**[Windows 安装包](https://github.com/jiangyunxi222/LovePet-Windows/releases/latest)** · [Android APK](https://github.com/jiangyunxi222/LovePet-Android/releases/latest)

## 角色库

- **Garupa** 收录 Poppin’Party、Roselia、Pastel＊Palettes 等《少女乐团派对！》角色。[角色 ZIP](https://github.com/jiangyunxi222/GarupaLive2D-Windows/releases/latest)
- **OurNotes** 收录夢限大みゅーたいぷ、millsage、一家Dumb Rock! 等《BanG Dream! Our Notes》角色。[角色 ZIP](https://github.com/jiangyunxi222/OurNotesLive2D-Windows/releases)

MyGO!!!!! 与 Ave Mujica 在两库均有收录，模型和衣装随游戏版本而异。

## 角色实录

![Windows 实录。长崎爽世播放动作并切换衣装](docs/media/windows-demo.gif)

*MyGO!!!!! · 长崎爽世（Garupa）· Windows 动作与换装实录*

## 安装与使用

### Windows

1. 运行发布页的 `LovePet-1.0.0-Windows-x64.exe`。安装向导可选目录和桌面快捷方式。
2. 点「更换模型」，导入发布页的单角色 ZIP，也可以选择已导入的模型。首页的「演出」「桌宠」「壁纸」按钮有颜色时表示已开启。
3. 左键拖动桌宠，**Shift + 滑轮**缩放。完整角色包点腿部开菜单。右击托盘 **b\*** 可调大小、层级，或退出桌宠和壁纸。

LovePet 1.0.0 沿用 Windows 独立版的安装目录和用户数据。此前 Windows 1.0.1 的安装和模型记录留在旧版目录，需要在 LovePet 中重新选择要使用的模型。

关闭主窗口后，托盘继续运行已开启的桌宠和壁纸。「退出壁纸」会露出原系统壁纸。「退出程序」关闭托盘和桌面显示。可在 Windows「设置 → 应用 → 已安装的应用」卸载。

### Android

1. 在 Android 11 及以上安装安卓版发布页的 APK，打开应用并选择角色包。符合 LovePet 角色包协议的 ZIP、LPK 和 WPK 均可加载应用工作台。[LovePet Android 发布页](https://github.com/jiangyunxi222/LovePet-Android/releases/latest)
2. 点「显示桌宠」并授予浮窗权限。单指拖动，双指缩放。
3. 完整角色包点腿部开菜单。第三方 LPK、WPK 保留可识别的包内触控，可在设置中开启右下角三点菜单。可从应用或桌宠通知退出。

## 导入格式

| 文件 | Windows | Android |
| --- | --- | --- |
| Garupa / OurNotes 发布页的单角色 ZIP | 直接导入，含角色控制 | 直接导入，含角色控制 |
| 解压后的 `00_integrated.model.json` / `00_integrated.model3.json` | 选择父模型 JSON，保留完整角色目录 | 请选择原发布 ZIP |
| 普通 Live2D 模型 JSON | 选择 `*.model.json` / `*.model3.json`，保留相对路径 | 请选兼容的 LPK / WPK |
| LPK / WPK | 预览、桌宠与壁纸，支持包内动作等触控 | 预览、桌宠与壁纸，支持包内动作等触控 |

角色 ZIP 请从发布页的 **Assets** 下载。第三方 ZIP 在 Windows 上需先解压，再选择模型 JSON。Android 角色包协议见 [Android 导入说明](https://github.com/jiangyunxi222/LovePet-Android#lovepet-android)。

创意工坊 LPK 如需 `config.json`，请把对应配置放在同目录。普通 Cubism 3 及以上模型首次导入需联网获取官方运行库。经典 Cubism 2 需先导入一次完整角色发行包。

## 壁纸和演出

- 在「设置 → 壁纸设置」添加图片、循环视频和特效。可调整图层顺序、透明度、大小和位置，也可以保存场景并重新使用。
- 在 Windows 的纯享、桌宠和壁纸编辑器中，按住 Alt 滚动可旋转，按住 Alt 双击可复位。触屏支持三指旋转和三指双击复位。壁纸图层也可用旋转滑杆调整。
- 点击「纯享」全屏预览。Windows 将鼠标移到窗口顶部可唤出控件，按 `Esc` 退出。点击「壁纸」把当前场景应用到主屏幕。
- 按住壁纸的空白区域约 0.3 秒再移动，角色视线随拖动变化，松开后回正。点角色仍可互动，桌面图标优先处理点击。
- 在「设置 → 主题配色」选用 12 套主题，实时更新按钮、卡片和面板。
- 在「设置 → 演出设置」为同一件衣装保存多组动作、表情及语音组合。开启「演出」后，点角色上身会依次播放当前衣装的组合。
- Windows 可分别设置动作、表情、语音与换装的循环间隔。换装和其他循环同时到期时，其他项目使用换装后的素材。开启演出模式后，动作循环按顺序播放当前衣装的演出组。
- 「设置 → 触控菜单」在角色发行包中默认开启，可点击腿部。第三方模型默认关闭，开启后使用右下角三点。

<details>
<summary>开发与构建</summary>

Windows 构建需要 Windows x64、Python、PyInstaller、[Inno Setup](https://jrsoftware.org/inno-setup/downloads)、[Electron rcedit](https://github.com/electron/rcedit/releases) 和解包后的 Windows x64 Electron。若 Inno Setup 缺简体中文语言文件，从 [Inno Setup 翻译页](https://jrsoftware.org/inno-setup/translations) 取 `ChineseSimplified.isl`，放入其 `Languages` 目录。

```powershell
python -m pip install pyinstaller
pwsh -File .\build.ps1 -ElectronDirectory "D:\electron-win32-x64" -ResourceEditor "D:\rcedit-x64.exe" -InnoSetupCompiler "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
```

Windows 输出为 `dist/BandoriLovePet-Setup.exe`。Android 源码与构建说明位于 [LovePet-Android 仓库](https://github.com/jiangyunxi222/LovePet-Android)。第三方组件见 [THIRD_PARTY_NOTICES.txt](panel/THIRD_PARTY_NOTICES.txt)。

使用已安装在当前用户证书库中的可信代码签名证书时，为构建命令追加 `-SignTool <signtool.exe 路径> -CodeSigningThumbprint <证书指纹>`。脚本会签名应用、辅助程序、安装器和卸载器，并检查公信验证结果。

Windows 与 Android 使用相同的发布版本。每次更新末位加一，满十向前进位，例如 `1.0.9` 后为 `1.1.0`。

</details>

角色素材随角色包提供，演示中的角色与游戏素材权利归原权利人。这是同好制作的工具项目。
