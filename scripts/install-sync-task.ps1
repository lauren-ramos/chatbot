$ErrorActionPreference = 'Stop'

$TaskName = 'SyncSupabaseVolumes'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$SyncScript = Join-Path $ProjectDir 'scripts\run-sync.ps1'
$HiddenSyncScript = Join-Path $ProjectDir 'scripts\run-sync-hidden.vbs'

if (-not (Test-Path $SyncScript)) {
  throw "Script de sync nao encontrado: $SyncScript"
}

if (-not (Test-Path $HiddenSyncScript)) {
  throw "Script oculto de sync nao encontrado: $HiddenSyncScript"
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$HiddenSyncScript`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Atualiza tabela volumes_diarios no Supabase a cada 5 minutos' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output "Tarefa '$TaskName' criada e iniciada."
