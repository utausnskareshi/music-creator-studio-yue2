# Runs the uninstaller's file functions from src-tauri/windows/hooks.nsh (McsCleanPath, McsIsDir, McsToolsChoice with
# McsOutputInDataRoot and McsFormerInDataRoot, McsRMDirR, McsDeleteDataRoot with McsDeleteOwnFiles, McsDeleteOutput)
# against fixture folders: a small test installer that includes hooks.nsh is compiled with makensis (default: the
# NSIS Tauri downloads, %LOCALAPPDATA%\tauri\NSIS) and run silently, then the script checks what was removed and what
# was kept. The uninstall hook itself only shows the messages of McsToolsChoice's choice and calls the delete
# functions (src-tauri/src/config.rs checks that it has a message for every choice).
# Usage: pwsh -File tools/nsis_hooks_test.ps1 [-MakeNsis <makensis.exe>] [-Hooks <hooks.nsh>] [-Keep]   (Windows PowerShell 5.1 works too)
#        or: npm run test:nsis-hooks
# Run it after every change to hooks.nsh and before every release: an uninstaller that has shipped cannot be fixed
# by a later release (an upgrade runs the OLD version's uninstaller). .github/workflows/release.yml runs it after the
# installer build (step "Uninstaller hooks test (NSIS)"), and a failure fails the job.
#
# hooks.nsh is only read (!include). For a mutation check, edit a copy outside the repository and pass it with
# -Hooks; never edit src-tauri\windows\hooks.nsh in place for that.
#
# Every folder the functions delete in lies in a new work folder, %TEMP%\mcs_hooks_test_<random>; the junctions
# point into its "outside" folder, whose files must survive. The real data root, song folder and app data are
# never named: McsCleanPath and McsToolsChoice are only given paths (the profile, Windows, Music ...) and only read
# there. The work
# folder is removed at the end with "rd /s /q" (which does not follow junctions) unless -Keep is given or a
# check failed. Exit code: 0 all checks passed, 1 a check failed, 2 makensis or the test installer failed.
param(
  [string]$MakeNsis,
  [string]$Hooks,
  [switch]$Keep
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Hooks) { $Hooks = Join-Path $repo "src-tauri\windows\hooks.nsh" }
if (-not (Test-Path -LiteralPath $Hooks -PathType Leaf)) { Write-Host "hooks file not found: $Hooks"; exit 2 }
$Hooks = (Resolve-Path -LiteralPath $Hooks).ProviderPath
Write-Host "hooks: $Hooks"
if (-not $MakeNsis) { $MakeNsis = Join-Path $env:LOCALAPPDATA "tauri\NSIS\makensis.exe" }
if (-not (Test-Path -LiteralPath $MakeNsis)) {
  $found = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if (-not $found) { Write-Host "makensis.exe not found (pass -MakeNsis, or build the installer once so Tauri downloads NSIS)"; exit 2 }
  $MakeNsis = $found.Source
}

$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = Join-Path $temp ("mcs_hooks_test_" + [guid]::NewGuid().ToString("N").Substring(0, 12))
if (-not $work.StartsWith($temp) -or (Test-Path -LiteralPath $work)) { throw "unexpected work folder $work" }
[void][IO.Directory]::CreateDirectory($work)
Write-Host "work folder: $work"

