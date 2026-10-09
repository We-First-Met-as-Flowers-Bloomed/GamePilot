param([Parameter(Mandatory=$true)][string]$Out)
$ErrorActionPreference = 'Stop'
$auditRoot = (Resolve-Path -LiteralPath $Out).Path
$baseline = Get-Content -LiteralPath (Join-Path $auditRoot 'baseline.json') -Raw | ConvertFrom-Json
$start = [datetime]::ParseExact($baseline.start,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
$end = [datetime]::ParseExact($baseline.end,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture)
if (($end-$start).Days -ne 6 -or [TimeZoneInfo]::Local.BaseUtcOffset.TotalHours -ne 8) { throw 'Expected seven days in UTC+8' }
$taskName = 'GamePilot-Acceptance-' + $start.ToString('yyyyMMdd')
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'An observation task already exists; inspect it before changing it' }
$node = (Get-Command node.exe).Source
$tool = Join-Path $auditRoot 'audit.cjs'
$launcher = Join-Path $auditRoot 'invoke-audit.ps1'
if (-not (Test-Path -LiteralPath $tool)) { throw 'Build and copy the standalone audit tool first' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'invoke-audit.ps1') -Destination $launcher
foreach($path in @($auditRoot,$baseline.data,$node,$tool,$launcher)) { if($path.Contains('"')) {throw 'Invalid path'} }
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$launcher+'" -NodePath "'+$node+'" -Tool "'+$tool+'" -Data "'+$baseline.data+'" -Out "'+$auditRoot+'"'
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument $arguments -WorkingDirectory $auditRoot
$triggers = @(2,11) | ForEach-Object {
  $trigger = New-ScheduledTaskTrigger -Daily -At $start.AddHours($_)
  $trigger.StartBoundary = $start.AddHours($_).ToString('s')
  $trigger.EndBoundary = $end.AddDays(1).AddSeconds(-1).ToString('s')
  $trigger
}
# The final day's 20:00 round has no following daily collection inside the
# observation window. Collect it once the next morning, without starting games.
$finalAt = $end.AddDays(1).AddHours(2)
$finalTrigger = New-ScheduledTaskTrigger -Once -At $finalAt
$finalTrigger.StartBoundary = $finalAt.ToString('s')
$finalTrigger.EndBoundary = $end.AddDays(2).AddSeconds(-1).ToString('s')
$triggers += $finalTrigger
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DeleteExpiredTaskAfter (New-TimeSpan -Days 1)
# Keep this UTF-8 script ASCII so Windows PowerShell 5.1 also parses it without a BOM.
$task = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'GamePilot seven-day read-only audit: daily 02:00/11:00 and one final 02:00 collection after the window; no game launch or computer wake.'
Register-ScheduledTask -TaskName $taskName -InputObject $task | Select-Object TaskName,State
