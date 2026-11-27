param([switch]$TestNotification)
$ErrorActionPreference = 'Stop'
$kuviRoot=$PSScriptRoot
$kuviResult=$null
$kuviExit=1
if ($TestNotification) {
  $kuviExit=0
  $kuviResult=[pscustomobject]@{ok=$true;notification='test';codes=@()}
} else {
  try {
    $kuviRaw=& (Join-Path $env:ProgramFiles 'nodejs\node.exe') "$kuviRoot\backup-observer.mjs" "$kuviRoot\monitor-config.json" 2>&1
    $kuviExit=$LASTEXITCODE
    $kuviResult=($kuviRaw -join "`n") | ConvertFrom-Json
    if($kuviExit -eq 1 -or -not $kuviResult.checkedAt){
      $kuviResult=[pscustomobject]@{ok=$false;notification='problem';codes=@('OBSERVER_EXECUTION_FAILED')}
    }
  } catch { $kuviResult=[pscustomobject]@{ok=$false;notification='problem';codes=@('OBSERVER_EXECUTION_FAILED')} }
}
if($kuviResult.notification){
  try {
    $kuviAppId='Kuvi.Backup.Observer'
    $kuviAppKey="HKCU:\Software\Classes\AppUserModelId\$kuviAppId"
    New-Item -Path $kuviAppKey -Force | Out-Null
    New-ItemProperty -Path $kuviAppKey -Name DisplayName -Value 'Respaldos de Kuvi' -PropertyType String -Force | Out-Null
    [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null
    $kuviMessage=if($TestNotification){'Prueba de avisos de Kuvi. No se ha detectado un fallo.'}elseif($kuviResult.ok){'Los respaldos vuelven a estar al día.'}else{'Hay un problema con el respaldo o su copia. Revisa el estado de respaldos de Kuvi.'}
    $kuviXml=[Windows.Data.Xml.Dom.XmlDocument]::new()
    $kuviXml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>Respaldos de Kuvi</text><text>$kuviMessage</text></binding></visual></toast>")
    $kuviToast=[Windows.UI.Notifications.ToastNotification]::new($kuviXml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($kuviAppId).Show($kuviToast)
    if(-not $TestNotification -and (Test-Path -LiteralPath "$kuviRoot\backup-monitor-status.json")){
      $kuviState=Get-Content -LiteralPath "$kuviRoot\backup-monitor-status.json" -Raw | ConvertFrom-Json
      $kuviState.lastNotifiedAt=[DateTime]::UtcNow.ToString('o')
      $kuviState.lastNotifiedCodes=$kuviState.codes
      $kuviTemp="$kuviRoot\notification-$([Guid]::NewGuid().ToString('N')).part"
      [IO.File]::WriteAllText($kuviTemp,($kuviState | ConvertTo-Json -Compress))
      Move-Item -LiteralPath $kuviTemp -Destination "$kuviRoot\backup-monitor-status.json" -Force
    }
    Write-Output 'Windows notification submitted; delivery depends on Windows notification settings.'
  } catch { Write-Output 'WINDOWS_NOTIFICATION_FAILED';$kuviExit=1 }
}
if($TestNotification){exit $kuviExit}
Write-Output ($kuviResult | ConvertTo-Json -Compress)
exit $kuviExit
