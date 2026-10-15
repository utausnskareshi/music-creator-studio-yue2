# Install / launch / uninstall smoke test for the NSIS installer (per-user, silent). It never touches a real
# installation of the app.
# Usage: pwsh -File tools/install_test.ps1 -Installer <path to *-setup.exe> [-InstallDir <new folder>] [-KeepInstalled]
#
# The installer runs as "setup.exe /S /NS /D=<InstallDir>": into a folder that must not exist yet (default: the app
# folder of this run's work folder, %TEMP%\mcs_install_test_<yyyyMMdd_HHmmss>_<pid>\app) and without shortcuts (/NS;
# a silent install otherwise creates the Desktop and Start Menu shortcuts, and the uninstaller deletes the ones that
# point at its own exe). NSIS takes /D= only as the last argument and unquoted, even with spaces. The installed exe
# runs for 8 seconds (window capture: %TEMP%\mcs_installed_shot.png), then "uninstall.exe /S" removes it. The exit
# code is 1 when a check failed.
#
# Kept away from the real installation and its data:
# - Shortcuts: the "*Music Creator Studio*" files on the Desktop, in the Start Menu and among the pinned items are
#   compared before and after the run (FAIL when one was added, changed or removed).
# - Registry records the installer keeps per product, whatever the folder: the uninstall entry
#   (HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Music Creator Studio YuE2, which the uninstaller
#   deletes) and the remembered install folder (HKCU\Software\utausnskareshi\Music Creator Studio YuE2), plus the
#   app's own HKCU\Software\MusicCreatorStudioYuE2. All three are exported before the run and put back afterwards.
#   -KeepInstalled leaves the first two to the kept copy, so it is refused while an installation is registered. Its
#   silent uninstall keeps the remembered install folder (the next install would default to the deleted test
#   folder): the removal command the script prints also puts that record back as it was, from an export it keeps
#   in the work folder.
# - Data root and song folder: the uninstall hooks read them from HKCU\Software\MusicCreatorStudioYuE2, which points
#   at fixture folders in the work folder during the uninstall, so a hook regression can only reach the fixtures.
# - %APPDATA%\MusicCreatorStudioYuE2 (settings, library, secrets.json with the API keys), which the app under test
#   uses too: mirrored into the work folder before the launch and back afterwards (robocopy /MIR, so the backup never
#   lands inside a folder that still exists), then compared file by file. The work folder, with that copy of
#   secrets.json, is deleted once everything is back, and kept (its path printed) otherwise. The script refuses a
#   folder holding a junction or symbolic link (a mirror would empty its target).
# - WebView profile: the app under test gets its own in the work folder (WEBVIEW2_USER_DATA_FOLDER overrides the
#   folder an app passes to WebView2), not %LOCALAPPDATA%\com.utausnskareshi.musiccreatorstudioyue2.
# - Processes: only those whose exe lies inside the test install are closed or stopped. The script refuses to start
#   while the app runs (a second instance hands over to the running one and exits).
# Not avoidable: the uninstaller clears the taskbar jump list of the app's AppUserModelID, which every installation
# shares.
#
# Checks: the installer registers the test copy and the app starts; the silent uninstall (the same path as an
# upgrade's uninstall: hooks.nsh and Tauri's template remove app data only with the "delete app data" checkbox, which
# is off in /S and /P mode) removes the install folder and the uninstall entry and keeps the fixture data root and
# song folder, %APPDATA%\MusicCreatorStudioYuE2 and HKCU\Software\MusicCreatorStudioYuE2; afterwards the shortcuts
# are unchanged and the registry records and the app data are back.
# Run inside an MSIX-packaged app (a Store app), HKCU and %APPDATA% are virtualized into that package: the script sees and
# restores that view (the user's own uninstall entry is not visible there); %LOCALAPPDATA% and %TEMP% are not.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$InstallDir,
  [switch]$KeepInstalled
)
$ErrorActionPreference = "Stop"
$product = "Music Creator Studio YuE2"
# The app's process names: the installed (and release) exe, and cargo's name for the dev build.
$appProcessNames = @($product, "music-creator-studio-yue2")
$appData = Join-Path $env:APPDATA "MusicCreatorStudioYuE2"
$localData = Join-Path $env:LOCALAPPDATA "com.utausnskareshi.musiccreatorstudioyue2"
$uninstKey = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$manuKey = "HKCU\Software\utausnskareshi"
$appKey = "HKCU\Software\MusicCreatorStudioYuE2"
# Put back after the run. Kept: left as the installer wrote them with -KeepInstalled (the kept copy's own records).
$regRecords = @(
  [pscustomobject]@{ Key = $uninstKey; File = "uninstall_entry.reg"; Kept = $true; Existed = $false },
  [pscustomobject]@{ Key = "$manuKey\$product"; File = "install_location.reg"; Kept = $true; Existed = $false },
  [pscustomobject]@{ Key = $appKey; File = "app_record.reg"; Kept = $false; Existed = $false }
)
# One entry of every kind hooks.nsh removes on request (McsDeleteDataRoot, McsDeleteOutput), so a silent uninstall
# that removes anything shows up. comfy_input\mcs_uploads and comfy_output\mcs lose only names the app gives its
# files there (McsDeleteOwnFiles), so their entries have such names.
$fixtureFiles = @(
  "data_root\runtime\ComfyUI_windows_portable\marker.txt",
  "data_root\cache\sep_work\marker.txt",
  "data_root\cache\ComfyUI_windows_portable_nvidia.7z",
  "data_root\comfy_input\mcs_uploads\0123456789abcdef_take.wav",
  "data_root\comfy_output\mcs\0123abcd_00001_.flac",
  "data_root\extra_model_paths.yaml",
  "data_root\models\checkpoints\yue2_3b_bf16.safetensors",
  "data_root\models\separation\model_bs_roformer_ep_317_sdr_12.9755.ckpt",
  "songs\2026-10-01\120000_0123abcd\song.json",
  "songs\separated\20261001_120000_track\vocals.wav",
  "songs\mcs-diagnostics-20261001-120000.zip"
)

