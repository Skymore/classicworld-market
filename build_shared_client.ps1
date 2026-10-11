$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
Set-Location $PSScriptRoot
$pythonPath=Get-MarketPython
& $pythonPath -m PyInstaller --noconfirm --clean --onedir --name ClassicWorldCollector --add-data 'maple_crypto_constants.cs;.' shared_client.py
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Copy-Item -LiteralPath 'SHARED_CLIENT_GUIDE.md' -Destination 'dist\ClassicWorldCollector\README.md'
Copy-Item -LiteralPath 'COPYING.MapleLib','THIRD_PARTY_NOTICES.md' -Destination 'dist\ClassicWorldCollector'
Compress-Archive -Path 'dist\ClassicWorldCollector' -DestinationPath 'dist\ClassicWorldCollector-windows-x64.zip' -Force
Get-FileHash 'dist\ClassicWorldCollector-windows-x64.zip' -Algorithm SHA256
