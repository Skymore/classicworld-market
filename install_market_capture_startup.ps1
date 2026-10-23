param([string]$RunId='manual')
$ErrorActionPreference='Stop'
$workspace=$PSScriptRoot
$taskName='ClassicWorld Read-Only Capture'
$resultPath=Join-Path $workspace 'market_data\capture-startup-install.json'
$installLog=Join-Path $workspace 'market_data\capture-startup-install.log'
New-Item -ItemType Directory -Path (Join-Path $workspace 'market_data') -Force | Out-Null
Start-Transcript -Path $installLog -Append | Out-Null
try {
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator approval is required to install the startup task.'
    }
    $python=Join-Path $workspace '.venv\Scripts\pythonw.exe'
    $collector=Join-Path $workspace 'market_capture_service.py'
    $captureFolder=Join-Path $workspace 'network_captures\market_live'
    if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $collector)) {
        throw 'Project Python or capture service source is missing.'
    }
    $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and -not ($existing.Actions.Arguments -like ('*'+$collector+'*'))) {
        throw 'A different task already uses this name; refusing to replace it.'
    }
    $taskArgs='-u -X utf8 "'+$collector+'" --folder "'+$captureFolder+'"'
    $action=New-ScheduledTaskAction -Execute $python -Argument $taskArgs -WorkingDirectory $workspace
    $trigger=New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay='PT20S'
    $identity=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
        -RestartInterval ([TimeSpan]::FromMinutes(1)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $identity -Settings $settings -Description 'Receive-only ClassicWorld market capture; local raw data, structured market uploads managed separately.' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    @{ok=$true;run_id=$RunId;task=$taskName;trigger='startup';mode='SNIFF|RECV_ONLY';time=(Get-Date).ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8
} catch {
    @{ok=$false;run_id=$RunId;task=$taskName;error=$_.Exception.Message;time=(Get-Date).ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8
    throw
} finally {
    Stop-Transcript | Out-Null
}