function Get-RegPath([string]$Key) { "Registry::$Key" }

# Exports a registry record that exists now (Existed), for Restore-RegRecord.
function Backup-RegRecord($R) {
  $R.Existed = Test-Path (Get-RegPath $R.Key)
  if ($R.Existed) {
    & reg.exe export $R.Key (Join-Path $backupDir $R.File) /y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "reg export $($R.Key) failed (exit code $LASTEXITCODE)" }
  }
}

# Puts a record back as it was: deletes what the run left, imports the export and checks that a new export is
# identical. True when the record is back.
function Restore-RegRecord($R) {
  if (Test-Path (Get-RegPath $R.Key)) { & reg.exe delete $R.Key /f | Out-Null }
  if (-not $R.Existed) { return -not (Test-Path (Get-RegPath $R.Key)) }
  $file = Join-Path $backupDir $R.File
  & reg.exe import $file 2>$null | Out-Null
  & reg.exe export $R.Key "$file.check" /y | Out-Null
  $same = ($LASTEXITCODE -eq 0) -and ((Get-FileHash -LiteralPath "$file.check").Hash -eq (Get-FileHash -LiteralPath $file).Hash)
  Remove-Item -LiteralPath "$file.check" -ErrorAction SilentlyContinue
  $same
}

# Junctions and symbolic links below $Dir. robocopy /MIR empties the target of a junction it purges, even with /XJ,
# so the app data folder is backed up and mirrored back only while it has none.
function Get-Links([string]$Dir) {
  if (Test-Path -LiteralPath $Dir) {
    Get-ChildItem -LiteralPath $Dir -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object FullName
  }
}

# Makes $To an exact copy of $From (a folder without links, see Get-Links): robocopy /MIR also removes what $From
# lacks, /IS /IT copy every file, /XJ skips links.
function Copy-Mirror([string]$From, [string]$To) {
  $out = & robocopy.exe $From $To /MIR /IS /IT /XJ /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy $From -> $To failed (exit code $LASTEXITCODE): " + (($out | Where-Object { $_ -match '\S' } | Select-Object -Last 3) -join " ")
  }
}

