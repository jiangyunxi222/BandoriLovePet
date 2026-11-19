param(
    [Parameter(Mandatory = $true)][string]$ElectronDirectory,
    [Parameter(Mandatory = $true)][string]$ResourceEditor,
    [Parameter(Mandatory = $true)][string]$InnoSetupCompiler,
    [string]$PanelSource = "",
    [string]$PyInstallerModules = ""
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $PanelSource) { $PanelSource = Join-Path $root "panel" }
$build = Join-Path $root "build"
$dist = Join-Path $root "dist"
$stage = Join-Path $build "player"
$electron = (Resolve-Path -LiteralPath $ElectronDirectory).Path
$resourceEditor = (Resolve-Path -LiteralPath $ResourceEditor).Path
$installerCompiler = (Resolve-Path -LiteralPath $InnoSetupCompiler).Path
$panel = (Resolve-Path -LiteralPath $PanelSource).Path
$icon = Join-Path $panel "ControlPanel.ico"
$version = (Get-Content -Raw -LiteralPath (Join-Path $root "package.json") | ConvertFrom-Json).version
if ($PyInstallerModules) { $env:PYTHONPATH = (Resolve-Path -LiteralPath $PyInstallerModules).Path }
$env:PYINSTALLER_CONFIG_DIR = Join-Path $build "pyinstaller-cache"
New-Item -ItemType Directory -Path $build,$dist,$stage -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $stage "resources/app")) { throw "Use a fresh build/player directory." }
Get-ChildItem -LiteralPath $electron | Where-Object { $_.Name -notin @("resources","PetProfile") } |
    Copy-Item -Destination $stage -Recurse
$binary = Get-ChildItem -LiteralPath $stage -File -Filter "*.exe" | Select-Object -First 1
Rename-Item -LiteralPath $binary.FullName -NewName "BandoriLovePet.exe"
& $resourceEditor (Join-Path $stage "BandoriLovePet.exe") --set-icon $icon --set-file-version $version --set-product-version $version --set-version-string FileDescription "BandoriLovePet" --set-version-string ProductName "BandoriLovePet" --set-version-string OriginalFilename "BandoriLovePet.exe"
if ($LASTEXITCODE) { throw "Windows application icon update failed" }
$resources = Join-Path $stage "resources"
$desktop = Join-Path $resources "app"
$backend = Join-Path $resources "panel"
New-Item -ItemType Directory -Path $desktop,$backend -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $desktop
$desktopScripts = Join-Path $desktop 'desktop'
New-Item -ItemType Directory -Path $desktopScripts -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'desktop') -File |
    Where-Object Extension -in '.cjs', '.html' | Copy-Item -Destination $desktopScripts
$compiler = Join-Path $env:WINDIR "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$(Join-Path $backend 'PetWindow.exe')" (Join-Path $root "desktop/PetWindow.cs")
if ($LASTEXITCODE) { throw "Native window helper build failed" }
$gac = Join-Path $env:WINDIR 'Microsoft.NET/assembly/GAC_MSIL'
$automation = foreach ($module in @('WindowsBase', 'UIAutomationTypes', 'UIAutomationClient')) {
    $assembly = Get-ChildItem -LiteralPath (Join-Path $gac $module) -Recurse -Filter "$module.dll" | Select-Object -First 1
    if (!$assembly) { throw "Windows desktop assembly $module was not found." }
    "/reference:$($assembly.FullName)"
}
& $compiler /nologo /target:exe /platform:x64 /optimize+ @automation "/win32manifest:$(Join-Path $root 'desktop/WallpaperHost.manifest')" "/out:$(Join-Path $backend 'WallpaperHost.exe')" (Join-Path $root 'desktop/WallpaperHost.cs')
if ($LASTEXITCODE) { throw "Native wallpaper host build failed" }
Copy-Item -Path (Join-Path $panel "web"),(Join-Path $panel "ControlPanel.ico"),(Join-Path $panel "THIRD_PARTY_NOTICES.txt") -Destination $backend -Recurse
foreach ($runtime in @("live2d.min.js","live2dcubismcore.min.js")) {
    $bundledRuntime = Join-Path $backend "web/vendor/$runtime"
    if (Test-Path -LiteralPath $bundledRuntime) { Remove-Item -LiteralPath $bundledRuntime }
}
python -m PyInstaller --noconfirm --onefile --windowed --icon $icon --name ControlPanel --distpath $backend --workpath (Join-Path $build "backend-work") --specpath $build (Join-Path $panel "server.py")
if ($LASTEXITCODE) { throw "Control Panel build failed" }
& $installerCompiler "/DAppVersion=$version" (Join-Path $root "installer.iss")
if ($LASTEXITCODE) { throw "Installer build failed" }
Get-FileHash -LiteralPath (Join-Path $dist "BandoriLovePet-Setup.exe")
