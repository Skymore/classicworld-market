. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$ErrorActionPreference = 'Stop'
$pythonPath = (Get-MarketPython)
$capturePath = Join-Path $PSScriptRoot 'capture_shop_session.py'
$logPath = Join-Path $PSScriptRoot 'shop_capture_launch.log'
& $pythonPath -u $capturePath --seconds 600 --server-subnet 44.234.79.0/24 *> $logPath
exit $LASTEXITCODE
