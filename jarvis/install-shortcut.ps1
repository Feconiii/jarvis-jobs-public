# jarvis/install-shortcut.ps1 — put a "Jarvis Jobs" shortcut on the Desktop.
#
# Run:  powershell -ExecutionPolicy Bypass -File jarvis\install-shortcut.ps1
# or:   npm run jarvis:shortcut
#
# Re-running is safe: it overwrites the existing shortcut in place.
# Pass -Remove to delete it.

param(
  [switch]$Remove,
  [string]$Name = 'Jarvis Jobs'
)

$ErrorActionPreference = 'Stop'

$repo    = Split-Path -Parent $PSScriptRoot
$target  = Join-Path $PSScriptRoot 'launch-jarvis.cmd'
$icon    = Join-Path $PSScriptRoot 'assets\jarvis.ico'
# [Environment]::GetFolderPath follows a redirected Desktop (OneDrive), which a
# hardcoded $env:USERPROFILE\Desktop would miss.
$desktop = [Environment]::GetFolderPath('Desktop')
$link    = Join-Path $desktop "$Name.lnk"

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Force; Write-Host "Removed $link" }
  else { Write-Host "Nothing to remove - no shortcut at $link" }
  exit 0
}

if (-not (Test-Path $target)) { throw "Launcher not found: $target" }

$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath       = $target
$shortcut.WorkingDirectory = $repo
$shortcut.Description      = 'Open the Jarvis Jobs dashboard'
$shortcut.WindowStyle      = 7          # start minimized - the browser is the UI
if (Test-Path $icon) { $shortcut.IconLocation = $icon }
$shortcut.Save()

Write-Host "Shortcut created: $link"
Write-Host "  -> $target"
