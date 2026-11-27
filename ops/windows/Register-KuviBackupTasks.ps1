param([switch]$VerifyOnly)
$ErrorActionPreference='Stop'
$kuviRoot=$PSScriptRoot
foreach($kuviRequired in @('monitor-config.json','Invoke-KuviBackupWatch.ps1')){
  if(-not (Test-Path -LiteralPath (Join-Path $kuviRoot $kuviRequired) -PathType Leaf)){throw 'Install scripts and private configurations in the operator backup folder first.'}
}
$kuviMonitorConfig=Get-Content -LiteralPath (Join-Path $kuviRoot 'monitor-config.json') -Raw | ConvertFrom-Json
$kuviDirectNas=$kuviMonitorConfig.nasMode -eq 'server-direct'
if(-not $kuviDirectNas){
  foreach($kuviRequired in @('nas-pull-config.json','Invoke-KuviBackupNasPull.ps1')){
    if(-not (Test-Path -LiteralPath (Join-Path $kuviRoot $kuviRequired) -PathType Leaf)){throw 'Install private NAS pull configuration and script first.'}
  }
}
$kuviUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$kuviExecutable=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$kuviPrincipal=New-ScheduledTaskPrincipal -UserId $kuviUser -LogonType Interactive -RunLevel Limited
$kuviDefinitions=@(
  @{Name='Kuvi-DatabaseBackup-NasPull';Script='Invoke-KuviBackupNasPull.ps1';Minute=38;Limit=20;Network=$true;Hours=12;Hour=3;Logon=$false},
  @{Name='Kuvi-DatabaseBackup-Watch';Script='Invoke-KuviBackupWatch.ps1';Minute=45;Limit=5;Network=$false;Hours=1;Logon=$true}
)
foreach($kuviDefinition in $kuviDefinitions){
  if($kuviDirectNas -and $kuviDefinition.Name -eq 'Kuvi-DatabaseBackup-NasPull'){
    $kuviRetired=Get-ScheduledTask -TaskName $kuviDefinition.Name -ErrorAction SilentlyContinue
    if($kuviRetired -and $kuviRetired.State -ne 'Disabled'){throw 'Disable the Windows NAS transfer after verifying the direct server copy.'}
    Write-Output 'NAS transfer runs directly on Ubuntu; Windows NAS task is retired.'
    continue
  }
  $kuviArgument='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $kuviRoot $kuviDefinition.Script)+'"'
  $kuviExisting=Get-ScheduledTask -TaskName $kuviDefinition.Name -ErrorAction SilentlyContinue
  if($kuviExisting){
    if($kuviExisting.Actions.Count -ne 1 -or $kuviExisting.Actions[0].Execute -ne $kuviExecutable -or $kuviExisting.Actions[0].Arguments -ne $kuviArgument -or $kuviExisting.Principal.RunLevel -ne 'Limited' -or $kuviExisting.Principal.LogonType -ne 'Interactive'){throw 'Existing task differs from the expected action or privilege level; review it before changing anything.'}
    Write-Output ($kuviDefinition.Name+': existing task verified')
    continue
  }
  if($VerifyOnly){throw 'Expected backup task is missing.'}
  $kuviNow=Get-Date
  $kuviHour=if($kuviDefinition.ContainsKey('Hour')){$kuviDefinition.Hour}else{$kuviNow.Hour}
  $kuviAt=$kuviNow.Date.AddHours($kuviHour).AddMinutes($kuviDefinition.Minute)
  while($kuviAt -le $kuviNow){$kuviAt=$kuviAt.AddHours($kuviDefinition.Hours)}
  $kuviTriggers=@((New-ScheduledTaskTrigger -Once -At $kuviAt -RepetitionInterval (New-TimeSpan -Hours $kuviDefinition.Hours)))
  if($kuviDefinition.Logon){$kuviTriggers+=(New-ScheduledTaskTrigger -AtLogOn -User $kuviUser)}
  $kuviSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $kuviDefinition.Limit) -RunOnlyIfNetworkAvailable:$kuviDefinition.Network
  $kuviAction=New-ScheduledTaskAction -Execute $kuviExecutable -Argument $kuviArgument
  Register-ScheduledTask -TaskName $kuviDefinition.Name -Action $kuviAction -Trigger $kuviTriggers -Principal $kuviPrincipal -Settings $kuviSettings -Description 'Kuvi encrypted backup transfer or independent local observer. No credentials in task arguments.' | Out-Null
  Write-Output ($kuviDefinition.Name+': registered')
}
