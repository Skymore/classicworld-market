. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$ErrorActionPreference = 'Stop'
$pythonPath = (Get-MarketPython)
$captureFolder = Join-Path $PSScriptRoot 'network_captures\market_live'
$dataFolder = Join-Path $PSScriptRoot 'market_data'
New-Item -ItemType Directory -Path $captureFolder -Force | Out-Null
New-Item -ItemType Directory -Path $dataFolder -Force | Out-Null
if (Get-NetTCPConnection -LocalPort 1088 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 1088 is in use. Inspect the existing proxy before starting the MVP.'
}
if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8765 is in use. Inspect the existing dashboard before starting the MVP.'
}
$dashboardArgs = @('-u', ('"' + (Join-Path $PSScriptRoot 'market_dashboard.py') + '"'))
$dashboard = Start-Process -FilePath $pythonPath -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -ArgumentList $dashboardArgs -RedirectStandardOutput (Join-Path $dataFolder 'dashboard.log') -RedirectStandardError (Join-Path $dataFolder 'dashboard-error.log') -PassThru
$proxyArgs = @('-u', ('"' + (Join-Path $PSScriptRoot 'market_proxy.py') + '"'), '--market-only', '--folder', ('"' + $captureFolder + '"'))
try {
    $proxy = Start-Process -FilePath $pythonPath -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -ArgumentList $proxyArgs -RedirectStandardOutput (Join-Path $captureFolder 'stdout.log') -RedirectStandardError (Join-Path $captureFolder 'stderr.log') -PassThru
    $proxy.Id | Set-Content (Join-Path $captureFolder 'proxy.pid') -Encoding ascii
    $dashboard.Id | Set-Content (Join-Path $dataFolder 'dashboard.pid') -Encoding ascii
    Start-Sleep -Milliseconds 800
    if ($proxy.HasExited -or $dashboard.HasExited) { throw 'A service exited; inspect the error logs.' }
    & 'C:\Program Files (x86)\Proxifier\Proxifier.exe' (Join-Path $PSScriptRoot 'tools\MarketPassive.ppx') silent-load
    Write-Output 'Ready: http://127.0.0.1:8765 . Reconnect the game channel, then browse manually.'
} catch {
    if ($proxy -and -not $proxy.HasExited) { Stop-Process -Id $proxy.Id }
    if (-not $dashboard.HasExited) { Stop-Process -Id $dashboard.Id }
    throw
}
