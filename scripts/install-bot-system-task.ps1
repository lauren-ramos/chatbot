$ErrorActionPreference = 'Stop'

$TaskName = 'ChatbotWhatsApp24h'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$BotScript = Join-Path $ProjectDir 'scripts\start-bot.ps1'
$EnvFile = Join-Path $ProjectDir '.env'

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)

  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Execute este script em um PowerShell aberto como Administrador."
  }
}

function Resolve-NodeExe {
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

  throw "node.exe nao encontrado. Instale o Node.js para todos os usuarios antes de criar a tarefa 24h."
}

function Get-BotPort {
  if (-not (Test-Path $EnvFile)) {
    return 8787
  }

  $line = Get-Content $EnvFile | Where-Object { $_ -match '^\s*BOT_PORT\s*=' } | Select-Object -First 1
  if (-not $line) {
    return 8787
  }

  $value = ($line -split '=', 2)[1].Trim()
  $port = 0
  if ([int]::TryParse($value, [ref]$port)) {
    return $port
  }

  return 8787
}

Assert-Administrator

if (-not (Test-Path $BotScript)) {
  throw "Script do bot nao encontrado: $BotScript"
}

if (-not (Test-Path $EnvFile)) {
  throw "Arquivo .env nao encontrado em $ProjectDir"
}

$NodeExe = Resolve-NodeExe
$BotPort = Get-BotPort

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$botProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -match 'start-bot\.ps1' -or
    $_.CommandLine -match 'waha-bot\.js'
  }

foreach ($botProcess in $botProcesses) {
  Stop-Process -Id $botProcess.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "Processo antigo do bot encerrado: PID $($botProcess.ProcessId)."
}

Start-Sleep -Seconds 2

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `$env:NODE_EXE='$NodeExe'; & '$BotScript'" `
  -WorkingDirectory $ProjectDir

$trigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)

$principal = New-ScheduledTaskPrincipal `
  -UserId 'SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Mantem o bot WhatsApp WAHA rodando no boot como SYSTEM, mesmo sem usuario logado' `
  -Force | Out-Null

Write-Output "Tarefa '$TaskName' criada como SYSTEM."
Write-Output "Trigger: ao iniciar o Windows."
Write-Output "Node: $NodeExe"
Write-Output "Logs: $(Join-Path $ProjectDir 'logs\bot.log')"

Start-ScheduledTask -TaskName $TaskName
Write-Output "Tarefa '$TaskName' iniciada agora."