# "relative path|SHA-256" of every file below $Dir, sorted and joined; $null when the folder does not exist.
function Get-TreeState([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $null }
  $root = (Get-Item -LiteralPath $Dir -Force).FullName.TrimEnd('\') + '\'
  (Get-ChildItem -LiteralPath $Dir -Recurse -Force -File | ForEach-Object {
    $_.FullName.Substring($root.Length) + '|' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  } | Sort-Object) -join "`n"
}

# The shortcut files an install or uninstall of the app could create, retarget or delete, as "path|SHA-256".
function Get-ShortcutState {
  $places = [ordered]@{
    ([Environment]::GetFolderPath("Desktop")) = 0
    ([Environment]::GetFolderPath("Programs")) = 3
    (Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned") = 3
  }
  foreach ($dir in $places.Keys) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Filter "*Music Creator Studio*" -Depth $places[$dir] -Force -File -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName + '|' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  }
}

# Processes running an exe from the test install: the app under test. Nothing else is ever stopped.
function Get-TestProcesses {
  $prefix = $InstallDir + '\'
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
}

# Closes the app under test (its own shutdown ends a ComfyUI / llama-server it started), stops what still runs from
# the test install and waits until nothing does (the uninstaller cannot remove a running exe). The launched process
# is also taken by its handle, in case its path is spelled differently (8.3 names).
function Stop-TestApp {
  $list = @(Get-TestProcesses)
  if ($script:proc -and -not $script:proc.HasExited -and $script:proc.Id -notin $list.Id) { $list += $script:proc }
  foreach ($p in $list) {
    try { $closed = $p.CloseMainWindow() -and $p.WaitForExit(15000) } catch { $closed = $false }
    if (-not $closed) { try { $p.Kill(); [void]$p.WaitForExit(5000) } catch { } }
  }
  for ($i = 0; $i -lt 30 -and @(Get-TestProcesses).Count; $i++) { Start-Sleep -Milliseconds 500 }
  foreach ($p in @(Get-TestProcesses)) { Write-Warning "still running from the test install: $($p.Id) $($p.Path)" }
}

# Removes a folder of this run, retrying while a process that just ended (WebView) still holds a file.
function Remove-Tree([string]$Path) {
  for ($i = 0; $i -lt 5 -and (Test-Path -LiteralPath $Path); $i++) {
    try { Remove-Item -LiteralPath $Path -Recurse -Force } catch { Start-Sleep -Seconds 1 }
  }
  if (Test-Path -LiteralPath $Path) { Write-Warning "could not remove $Path" }
}

# True when every fixture file below $Prefix ("data_root\" or "songs\") is still there.
function Test-Fixtures([string]$Prefix) {
  $missing = @($fixtureFiles | Where-Object { $_.StartsWith($Prefix) -and -not (Test-Path -LiteralPath (Join-Path $fixtureDir $_)) })
  foreach ($m in $missing) { Write-Warning "removed: $m" }
  $missing.Count -eq 0
}

# Silent uninstall of the test copy. The hooks read the data root and the song folder from the app's registry
# record, which points at the fixtures here (it is put back with the other records afterwards).
function Invoke-TestUninstall {
  $rp = Get-RegPath $appKey
  if (-not (Test-Path $rp)) { New-Item -Path $rp | Out-Null }
  New-ItemProperty -Path $rp -Name DataRoot -Value $fixtureRoot -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $rp -Name OutputDir -Value $fixtureSongs -PropertyType String -Force | Out-Null
  $script:uninstalled = $true
  $u = Start-Process -FilePath $uninst -ArgumentList "/S" -Wait -PassThru
  # uninstall.exe hands over to a copy of itself in %TEMP%: give it time to finish
  for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath $InstallDir); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2
  Write-Output "uninstaller exit code: $($u.ExitCode)"
}

