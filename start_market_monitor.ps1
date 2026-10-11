. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$ErrorActionPreference = 'Stop'
$pythonPath = (Get-MarketPython)
$monitorPath = Join-Path $PSScriptRoot 'monitor_market.py'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Bundled Python was not found.' }
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    & $pythonPath -u $monitorPath
    exit $LASTEXITCODE
}
# This visible console is interactive: the user enters action markers and stops capture.
$process = Start-Process -FilePath $pythonPath -Verb RunAs -ArgumentList @('-u', ('"' + $monitorPath + '"')) -PassThru
Write-Host "Monitor requested in an administrator console. Process: $($process.Id)"
