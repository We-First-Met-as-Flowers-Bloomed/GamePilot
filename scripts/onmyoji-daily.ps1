# Compatibility wakeup only. Time, weekdays and steps are owned by the App.
[CmdletBinding()]
param(
  [ValidateSet('morning','evening')][string]$Pass='morning',
  [switch]$DryRun,
  [string]$Data=(Join-Path $env:USERPROFILE '.gamepilot')
)
$ErrorActionPreference='Stop'
$nodeExe='D:\Node.js\node.exe'
if(-not(Test-Path -LiteralPath $nodeExe)){$nodeExe=(Get-Command node -ErrorAction Stop).Source}
$entry=Join-Path $PSScriptRoot 'onmyoji-app.mjs'
# Pass preserves old callers only; App selects saved due jobs and deduplicates them.
$mode=if($DryRun){'--status'}else{'--due'}
& $nodeExe $entry $mode --data $Data
exit $LASTEXITCODE
