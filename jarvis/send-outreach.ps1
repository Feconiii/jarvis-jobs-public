# SEND OUTREACH (2026-10-23): the desktop shortcut behind his send session.
# Opens Opera GX with its debugging port (restarting it if it is running
# without one; Opera brings his tabs back), then fills every saved, unsent
# message in its own tab. He looks each over and presses Send; each tab closes
# and is marked sent by itself. Nothing here presses Send.
# Afterwards he restarts Opera normally to close the port.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Opera = Join-Path $env:LOCALAPPDATA 'Programs\Opera GX\opera.exe'
$Port = 9222
$Host.UI.RawUI.WindowTitle = 'Send outreach'

function Test-Port {
  try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if (-not (Test-Port)) {
  if (Get-Process opera -ErrorAction SilentlyContinue) {
    Write-Host 'Restarting Opera with the outreach port (your tabs come back)...'
    # A polite close first, so Opera saves the session; forced only if it hangs.
    & taskkill.exe /IM opera.exe | Out-Null
    for ($i = 0; $i -lt 40 -and (Get-Process opera -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
    if (Get-Process opera -ErrorAction SilentlyContinue) { & taskkill.exe /F /IM opera.exe | Out-Null; Start-Sleep -Milliseconds 800 }
  } else {
    Write-Host 'Opening Opera with the outreach port...'
  }
  Start-Process -FilePath $Opera -ArgumentList "--remote-debugging-port=$Port"
  for ($i = 0; $i -lt 60 -and -not (Test-Port); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Port)) { Write-Host 'Opera did not open its port. Close Opera fully and run this again.'; Read-Host 'Enter to close'; exit 1 }
}

Write-Host 'Switch Opera to your Outreach workspace now; tabs open in the one on screen.'
Start-Sleep -Seconds 3
Set-Location $Root
& node jarvis\opera-fill.mjs --send @args
Write-Host ''
Read-Host 'Done. Enter to close (restart Opera normally later to close the port)'
