param(
  [string]$AppDir = (Split-Path -Parent $PSScriptRoot),
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$ListenHost = '127.0.0.1'
)

$ErrorActionPreference = 'Continue'
$logDir = Join-Path $AppDir 'logs'
$outLog = Join-Path $logDir 'server.log'
$errLog = Join-Path $logDir 'server.err.log'
$env:DASHBOARD_HOST = $ListenHost
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Set-Location $AppDir

while ($true) {
  try {
    & $NodeExe (Join-Path $AppDir 'server.mjs') 1>> $outLog 2>> $errLog
    $exitCode = $LASTEXITCODE
    Add-Content -LiteralPath $errLog -Value "[$(Get-Date -Format s)] server exited with code $exitCode; restarting in 10 seconds"
  } catch {
    Add-Content -LiteralPath $errLog -Value "[$(Get-Date -Format s)] server launch failed: $($_.Exception.Message); restarting in 10 seconds"
  }
  Start-Sleep -Seconds 10
}
