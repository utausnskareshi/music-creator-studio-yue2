# Capture the main app window (or the whole primary screen when no such process runs) to a PNG for visual checks.
# Usage: pwsh -File tools/screenshot.ps1 -Out C:\path\shot.png [-Title "Music Creator Studio YuE2"]
param(
  [string]$Out = "$env:TEMP\mcs_shot.png",
  [string]$Title = "Music Creator Studio YuE2",
  [int]$ProcessId = 0
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$proc = if ($ProcessId -gt 0) { Get-Process -Id $ProcessId -ErrorAction SilentlyContinue } else { Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Sort-Object StartTime -Descending | Select-Object -First 1 }
# a full-screen shot for a process that has exited could be mistaken for the app
if ($ProcessId -gt 0 -and -not $proc) { Write-Error "process $ProcessId not found (exited?)"; exit 1 }
if ($proc) {
  $h = $proc.MainWindowHandle
  # a found process without a usable window fails: a full-screen shot could be mistaken for the app
  if ($h -eq [IntPtr]::Zero) { Write-Error "process $($proc.Id) has no main window"; exit 1 }
  [Win32]::ShowWindow($h, 9) | Out-Null
  [Win32]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 400
  $r = New-Object Win32+RECT
  # a failed call, an empty rect or a window still minimized (-32000) would capture the wrong area
  if (-not [Win32]::GetWindowRect($h, [ref]$r) -or ($r.Right - $r.Left) -le 0 -or ($r.Bottom - $r.Top) -le 0 -or $r.Left -le -32000) { Write-Error "invalid window rect ($($r.Left),$($r.Top),$($r.Right),$($r.Bottom))"; exit 1 }
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
} else {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out (window found: $([bool]$proc))"
