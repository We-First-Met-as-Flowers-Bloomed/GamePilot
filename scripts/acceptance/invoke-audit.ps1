param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$Tool,
  [Parameter(Mandatory=$true)][string]$Data,
  [Parameter(Mandatory=$true)][string]$Out
)
$ErrorActionPreference = 'Stop'
# No game input, network or production writes. Quoted path arguments are passed
# directly to Node; do not interpolate user text into a shell command.
foreach ($path in @($NodePath,$Tool,$Data,$Out)) {
  if ($path.Contains('"') -or -not (Test-Path -LiteralPath $path)) { throw 'Invalid audit path' }
}
$arguments = @(('"'+$Tool+'"'),'--data',('"'+$Data+'"'),'--out',('"'+$Out+'"'))
$process = Start-Process -FilePath $NodePath -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $Out 'audit.stdout.log') -RedirectStandardError (Join-Path $Out 'audit.stderr.log')
exit $process.ExitCode
