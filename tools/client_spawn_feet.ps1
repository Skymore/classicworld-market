# Where each monster spawn point stands, from the Classic World client's Map.wz.
#
# NiaDB's spawns.y is the life entry's `y`, which can sit well above the
# platform; the monster stands on the foothold at `cy`. This writes
# data/reference/niadb/spawn-feet.json: per map, [mobId, x, y, cy] for every
# spawn whose cy differs from y. import_catalog matches them by (map, mob, x, y).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\client_spawn_feet.ps1
param(
    [string]$Data = "C:\Nexon\Library\maplestorycw\appdata\Data",
    [string]$Lib = "$PSScriptRoot\..\shared_data\client-scenes-work\WcR2\Lib\WzComparerR2.WzLib.dll",
    [string]$Maps = "$PSScriptRoot\..\data\reference\niadb\maps.json",
    [string]$Output = "$PSScriptRoot\..\data\reference\niadb\spawn-feet.json"
)
$ErrorActionPreference = "Stop"
Add-Type -Path $Lib
$wz = New-Object WzComparerR2.WzLib.Wz_Structure
$root = $null
$wz.LoadWzFolder("$Data\Map", [ref]$root, $true)

$ids = (Get-Content -Raw -Encoding UTF8 $Maps | ConvertFrom-Json) |
    Where-Object { $_.spawns.Count -gt 0 } | ForEach-Object { $_.id }
$out = [ordered]@{}
$missing = 0
foreach ($id in $ids) {
    $node = $root.FindNodeByPath("Map\Map$($id.Substring(0, 1))\$id.img")
    if (-not $node) { $missing++; continue }
    $img = $node.Value
    [void]$img.TryExtract()
    $life = $img.Node.FindNodeByPath("life")
    if (-not $life) { continue }
    $rows = @()
    foreach ($l in $life.Nodes) {
        if ($l.FindNodeByPath("type").Value -ne "m") { continue }
        $y = [int]$l.FindNodeByPath("y").Value
        $cy = [int]$l.FindNodeByPath("cy").Value
        if ($cy -eq $y) { continue }
        $rows += , @([int]$l.FindNodeByPath("id").Value, [int]$l.FindNodeByPath("x").Value, $y, $cy)
    }
    if ($rows.Count) { $out["$([int]$id)"] = $rows }
}
$json = ConvertTo-Json -InputObject $out -Depth 4 -Compress
[IO.File]::WriteAllText((Resolve-Path -LiteralPath (Split-Path $Output)).Path + "\" + (Split-Path $Output -Leaf), $json + "`n")
Write-Host "maps $($out.Count), spawn points $(($out.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum), not in client $missing"
