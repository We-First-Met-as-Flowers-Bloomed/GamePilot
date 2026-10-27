# 修复两个方舟日常计划任务的电源设置（这是 2026-10-20 早班没跑的根因）
#   1) DisallowStartIfOnBatteries = false   —— 不再"仅交流电时启动"（0x800710E0 的直接原因）
#   2) StopIfGoingOnBatteries    = false   —— 改用电池时不停止
#   3) WakeToRun                 = true    —— 睡眠时**唤醒计算机**执行
#   4) StartWhenAvailable        = true    —— 错过时间后补跑（原本就是 true，保留）
# 会先把原 XML 备份到 artifacts\task-backup\，改动仅限上述四项。
$ErrorActionPreference = 'Stop'
$backupDir = 'D:\Desktop\yys\artifacts\task-backup'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$tasks = @('GamePilot-Arknights-Daily-0800', 'GamePilot-Arknights-Daily-2000')
$ns = 'http://schemas.microsoft.com/windows/2004/02/mit/task'

foreach ($tn in $tasks) {
  $raw = (& schtasks /query /tn $tn /xml) -join "`n"
  $backup = Join-Path $backupDir ($tn + '.xml')
  $raw | Set-Content -Path $backup -Encoding UTF8
  Write-Output "=== $tn ==="
  Write-Output ("  原 XML 已备份: " + $backup)

  $xml = [xml]$raw
  $nsm = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
  $nsm.AddNamespace('t', $ns)

  function Set-Setting($xml, $nsm, $name, $value) {
    $node = $xml.SelectSingleNode('//t:Settings/t:' + $name, $nsm)
    if ($null -eq $node) {
      $settings = $xml.SelectSingleNode('//t:Settings', $nsm)
      $node = $xml.CreateElement($name, $ns)
      [void]$settings.AppendChild($node)
    }
    $node.InnerText = $value
  }

  Set-Setting $xml $nsm 'DisallowStartIfOnBatteries' 'false'
  Set-Setting $xml $nsm 'StopIfGoingOnBatteries' 'false'
  Set-Setting $xml $nsm 'WakeToRun' 'true'
  Set-Setting $xml $nsm 'StartWhenAvailable' 'true'

  $tmp = Join-Path $env:TEMP ('task-' + [guid]::NewGuid().ToString('N') + '.xml')
  $xml.Save($tmp)
  & schtasks /create /tn $tn /xml $tmp /f 2>&1 | Select-Object -First 1
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue

  $check = & schtasks /query /tn $tn /v /fo LIST 2>&1 | Select-String -Pattern 'Power Management' | ForEach-Object { $_.Line.Trim() }
  Write-Output ("  改后电源设置: " + ($check -join ' '))
}
Write-Output '=== 完成 ==='
