$ErrorActionPreference='Stop'
$kuviRoot=$PSScriptRoot
$kuviExit=1
$kuviStatus=@{at=[DateTime]::UtcNow.ToString('o');ok=$false;code='NAS_PULL_FAILED'}
try{
  $kuviRaw=& (Join-Path $env:ProgramFiles 'nodejs\node.exe') "$kuviRoot\backup-pull.mjs" "$kuviRoot\nas-pull-config.json" 2>&1
  $kuviExit=$LASTEXITCODE
  $kuviResult=($kuviRaw -join "`n") | ConvertFrom-Json
  if($kuviExit -eq 0 -and $kuviResult.ok -eq $true){$kuviStatus=@{at=[DateTime]::UtcNow.ToString('o');ok=$true;verified=$kuviResult.verified;copied=$kuviResult.copied}}
}catch{$kuviExit=1}
[IO.File]::WriteAllText("$kuviRoot\last-nas-pull.json",($kuviStatus | ConvertTo-Json -Compress))
Write-Output ($kuviStatus | ConvertTo-Json -Compress)
exit $kuviExit
