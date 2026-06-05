$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

$LogDir = Join-Path $ProjectDir 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogFile = Join-Path $LogDir 'bot.log'

$EnvFile = Join-Path $ProjectDir '.env'
if (-not (Test-Path $EnvFile)) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Arquivo .env nao encontrado em $ProjectDir" |
    Out-File -FilePath $LogFile -Append -Encoding utf8
  throw "Arquivo .env nao encontrado em $ProjectDir"
}

function Resolve-NodeExe {
  if ($env:NODE_EXE -and (Test-Path $env:NODE_EXE)) {
    return $env:NODE_EXE
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    return $cmd.Source
  }

  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  throw "node.exe nao encontrado. Instale o Node.js para todos os usuarios ou defina NODE_EXE com o caminho do node.exe."
}

try {
  $NodeExe = Resolve-NodeExe
} catch {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Falha ao localizar node.exe: $_" |
    Out-File -FilePath $LogFile -Append -Encoding utf8
  throw
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Supervisor iniciado. PID=$PID Node=$NodeExe" |
  Out-File -FilePath $LogFile -Append -Encoding utf8

Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
}

while ($true) {
  $Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  "[${Timestamp}] Iniciando waha-bot.js" | Out-File -FilePath $LogFile -Append -Encoding utf8
  $PortInUse = $false

  try {
    & $NodeExe waha-bot.js 2>&1 | ForEach-Object {
      if ($_ -match 'A porta .* ja esta em uso' -or $_ -match 'EADDRINUSE') {
        $PortInUse = $true
      }

      $_ | Out-File -FilePath $LogFile -Append -Encoding utf8
      Write-Output $_
    }
  } catch {
    $ErrorTimestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[${ErrorTimestamp}] Erro: $_" | Out-File -FilePath $LogFile -Append -Encoding utf8

    if ("$_" -match 'A porta .* ja esta em uso' -or "$_" -match 'EADDRINUSE') {
      $PortInUse = $true
    }
  }

  if ($PortInUse) {
    $ExitTimestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    "[${ExitTimestamp}] Encerrando esta instancia para evitar duplicidade." | Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 1
  }

  $RestartTimestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  "[${RestartTimestamp}] Bot parou. Reiniciando em 10 segundos..." | Out-File -FilePath $LogFile -Append -Encoding utf8
  Start-Sleep -Seconds 10
}
