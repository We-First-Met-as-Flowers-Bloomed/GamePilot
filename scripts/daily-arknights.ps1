# 兼容旧 Windows 任务名称；执行与时间配置统一归 App。
[CmdletBinding()]
param(
  [ValidateSet('all','a','b')][string]$Shift='all',
  [switch]$Evening,
  [switch]$DryRun,
  [switch]$Force,
  [string[]]$FallbackStages=@(),
  [ValidateRange(0,1)][int]$Retry=0,
  [switch]$NoFastBaseSwap,
  [ValidateSet('app','maa')][string]$ShiftBEngine='app',
  [string]$Data=(Join-Path $env:USERPROFILE '.gamepilot')
)
$ErrorActionPreference='Stop'
if($Shift -ne 'all' -or $Force -or $FallbackStages.Count -gt 0 -or $Retry -gt 0 -or $NoFastBaseSwap -or $ShiftBEngine -eq 'maa') {
  throw '方舟执行已统一到 App。请在 App 中保存账号、关卡和执行步骤；单计划可用 arknights-app.mjs --job <ID>。'
}
$nodeExe='D:\Node.js\node.exe'
if(-not(Test-Path -LiteralPath $nodeExe)){$nodeExe=(Get-Command node -ErrorAction Stop).Source}
$entry=Join-Path $PSScriptRoot 'arknights-app.mjs'
# Evening 仅保留旧任务兼容；应执行哪些计划由 App 自己的时间/星期/账本判断。
$mode=if($DryRun){'--status'}else{'--due'}
& $nodeExe $entry $mode --data $Data
exit $LASTEXITCODE