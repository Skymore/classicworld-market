param(
    [Parameter(Mandatory=$true)][string]$WinDivert,
    [Parameter(Mandatory=$true)][string]$WinDivertSource
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$pythonPath=Get-MarketPython
& $pythonPath (Join-Path $PSScriptRoot 'build_unified_client.py') --windivert $WinDivert --windivert-source $WinDivertSource
if ($LASTEXITCODE -ne 0) { throw 'Unified scanner build failed' }
