param(
    [ValidateSet('Calibrate','Run','Test')][string]$Mode = 'Calibrate',
    [int]$Room = 7,
    [int]$Limit = 300,
    [ValidateSet('Network','Minimap')][string]$PositionSource = 'Network'
)
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$mapId = 80002000 + $Room
$resource = Join-Path $PSScriptRoot "market_data\maps\$mapId.json"
$profile = Join-Path $PSScriptRoot "market_data\maps\room$Room-navigation.json"
$pythonExe = Get-MarketPython
if ($Mode -eq 'Calibrate') {
    if (Test-Path -LiteralPath $profile) {
        $backup = Join-Path $PSScriptRoot ('market_data\maps\calibration-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        Get-ChildItem -LiteralPath (Split-Path $profile) -Filter "room$Room-navigation.*" | Copy-Item -Destination $backup
    }
    & $pythonExe -X utf8 (Join-Path $PSScriptRoot 'market_map_resources.py') --wz 'C:\Nexon\Library\maplestorycw\appdata\Data\Map\Map\Map0\Map0_000.wz' --map-id $mapId --output $resource
    if ($LASTEXITCODE -ne 0) { throw 'Map extraction failed' }
    & $pythonExe -X utf8 (Join-Path $PSScriptRoot 'market_browser_bot.py') --run --calibrate-map $resource --calibration-output $profile
} else {
    if (-not (Test-Path -LiteralPath $profile)) { throw 'Run calibration first' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'The tested game runs as Administrator. Run this script from an Administrator PowerShell window so Windows can deliver keyboard and mouse input.'
    }
    if ($Mode -eq 'Test') {
        $positionArgs = @()
        if ($PositionSource -eq 'Network') { $positionArgs = @('--position-file', (Join-Path $PSScriptRoot 'market_data\player_position.json')) }
        & $pythonExe -X utf8 (Join-Path $PSScriptRoot 'market_browser_bot.py') --run --navigate-map $profile --navigation-test --limit 1 @positionArgs
    } else {
        $positionArgs = @()
        if ($PositionSource -eq 'Network') { $positionArgs = @('--position-file', (Join-Path $PSScriptRoot 'market_data\player_position.json')) }
        & $pythonExe -X utf8 (Join-Path $PSScriptRoot 'market_browser_bot.py') --run --navigate-map $profile --limit $Limit @positionArgs
    }
}
