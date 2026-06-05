$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

$EnvFile = Join-Path $ProjectDir '.env'
if (-not (Test-Path $EnvFile)) {
  throw "Arquivo .env nao encontrado em $ProjectDir"
}

Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
}

node upload-to-supabase.js
