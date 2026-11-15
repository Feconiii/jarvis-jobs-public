# Scheduled LinkedIn send (2026-10-24): "any time within that window that laptop
# is on it sends it". The dashboard server does the sending, but nothing starts
# it at login. This registers the Windows task "Jarvis outreach send": at login
# and every 15 minutes it runs `node jarvis/send-outreach.mjs --ensure`, which
# starts the server ONLY when a scheduled send is waiting and the server is down,
# and does nothing otherwise. No window (conhost --headless).
#
# Run once:   powershell -ExecutionPolicy Bypass -File jarvis/install-send-task.ps1
# Remove:     Unregister-ScheduledTask -TaskName 'Jarvis outreach send' -Confirm:$false

$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless `"$node`" jarvis/send-outreach.mjs --ensure" -WorkingDirectory $repo
$atLogin = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$every15 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Jarvis outreach send' -Description 'Starts the Jarvis dashboard when a scheduled LinkedIn send is waiting (node jarvis/send-outreach.mjs --ensure). Does nothing otherwise.' -Action $action -Trigger $atLogin, $every15 -Settings $settings -Principal $principal -Force | Select-Object TaskName, State
