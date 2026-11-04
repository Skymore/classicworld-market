param(
    [Parameter(Mandatory = $true)][string]$WzComparerDirectory,
    [Parameter(Mandatory = $true)][string]$ClientDataDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [int[]]$MapIds
)

# WzComparerR2 netfx 20261004.1, extracted outside the client/repository.
$ErrorActionPreference = 'Stop'
$rendererRoot = (Resolve-Path -LiteralPath $WzComparerDirectory).Path
$clientRoot = (Resolve-Path -LiteralPath $ClientDataDirectory).Path
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if ($outputRoot -eq $clientRoot -or $outputRoot.StartsWith($clientRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output must be outside the read-only client Data directory'
}
if (-not $MapIds) {
    $document = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../MAP_SCENES_FROM_CLIENT.md') -Raw
    $MapIds = [regex]::Matches($document, '(?m)^\|\s*(\d+)\s*\|') | ForEach-Object { [int]$_.Groups[1].Value }
}
$pending = @($MapIds | Where-Object {
    $png = Test-Path -LiteralPath (Join-Path $outputRoot "$_.png")
    $json = Test-Path -LiteralPath (Join-Path $outputRoot "$_.json")
    if ($png -ne $json) { throw "Incomplete existing render $_; inspect it before resuming" }
    -not $png
})
if (-not $pending.Count) { Write-Output 'All requested raw renders already exist'; exit 0 }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$references = @(
    'Lib/WzComparerR2.WzLib.dll', 'Lib/WzComparerR2.Common.dll',
    'Lib/WzComparerR2.PluginBase.dll', 'Lib/MonoGame.Framework.dll',
    'Plugin/WzComparerR2.MapRender/WzComparerR2.MapRender.dll',
    'Plugin/WzComparerR2.MapRender/EmptyKeys.UserInterface.Core.dll',
    'Plugin/WzComparerR2.MapRender/EmptyKeys.UserInterface.dll'
)
$executable = Join-Path $rendererRoot 'ClientMapScenes.Batch.exe'
$compileArgs = @('/nologo', '/target:exe', '/platform:x64', "/out:$executable")
$compileArgs += $references | ForEach-Object { '/r:' + (Join-Path $rendererRoot $_) }
$compileArgs += @('/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Configuration.dll')
$compileArgs += (Join-Path $PSScriptRoot 'render_client_scenes.cs')
& $compiler @compileArgs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Copy-Item -LiteralPath (Join-Path $rendererRoot 'WzComparerR2.anycpu.exe.config') -Destination "$executable.config"
Push-Location -LiteralPath $rendererRoot
try {
    & $executable $clientRoot $outputRoot ($pending -join ',')
    $renderExit = $LASTEXITCODE
} finally { Pop-Location }
exit $renderExit
