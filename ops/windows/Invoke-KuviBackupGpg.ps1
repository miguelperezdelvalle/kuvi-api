param(
  [Parameter(Mandatory=$true)][ValidateSet('ExportPublic','ExportPrivate','Decrypt')][string]$Action,
  [string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$kuviHome = $PSScriptRoot
$kuviNativeHome = Join-Path $kuviHome 'gnupg'
$kuviGpgHome = '/' + $kuviNativeHome.Substring(0,1).ToLowerInvariant() + $kuviNativeHome.Substring(2).Replace('\','/')
$kuviDataDirectory = (Get-Content -LiteralPath (Join-Path $kuviHome 'pull-config.json') -Raw | ConvertFrom-Json).localDirectory
$kuviGpgExecutable = Join-Path $env:ProgramFiles 'Git\usr\bin\gpg.exe'
$kuviOutput = [System.IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $kuviOutput) { throw 'The output already exists. Preserve it.' }
$kuviArgs = @('--no-options','--homedir',$kuviGpgHome,'--batch','--no-tty')
if ($Action -eq 'Decrypt') {
  $kuviInput = [System.IO.Path]::GetFullPath($InputPath)
  if ([System.IO.Path]::GetDirectoryName($kuviInput) -ne $kuviDataDirectory -or
      [System.IO.Path]::GetFileName($kuviInput) -notmatch '^kuvi-db-\d{8}T\d{6}Z-[a-f0-9]{8}\.dump\.gpg$' -or
      [System.IO.Path]::GetDirectoryName($kuviOutput) -ne "$kuviHome\verify" -or
      [System.IO.Path]::GetFileName($kuviOutput) -notmatch '^restore-check-[a-f0-9-]{36}\.dump$') { throw 'Invalid backup verification path.' }
  $kuviManifest = Get-Content -LiteralPath "$kuviInput.json" -Raw | ConvertFrom-Json
  $kuviActual = (Get-FileHash -LiteralPath $kuviInput -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($kuviActual -ne $kuviManifest.sha256) { throw 'The ciphertext checksum does not match.' }
  $kuviArgs += @('--pinentry-mode','loopback','--passphrase-fd','0','--output',$kuviOutput,'--decrypt',$kuviInput)
} else {
  $kuviKeyList = & $kuviGpgExecutable --no-options --homedir $kuviGpgHome --batch --with-colons --list-keys 2>$null
  $kuviFingerprint = ($kuviKeyList | Where-Object { $_.StartsWith('fpr:') } | Select-Object -First 1).Split(':')[9]
  if ($kuviFingerprint -notmatch '^[A-F0-9]{40}$') { throw 'Operator fingerprint is unavailable.' }
  if ($Action -eq 'ExportPrivate') {
    $kuviArgs += @('--pinentry-mode','loopback','--passphrase-fd','0','--armor','--output',$kuviOutput,'--export-secret-keys',$kuviFingerprint)
  } else {
    $kuviArgs += @('--armor','--output',$kuviOutput,'--export',$kuviFingerprint)
  }
}
$kuviProcessInfo = [System.Diagnostics.ProcessStartInfo]::new()
$kuviProcessInfo.FileName = $kuviGpgExecutable
$kuviProcessInfo.UseShellExecute = $false
$kuviProcessInfo.CreateNoWindow = $true
$kuviProcessInfo.RedirectStandardInput = $true
$kuviProcessInfo.RedirectStandardOutput = $true
$kuviProcessInfo.RedirectStandardError = $true
foreach ($kuviArg in $kuviArgs) { $kuviProcessInfo.ArgumentList.Add($kuviArg) }
$kuviBstr = [IntPtr]::Zero
$kuviProcess = $null
try {
  $kuviProcess = [System.Diagnostics.Process]::Start($kuviProcessInfo)
  $kuviOutTask = $kuviProcess.StandardOutput.ReadToEndAsync()
  $kuviErrTask = $kuviProcess.StandardError.ReadToEndAsync()
  if ($Action -ne 'ExportPublic') {
    $kuviProtectedText = Get-Content -LiteralPath "$kuviHome\operator-passphrase.dpapi" -Raw
    $kuviSecret = ConvertTo-SecureString $kuviProtectedText
    $kuviBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($kuviSecret)
    $kuviPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($kuviBstr)
    $kuviProcess.StandardInput.WriteLine($kuviPlain)
    $kuviPlain = $null
  }
  $kuviProcess.StandardInput.Close()
  if (-not $kuviProcess.WaitForExit(180000)) { $kuviProcess.Kill(); throw 'Backup cryptography timed out.' }
  if ($kuviProcess.ExitCode -ne 0) { throw 'Backup cryptography did not complete. No output was accepted.' }
  Write-Output 'Cryptographic operation completed. Secret material was not printed.'
} catch {
  if ($kuviProcess -and -not $kuviProcess.HasExited) { $kuviProcess.Kill() }
  if (Test-Path -LiteralPath $kuviOutput) { Remove-Item -LiteralPath $kuviOutput }
  throw 'Backup cryptography failed. Check the protected local configuration.'
} finally {
  if ($kuviBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($kuviBstr) }
  if ($kuviSecret) { $kuviSecret.Dispose() }
}
