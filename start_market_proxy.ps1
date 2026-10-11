param([switch]$AllowRequests)
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$ErrorActionPreference = 'Stop'
$pythonPath = (Get-MarketPython)
$proxyPath = Join-Path $PSScriptRoot 'market_proxy.py'
$outputFolder = Join-Path $PSScriptRoot 'network_captures\proxy_live'
New-Item -ItemType Directory -Path $outputFolder -Force | Out-Null
if (Get-NetTCPConnection -LocalPort 1088 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 1088 is already in use. Inspect it before launching another proxy.'
}
$proxyArguments = @('-u', ('"' + $proxyPath + '"'))
if ($AllowRequests) { $proxyArguments += '--allow-requests' }
$proc = Start-Process -FilePath $pythonPath -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -ArgumentList $proxyArguments -RedirectStandardOutput (Join-Path $outputFolder 'stdout.log') -RedirectStandardError (Join-Path $outputFolder 'stderr.log') -PassThru
$proc.Id | Set-Content (Join-Path $outputFolder 'proxy.pid') -Encoding ascii
Write-Output ('Proxy process launched: ' + $proc.Id)
