"""Configure only this executable's receive rule for ClassicWorld game ports."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

SCRIPT = r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$program=$env:CLASSICWORLD_CAPTURE_EXE
$name=$env:CLASSICWORLD_CAPTURE_RULE
function Test-CaptureRule($rule) {
 if(!$rule -or $rule.Enabled.ToString() -ne 'True' -or $rule.Direction.ToString() -ne 'Inbound' -or $rule.Action.ToString() -ne 'Allow'){return $false}
 $app=$rule | Get-NetFirewallApplicationFilter
 $port=$rule | Get-NetFirewallPortFilter
 return ($app.Program -ieq $program -and $port.Protocol.ToString() -in @('TCP','6') -and @($port.RemotePort).Count -eq 1 -and $port.RemotePort -eq '8500-8999')
}
$rule=Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if($rule) {
 if(!(Test-CaptureRule $rule)){throw 'Existing collector rule has unexpected settings; no rule was modified.'}
 $state='existing'
} else {
 # Reuse the exact, already-approved local diagnostic rule when applicable.
 $legacy=Get-NetFirewallRule -Name 'ClassicWorld-NativeCapture-GameInbound-v1' -ErrorAction SilentlyContinue
 if(Test-CaptureRule $legacy){$name=$legacy.Name;$state='existing'}
 else {
  New-NetFirewallRule -Name $name -DisplayName 'ClassicWorld collector: game TCP receive only' -Direction Inbound -Action Allow -Program $program -Protocol TCP -RemotePort '8500-8999' -Profile Any -EdgeTraversalPolicy Block | Out-Null
  $rule=Get-NetFirewallRule -Name $name
  if(!(Test-CaptureRule $rule)){throw 'Collector firewall rule verification failed.'}
  $state='created'
 }
}
@{state=$state;rule=$name;remote_ports='8500-8999';protocol='TCP'} | ConvertTo-Json -Compress
'''


def ensure_capture_firewall():
    if sys.platform != 'win32':
        raise RuntimeError('Windows is required for native capture firewall setup')
    import psutil
    # A virtualenv launcher may hand execution to another python[w].exe.
    # Windows firewall must match the actual process image, not the launcher.
    program=str(Path(psutil.Process(os.getpid()).exe()).resolve())
    name='ClassicWorld-Capture-'+hashlib.sha256(os.path.normcase(program).encode()).hexdigest()[:16]
    env=dict(os.environ,CLASSICWORLD_CAPTURE_EXE=program,CLASSICWORLD_CAPTURE_RULE=name)
    powershell=Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result=subprocess.run([str(powershell),'-NoProfile','-NonInteractive','-Command',SCRIPT],
            env=env,capture_output=True,timeout=40,creationflags=subprocess.CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError('Firewall setup timed out; capture has not started. Retry as administrator.') from error
    if result.returncode:
        raise RuntimeError('Firewall setup failed; capture has not started. Check administrator permission or managed firewall policy. '+result.stderr.decode('utf-8',errors='replace')[-600:])
    try:
        status=json.loads(result.stdout.decode('utf-8-sig'))
        if status['state'] not in ('created','existing') or status['protocol']!='TCP' or status['remote_ports']!='8500-8999':
            raise ValueError('Unexpected rule result')
    except (ValueError,KeyError,TypeError) as error:
        raise RuntimeError('Could not verify the restricted firewall rule; capture has not started.') from error
    return status
