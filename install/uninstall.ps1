# Removes the desktop shortcut and launcher, and stops the app if it is running.
# Keeps your settings (~\.daily-dashboard\config.json) and your progress files.
# Usage: powershell -ExecutionPolicy Bypass -File install\uninstall.ps1
$appDir = Join-Path $env:USERPROFILE ".daily-dashboard"

# Stop a running instance through its own API (only it answers /api/ping this way).
try {
    $cfg = Get-Content (Join-Path $appDir "config.json") -Raw -ErrorAction Stop | ConvertFrom-Json
    $port = if ($cfg.port) { $cfg.port } else { 4317 }
} catch { $port = 4317 }
try {
    Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/quit" -Headers @{ "x-dd" = "1"; "Origin" = "http://127.0.0.1:$port" } -TimeoutSec 3 | Out-Null
    Write-Host "Stopped the running app."
} catch { }

$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Daily Dashboard.lnk"
foreach ($f in $lnk, (Join-Path $appDir "launch.vbs"), (Join-Path $appDir "icon.ico")) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "Removed $f" }
}
Write-Host "Kept settings and data in $appDir and your progress folder."
