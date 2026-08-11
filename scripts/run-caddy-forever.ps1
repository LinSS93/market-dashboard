param(
  [string]$AppDir = (Split-Path -Parent $PSScriptRoot),
  [string]$CaddyExe = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\caddy.exe')
)

$ErrorActionPreference = 'Continue'
$logDir = Join-Path $AppDir 'logs'
$outLog = Join-Path $logDir 'caddy.log'
$errLog = Join-Path $logDir 'caddy.err.log'
$env:XDG_DATA_HOME = Join-Path $AppDir 'data\caddy'
$env:XDG_CONFIG_HOME = Join-Path $AppDir 'data\caddy-config'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path $env:XDG_DATA_HOME -Force | Out-Null
New-Item -ItemType Directory -Path $env:XDG_CONFIG_HOME -Force | Out-Null
Set-Location $AppDir

while ($true) {
  try {
    & $CaddyExe run --config (Join-Path $AppDir 'Caddyfile') --adapter caddyfile 1>> $outLog 2>> $errLog
    $exitCode = $LASTEXITCODE
    Add-Content -LiteralPath $errLog -Value "[$(Get-Date -Format s)] caddy exited with code $exitCode; restarting in 10 seconds"
  } catch {
    Add-Content -LiteralPath $errLog -Value "[$(Get-Date -Format s)] caddy launch failed: $($_.Exception.Message); restarting in 10 seconds"
  }
  Start-Sleep -Seconds 10
}