# ---- Refuse before anything is changed.
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "installer not found: $Installer" }
$Installer = (Get-Item -LiteralPath $Installer).FullName
$running = @(Get-Process -Name $appProcessNames -ErrorAction SilentlyContinue)
if ($running.Count) {
  $list = ($running | ForEach-Object { "$($_.Id) $($_.Path)" }) -join ", "
  throw "close $product first (running: $list): the test launch would hand over to it, and its settings folder is backed up and restored here"
}
$stamp = [DateTime]::Now.ToString("yyyyMMdd_HHmmss", [Globalization.CultureInfo]::InvariantCulture)
$work = Join-Path $env:TEMP "mcs_install_test_${stamp}_$PID"
if (-not $InstallDir) { $InstallDir = Join-Path $work "app" }
# absolute, backslashes only and no trailing "\": NSIS takes /D= as it is
$InstallDir = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)).TrimEnd('\')
if (Test-Path -LiteralPath $InstallDir) { throw "the install folder must be new: $InstallDir exists" }
if (Test-Path -LiteralPath $work) { throw "work folder $work exists" }
if ($KeepInstalled -and (Test-Path (Get-RegPath $uninstKey))) {
  $location = (Get-ItemProperty (Get-RegPath $uninstKey)).InstallLocation
  throw "-KeepInstalled: an installation is registered ($location) and the kept copy would take over its uninstall entry; run without -KeepInstalled"
}
$links = @(Get-Links $appData)
if ($links.Count) { throw "$appData contains a junction or symbolic link ($($links -join ', ')): it cannot be backed up and restored safely" }

# ---- Snapshots and backups (written only into the work folder).
$backupDir = Join-Path $work "backup"
$fixtureDir = Join-Path $work "fixture"
$fixtureRoot = Join-Path $fixtureDir "data_root"
$fixtureSongs = Join-Path $fixtureDir "songs"
$webviewDir = Join-Path $work "webview"
$appDataCopy = Join-Path $backupDir "appdata"
$uninst = Join-Path $InstallDir "uninstall.exe"
New-Item -ItemType Directory -Path $backupDir | Out-Null
try {
  $shortcutsBefore = @(Get-ShortcutState | Sort-Object)
  foreach ($r in $regRecords) { Backup-RegRecord $r }
  $hadManuKey = Test-Path (Get-RegPath $manuKey)
  $hadLocal = Test-Path -LiteralPath $localData
  $hadAppData = Test-Path -LiteralPath $appData
  $appDataBefore = Get-TreeState $appData
  if ($hadAppData) {
    Copy-Mirror $appData $appDataCopy
    if ((Get-TreeState $appDataCopy) -ne $appDataBefore) { throw "the copy of $appData does not match it" }
  }
  foreach ($rel in $fixtureFiles) {
    $f = Join-Path $fixtureDir $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $f) | Out-Null
    Set-Content -LiteralPath $f -Value "install_test.ps1 fixture"
  }
} catch {
  Remove-Tree $work
  throw
}
Write-Output "work folder: $work (registry exports, fixtures, WebView profile)"
if ($hadAppData) { Write-Output "backed up $appData to $appDataCopy" }

