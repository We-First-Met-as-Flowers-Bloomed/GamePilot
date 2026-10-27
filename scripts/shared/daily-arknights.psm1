# Pure round evidence and scoped process helpers. This module never acts on import.
$script:DailyTopTasks = @('开始唤醒', '理智作战', '自动公招', '信用收支', '领取奖励', '基建换班')

function Get-DailyRoundProgress([AllowEmptyString()][string]$Baseline, [AllowEmptyString()][string]$Current) {
  if (-not $Current.StartsWith($Baseline, [StringComparison]::Ordinal)) {
    return [pscustomobject]@{ Completed=0; Failed=0; Terminal=$false; Succeeded=$false; Unknown=$true }
  }
  $suffix = $Current.Substring($Baseline.Length)
  $done = @{}
  $failed = @{}
  foreach ($line in ($suffix -split "`r?`n")) {
    $match = [regex]::Match($line, '(完成任务|任务出错):\s*(.+?)\s*$')
    if (-not $match.Success) { continue }
    $name = $match.Groups[2].Value.Trim()
    if ($script:DailyTopTasks -notcontains $name) { continue }
    if ($match.Groups[1].Value -eq '任务出错') { $failed[$name] = $true; $done.Remove($name) }
    elseif (-not $failed.ContainsKey($name)) { $done[$name] = $true }
  }
  $terminal = ($suffix -match '任务已全部完成') -or (($done.Count + $failed.Count) -eq $script:DailyTopTasks.Count)
  return [pscustomobject]@{ Completed=$done.Count; CompletedTasks=@($done.Keys); Failed=$failed.Count; Terminal=$terminal; Succeeded=($done.Count -eq $script:DailyTopTasks.Count -and $failed.Count -eq 0); Unknown=$false }
}

function Get-DailyNativeRound($Record, [string]$Lane, [string[]]$Skills, [datetime]$StartedAt, [int]$ExitCode) {
  $unknown = [pscustomobject]@{ Succeeded=$false; Unknown=$true }
  if ($ExitCode -ne 0 -or $null -eq $Record -or $Record.lane -ne $Lane -or $Record.game -ne 'arknights') { return $unknown }
  try {
    $start = [datetimeoffset]::Parse([string]$Record.startedAt).UtcDateTime
    $finish = [datetimeoffset]::Parse([string]$Record.finishedAt).UtcDateTime
    if ($start -lt $StartedAt.ToUniversalTime() -or $finish -lt $start -or $finish -gt [datetime]::UtcNow.AddSeconds(5)) { return $unknown }
    $outcomes = @($Record.outcomes)
    if ($outcomes.Count -ne $Skills.Count) { return $unknown }
    foreach ($skill in $Skills) {
      $matches = @($outcomes | Where-Object { $_.skill -eq $skill })
      if ($matches.Count -ne 1 -or $matches[0].status -ne 'succeeded' -or $matches[0].arknights.completion -ne 'native-confirmed') { return $unknown }
      if ($skill -eq 'login') {
        $login = $matches[0].arknights.login
        if ([string]::IsNullOrWhiteSpace([string]$login.expectedUid) -or $login.expectedUid -cne $login.observedUid -or $login.home -ne $true) { return $unknown }
      }
    }
    return [pscustomobject]@{ Succeeded=$true; Unknown=$false }
  } catch { return $unknown }
}

function Resolve-DailyUnknownMarker([string]$Path, $Evidence) {
  $marker = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ($marker.ownerPid -ne $PID -or $marker.status -ne 'unknown') { throw '未确认标记不属于本轮，保留原记录' }
  $resolution = [pscustomobject]@{ action='verified'; at=[datetime]::UtcNow.ToString('o'); evidence=$Evidence }
  $marker | Add-Member -NotePropertyName resolution -NotePropertyValue $resolution -Force
  $archive = $Path + '.resolved-' + [guid]::NewGuid().ToString('N') + '.json'
  $marker | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $archive -Encoding UTF8 -ErrorAction Stop
  Remove-Item -LiteralPath $Path -ErrorAction Stop
  return $archive
}

