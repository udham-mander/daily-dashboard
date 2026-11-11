# Installs Daily Dashboard for the current Windows user:
#   - checks node / gh / claude
#   - writes %USERPROFILE%\.daily-dashboard\launch.vbs (starts the app with no console window)
#   - draws %USERPROFILE%\.daily-dashboard\icon.ico
#   - creates a "Daily Dashboard" shortcut on the desktop
# Usage: powershell -ExecutionPolicy Bypass -File install\install.ps1
$ErrorActionPreference = "Stop"

$repo   = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $env:USERPROFILE ".daily-dashboard"
New-Item -ItemType Directory -Force $appDir | Out-Null

# --- prerequisites ---
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js 20.11 or newer is required (node was not found on PATH)." }
$nodeVersion = (& $node --version).TrimStart("v")
if ([version]$nodeVersion -lt [version]"20.11.0") { throw "Node.js 20.11 or newer is required (found $nodeVersion)." }
if ($repo -match '"') { throw "The repository path must not contain a double quote: $repo" }
foreach ($tool in "gh", "claude") {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Warning "$tool was not found on PATH. The app still starts, but that data source will show an error."
    }
}

# --- launcher: wscript runs node hidden; the absolute node path avoids PATH differences ---
$vbs = Join-Path $appDir "launch.vbs"
@"
' Starts Daily Dashboard without a console window (created by install.ps1).
' Extra arguments are passed to app.js, e.g.: wscript launch.vbs --no-open
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$repo"
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
sh.Run """$node"" ""$repo\app.js""" & args, 0, False
"@ | Set-Content -Encoding Unicode $vbs   # UTF-16: safe for non-ASCII paths; wscript reads it

# --- icon: 256x256 PNG wrapped in an .ico container (supported since Windows Vista) ---
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = "AntiAlias"; $g.TextRenderingHint = "AntiAliasGridFit"
$g.Clear([System.Drawing.Color]::Transparent)
function RoundRect($x, $y, $w, $h, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, $r, $r, 180, 90); $p.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
    $p.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90); $p.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
    $p.CloseFigure(); return $p
}
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $size, $size), ([System.Drawing.Color]::FromArgb(47, 111, 222)), ([System.Drawing.Color]::FromArgb(110, 70, 210))
$g.FillPath($bg, (RoundRect 8 8 240 240 64))
# a checklist: three rows, first two ticked
$white = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 14
$white.StartCap = "Round"; $white.EndCap = "Round"; $white.LineJoin = "Round"
$soft = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 255, 255, 255)), 14
$soft.StartCap = "Round"; $soft.EndCap = "Round"
foreach ($i in 0..2) {
    $y = 74 + $i * 56
    if ($i -lt 2) { $g.DrawLines($white, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 58, $y), (New-Object System.Drawing.Point 72, ($y + 14)), (New-Object System.Drawing.Point 98, ($y - 14)))) }
    else { $g.DrawEllipse($white, 62, ($y - 14), 28, 28) }
    $g.DrawLine($soft, 124, $y, 198, $y)
}
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
$png = $ms.ToArray()
$ico = Join-Path $appDir "icon.ico"
$fs = [System.IO.File]::Create($ico); $w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)          # ICONDIR: reserved, type=icon, count=1
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)  # 256x256 (0 = 256), no palette
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png); $w.Close()

# --- desktop shortcut ---
$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = Join-Path $desktop "Daily Dashboard.lnk"
$sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$sc.Arguments = "`"$vbs`""
$sc.WorkingDirectory = $repo
$sc.IconLocation = "$ico,0"
$sc.Description = "Open Jira issues, PRs and review requests, with daily notes"
$sc.Save()

Write-Host "Installed."
Write-Host "  Shortcut : $lnk"
Write-Host "  Launcher : $vbs"
Write-Host "  Config   : $appDir\config.json (created on first start — then set jira.site and restart)"
Write-Host "  Node     : $node"
