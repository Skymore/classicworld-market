$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path 'vendor\downloads' | Out-Null
$assets=@(
    @{Name='WinDivert-2.2.2-A.zip';Url='https://github.com/basil00/WinDivert/releases/download/v2.2.2/WinDivert-2.2.2-A.zip';Hash='63CB41763BB4B20F600B6DE04E991A9C2BE73279E317D4D82F237B150C5F3F15'},
    @{Name='WinDivert-2.2.2-source.zip';Url='https://github.com/basil00/WinDivert/archive/refs/tags/v2.2.2.zip';Hash='65EC79C9E6AFA99F648A3F4D1F6DB794640B40D0B65BD438770EA503EE14ECB7'}
)
foreach ($asset in $assets) {
    $target=Join-Path 'vendor\downloads' $asset.Name
    if (-not (Test-Path -LiteralPath $target)) { Invoke-WebRequest -Uri $asset.Url -OutFile $target }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $asset.Hash) { throw ('Checksum mismatch: '+$asset.Name) }
}
if (-not (Test-Path -LiteralPath 'vendor\windivert\WinDivert-2.2.2-A\x64\WinDivert.dll')) {
    Expand-Archive -LiteralPath 'vendor\downloads\WinDivert-2.2.2-A.zip' -DestinationPath 'vendor\windivert' -Force
}
$binaryHashes=@{
    'WinDivert.dll'='C1E060EE19444A259B2162F8AF0F3FE8C4428A1C6F694DCE20DE194AC8D7D9A2'
    'WinDivert64.sys'='8DA085332782708D8767BCACE5327A6EC7283C17CFB85E40B03CD2323A90DDC2'
}
foreach ($name in $binaryHashes.Keys) {
    $file=Join-Path 'vendor\windivert\WinDivert-2.2.2-A\x64' $name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $binaryHashes[$name]) { throw ('Binary checksum mismatch: '+$name) }
}
$signature=Get-AuthenticodeSignature 'vendor\windivert\WinDivert-2.2.2-A\x64\WinDivert64.sys'
if ($signature.Status -ne 'Valid') { throw 'WinDivert driver signature validation failed' }
Write-Host 'Official WinDivert archive hashes and driver signature verified.'