function Test-DailyProcessIdentity($Expected, $Actual) {
  if ($null -eq $Expected -or $null -eq $Actual) { return $false }
  try {
    return ($Expected.Id -gt 0 -and $Expected.Id -eq $Actual.Id -and
      -not [string]::IsNullOrWhiteSpace($Expected.Path) -and
      [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Expected.Path), [IO.Path]::GetFullPath($Actual.Path)) -and
      ([datetime]$Expected.StartTime).Ticks -eq ([datetime]$Actual.StartTime).Ticks)
  } catch { return $false }
}

function Get-DailyProcessIdentity($Process) {
  if ($null -eq $Process) { throw 'Cannot prove process ownership without a process receipt' }
  try { $identity = [pscustomobject]@{ Id=[int]$Process.Id; Path=[string]$Process.Path; StartTime=$Process.StartTime } }
  catch { throw 'Cannot inspect process identity; preserve the scene' }
  if (-not (Test-DailyProcessIdentity $identity $identity)) { throw 'Invalid process identity; preserve the scene' }
  return $identity
}

function Get-DailyOwnedProcess($Expected) {
  try { $found = @(Get-Process -Id $Expected.Id -ErrorAction Stop) }
  catch {
    if ($_.CategoryInfo.Category -eq [Management.Automation.ErrorCategory]::ObjectNotFound) { return $null }
    throw
  }
  if ($found.Count -eq 0) { return $null }
  if ($found.Count -ne 1 -or -not (Test-DailyProcessIdentity $Expected $found[0])) { throw 'Process identity changed or is unknown; refuse to close it' }
  return $found[0]
}

function Close-DailyOwnedProcess($Expected, [int]$TimeoutSeconds = 90) {
  $process = Get-DailyOwnedProcess $Expected
  if ($null -eq $process) { return }
  $process.CloseMainWindow() | Out-Null
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($null -eq (Get-DailyOwnedProcess $Expected)) { return }
    Start-Sleep -Seconds 3
  }
  $process = Get-DailyOwnedProcess $Expected
  if ($null -ne $process) { Stop-Process -InputObject $process -Force -ErrorAction Stop }
  if ($null -ne (Get-DailyOwnedProcess $Expected)) { throw 'Managed MAA exit is unconfirmed; preserve the scene' }
}

function Enter-DailyLock([string]$Path) {
  $stream = $null
  try {
    try { $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      # An open live lock cannot be inspected or stolen. A closed lock may be reused
      # only when its recorded PID is definitively absent (never on TTL alone).
      $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 1024, $true)
      try { $prior = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop } finally { $reader.Dispose() }
      if ($null -eq $prior.pid -or [int]$prior.pid -le 0 -or -not $prior.startedAt -or -not $prior.token) { throw 'Legacy/unknown lock owner requires manual inspection' }
      $ownerAlive = $true
      try { Get-Process -Id ([int]$prior.pid) -ErrorAction Stop | Out-Null }
      catch {
        if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw }
        $ownerAlive = $false
      }
      if ($ownerAlive) { throw 'Daily lock owner is still alive' }
    }
    $process = Get-Process -Id $PID -ErrorAction Stop
    $token = [guid]::NewGuid().ToString('N')
    $owner = @{ pid=$PID; startedAt=$process.StartTime.ToUniversalTime().ToString('o'); token=$token }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($owner | ConvertTo-Json -Compress))
    $stream.SetLength(0); $stream.Position = 0; $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
    return [pscustomobject]@{ Stream=$stream; Path=$Path; Token=$token }
  } catch {
    if ($null -ne $stream) { $stream.Dispose() }
    throw
  }
}

function Exit-DailyLock($Lock) {
  if ($null -eq $Lock) { return }
  # Keep our live PID in the record until deletion: contenders cannot reclaim it.
  $Lock.Stream.Dispose()
  Remove-Item -LiteralPath $Lock.Path -ErrorAction Stop
}

Export-ModuleMember -Function Get-DailyRoundProgress, Get-DailyNativeRound, Resolve-DailyUnknownMarker, Test-DailyProcessIdentity, Get-DailyProcessIdentity, Get-DailyOwnedProcess, Close-DailyOwnedProcess, Enter-DailyLock, Exit-DailyLock
