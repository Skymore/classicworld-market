param([string]$Destination, [string]$Shortcut)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
$runtimeDir = Join-Path $PSScriptRoot '.gameplay-venv'
$runtimePython = Join-Path $runtimeDir 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    $basePython = Get-MarketPython
    & $basePython -m venv $runtimeDir
    if ($LASTEXITCODE -ne 0) { throw 'Could not create recorder environment.' }
}
& $runtimePython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements-gameplay-build.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install build dependencies.' }
$buildArgs = @((Join-Path $PSScriptRoot 'build_gameplay_recorder.py'))
if ($Destination) { $buildArgs += @('--destination', $Destination) }
if ($Shortcut) { $buildArgs += @('--shortcut', $Shortcut) }
& $runtimePython @buildArgs
if ($LASTEXITCODE -ne 0) { throw 'Recorder build or verification failed.' }
