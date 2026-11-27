param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$kuviDestination = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $kuviDestination -PathType Container)) { throw 'Choose an existing external recovery folder.' }
$kuviResolvedDestination = (Resolve-Path -LiteralPath $kuviDestination).ProviderPath
if ($kuviResolvedDestination.TrimEnd('\') -ne $kuviDestination.TrimEnd('\')) { throw 'Use the resolved absolute destination path.' }
$kuviAncestor = [System.IO.DirectoryInfo]::new($kuviResolvedDestination)
while ($kuviAncestor) {
  if (Test-Path -LiteralPath (Join-Path $kuviAncestor.FullName '.git')) { throw 'Recovery secrets cannot be exported into a Git checkout.' }
  $kuviAncestor = $kuviAncestor.Parent
}
$kuviKeyTarget = Join-Path $kuviDestination 'Kuvi-operator-secret.asc'
$kuviPassTarget = Join-Path $kuviDestination 'Kuvi-operator-passphrase.txt'
if ((Test-Path -LiteralPath $kuviKeyTarget) -or (Test-Path -LiteralPath $kuviPassTarget)) { throw 'Recovery files already exist. Preserve them.' }
$kuviDataDirectory = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'pull-config.json') -Raw | ConvertFrom-Json).localDirectory
$kuviKeySource = Join-Path $kuviDataDirectory 'Recovery\operator-secret-protected.asc'
$kuviBstr = [IntPtr]::Zero
try {
  $kuviSecret = ConvertTo-SecureString (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'operator-passphrase.dpapi') -Raw)
  $kuviBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($kuviSecret)
  $kuviPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($kuviBstr)
  $kuviKeyFile = [System.IO.File]::Open($kuviKeyTarget,[System.IO.FileMode]::CreateNew)
  try { $kuviKeyBytes = [System.IO.File]::ReadAllBytes($kuviKeySource); $kuviKeyFile.Write($kuviKeyBytes,0,$kuviKeyBytes.Length); $kuviKeyFile.Flush($true) }
  finally { $kuviKeyFile.Dispose() }
  $kuviPassFile = [System.IO.File]::Open($kuviPassTarget,[System.IO.FileMode]::CreateNew)
  try { $kuviPassBytes = [System.Text.Encoding]::UTF8.GetBytes($kuviPlain); $kuviPassFile.Write($kuviPassBytes,0,$kuviPassBytes.Length); $kuviPassFile.Flush($true) }
  finally { $kuviPassFile.Dispose() }
  $kuviPlain = $null
  Write-Output 'Recovery material exported to the chosen folder. The passphrase was not printed.'
} finally {
  if ($kuviBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($kuviBstr) }
  if ($kuviSecret) { $kuviSecret.Dispose() }
}
