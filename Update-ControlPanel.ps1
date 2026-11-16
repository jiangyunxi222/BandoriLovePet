param([Parameter(Mandatory = $true)][string]$RoleDirectory)

$ErrorActionPreference = "Stop"
$role = (Resolve-Path -LiteralPath $RoleDirectory).Path
$target = Join-Path $role "ControlPanel"
$install = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BandoriLovePet_is1' -Name InstallLocation -ErrorAction SilentlyContinue
if (-not $install) { $install = Join-Path $env:LOCALAPPDATA "Programs/BandoriLoveDesktopPet" }
$source = Join-Path $install "resources/panel"
if (-not (Test-Path -LiteralPath (Join-Path $role "manifest.json") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $target "web") -PathType Container)) {
    throw "请选择已解压的角色根目录。"
}
foreach ($file in @("ControlPanel.exe", "web/app.js", "web/index.html", "web/style.css")) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $file) -PathType Leaf)) {
        throw "请先运行 BandoriLovePet-Setup.exe 安装桌宠。"
    }
}
$backup = Join-Path $target (".desktop-pet-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path (Join-Path $backup "web") -Force | Out-Null
foreach ($file in @("ControlPanel.exe", "web/app.js", "web/index.html", "web/style.css")) {
    Copy-Item -LiteralPath (Join-Path $target $file) -Destination (Join-Path $backup $file)
}
try {
    foreach ($file in @("ControlPanel.exe", "web/app.js", "web/index.html", "web/style.css")) {
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $target $file) -Force
    }
} catch {
    foreach ($file in @("ControlPanel.exe", "web/app.js", "web/index.html", "web/style.css")) {
        Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $target $file) -Force -ErrorAction SilentlyContinue
    }
    throw
}
Write-Host "Control Panel 已更新。重新打开后可选择桌面播放器。"
