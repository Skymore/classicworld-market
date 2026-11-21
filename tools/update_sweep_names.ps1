param(
    [Parameter(Mandatory=$true)][string]$WzComparerDirectory,
    [Parameter(Mandatory=$true)][string]$ClientDataDirectory
)
$ErrorActionPreference='Stop'
$libraryRoot=(Resolve-Path -LiteralPath $WzComparerDirectory).Path
$clientRoot=(Resolve-Path -LiteralPath $ClientDataDirectory).Path
$executable=Join-Path $libraryRoot 'CollectorItemNames.exe'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:exe /platform:x64 "/out:$executable" "/r:$libraryRoot/Lib/WzComparerR2.WzLib.dll" (Join-Path $PSScriptRoot 'export_item_names.cs')
if ($LASTEXITCODE) { throw 'Name exporter compilation failed' }
Copy-Item -LiteralPath (Join-Path $libraryRoot 'WzComparerR2.anycpu.exe.config') -Destination "$executable.config"
& $executable $clientRoot (Join-Path $PSScriptRoot '../assets/sweep/item-names.json')
if ($LASTEXITCODE) { throw 'Client name export failed' }
