$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $PSScriptRoot
$SystemInstaller = Join-Path $PSScriptRoot 'install-bot-system-task.ps1'
$BotScript = Join-Path $PSScriptRoot 'start-bot.ps1'
$StartupScript = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatbotWhatsApp24h.cmd'

if (-not (Test-Path $SystemInstaller)) {
  throw "Instalador da tarefa de boot nao encontrado: $SystemInstaller"
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (Test-Administrator) {
  & $SystemInstaller
  exit 0
}

try {
  Write-Output 'Solicitando permissao de Administrador para instalar a inicializacao no boot...'
  $process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$SystemInstaller`"" `
    -WorkingDirectory $ProjectDir `
    -Verb RunAs `
    -Wait `
    -PassThru

  if ($process.ExitCode -ne 0) {
    throw "O instalador elevado terminou com codigo $($process.ExitCode)."
  }

  if (Test-Path $StartupScript) {
    Remove-Item -LiteralPath $StartupScript -Force
  }

  Write-Output "Tarefa de boot instalada com sucesso."
} catch {
  $cmd = "@echo off`r`nstart `"ChatbotWhatsApp24h`" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$BotScript`"`r`n"
  Set-Content -LiteralPath $StartupScript -Value $cmd -Encoding ASCII

  Write-Warning "Nao foi possivel instalar a tarefa de boot: $_"
  Write-Output "Fallback criado para iniciar apos o login: $StartupScript"
  Write-Output "Para iniciar antes do login, execute este instalador e aceite a solicitacao de Administrador."
}

Write-Output "Logs: $(Join-Path $ProjectDir 'logs\bot.log')"
