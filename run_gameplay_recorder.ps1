param([switch]$SelfTest)
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
$requirementsPath = Join-Path $PSScriptRoot 'requirements-gameplay.txt'
$requirementsHash = (Get-FileHash -LiteralPath $requirementsPath -Algorithm SHA256).Hash
$stampPath = Join-Path $runtimeDir 'requirements.sha256'
if (-not (Test-Path -LiteralPath $stampPath) -or (Get-Content -LiteralPath $stampPath -Raw).Trim() -ne $requirementsHash) {
    & $runtimePython -m pip install --disable-pip-version-check -r $requirementsPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not install recorder dependencies.' }
    Set-Content -LiteralPath $stampPath -Value $requirementsHash -Encoding ascii
}
if ($SelfTest) {
    & $runtimePython (Join-Path $PSScriptRoot 'record_gameplay.py') --self-test
} else {
    & $runtimePython (Join-Path $PSScriptRoot 'record_gameplay.py')
}
exit $LASTEXITCODE