# .NET with the \\?\ prefix: the long-path fixture is longer than MAX_PATH, and names with % & ! ^ stay literal.
function Long([string]$p) { if ($p.StartsWith("\\?\")) { $p } else { "\\?\" + $p } }
function Full([string]$rel) { if ($rel) { Join-Path $work $rel } else { $work } }
function MkDir([string]$rel) { [void][IO.Directory]::CreateDirectory((Long (Full $rel))) }
function MkFile([string]$rel) {
  MkDir (Split-Path $rel -Parent)
  [IO.File]::WriteAllText((Long (Full $rel)), "x")
}
function Exists([string]$rel) { $p = Long (Full $rel); [IO.File]::Exists($p) -or [IO.Directory]::Exists($p) }
function Junction([string]$rel, [string]$targetRel) {
  MkDir (Split-Path $rel -Parent)
  $null = & cmd.exe /d /c mklink /J (Full $rel) (Full $targetRel)
  if ($LASTEXITCODE -ne 0) { throw "mklink /J $rel failed" }
}
# A junction more than MAX_PATH below the drive (mklink cannot make one there).
function LongJunction([string]$rel, [string]$targetRel) {
  MkDir (Split-Path $rel -Parent)
  $null = New-Item -ItemType Junction -Path (Long (Full $rel)) -Target (Full $targetRel)
  if (-not (Exists $rel)) { throw "junction $rel was not made" }
}

# ---- fixtures
$jp = -join [char[]](0x66F2, 0x0020, 0x30D5, 0x30A9, 0x30EB, 0x30C0) # a song folder name in Japanese
# A tree longer than MAX_PATH (the portable ComfyUI has files ~240 characters below the data root).
$deep = "data\runtime\ComfyUI_windows_portable\deep\" + ((1..8 | ForEach-Object { "segment_$_" + ("x" * 30) }) -join "\")

# Data root: the app's entries (removed) next to other tools' and the user's files (kept).
$dataGone = @(
  "data\runtime\ComfyUI_windows_portable\ComfyUI\main.py",
  "$deep\file.txt",
  "data\runtime\ComfyUI_windows_portable\odd % & ! ^ name\x.txt",
  "data\runtime\bin\7zr.exe",
  "data\runtime\ffmpeg\bin\ffmpeg.exe",
  "data\runtime\.mcs_extracting\uroman_pip",
  "data\cache\sep_work\a\vocals.wav",
  "data\cache\align_stems\b.wav",
  "data\cache\pip-constraints-uroman_pip.txt",
  "data\cache\ComfyUI_windows_portable_nvidia.7z.part",
  "data\cache\ComfyUI_windows_portable_nvidia.7z.part.src",
  "data\extra_model_paths.yaml",
  "data\models\checkpoints\yue2_3b_bf16.safetensors",
  "data\models\checkpoints\yue2_3b_int8_convrot.safetensors.part.src",
  "data\models\separation\model_bs_roformer_ep_317_sdr_12.9755.ckpt",
  "data\models\separation\model_bs_roformer_ep_368_sdr_12.9628.ckpt.mcs_part",
  "data\models\separation\htdemucs_ft.yaml",
  "data\models\separation\download_checks.json",
  "data\models\separation\download_checks.json.mcs_part",
  "data\models\torch\hub\checkpoints\model.pt.part",
  "data\models\llm\Qwen3-14B-Q4_K_M.gguf"
)
$dataKept = @(
  "data\runtime\other_tool\keep.txt",
  "data\cache\other.zip",
  "data\comfy_input\user.png",
  "data\models\checkpoints\mine.safetensors",
  "data\models\separation\my_model.ckpt",
  "outside\shared_nodes\keep.txt",
  "outside\llama_target\llama-server.exe",
  "outside\uploads_target\keep.wav"
)
# ComfyUI's input / output folders of the app (comfy_input\mcs_uploads, comfy_output\mcs and mcs_sep) may have been
# the song folder once: only the names the app gives its files there go, at the top of each folder (staged copies
# and their .part: is_staged_upload_name in src-tauri/src/comfy/client.rs; generation / separation outputs:
# is_comfy_output_name in src-tauri/src/lib.rs). A song folder, an export, a diagnostic bundle, names that only look
# like the app's and the app's names in a sub-folder stay, and so does each folder then.
$up = "data\comfy_input\mcs_uploads"
$out = "data\comfy_output\mcs"
$sep = "data\comfy_output\mcs_sep"
$uuid = "0123456789abcdef0123456789abcdef"
# The names at the top of the three folders come from tools/uninstall_name_cases.txt, against which the app's own
# rules are checked too (src-tauri/src/lib.rs the_uninstallers_name_rules_are_the_apps).
$folderOf = @{ uploads = $up; mcs = $out; mcs_sep = $sep }
$ownGone = @()
$ownKept = @()
foreach ($line in [IO.File]::ReadAllLines((Join-Path $PSScriptRoot "uninstall_name_cases.txt"))) {
  if ($line -match '^\s*(#|$)') { continue }
  if ($line -notmatch '^(\S+)\s+(gone|kept)\s+(.+?)\s*$') { throw "bad line in uninstall_name_cases.txt: $line" }
  $folder = $folderOf[$Matches[1]]
  if (-not $folder) { throw "unknown folder in uninstall_name_cases.txt: $line" }
  $verdict = $Matches[2]
  $name = [regex]::Replace($Matches[3].Replace("{uuid}", $uuid), '\{a\*(\d+)\}', { param($m) "a" * [int]$m.Groups[1].Value })
  if ($verdict -eq "gone") { $ownGone += "$folder\$name" } else { $ownKept += "$folder\$name" }
}
if ($ownGone.Count -lt 10 -or $ownKept.Count -lt 30) { throw "uninstall_name_cases.txt holds too few names" }
# The app's names in a sub-folder stay (only the top of each folder is looked at), and so do song folders.
$ownKept += @("$up\2026-10-01\0123456789abcdef_take.wav", "$out\2026-10-01\0123abcd_00001_.flac", "$sep\sub\89abcdef_vocals_00001_.wav")
foreach ($d in @($up, $out, $sep)) {
  $ownKept += @("$d\2026-10-01\120000_0123abcd\song.json", "$d\2026-10-01\120000_0123abcd\song.wav")
}
foreach ($f in $dataGone + $dataKept + $ownGone + $ownKept) { MkFile $f }
MkDir "data\comfy_input\3d"
# Links: two inside removed trees, one given to the delete directly. Only the links go. A link named like a staged
# copy in mcs_uploads is a folder, not a copy: it stays, and so does what it points to.
Junction "data\runtime\ComfyUI_windows_portable\ComfyUI\custom_nodes\shared" "outside\shared_nodes"
Junction "data\runtime\llama" "outside\llama_target"
Junction "$up\0123456789abcdef_linked.wav" "outside\uploads_target"
$dataGoneDirs = @("data\runtime\ComfyUI_windows_portable", "data\runtime\bin", "data\runtime\ffmpeg", "data\runtime\llama", "data\runtime\.mcs_extracting",
  "data\cache\sep_work", "data\cache\align_stems", "data\comfy_input\3d",
  "data\models\torch", "data\models\llm")

# A data root holding only the app's entries: removed entirely. The separation download cut off by a killed
# ComfyUI (the node pack's <file>.mcs_part) must not keep models\separation and the root alive.
foreach ($f in @("data2\runtime\bin\7zr.exe", "data2\cache\ComfyUI_windows_portable_nvidia.7z", "data2\models\checkpoints\yue2_3b_bf16.safetensors", "data2\extra_model_paths.yaml",
    "data2\models\separation\download_checks.json.mcs_part", "data2\comfy_input\mcs_uploads\0123456789abcdef_take.wav",
    "data2\comfy_input\mcs_uploads\0123456789abcdef_take.wav.$uuid.part", "data2\comfy_output\mcs\0123abcd_00001_.flac")) { MkFile $f }
MkDir "data2\models\loras"
MkDir "data2\comfy_output\mcs_sep"

# A data root whose folders on the way to the deleted entries are links (shared with another tool, or planted by
# another account): only the links go, never what is behind them.
$linkedKept = @(
  "outside\runtime_target\bin\7zr.exe",
  "outside\runtime_target\ComfyUI_windows_portable\ComfyUI\main.py",
  "outside\runtime_target\ffmpeg\bin\ffmpeg.exe",
  "outside\cache_target\ComfyUI_windows_portable_nvidia.7z",
  "outside\cache_target\sep_work\a\vocals.wav",
  "outside\input_target\mcs_uploads\x.wav",
  "outside\input_target\mcs_uploads\0123456789abcdef_take.wav",
  "outside\mcs_target\0123abcd_00001_.flac",
  "outside\ckpt_target\yue2_3b_bf16.safetensors",
  "outside\hub_target\checkpoints\model.pt"
)
foreach ($f in $linkedKept + @("data3\models\llm\Qwen3-14B-Q4_K_M.gguf", "data3\extra_model_paths.yaml")) { MkFile $f }
Junction "data3\runtime" "outside\runtime_target"
Junction "data3\cache" "outside\cache_target"
Junction "data3\comfy_input" "outside\input_target"
Junction "data3\comfy_output\mcs" "outside\mcs_target"
Junction "data3\models\checkpoints" "outside\ckpt_target"
Junction "data3\models\torch\hub" "outside\hub_target"

# A data root whose comfy_input and comfy_output are real folders but whose mcs_uploads and mcs_sep are links:
# McsDeleteOwnFiles goes into the folder it is given, so the app's names behind such a link (another tool's or
# account's folder) would go too. Only the links go; the app's file next to them (comfy_output\mcs) still goes.
$ownLinkedKept = @(
  "outside\uploads_link_target\0123456789abcdef_take.wav",
  "outside\uploads_link_target\0123456789abcdef_take.wav.$uuid.part",
  "outside\sep_target\89abcdef_vocals_00001_.wav",
  "outside\sep_target\89abcdef_instrumental_00002_.flac"
)
foreach ($f in $ownLinkedKept + @("data4\comfy_output\mcs\0123abcd_00001_.flac")) { MkFile $f }
MkDir "data4\comfy_input\3d"
Junction "data4\comfy_input\mcs_uploads" "outside\uploads_link_target"
Junction "data4\comfy_output\mcs_sep" "outside\sep_target"

# Data roots of 185 and 238 characters: a staged copy with a 40-character stem (and its .part) is more than MAX_PATH
# below them, which the app writes with long paths, and below the longer one so is mcs_uploads itself.
# McsDeleteOwnFiles must reach them, or the copy, mcs_uploads, comfy_input and the root all stay.
$longCopy = "0123456789abcdef_$('a' * 40).wav"
$longRoots = @()
foreach ($n in @(185, 238)) {
  $root = "data5_$n"
  while ((Full $root).Length -lt $n - 40) { $root += "\long_root_" + ("r" * 25) }
  $root += "\" + ("r" * ($n - (Full $root).Length - 1))
  if ((Full $root).Length -ne $n) { throw "the long data root fixture is $((Full $root).Length) characters, not $n" }
  foreach ($f in @("$root\comfy_input\mcs_uploads\$longCopy", "$root\comfy_input\mcs_uploads\$longCopy.$uuid.part")) { MkFile $f }
  if ((Full "$root\comfy_input\mcs_uploads\$longCopy").Length -le 260) { throw "the long data root fixture is not longer than MAX_PATH" }
  $longRoots += $root
}

# Song folder: song folders (<date>\<HHMMSS>_<8 chars> with a marker file), separations, diagnostics.
$songsGone = @(
  "songs\2026-10-07\120000_abcd1234\song.json",
  "songs\2026-10-07\120001_abcd1234\workflow_api.json",
  "songs\2026-10-07\120002_abcd1234\failure.json",
  "songs\2026-10-08\120000_ffffffff\song.json",
  "songs\separated\20261007_120000_my song\vocals.wav",
  "songs\mcs-diagnostics-20261007_120000.zip",
  "songs\mcs-diagnostics-20261007_120001.zip.part"
)
$songsKept = @(
  "songs\2026-10-07\120003_abcd1234\notes.txt",
  "songs\2026-10-07\120000_abcd123\song.json",
  "songs\2026-10-07\1200001abcd1234\song.json",
  "songs\2026-10-07\export.mp3",
  "songs\2026-1-07\120000_abcd1234\song.json",
  "songs\my-folder\120000_abcd1234\song.json",
  "songs\separated\htdemucs_ft\x.wav",
  "songs\separated\20261007_120000_\x.wav",
  "songs\mine.zip",
  "outside\song_target\song.json"
)
foreach ($f in $songsGone + $songsKept) { MkFile $f }
Junction "songs\2026-10-10\120000_abcd1234" "outside\song_target"
$songsGoneDirs = @("songs\2026-10-07\120000_abcd1234", "songs\2026-10-08", "songs\2026-10-10", "songs\separated\20261007_120000_my song")
MkFile "$jp\2026-10-07\130000_abcdef12\song.json"

# Song folders used before the current one (FormerOutputDirs) inside a tree the tools prompt removes: ComfyUI's own
# output folder with only its placeholder (nothing to keep), one holding a song, and one with a song more than
# MAX_PATH below the drive (under the 238-character data root).
MkFile "data\runtime\ComfyUI_windows_portable\ComfyUI\output\_output_images_will_be_put_here"
MkFile "data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before\2026-10-07\120000_abcd1234\song.json"
$longFormer = "$($longRoots[1])\runtime\ComfyUI_windows_portable\ComfyUI\output"
MkFile "$longFormer\2026-10-07\120000_abcd1234\song.json"
if ((Full $longFormer).Length -lt 260) { throw "the long former song folder is not longer than MAX_PATH" }
# 8.3 short names, when the volume makes them: McsCleanPath gives the long names.
$shortData = (New-Object -ComObject Scripting.FileSystemObject).GetFolder((Full "data")).ShortPath
# A share path of the work folder (the administrative share of its drive), when it can be reached: RemoveDirectoryW
# removes what NSIS's RMDir cannot with a \\?\UNC\ path, below a data root of 238 characters as a share path.
$uncWork = "\\localhost\" + $work.Substring(0, 1) + "$" + $work.Substring(2)
$uncRoot = $null
$rmLong = $null
if (Test-Path -LiteralPath $uncWork) {
  $root = "data7"
  while (("$uncWork\$root").Length -lt 238 - 40) { $root += "\unc_root_" + ("u" * 25) }
  $root += "\" + ("u" * (238 - ("$uncWork\$root").Length - 1))
  foreach ($f in @("$root\comfy_input\mcs_uploads\$longCopy", "$root\comfy_input\mcs_uploads\$longCopy.$uuid.part")) { MkFile $f }
  # a link on the way to the models, more than MAX_PATH below the share path: only RemoveDirectoryW unlinks it
  MkFile "outside\unc_ckpt_target\keep.pt"
  LongJunction "$root\models\torch\hub\checkpoints" "outside\unc_ckpt_target"
  if (("$uncWork\$root\models\torch\hub\checkpoints").Length -le 260) { throw "the share-path link is not longer than MAX_PATH" }
  $uncRoot = $root
  # McsRMDirR given a link more than MAX_PATH below a share path: the link goes, what it points to stays
  $rmLong = "rmlong"
  while (("$uncWork\$rmLong\link").Length -le 265) { $rmLong += "\rm_long_" + ("l" * 25) }
  MkFile "outside\rmlong_target\keep.txt"
  LongJunction "$rmLong\link" "outside\rmlong_target"
}
# An intermediate folder this account may pass through but not list (a share's home folders root, Z:\bob\MCS): the
# folders below it are still found and cleaned, and their 8.3 short names are made long (a name right below it by
# asking the folder itself; for a link there, the link's own name). A link whose target is gone counts as no folder.
Add-Type -Namespace McsHooksTest -Name Native -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetShortPathNameW(string longPath, System.Text.StringBuilder shortPath, uint size);'
function ShortOf([string]$rel) {
  $sb = New-Object System.Text.StringBuilder 4096
  $n = [McsHooksTest.Native]::GetShortPathNameW((Long (Full $rel)), $sb, 4096)
  if ($n -eq 0 -or $n -ge 4096) { throw "GetShortPathNameW failed for $rel" }
  $sb.ToString().Substring(4)
}
MkDir "tonly\sub\MCS"
MkDir "tonly\sub\mcs_long_folder_name"
MkDir "tonly\mcs_long_folder_name"
MkDir "outside\target_folder_long"
Junction "tonly\link_to_target_folder" "outside\target_folder_long"
$fso = New-Object -ComObject Scripting.FileSystemObject
$shortBelow = $fso.GetFolder((Full "tonly\sub\mcs_long_folder_name")).ShortPath
$shortUnder = $fso.GetFolder((Full "tonly\mcs_long_folder_name")).ShortPath
$aliasLink = ShortOf "tonly\link_to_target_folder"
# A data root right below it recorded by its 8.3 name, with the song folder in it recorded by long names (and the
# other way round): both are made long (the folder itself is asked for its name) and the song folder is found inside.
# A name that cannot be looked up at all (this account may not read that folder's attributes either) cannot be
# compared: McsCleanPath gives "" with McsCleanUnsure 1, and McsToolsChoice refuses the tools prompt for such a song
# folder, or a former one that holds something (also recorded with a trailing "\" or "/").
MkFile "tonly\mcs_data_root_folder\runtime\ComfyUI_windows_portable\ComfyUI\output\2026-10-07\120000_abcd1234\song.json"
MkFile "tonly\mcs_noattr_folder\2026-10-07\120000_abcd1234\song.json"
MkDir "tonly\mcs_noattr_empty"
$aliasNoAttrEmpty = $fso.GetFolder((Full "tonly\mcs_noattr_empty")).ShortPath
$aliasRoot = $fso.GetFolder((Full "tonly\mcs_data_root_folder")).ShortPath
$aliasOut = $fso.GetFolder((Full "tonly\mcs_data_root_folder\runtime\ComfyUI_windows_portable\ComfyUI\output")).ShortPath
$aliasNoAttr = $fso.GetFolder((Full "tonly\mcs_noattr_folder")).ShortPath
# 8.3 names whose long names would not fit in an NSIS string (1024 characters): such a path cannot be compared either,
# whether the long names overflow with the last name (deep5) or before it (deep6: the path is cut before the last
# name is looked up).
$deepRel = "deep83"
foreach ($c in "a", "b", "c", "d", "e", "f") { $deepRel += "\" + ([string]$c * 200) }
MkDir $deepRel
$deep5 = ShortOf (Split-Path $deepRel -Parent)
$deep6 = ShortOf $deepRel
# An 8.3 name looked up more than MAX_PATH below the drive (below the long former song folder): made long through the
# extended-length path, inside the data root of 238 characters (and outside another data root).
$longSongRel = "$longFormer\mcs_song_folder_8dot3"
MkDir $longSongRel
$longAlias = ShortOf $longSongRel
$long83 = (Split-Path $longAlias -Leaf).Contains("~")
# (without 8.3 names the paths are too long for the test installer's strings: the cases are skipped)
$deepShort = $deep6.Length -lt 900
if ($deepShort -and (Full (Split-Path $deepRel -Parent)).Length -le 1023) { throw "the long names of deep5 fit in an NSIS string" }
Junction "dangling" "outside\never_made"
$me = "$env:USERDOMAIN\$env:USERNAME"

# McsRMDirR on its own.
foreach ($f in @("rm\plain\a\b.txt", "rm\a % b & c ! d ^ e\f.txt", "outside\rm_target\keep.txt")) { MkFile $f }
Junction "rm\link" "outside\rm_target"
MkDir "Music"

# ---- the test installer
function NsisString([string]$s) { $s.Replace('$', '$$').Replace('"', '$\"') }
$nsi = Join-Path $work "hooks_test.nsi"
$exe = Join-Path $work "hooks_test.exe"
$results = Join-Path $work "results.txt"
$W = NsisString $work
$lines = @(
  'Unicode true',
  'Name "MCS hooks test"',
  "OutFile `"$(NsisString $exe)`"",
  'RequestExecutionLevel user',
  'SilentInstall silent',
  "!include /CHARSET=UTF8 `"$(NsisString $Hooks)`"",
  '!insertmacro McsHookFunctions ""',
  'Var Log',
  'Var Kept',
  'Var Top',
  '!macro Result KEY VALUE',
  '  FileWriteUTF16LE $Log "${KEY}=${VALUE}$\r$\n"',
  '!macroend',
  '!macro CleanCase KEY IN',
  '  Push "${IN}"',
  '  Call McsCleanPath',
  '  Pop $0',
  '  !insertmacro Result "${KEY}" "$0"',
  '!macroend',
  '!macro FormerCase KEY LIST',
  "  !insertmacro FormerCaseIn `"`${KEY}`" `"`${LIST}`" `"$W\data`"",
  '!macroend',
  # the folder, and whether it cannot be compared (KEY_unsure)
  '!macro FormerCaseIn KEY LIST ROOT',
  '  Push "${LIST}"',
  '  Push "${ROOT}"',
  '  Call McsFormerInDataRoot',
  '  Pop $1',
  '  Pop $0',
  '  !insertmacro Result "${KEY}" "$0"',
  '  !insertmacro Result "${KEY}_unsure" "$1"',
  '!macroend',
  '!macro IsDirCase KEY PATH',
  '  Push "${PATH}"',
  '  Call McsIsDir',
  '  Pop $0',
  '  !insertmacro Result "${KEY}" "$0"',
  '!macroend',
  '!macro InsideCase KEY OUT',
  '  Push "${OUT}"',
  "  Push `"$W\data`"",
  '  Call McsOutputInDataRoot',
  '  Pop $0',
  '  !insertmacro Result "${KEY}" "$0"',
  '!macroend',
  # as the uninstall hook does: both recorded paths cleaned first
  '!macro CleanInsideCase KEY OUT ROOT',
  '  Push "${OUT}"',
  '  Call McsCleanPath',
  '  Pop $1',
  '  Push "${ROOT}"',
  '  Call McsCleanPath',
  '  Pop $2',
  '  StrCpy $0 "not cleaned"',
  '  ${If} $1 != ""',
  '  ${AndIf} $2 != ""',
  '    Push $1',
  '    Push $2',
  '    Call McsOutputInDataRoot',
  '    Pop $0',
  '  ${EndIf}',
  '  !insertmacro Result "${KEY}" "$0"',
  '!macroend',
  # McsCleanUnsure after McsCleanPath: whether the path cannot be compared (its 8.3 names cannot be made long)
  '!macro UnresolvedCase KEY PATH',
  '  Push "${PATH}"',
  '  Call McsCleanPath',
  '  Pop $0',
  '  !insertmacro Result "${KEY}" "$McsCleanUnsure"',
  '!macroend',
  # the uninstall hook's choice about the tools and models (McsToolsChoice, on the hook's registers):
  # "choice|named folder|cleaned data root|cleaned song folder|song folder there|data root there|kept", where kept
  # says that $0, $1, $5, $9, $R0-$R9 and the stack are as they were
  '!macro ChoiceCase KEY ROOT SONG FORMER',
  '  StrCpy $0 "${ROOT}"',
  '  StrCpy $1 "${SONG}"',
  '  StrCpy $5 "${FORMER}"',
  '  StrCpy $9 "s9"',
  '  StrCpy $R0 "r0"',
  '  StrCpy $R1 "r1"',
  '  StrCpy $R2 "r2"',
  '  StrCpy $R3 "r3"',
  '  StrCpy $R4 "r4"',
  '  StrCpy $R5 "r5"',
  '  StrCpy $R6 "r6"',
  '  StrCpy $R7 "r7"',
  '  StrCpy $R8 "r8"',
  '  StrCpy $R9 "r9"',
  '  Push "stack sentinel"',
  '  Call McsToolsChoice',
  '  Pop $Top',
  '  StrCpy $Kept "kept"',
  '  ${If} $Top != "stack sentinel"',
  '    StrCpy $Kept "stack"',
  '  ${EndIf}',
  '  ${If} $0 != "${ROOT}"',
  '  ${OrIf} $1 != "${SONG}"',
  '  ${OrIf} $5 != "${FORMER}"',
  '  ${OrIf} $9 != "s9"',
  '  ${OrIf} $R0 != "r0"',
  '  ${OrIf} $R1 != "r1"',
  '  ${OrIf} $R2 != "r2"',
  '  ${OrIf} $R3 != "r3"',
  '  ${OrIf} $R4 != "r4"',
  '  ${OrIf} $R5 != "r5"',
  '  ${OrIf} $R6 != "r6"',
  '  ${OrIf} $R7 != "r7"',
  '  ${OrIf} $R8 != "r8"',
  '  ${OrIf} $R9 != "r9"',
  '    StrCpy $Kept "registers"',
  '  ${EndIf}',
  '  !insertmacro Result "${KEY}" "$4|$6|$2|$3|$7|$8|$Kept"',
  '!macroend',
  'Section',
  '  SetShellVarContext current',
  "  FileOpen `$Log `"$(NsisString $results)`" w",
  '  FileWriteWord $Log 0xFEFF',
  '  !insertmacro CleanCase empty ""',
  '  !insertmacro CleanCase relative "data\runtime"',
  '  !insertmacro CleanCase drive_root "C:\"',
  '  !insertmacro CleanCase drive "C:"',
  "  !insertmacro CleanCase missing `"$W\missing`"",
  "  !insertmacro CleanCase trailing `"$W\data\`"",
  "  !insertmacro CleanCase slashes `"$($W.Replace('\', '/'))/data`"",
  "  !insertmacro CleanCase case `"$W\DATA`"",
  "  !insertmacro CleanCase dotdot `"$W\data\..`"",
  "  !insertmacro CleanCase lookalike `"$W\Music`"",
  "  !insertmacro CleanCase japanese `"$W\$jp`"",
  '  !insertmacro CleanCase windir "$WINDIR"',
  '  !insertmacro CleanCase profile "$PROFILE"',
  '  !insertmacro CleanCase users "$PROFILE\.."',
  '  !insertmacro CleanCase music "$PROFILE\Music"',
  '  !insertmacro CleanCase documents "$PROFILE\Documents"',
  '  !insertmacro CleanCase appdata "$APPDATA"',
  # Shares: a folder below the share is accepted, the share and the server are not. The trailing "\" keeps
  # GetFullPathName from looking the name up (no network wait for the made-up server).
  '  !insertmacro CleanCase unc_share "\\server\share\"',
  '  !insertmacro CleanCase unc_share_slashes "//server/share/"',
  '  !insertmacro CleanCase unc_server "\\server\"',
  '  !insertmacro CleanCase unc_dir "\\server\share\MCSYuE2\"',
  '  !insertmacro CleanCase unc_dir_slashes "//server/share/MCSYuE2/"',
  "  !insertmacro InsideCase in_comfy_output `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\output`"",
  "  !insertmacro InsideCase is_portable `"$W\data\runtime\ComfyUI_windows_portable`"",
  "  !insertmacro InsideCase upper_case `"$W\data\RUNTIME\comfyui_windows_portable\x`"",
  "  !insertmacro InsideCase is_mcs_output `"$W\data\comfy_output\mcs`"",
  "  !insertmacro InsideCase in_llama `"$W\data\runtime\llama\songs`"",
  "  !insertmacro InsideCase in_uploads `"$W\data\comfy_input\mcs_uploads\a`"",
  "  !insertmacro InsideCase mcs_lookalike `"$W\data\comfy_output\mcs2`"",
  "  !insertmacro InsideCase llama_lookalike `"$W\data\runtime\llama2`"",
  "  !insertmacro InsideCase comfy_output `"$W\data\comfy_output`"",
  "  !insertmacro InsideCase runtime_songs `"$W\data\runtime\songs`"",
  "  !insertmacro InsideCase root `"$W\data`"",
  "  !insertmacro InsideCase root_songs `"$W\data\songs`"",
  "  !insertmacro InsideCase elsewhere `"$W\songs`"",
  # The song folders used before (FormerOutputDirs, "|"-separated): the first that still exists and lies in a
  # folder the tools prompt deletes in, or "".
  "  !insertmacro FormerCase former_inside `"$W\missing|$W\songs|$W\data\runtime\ComfyUI_windows_portable\ComfyUI`"",
  # the app's files alone go in mcs_uploads, mcs and mcs_sep: a song folder there once is no reason to refuse
  "  !insertmacro FormerCase former_uploads `"$W\songs|$W\data\comfy_input\mcs_uploads`"",
  "  !insertmacro FormerCase former_outside `"$W\songs|$W\Music`"",
  "  !insertmacro FormerCase former_gone `"$W\data\runtime\ComfyUI_windows_portable\gone`"",
  '  !insertmacro FormerCase former_empty ""',
  "  !insertmacro FormerCase former_slashes `"$($W.Replace('\', '/'))/data/runtime/ComfyUI_windows_portable/ComfyUI/`"",
  # only ComfyUI's placeholder left (the songs were moved): no reason to refuse; a song still there is
  "  !insertmacro FormerCase former_placeholder `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\output`"",
  "  !insertmacro FormerCase former_songs `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\output|$W\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before`"",
  "  !insertmacro FormerCaseIn former_long `"$(NsisString (Full $longFormer))`" `"$(NsisString (Full $longRoots[1]))`"",
  "  !insertmacro IsDirCase isdir_long `"$(NsisString (Full $longFormer))`"",
  "  !insertmacro IsDirCase isdir_slashes `"$($W.Replace('\', '/'))/data/`"",
  "  !insertmacro IsDirCase isdir_file `"$W\data\extra_model_paths.yaml`"",
  "  !insertmacro IsDirCase isdir_missing `"$W\missing`"",
  '  !insertmacro IsDirCase isdir_empty ""',
  "  !insertmacro CleanCase long_path `"$(NsisString (Full $longFormer))`"",
  "  !insertmacro CleanCase short_name `"$(NsisString $shortData)\`"",
  "  !insertmacro CleanCase below_unlistable `"$W\tonly\sub\MCS`"",
  "  !insertmacro CleanCase short_below_unlistable `"$(NsisString $shortBelow)`"",
  "  !insertmacro CleanCase short_under_unlistable `"$(NsisString $shortUnder)`"",
  "  !insertmacro CleanInsideCase alias_root_inside `"$W\tonly\mcs_data_root_folder\runtime\ComfyUI_windows_portable\ComfyUI\output`" `"$(NsisString $aliasRoot)`"",
  "  !insertmacro CleanInsideCase alias_out_inside `"$(NsisString $aliasOut)`" `"$W\tonly\mcs_data_root_folder`"",
  # the hook's choice (before McsDeleteDataRoot below removes the data root's trees)
  "  !insertmacro ChoiceCase choice_inside `"$W\data`" `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\output`" `"`"",
  "  !insertmacro ChoiceCase choice_inside_first `"$W\data`" `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\output`" `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before`"",
  "  !insertmacro ChoiceCase choice_ask `"$W\data`" `"$W\songs`" `"`"",
  "  !insertmacro ChoiceCase choice_music `"$W\data`" `"`$PROFILE\Music`" `"`"",
  "  !insertmacro ChoiceCase choice_alias_root `"$(NsisString $aliasRoot)`" `"$W\tonly\mcs_data_root_folder\runtime\ComfyUI_windows_portable\ComfyUI\output`" `"`"",
  "  !insertmacro ChoiceCase choice_alias_song `"$W\tonly\mcs_data_root_folder`" `"$(NsisString $aliasOut)`" `"`"",
  "  !insertmacro ChoiceCase choice_unknown `"$W\data`" `"$(NsisString $aliasNoAttr)`" `"`"",
  "  !insertmacro ChoiceCase choice_root_unknown `"$(NsisString $aliasNoAttr)`" `"$W\songs`" `"`"",
  "  !insertmacro ChoiceCase choice_root_missing `"$W\missing`" `"$W\songs`" `"`"",
  "  !insertmacro ChoiceCase choice_root_drive `"C:\`" `"$W\songs`" `"`"",
  "  !insertmacro ChoiceCase choice_former `"$W\data`" `"$W\songs`" `"$W\songs|$W\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before`"",
  "  !insertmacro ChoiceCase choice_former_unknown `"$W\data`" `"$W\songs`" `"$W\songs|$(NsisString $aliasNoAttr)`"",
  "  !insertmacro ChoiceCase choice_former_unknown_slash `"$W\data`" `"$W\songs`" `"$(NsisString $aliasNoAttr)\`"",
  "  !insertmacro ChoiceCase choice_former_outside `"$W\data`" `"$W\songs`" `"$W\songs|$W\Music`"",
  # a former song folder inside, whatever the song folder is (missing, the Music folder, a drive root)
  "  !insertmacro ChoiceCase choice_former_song_missing `"$W\data`" `"$W\missing`" `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before`"",
  "  !insertmacro ChoiceCase choice_former_song_music `"$W\data`" `"`$PROFILE\Music`" `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before`"",
  "  !insertmacro ChoiceCase choice_former_song_drive `"$W\data`" `"C:\`" `"$W\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before`"",
  # a former folder that cannot be compared but holds nothing does not refuse; a data root that cannot be compared
  # refuses before a song folder that cannot be compared
  "  !insertmacro ChoiceCase choice_former_unknown_empty `"$W\data`" `"$W\songs`" `"$(NsisString $aliasNoAttrEmpty)`"",
  "  !insertmacro ChoiceCase choice_both_unknown `"$(NsisString $aliasNoAttr)`" `"$(NsisString $aliasNoAttrEmpty)`" `"`"",
  $(if ($long83) { "  !insertmacro CleanCase long_alias `"$(NsisString $longAlias)`"" } else { "" }),
  $(if ($long83) { "  !insertmacro ChoiceCase choice_long_alias `"$(NsisString (Full $longRoots[1]))`" `"$(NsisString $longAlias)`" `"`"" } else { "" }),
  $(if ($long83) { "  !insertmacro ChoiceCase choice_long_alias_ask `"$W\data`" `"$(NsisString $longAlias)`" `"`"" } else { "" }),
  "  !insertmacro CleanCase unresolved `"$(NsisString $aliasNoAttr)`"",
  "  !insertmacro UnresolvedCase unresolved_alias `"$(NsisString $aliasNoAttr)`"",
  "  !insertmacro UnresolvedCase resolved_alias `"$(NsisString $shortBelow)`"",
  "  !insertmacro UnresolvedCase plain_path `"$W\data`"",
  "  !insertmacro FormerCase former_unresolved `"$W\songs|$(NsisString $aliasNoAttr)`"",
  "  !insertmacro FormerCase former_unresolved_slash `"$(NsisString $aliasNoAttr)\`"",
  "  !insertmacro FormerCase former_unresolved_fwd `"$(NsisString $aliasNoAttr)/`"",
  "  !insertmacro CleanCase junction_alias `"$(NsisString $aliasLink)`"",
  "  !insertmacro IsDirCase isdir_noattr `"$(NsisString $aliasNoAttr)`"",
  $(if ($deepShort) { "  !insertmacro CleanCase too_long_5 `"$(NsisString $deep5)`"" } else { "" }),
  $(if ($deepShort) { "  !insertmacro CleanCase too_long_6 `"$(NsisString $deep6)`"" } else { "" }),
  $(if ($deepShort) { "  !insertmacro UnresolvedCase too_long_unresolved `"$(NsisString $deep6)`"" } else { "" }),
  $(if ($deepShort) { "  !insertmacro IsDirCase isdir_too_long `"$(NsisString $deep6)`"" } else { "" }),
  $(if ($uncRoot) { "  !insertmacro CleanCase unc_short_name `"$(NsisString ("\\localhost\" + $shortData.Substring(0, 1) + "$" + $shortData.Substring(2)))`"" } else { "" }),
  "  !insertmacro IsDirCase isdir_below_unlistable `"$W\tonly\sub\MCS`"",
  "  !insertmacro IsDirCase isdir_unlistable `"$W\tonly`"",
  "  !insertmacro IsDirCase isdir_dangling `"$W\dangling`"",
  $(if ($rmLong) { "  !insertmacro McsRMDirR `"`" `"$(NsisString "$uncWork\$rmLong\link")`"" } else { "" }),
  "  !insertmacro McsRMDirR `"`" `"$W\rm\plain`"",
  "  !insertmacro McsRMDirR `"`" `"$W\rm\a % b & c ! d ^ e`"",
  "  !insertmacro McsRMDirR `"`" `"$W\rm\link`"",
  "  !insertmacro McsRMDirR `"`" `"$W\rm\missing`"",
  "  Push `"$W\data`"",
  '  Call McsDeleteDataRoot',
  "  Push `"$W\data2`"",
  '  Call McsDeleteDataRoot',
  "  Push `"$W\data3`"",
  '  Call McsDeleteDataRoot',
  "  Push `"$W\data4`"",
  '  Call McsDeleteDataRoot',
  "  Push `"$(NsisString (Full $longRoots[0]))`"",
  '  Call McsDeleteDataRoot',
  "  Push `"$(NsisString (Full $longRoots[1]))`"",
  '  Call McsDeleteDataRoot',
  $(if ($uncRoot) { "  Push `"$(NsisString "$uncWork\$uncRoot")`"" } else { "" }),
  $(if ($uncRoot) { '  Call McsDeleteDataRoot' } else { "" }),
  "  Push `"$W\songs`"",
  '  Call McsDeleteOutput',
  "  Push `"$W\$jp`"",
  '  Call McsDeleteOutput',
  '  !insertmacro Result done 1',
  '  FileClose $Log',
  'SectionEnd'
)
[IO.File]::WriteAllText($nsi, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($true)))

# (its error lines are output, not errors: Windows PowerShell 5.1 turns a redirected error line into an exception
# under "Stop")
$ErrorActionPreference = "Continue"
$compile = & $MakeNsis /V2 /INPUTCHARSET UTF8 $nsi 2>&1
$compiled = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($compiled -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
  $compile | ForEach-Object { Write-Host $_ }
  Write-Host "FAIL: makensis exited with $compiled (work folder kept: $work)"
  exit 2
}
# tonly: this account may pass through but not list it, and not read the attributes of mcs_noattr_folder and
# mcs_noattr_empty in it, only while the test installer runs (the work folder must be removable afterwards, also when
# it is kept after a failure; if the script was killed in between, first stop the hooks_test.exe running from that
# work folder and the cmd.exe it started, not another run's: Get-CimInstance Win32_Process -Filter
# "Name='hooks_test.exe'" | Where-Object ExecutablePath -like '<work>\*' | ForEach-Object { taskkill.exe /T /F /PID
# $_.ProcessId }; then remove them: icacls <work>\tonly /remove:d <account>, then the same for the two folders in it, before
# "rd /s /q"). The test installer gets 120 seconds (the whole run takes a few): one that hangs is stopped, exit 2.
$noAttr = @("tonly\mcs_noattr_folder", "tonly\mcs_noattr_empty")
$run = $null
$hung = $false
$null = & icacls.exe (Full "tonly") /deny "${me}:(RD)"
if ($LASTEXITCODE -ne 0) { throw "icacls /deny on tonly failed" }
try {
  foreach ($d in $noAttr) {
    $null = & icacls.exe (Full $d) /deny "${me}:(RA)"
    if ($LASTEXITCODE -ne 0) { throw "icacls /deny on $d failed" }
  }
  $run = Start-Process -FilePath $exe -PassThru
  # (Windows PowerShell 5.1 keeps the exit code of a process started without -Wait only while its handle is open)
  $null = $run.Handle
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  # (short waits: Ctrl+C still stops the script at once)
  while (-not $run.WaitForExit(250)) {
    if ([DateTime]::UtcNow -gt $deadline) { $hung = $true; break }
  }
} finally {
  # the test installer first, with the processes it started (a cmd.exe running rd for McsRMDirR would otherwise go on
  # deleting in the kept work folder): it keeps its exe and results.txt open
  if ($run -and -not $run.HasExited) {
    $null = & taskkill.exe /T /F /PID $run.Id
    try { $run.Kill() } catch { }
    $null = $run.WaitForExit(10000)
  }
  # tonly first: reading the attributes of a folder in it needs the right to list tonly while the folder denies it.
  # (no 2>&1: Windows PowerShell 5.1 turns a redirected error line into an exception under "Stop")
  $null = & icacls.exe (Full "tonly") /remove:d $me
  $aclLeft = $LASTEXITCODE -ne 0
  foreach ($d in $noAttr) {
    $null = & icacls.exe (Full $d) /remove:d $me
    if ($LASTEXITCODE -ne 0) { $aclLeft = $true }
  }
  if ($aclLeft) { Write-Host "warning: a deny ACE in $(Full "tonly") was not removed (icacls /remove:d $me, tonly first)" }
}
if ($hung) {
  Write-Host "FAIL: the test installer did not finish within 120 seconds and was stopped (work folder kept: $work)"
  exit 2
}
if ($run.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $results)) {
  Write-Host "FAIL: the test installer exited with $($run.ExitCode) (work folder kept: $work)"
  exit 2
}

# ---- checks
$failures = New-Object System.Collections.Generic.List[string]
function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "ok   $what" } else { Write-Host "FAIL $what"; $failures.Add($what) }
}
$got = @{}
foreach ($line in [IO.File]::ReadAllText($results) -split "`r`n") {
  $i = $line.IndexOf("=")
  if ($i -gt 0) { $got[$line.Substring(0, $i)] = $line.Substring($i + 1) }
}
Check ($got["done"] -eq "1") "the test installer ran to the end"
$clean = [ordered]@{
  empty = ""; relative = ""; drive_root = ""; drive = ""; missing = "";
  trailing = "$work\data"; slashes = "$work\data"; case = "$work\DATA"; dotdot = $work; lookalike = "$work\Music"; japanese = "$work\$jp";
  windir = ""; profile = ""; users = ""; music = ""; documents = ""; appdata = "";
  unc_share = ""; unc_share_slashes = ""; unc_server = ""; unc_dir = "\\server\share\MCSYuE2"; unc_dir_slashes = "\\server\share\MCSYuE2";
  long_path = (Full $longFormer); short_name = "$work\data"; below_unlistable = "$work\tonly\sub\MCS";
  short_below_unlistable = "$work\tonly\sub\mcs_long_folder_name"; short_under_unlistable = "$work\tonly\mcs_long_folder_name"
}
if ($uncRoot) { $clean["unc_short_name"] = "$uncWork\data" }
# (the folders' own names decide: on a volume that makes no 8.3 names, an ancestor of the work folder may still have
# one, which McsLongNames makes long; the folder itself then has its long name and can be compared)
$noAttr83 = (Split-Path $aliasNoAttr -Leaf).Contains("~") -and (Split-Path $aliasNoAttrEmpty -Leaf).Contains("~")
$clean["unresolved"] = $(if ($noAttr83) { "" } else { Full "tonly\mcs_noattr_folder" })
if ($long83) { $clean["long_alias"] = Full $longSongRel }
$clean["junction_alias"] = "$work\tonly\link_to_target_folder"
if ($deepShort) {
  $clean["too_long_5"] = ""
  $clean["too_long_6"] = ""
} else {
  Write-Host "note: no 8.3 short names for the deep83 folders: the cases of long names too long for NSIS were skipped"
}
foreach ($k in $clean.Keys) { Check ($got[$k] -ceq $clean[$k]) "McsCleanPath $k -> '$($clean[$k])' (got '$($got[$k])')" }
if ($shortData -eq (Full "data")) { Write-Host "note: no 8.3 short names on this volume (short_name compared the long name)" }
$isDir = [ordered]@{
  isdir_long = "1"; isdir_slashes = "1"; isdir_file = "0"; isdir_missing = "0"; isdir_empty = "0";
  isdir_below_unlistable = "1"; isdir_unlistable = "0"; isdir_dangling = "0"; isdir_noattr = "1"
}
foreach ($k in $isDir.Keys) { Check ($got[$k] -eq $isDir[$k]) "McsIsDir $k -> $($isDir[$k]) (got '$($got[$k])')" }
$cleanInside = [ordered]@{ alias_root_inside = "1"; alias_out_inside = "1" }
foreach ($k in $cleanInside.Keys) { Check ($got[$k] -eq $cleanInside[$k]) "McsCleanPath then McsOutputInDataRoot $k -> $($cleanInside[$k]) (got '$($got[$k])')" }
$comfyOut = "$work\data\runtime\ComfyUI_windows_portable\ComfyUI\output"
$aliasComfyOut = "$work\tonly\mcs_data_root_folder\runtime\ComfyUI_windows_portable\ComfyUI\output"
# choice|named folder|cleaned data root|cleaned song folder|song folder there|data root there|kept
function Choice([string]$c, [string]$named, [string]$root, [string]$song, [int]$songThere, [int]$rootThere) { "$c|$named|$root|$song|$songThere|$rootThere|kept" }
$data = "$work\data"
$songs = "$work\songs"
$before = "$work\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before"
$aliasData = "$work\tonly\mcs_data_root_folder"
$music = [int](Test-Path -LiteralPath (Join-Path $env:USERPROFILE "Music") -PathType Container)
$choice = [ordered]@{
  choice_inside = Choice inside $comfyOut $data $comfyOut 1 1; choice_inside_first = Choice inside $comfyOut $data $comfyOut 1 1;
  choice_ask = Choice ask "" $data $songs 1 1; choice_music = Choice ask "" $data "" $music 1;
  choice_alias_root = Choice inside $aliasComfyOut $aliasData $aliasComfyOut 1 1; choice_alias_song = Choice inside $aliasComfyOut $aliasData $aliasComfyOut 1 1;
  choice_root_missing = Choice none "" "" $songs 1 0; choice_root_drive = Choice root "" "" $songs 1 1;
  choice_former = Choice former $before $data $songs 1 1; choice_former_outside = Choice ask "" $data $songs 1 1;
  choice_former_song_missing = Choice former $before $data "" 0 1; choice_former_song_music = Choice former $before $data "" $music 1;
  choice_former_song_drive = Choice former $before $data "" 1 1
}
if ($noAttr83) {
  $choice["choice_unknown"] = Choice unknown $aliasNoAttr $data "" 1 1
  $choice["choice_root_unknown"] = Choice root "" "" $songs 1 1
  $choice["choice_former_unknown"] = Choice "former?" $aliasNoAttr $data $songs 1 1
  $choice["choice_former_unknown_slash"] = Choice "former?" $aliasNoAttr $data $songs 1 1
  $choice["choice_former_unknown_empty"] = Choice ask "" $data $songs 1 1
  $choice["choice_both_unknown"] = Choice root "" "" "" 1 1
} else {
  Write-Host "note: no 8.3 short names for the tonly folders: the McsToolsChoice cases of names that cannot be compared were skipped"
  # visible in the CI run's summary, as the share path skip
  if ($env:GITHUB_ACTIONS) { Write-Host "::warning::nsis_hooks_test: no 8.3 short names on this volume, the cases of names that cannot be compared were skipped" }
}
if ($long83) {
  $choice["choice_long_alias"] = Choice inside (Full $longSongRel) (Full $longRoots[1]) (Full $longSongRel) 1 1
  $choice["choice_long_alias_ask"] = Choice ask "" $data (Full $longSongRel) 1 1
} else {
  Write-Host "note: no 8.3 short name for the folder below the long former song folder: its cases were skipped"
}
foreach ($k in $choice.Keys) { Check ($got[$k] -ceq $choice[$k]) "McsToolsChoice $k -> '$($choice[$k])' (got '$($got[$k])')" }
$unresolved = [ordered]@{ unresolved_alias = $(if ($noAttr83) { "1" } else { "0" }); resolved_alias = "0"; plain_path = "0" }
if ($deepShort) { $unresolved["too_long_unresolved"] = "1"; $isDirLong = $got["isdir_too_long"]; Check ($isDirLong -eq "1") "McsIsDir isdir_too_long -> 1 (got '$isDirLong')" }
foreach ($k in $unresolved.Keys) { Check ($got[$k] -eq $unresolved[$k]) "McsCleanUnsure after McsCleanPath $k -> $($unresolved[$k]) (got '$($got[$k])')" }
$inside = [ordered]@{
  in_comfy_output = "1"; is_portable = "1"; upper_case = "1"; is_mcs_output = "1"; in_llama = "1"; in_uploads = "1";
  mcs_lookalike = "0"; llama_lookalike = "0"; comfy_output = "0"; runtime_songs = "0"; root = "0"; root_songs = "0"; elsewhere = "0"
}
foreach ($k in $inside.Keys) { Check ($got[$k] -eq $inside[$k]) "McsOutputInDataRoot $k -> $($inside[$k]) (got '$($got[$k])')" }
$former = [ordered]@{
  former_inside = "$work\data\runtime\ComfyUI_windows_portable\ComfyUI"; former_uploads = "";
  former_outside = ""; former_gone = ""; former_empty = ""; former_slashes = "$work\data\runtime\ComfyUI_windows_portable\ComfyUI";
  former_placeholder = ""; former_songs = "$work\data\runtime\ComfyUI_windows_portable\ComfyUI\songs_before"; former_long = (Full $longFormer);
  former_unresolved = $(if ($noAttr83) { $aliasNoAttr } else { "" });
  former_unresolved_slash = $(if ($noAttr83) { $aliasNoAttr } else { "" }); former_unresolved_fwd = $(if ($noAttr83) { $aliasNoAttr } else { "" })
}
foreach ($k in $former.Keys) { Check ($got[$k] -ceq $former[$k]) "McsFormerInDataRoot $k -> '$($former[$k])' (got '$($got[$k])')" }
$unsure = $(if ($noAttr83) { "1" } else { "0" })
$formerUnsure = [ordered]@{ former_songs_unsure = "0"; former_gone_unsure = "0"; former_unresolved_unsure = $unsure; former_unresolved_slash_unsure = $unsure; former_unresolved_fwd_unsure = $unsure }
foreach ($k in $formerUnsure.Keys) { Check ($got[$k] -eq $formerUnsure[$k]) "McsFormerInDataRoot $k -> $($formerUnsure[$k]) (got '$($got[$k])')" }

Check (-not (Exists "rm\plain")) "McsRMDirR removes a tree"
Check (-not (Exists "rm\a % b & c ! d ^ e")) "McsRMDirR removes a folder named with % & ! ^"
Check ((-not (Exists "rm\link")) -and (Exists "outside\rm_target\keep.txt")) "McsRMDirR given a junction removes only the link"
Check (Exists "rm") "McsRMDirR leaves the parent"

foreach ($f in $dataGone) { Check (-not (Exists $f)) "McsDeleteDataRoot removes $f" }
foreach ($d in $dataGoneDirs) { Check (-not (Exists $d)) "McsDeleteDataRoot removes $d" }
foreach ($f in $dataKept) { Check (Exists $f) "McsDeleteDataRoot keeps $f" }
foreach ($f in $ownGone) { Check (-not (Exists $f)) "McsDeleteDataRoot removes the app's file $f" }
foreach ($f in $ownKept) { Check (Exists $f) "McsDeleteDataRoot keeps $f" }
Check ((Exists "$up\0123456789abcdef_linked.wav") -and (Exists "outside\uploads_target\keep.wav")) "McsDeleteDataRoot keeps a link named like a staged copy and its target"
Check (Exists "data") "McsDeleteDataRoot keeps a data root that still holds other files"
Check (-not (Exists "data2")) "McsDeleteDataRoot removes a data root left empty"
foreach ($f in $linkedKept) { Check (Exists $f) "McsDeleteDataRoot keeps $f behind a linked folder" }
Check (-not (Exists "data3")) "McsDeleteDataRoot removes the links on the way and the data root left empty"
foreach ($f in $ownLinkedKept) { Check (Exists $f) "McsDeleteDataRoot keeps $f behind a linked mcs_uploads / mcs_sep" }
Check (-not (Exists "data4")) "McsDeleteDataRoot removes the links at mcs_uploads and mcs_sep, the app's file next to them and the data root left empty"
foreach ($root in $longRoots) {
  $n = (Full $root).Length
  Check (-not (Exists "$root\comfy_input")) "McsDeleteDataRoot removes a staged copy more than MAX_PATH below a data root of $n characters, and the folders left empty"
  Check (-not (Exists $root)) "McsDeleteDataRoot removes the data root of $n characters left empty"
}
if ($uncRoot) {
  Check (-not (Exists "$uncRoot\comfy_input")) "McsDeleteDataRoot removes the app's files and the folders left empty below a share path of 238 characters"
  Check (-not (Exists $uncRoot)) "McsDeleteDataRoot unlinks a link more than MAX_PATH below a share path and removes the data root left empty"
  Check (Exists "outside\unc_ckpt_target\keep.pt") "McsDeleteDataRoot keeps what that link points to"
  Check ((-not (Exists "$rmLong\link")) -and (Exists "outside\rmlong_target\keep.txt")) "McsRMDirR given a link more than MAX_PATH below a share path removes only the link"
} else {
  Write-Host "note: $uncWork cannot be reached: the share path cases were skipped"
  # visible in the CI run's summary (the cases guard RemoveDirectoryW, which only a share path needs)
  if ($env:GITHUB_ACTIONS) { Write-Host "::warning::nsis_hooks_test: $uncWork cannot be reached, the share path cases were skipped" }
}

foreach ($f in $songsGone) { Check (-not (Exists $f)) "McsDeleteOutput removes $f" }
foreach ($d in $songsGoneDirs) { Check (-not (Exists $d)) "McsDeleteOutput removes $d" }
foreach ($f in $songsKept) { Check (Exists $f) "McsDeleteOutput keeps $f" }
Check (Exists "songs\separated") "McsDeleteOutput keeps separated\ while it holds other folders"
Check (-not (Exists $jp)) "McsDeleteOutput empties and removes a song folder with a Japanese name"

if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) check(s) failed (work folder kept: $work)"
  exit 1
}
if ($Keep) {
  Write-Host "all checks passed (work folder kept: $work)"
} else {
  $null = & cmd.exe /d /c rd /s /q (Long $work)
  Write-Host "all checks passed"
}
exit 0
