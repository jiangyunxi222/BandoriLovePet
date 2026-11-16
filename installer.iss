#ifndef AppVersion
  #define AppVersion "0.1.3"
#endif
#ifndef InstallId
  #define InstallId "BandoriLovePet"
#endif
#ifndef ShortcutName
  #define ShortcutName "BandoriLovePet"
#endif

[Setup]
AppId={#InstallId}
AppName=BandoriLovePet
AppVersion={#AppVersion}
AppPublisher=BandoriLove
DefaultDirName={localappdata}\Programs\BandoriLoveDesktopPet
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
CloseApplicationsFilter=*.exe,*.dll
RestartApplications=no
SetupIconFile=panel\ControlPanel.ico
UninstallDisplayIcon={app}\BandoriLovePet.exe
UninstallDisplayName=BandoriLovePet
OutputDir=dist
OutputBaseFilename=BandoriLovePet-Setup
Compression=lzma2/fast
DiskSpanning=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"

[Files]
Source: "build\player\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Refresh the legacy executable only if an earlier installation used that name.
Source: "build\player\BandoriLovePet.exe"; DestDir: "{app}"; DestName: "BandoriLoveDesktopPet.exe"; Flags: ignoreversion; Check: FileExists(ExpandConstant('{app}\BandoriLoveDesktopPet.exe'))

[Icons]
Name: "{userprograms}\{#ShortcutName}"; Filename: "{app}\BandoriLovePet.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\{#ShortcutName}"; Filename: "{app}\BandoriLovePet.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\BandoriLovePet.exe"; Description: "{cm:LaunchProgram,BandoriLovePet}"; Flags: nowait postinstall skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  LegacyShortcut: String;
  Shell, Shortcut: Variant;
begin
  if CurStep <> ssPostInstall then Exit;
  LegacyShortcut := ExpandConstant('{userprograms}\BandoriLove Desktop Pet.lnk');
  if not FileExists(LegacyShortcut) then Exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    Shortcut := Shell.CreateShortcut(LegacyShortcut);
    if CompareText(Shortcut.TargetPath, ExpandConstant('{app}\BandoriLoveDesktopPet.exe')) = 0 then
      DeleteFile(LegacyShortcut);
  except
    Log('Could not remove the legacy Start menu shortcut');
  end;
end;
