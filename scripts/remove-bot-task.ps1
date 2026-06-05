$TaskName = 'ChatbotWhatsApp24h'
$StartupScript = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatbotWhatsApp24h.cmd'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Tarefa '$TaskName' removida."
} else {
  Write-Output "Tarefa '$TaskName' nao existe."
}

if (Test-Path $StartupScript) {
  Remove-Item -Path $StartupScript -Force
  Write-Output "Inicializacao automatica removida: $StartupScript"
}
