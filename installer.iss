#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef InstallId
  #define InstallId "BandoriLovePet.Standalone"
#endif
#ifndef ShortcutName
  #define ShortcutName "LovePet"
#endif

[Setup]
AppId={#InstallId}
AppName=LovePet
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher=BandoriLove
DefaultDirName={localappdata}\Programs\BandoriLovePet
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
CloseApplicationsFilter=*.exe,*.dll
RestartApplications=no
SetupIconFile=panel\ControlPanel.ico
UninstallDisplayIcon={app}\BandoriLovePet.exe
UninstallDisplayName=LovePet
OutputDir=dist
OutputBaseFilename=BandoriLovePet-Setup
Compression=lzma2/fast
DiskSpanning=no
#ifdef CodeSigning
SignTool=BandoriLove
SignedUninstaller=yes
#endif

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"

[Files]
Source: "build\player\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\resources\app\desktop\viewer-menu.html"
Type: files; Name: "{app}\resources\app\desktop\viewer-menu-preload.cjs"

[Icons]
Name: "{userprograms}\{#ShortcutName}"; Filename: "{app}\BandoriLovePet.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\{#ShortcutName}"; Filename: "{app}\BandoriLovePet.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\BandoriLovePet.exe"; Description: "{cm:LaunchProgram,LovePet}"; Flags: nowait postinstall skipifsilent
