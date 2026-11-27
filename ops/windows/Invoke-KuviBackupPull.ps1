$ErrorActionPreference = 'Stop'
$kuviRoot = $PSScriptRoot
$kuviExit = 1
$kuviStatus = @{ at = [DateTime]::UtcNow.ToString('o'); ok = $false; code = 'BACKUP_PULL_FAILED' }
try {
  $kuviResultText = & (Join-Path $env:ProgramFiles 'nodejs\node.exe') "$kuviRoot\backup-pull.mjs" "$kuviRoot\pull-config.json" 2>&1
  $kuviExit = $LASTEXITCODE
  try { $kuviResult = ($kuviResultText -join "`n") | ConvertFrom-Json } catch { $kuviResult = $null }
  if ($kuviExit -eq 0 -and $kuviResult.ok -eq $true) {
    $kuviStatus = @{ at = [DateTime]::UtcNow.ToString('o'); ok = $true;
        verified = $kuviResult.verified; copied = $kuviResult.copied }
  } elseif ($kuviResult.code -match '^[A-Z_]+$') {
    $kuviStatus.code = $kuviResult.code
  }
} catch { $kuviExit = 1 }
$kuviStatusText = $kuviStatus | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("$kuviRoot\last-pull.json", $kuviStatusText)
Write-Output $kuviStatusText
exit $kuviExit