$failures = [System.Collections.Generic.List[string]]::new()
function Write-Check([string]$Name, [bool]$Ok) {
  if ($Ok) { Write-Output "OK   $Name" } else { Write-Warning "FAIL $Name"; $failures.Add($Name) }
}
$proc = $null
$uninstalled = $false
try {
  Write-Output "installing silently to $InstallDir ..."
  # /D= last and unquoted (NSIS); /NS: no Desktop / Start Menu shortcuts
  $p = Start-Process -FilePath $Installer -ArgumentList "/S /NS /D=$InstallDir" -Wait -PassThru
  Write-Output "installer exit code: $($p.ExitCode)"
  if ($p.ExitCode -ne 0) { throw "the installer failed (exit code $($p.ExitCode))" }
  $exe = Get-ChildItem -LiteralPath $InstallDir -Filter *.exe | Where-Object { $_.Name -notlike "uninstall*" } | Select-Object -First 1 -ExpandProperty FullName
  if (-not $exe) { throw "no app exe in $InstallDir" }
  if (-not (Test-Path -LiteralPath $uninst)) { throw "no uninstall.exe in $InstallDir" }
  Write-Output "installed exe: $exe"
  $nodes = Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter "nodes.py" -ErrorAction SilentlyContinue | Select-Object -First 1
  Write-Output ("node pack present: " + ($nodes ? $nodes.FullName : "not found"))
  $entry = Get-ItemProperty (Get-RegPath $uninstKey) -ErrorAction SilentlyContinue
  if ($entry) { Write-Output "uninstall entry: $($entry.DisplayName) $($entry.DisplayVersion) in $($entry.InstallLocation)" }
  Write-Check "uninstall entry for the test copy" ($entry -and "$($entry.InstallLocation)".Trim('"') -eq $InstallDir)

  # Launch the installed app for a few seconds and capture its window. It gets its own WebView profile, and never the
  # developer self-test (MCS_AUTOTEST=1 starts a generation).
  $savedEnv = @{ WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER; MCS_AUTOTEST = $env:MCS_AUTOTEST }
  try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $webviewDir
    $env:MCS_AUTOTEST = $null
    $proc = Start-Process -FilePath $exe -PassThru
  } finally {
    foreach ($n in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $savedEnv[$n]) }
  }
  Start-Sleep -Seconds 8
  $win = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
  Write-Check ("app running after 8 s" + ($win ? " (window: $($win.MainWindowTitle))" : "")) ([bool]$win)
  Write-Check "WebView profile in the work folder" ([bool](Get-ChildItem -LiteralPath $webviewDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1))
  $shot = Join-Path $env:TEMP "mcs_installed_shot.png"
  # a PNG left by an earlier run must not pass as this run's capture
  Remove-Item $shot -ErrorAction SilentlyContinue
  if ($win -and -not $win.HasExited) {
    try {
      & (Join-Path $PSScriptRoot "screenshot.ps1") -Out $shot -ProcessId $proc.Id | Out-Null
      Write-Output "screenshot: $shot"
    } catch {
      Write-Warning "screenshot failed: $($_.Exception.Message)"
    }
  } else {
    Write-Warning "screenshot skipped: app not running (exited within 8 s)"
  }
  # Stop the app first: the uninstaller cannot remove a running exe (the finally block would only catch a failure).
  Stop-TestApp

  if (-not $KeepInstalled) {
    # The app data check needs the folder even when the app did not create it (it is restored or removed below).
    New-Item -ItemType Directory -Force -Path $appData | Out-Null
    Set-Content -LiteralPath (Join-Path $appData "install_test_marker.txt") -Value "install_test.ps1 $stamp"
    $appDataPre = Get-TreeState $appData
    Write-Output "uninstalling silently..."
    Invoke-TestUninstall
    # A silent (= upgrade-style) uninstall removes the app and its uninstall entry and keeps everything else.
    Write-Check "install folder removed" (-not (Test-Path -LiteralPath $InstallDir))
    Write-Check "uninstall entry removed" (-not (Test-Path (Get-RegPath $uninstKey)))
    Write-Check "fixture data root kept" (Test-Fixtures "data_root\")
    Write-Check "fixture song folder kept" (Test-Fixtures "songs\")
    Write-Check "$appData kept, unchanged" ((Get-TreeState $appData) -eq $appDataPre)
    Write-Check "$appKey kept" ((Get-ItemProperty (Get-RegPath $appKey) -ErrorAction SilentlyContinue).DataRoot -eq $fixtureRoot)
  }
} finally {
  # Always: stop the app under test, uninstall when a step failed before the uninstall, put the registry records and
  # the app data back, and compare the shortcuts.
  try {
    Stop-TestApp
    if (-not $KeepInstalled -and -not $uninstalled -and (Test-Path -LiteralPath $uninst)) {
      Write-Output "a step failed: uninstalling silently..."
      Invoke-TestUninstall
    }
  } catch {
    Write-Warning "stopping or uninstalling the test copy failed: $($_.Exception.Message)"
  }

  $restored = $true
  foreach ($r in $regRecords) {
    if ($KeepInstalled -and $r.Kept) { continue }
    try { $ok = Restore-RegRecord $r } catch { $ok = $false; Write-Warning $_.Exception.Message }
    if (-not $ok) { $restored = $false; Write-Warning "$($r.Key) is not back as it was (export: $(Join-Path $backupDir $r.File))" }
  }
  if (-not $KeepInstalled -and -not $hadManuKey) {
    # the parent key the installer created, once it is empty again
    $mk = Get-Item (Get-RegPath $manuKey) -ErrorAction SilentlyContinue
    if ($mk -and $mk.SubKeyCount -eq 0 -and $mk.ValueCount -eq 0) { Remove-Item (Get-RegPath $manuKey) -ErrorAction SilentlyContinue }
  }
  Write-Check "registry records restored" $restored

  $appDataOk = $true
  if ($hadAppData) {
    try {
      $links = @(Get-Links $appData)
      if ($links.Count) { throw "it now contains a junction or symbolic link ($($links -join ', '))" }
      Copy-Mirror $appDataCopy $appData
      $appDataOk = (Get-TreeState $appData) -eq $appDataBefore
    } catch {
      $appDataOk = $false
      Write-Warning "restoring $appData failed: $($_.Exception.Message)"
    }
    if (-not $appDataOk) { Write-Warning "the copy of $appData (with secrets.json) is kept at $appDataCopy" }
  } elseif (-not $KeepInstalled -and (Test-Path -LiteralPath $appData)) {
    # created by the app under test (now uninstalled); with -KeepInstalled it stays with the kept copy
    Remove-Tree $appData
    $appDataOk = -not (Test-Path -LiteralPath $appData)
  }
  Write-Check "$appData restored" $appDataOk
  $restored = $restored -and $appDataOk
  # the WebView folder only when the app under test created it (its profile itself went to the work folder)
  if (-not $KeepInstalled -and -not $hadLocal -and (Test-Path -LiteralPath $localData)) { Remove-Tree $localData }

  try {
    $shortcutsAfter = @(Get-ShortcutState | Sort-Object)
    $gone = @($shortcutsBefore | Where-Object { $_ -notin $shortcutsAfter })
    $new = @($shortcutsAfter | Where-Object { $_ -notin $shortcutsBefore })
    foreach ($s in $gone) { Write-Warning "shortcut removed or changed: $(($s -split '\|')[0])" }
    foreach ($s in $new) { Write-Warning "shortcut added or changed: $(($s -split '\|')[0])" }
    Write-Check "shortcuts unchanged ($($shortcutsBefore.Count) files)" (($gone.Count + $new.Count) -eq 0)
  } catch {
    Write-Check "shortcuts unchanged (not compared: $($_.Exception.Message))" $false
  }

  # -KeepInstalled: the kept copy's silent uninstall leaves the remembered install folder pointing at it (only the
  # "delete app data" checkbox deletes that record), so the removal command below puts back the record of before
  # the run; its export stays in the work folder.
  $location = $regRecords | Where-Object File -eq "install_location.reg"
  $locationExport = Join-Path $work $location.File
  if ($KeepInstalled -and $location.Existed) {
    try { Copy-Item -LiteralPath (Join-Path $backupDir $location.File) -Destination $locationExport } catch { Write-Warning "keeping the export of $($location.Key) failed: $($_.Exception.Message)" }
  }

  if ($restored) {
    # nothing of the user's is needed any more: the registry exports, the copy of secrets.json and the fixtures go
    foreach ($d in $backupDir, $fixtureDir, $webviewDir) { Remove-Tree $d }
    # what a failed run left of the test copy (the folder was new)
    if (-not $KeepInstalled -and (Test-Path -LiteralPath $InstallDir)) { Remove-Tree $InstallDir }
    if (-not (Get-ChildItem -LiteralPath $work -Force -ErrorAction SilentlyContinue)) { Remove-Tree $work }
  } else {
    Write-Warning "kept $work for a manual restore: the registry exports and the copy of $appData (with secrets.json) are in $backupDir"
  }
  if ($KeepInstalled -and (Test-Path -LiteralPath $uninst)) {
    $putBack = "reg delete '$($location.Key)' /f" + ($location.Existed ? "; reg import '$locationExport'" : "")
    Write-Output "kept the test copy in $InstallDir (remove it with: & '$uninst' /S; $putBack)"
  }
}
if ($failures.Count) {
  Write-Warning "$($failures.Count) check(s) failed"
  exit 1
}
Write-Output "all checks passed"
exit 0
