$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'resolve_python.ps1')
Set-Location $PSScriptRoot
$pythonPath=Get-MarketPython
# Default package uses Windows Winsock receive-only capture. No third-party driver.
# Do not fetch or redistribute the security-blocked WinDivert archive.
# A driver used by a previous test can remain loaded until reboot. Never overwrite it.
$packageRoot=Join-Path $PSScriptRoot ('dist\packages\'+(Get-Date -Format 'yyyyMMdd_HHmmss_fff'))
$bundle=Join-Path $packageRoot 'ClassicWorldCollector'
$webBundle=Join-Path $packageRoot 'web-source'
New-Item -ItemType Directory -Path $webBundle -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'web') | Where-Object {$_.Name -notin @('images','releases')} | Copy-Item -Destination $webBundle -Recurse
# Do not embed local game icon caches or any market/catalogue database.
& $pythonPath -m PyInstaller --noconfirm --clean --onedir --distpath $packageRoot --name ClassicWorldCollector --add-data 'maple_crypto_constants.cs;.' --add-data 'market_index.html;.' --add-data 'market_ui.js;.' --add-data 'market_ui.css;.' --add-data 'market_i18n.js;.' --add-data 'market_watchlist.js;.' --add-data "$webBundle;web" shared_client.py
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
Copy-Item -LiteralPath 'SHARED_CLIENT_GUIDE.md' -Destination (Join-Path $bundle 'README.md')
Copy-Item -LiteralPath 'COLLECTOR_QUICK_START.txt' -Destination (Join-Path $bundle '开始使用.txt')
Copy-Item -LiteralPath 'COPYING.MapleLib','THIRD_PARTY_NOTICES.md' -Destination $bundle
Copy-Item -LiteralPath 'msnet_reference\LICENSE' -Destination (Join-Path $bundle 'COPYING.msnet')
$managedFiles=@(Get-ChildItem -LiteralPath $bundle -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($bundle,$_.FullName).Replace('\','/') })
@{version='0.5.10';files=@($managedFiles)+@('install-manifest.json')} | ConvertTo-Json -Depth 3 | Set-Content -Encoding utf8 (Join-Path $bundle 'install-manifest.json')
Compress-Archive -Path $bundle -DestinationPath 'dist\ClassicWorldCollector-windows-x64-v0.5.10.zip' -Force
$bundle | Set-Content -Encoding utf8 'dist\bundle-path.txt'
Get-FileHash 'dist\ClassicWorldCollector-windows-x64-v0.5.10.zip' -Algorithm SHA256
