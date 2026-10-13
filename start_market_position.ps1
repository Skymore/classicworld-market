param([int]$Seconds = 0)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
Set-Location $PSScriptRoot
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run from Administrator PowerShell to use the receive-only WinDivert driver.'
}
$pythonExe = Get-MarketPython
Write-Host 'Receive-only position collector. Reconnect once after startup. Ctrl+C stops. No packet bodies are saved.'
& $pythonExe -X utf8 (Join-Path $PSScriptRoot 'market_movement_capture.py') --folder (Join-Path $PSScriptRoot 'network_captures\position_live') --seconds $Seconds --position-output (Join-Path $PSScriptRoot 'market_data\player_position.json')
