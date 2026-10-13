$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
Set-Location $PSScriptRoot
$pythonPath=Get-MarketPython
& (Join-Path $PSScriptRoot 'fetch_windivert.ps1')
$divertRoot=Join-Path $PSScriptRoot 'vendor\windivert\WinDivert-2.2.2-A'
# A driver used by a previous test can remain loaded until reboot. Never overwrite it.
$packageRoot=Join-Path $PSScriptRoot ('dist\packages\'+(Get-Date -Format 'yyyyMMdd_HHmmss_fff'))
$bundle=Join-Path $packageRoot 'ClassicWorldCollector'
& $pythonPath -m PyInstaller --noconfirm --clean --onedir --distpath $packageRoot --name ClassicWorldCollector --add-data 'maple_crypto_constants.cs;.' --add-data 'market_index.html;.' --add-data 'market_ui.js;.' --add-data 'market_ui.css;.' --add-data 'market_i18n.js;.' --add-data 'market_watchlist.js;.' --add-binary "$divertRoot\x64\WinDivert.dll;windivert" --add-binary "$divertRoot\x64\WinDivert64.sys;windivert" shared_client.py
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Copy-Item -LiteralPath 'SHARED_CLIENT_GUIDE.md' -Destination (Join-Path $bundle 'README.md')
Copy-Item -LiteralPath 'COPYING.MapleLib','THIRD_PARTY_NOTICES.md' -Destination $bundle
Copy-Item -LiteralPath 'msnet_reference\LICENSE' -Destination (Join-Path $bundle 'COPYING.msnet')
Copy-Item -LiteralPath (Join-Path $divertRoot 'LICENSE') -Destination (Join-Path $bundle 'COPYING.WinDivert')
Copy-Item -LiteralPath 'vendor\downloads\WinDivert-2.2.2-source.zip' -Destination $bundle
Compress-Archive -Path $bundle -DestinationPath 'dist\ClassicWorldCollector-windows-x64.zip' -Force
$bundle | Set-Content -Encoding utf8 'dist\bundle-path.txt'
Get-FileHash 'dist\ClassicWorldCollector-windows-x64.zip' -Algorithm SHA256
