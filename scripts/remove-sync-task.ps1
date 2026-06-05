$TaskName = 'SyncSupabaseVolumes'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Tarefa '$TaskName' removida."
} else {
  Write-Output "Tarefa '$TaskName' nao existe."
}
