# jarvis/daily-search.ps1 — the daily job search (2026-10-26).
#
# Run by the scheduled task "Jarvis Daily Job Search" (register-daily-search.ps1).
# Reads new postings in batches until 20 new picks are in his inbox, or enough
# to bring it to 50, whichever is more. Below-normal priority: he games on this
# machine. Output appended to data\jarvis\daily-search.log.

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo 'data\jarvis\daily-search.log'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" | Out-File -FilePath $log -Append -Encoding utf8
# The outcome log the health alarm reads (F-986): counted before the run, so a
# run killed outright (out of memory, no exit handler) still leaves a line.
$outcomes = Join-Path $repo 'data\jarvis\curate-daily.jsonl'
$before = 0
if (Test-Path $outcomes) { $before = @([IO.File]::ReadAllLines($outcomes)).Count }
# --topup: up to his dashboard setting (default 10) more fits each scheduled run,
# even with a full inbox (approved 2026-11-03).
$p = Start-Process -FilePath $node -ArgumentList 'jarvis/curate.mjs', '--daily', '--want', '20', '--target', '50', '--topup' `
  -WorkingDirectory $repo -NoNewWindow -PassThru `
  -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
$null = $p.Handle   # held now, or ExitCode reads empty after the exit
try { $p.PriorityClass = 'BelowNormal' } catch {}
$p.WaitForExit()
$after = 0
if (Test-Path $outcomes) { $after = @([IO.File]::ReadAllLines($outcomes)).Count }
if ($after -le $before) {
  $line = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); error = "the run ended with exit code $($p.ExitCode) and wrote no outcome (killed?)"; code = $p.ExitCode; pid = $p.Id } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($outcomes, "$line`n")
}
# Node writes UTF-8; read it as UTF-8 (the log showed "â€”" for every dash).
Get-Content "$log.out", "$log.err" -Encoding utf8 -ErrorAction SilentlyContinue | Out-File -FilePath $log -Append -Encoding utf8
Remove-Item "$log.out", "$log.err" -ErrorAction SilentlyContinue
