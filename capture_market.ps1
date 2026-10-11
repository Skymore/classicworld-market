param([ValidateRange(10,120)][int]$Seconds = 45, [switch]$IncludeReconnects, [switch]$AllComponents)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请在以管理员身份运行的 PowerShell 中执行此脚本。'
}
$games = @(Get-Process -Name MapleStory -ErrorAction SilentlyContinue)
if ($games.Count -ne 1) { throw '需要恰好一个 MapleStory 进程正在运行。' }
$connections = @(Get-NetTCPConnection -OwningProcess $games[0].Id -State Established)
if (-not $connections.Count) { throw '未找到游戏 TCP 连接，请先进入市场。' }
$existing = (& pktmon.exe filter list 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw $existing }
# Existing global filters are ORed together. Refuse rather than capture other apps.
if ($existing -notmatch '^(Packet Filters:\s*None|No filters\.?|没有筛选器[。.]?|没有过滤器[。.]?|无筛选器[。.]?)$') {
    Write-Host $existing
    throw '无法确认 PktMon 过滤器为空。为避免影响已有抓包或采集其他应用，已停止；请把以上输出提供给助手。'
}
$folder = Join-Path $PSScriptRoot ('network_captures\' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$connections | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess |
    Export-Csv (Join-Path $folder 'connections.csv') -NoTypeInformation -Encoding UTF8
$owned = @()
$started = $false
$etl = Join-Path $folder 'market.etl'
try {
    foreach ($connection in $connections) {
        $name = 'MarketCheck_' + [guid]::NewGuid().ToString('N')
        $filterPort = $connection.LocalPort
        if ($IncludeReconnects) { $filterPort = $connection.RemotePort }
        & pktmon.exe filter add $name -t TCP -i $connection.RemoteAddress -p $filterPort
        if ($LASTEXITCODE -ne 0) { throw '添加抓包过滤器失败。' }
        $owned += $name
    }
    $captureComponent = 'nics'
    if ($AllComponents) { $captureComponent = 'all' }
    & pktmon.exe start --capture --comp $captureComponent --pkt-size 0 --file-size 32 --file-name $etl
    if ($LASTEXITCODE -ne 0) { throw '启动失败。若已有 PktMon 会话，请先结束自己的会话后重试。' }
    $started = $true
    Write-Host "正在采集 $Seconds 秒。现在切换到游戏，打开摊位、滚动商品、关闭，再打开同一摊位。"
    if ($IncludeReconnects) { Write-Host '已启用同一远端的重连采集，可在开始后换频道以获取新连接握手。' } else { Write-Host '期间请勿换频道或重新登录；这会改变连接。' }
    Start-Sleep -Seconds $Seconds
} finally {
    if ($started) { & pktmon.exe stop }
    if ($owned.Count) { & pktmon.exe filter remove }
}
& pktmon.exe etl2pcap $etl --out (Join-Path $folder 'market.pcapng')
if ($LASTEXITCODE -ne 0) { throw '转换失败，原始 ETL 已保留。' }
Write-Host "完成：$folder"
