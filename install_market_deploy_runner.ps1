param([string]$Repository = 'Skymore/classicworld-market')
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$runnerRoot = Join-Path $taskRoot 'shared_data\actions-runner'
New-Item -ItemType Directory -Path $runnerRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $runnerRoot 'config.cmd'))) {
    $release = gh api repos/actions/runner/releases/latest | ConvertFrom-Json
    if ($LASTEXITCODE) { throw 'Could not get the official GitHub runner release' }
    $asset = $release.assets | Where-Object { $_.name -match '^actions-runner-win-x64-.*\.zip$' }
    if (-not $asset -or $asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Missing runner checksum' }
    $expectedHash = $Matches[1]
    $archive = Join-Path $taskRoot ('shared_data\' + $asset.name)
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
        throw 'Official runner download checksum mismatch'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $runnerRoot -Force
}
Push-Location -LiteralPath $runnerRoot
try {
    if (-not (Test-Path -LiteralPath '.runner')) {
        $registration = gh api "repos/$Repository/actions/runners/registration-token" --method POST | ConvertFrom-Json
        if ($LASTEXITCODE -or -not $registration.token) { throw 'Could not register the repository runner' }
        & .\config.cmd --unattended --url "https://github.com/$Repository" --token $registration.token --name 'mxd-liwin' --labels 'mxd-production' --work '_work'
        if ($LASTEXITCODE) { throw 'Runner configuration failed' }
        $registration = $null
    }
    $envFile = Join-Path $runnerRoot '.env'
    $envLines = if (Test-Path -LiteralPath $envFile) { @(Get-Content -LiteralPath $envFile | Where-Object { $_ -notmatch '^MXD_DEPLOY_ROOT=' }) } else { @() }
    @($envLines + "MXD_DEPLOY_ROOT=$taskRoot") | Set-Content -LiteralPath $envFile -Encoding utf8
} finally { Pop-Location }
$launcher = Join-Path $taskRoot 'shared_data\run-deploy-runner.cmd'
@('@echo off', ('cd /d "' + $runnerRoot + '"'), 'call run.cmd >> "..\deploy-runner.log" 2>&1') | Set-Content -LiteralPath $launcher -Encoding ascii
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument ('/d /c ""' + $launcher + '""')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'ClassicWorld Market Deploy Runner' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
if (-not (Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList ('/d /c ""' + $launcher + '""') -WorkingDirectory $taskRoot -WindowStyle Hidden
}
Write-Output 'Runner configured: mxd-liwin, label mxd-production; starts at user logon.'
