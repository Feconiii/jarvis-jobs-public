# jarvis/register-daily-search.ps1 — install the daily job search task (run once).
#
# Creates "Jarvis Daily Job Search": every day at 7:30 AM, or as soon as the
# laptop is on if it was off or asleep then, it runs jarvis/daily-search.ps1
# hidden. Remove it with:
#   Unregister-ScheduledTask -TaskName 'Jarvis Daily Job Search' -Confirm:$false

$script = Join-Path $PSScriptRoot 'daily-search.ps1'
$repo = Split-Path -Parent $PSScriptRoot

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" `
  -WorkingDirectory $repo
# 5:10 PM too: the enricher's per-site allowance resets at midnight UTC
# (5 PM Pacific), and the postings paced out earlier are what the search waits on.
$trigger = @(
  (New-ScheduledTaskTrigger -Daily -At 7:30am),
  (New-ScheduledTaskTrigger -Daily -At 5:10pm)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'Jarvis Daily Job Search' -Force `
  -Description 'Daily job search: reads new postings until 20 new picks are filed or the inbox reaches 50. Log: data\jarvis\daily-search.log' `
  -Action $action -Trigger $trigger -Settings $settings | Out-Null

Get-ScheduledTask -TaskName 'Jarvis Daily Job Search' | Get-ScheduledTaskInfo |
  Select-Object TaskName, NextRunTime
