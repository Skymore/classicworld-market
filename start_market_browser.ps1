. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& (Get-MarketPython) -X utf8 (Join-Path $PSScriptRoot 'market_browser_bot.py') --run --limit 5
