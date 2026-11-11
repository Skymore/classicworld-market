"""One per-user supervisor for the web origin, uploader and Cloudflare tunnel."""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from deploy_market import web_runtime, web_environment

ROOT=Path(__file__).resolve().parent


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cloudflared',default=r'C:\Program Files (x86)\cloudflared\cloudflared.exe')
    parser.add_argument('--adopt-running',action='store_true',help='Adopt verified children during a supervisor-only handoff')
    args=parser.parse_args()
    data=ROOT/'shared_data';data.mkdir(exist_ok=True)
    lock=(data/'supervisor.lock').open('a+b');lock.seek(0);lock.write(b'1');lock.flush();lock.seek(0)
    if os.name=='nt':
        import msvcrt
        try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:print('Supervisor already running');return
    # Login startup may use the bundled Python, whose packages can change after
    # runtime updates. Child services use this project's installed dependencies.
    service_python=ROOT/'.venv/Scripts/python.exe'
    service_python=str(service_python) if service_python.exists() else sys.executable
    commands={
        'dashboard':[service_python,'-u',str(ROOT/'market_dashboard.py')],
        'web':[service_python,'-u',str(ROOT/'shared_server.py')],
        'upload':[service_python,'-u',str(ROOT/'shared_client.py'),'--upload-only','--no-browser','--home',str(data/'host-client'),
                  '--config',str(data/'owner.json'),'--folder',str(ROOT/'network_captures/market_live')],
        'tunnel':[args.cloudflared,'--no-autoupdate','--config',str(data/'tunnel.yml'),'tunnel','run'],
    }
    native_path=data/'native-runtime.json'
    native=json.loads(native_path.read_text(encoding='utf-8')) if native_path.exists() else {}
    web_env=None;active_release='legacy'
    pg_bin=ROOT/'market_data/runtime/pgsql/bin'
    if native.get('enabled'):
        commands={'database':[str(pg_bin/'postgres.exe'),'-D',str(data/'postgres')],**commands}
        binary,web,active_release=web_runtime(ROOT)
        commands['web']=[str(binary)]
        if not native.get('legacy_dashboard_enabled',True):commands.pop('dashboard',None)
        web_env=web_environment(ROOT,native,web)
        if native.get('mesowatch',{}).get('enabled',False):
            commands['mesowatch']=[service_python,'-u',str(ROOT/'mesowatch_sync.py'),'--loop','--root',str(ROOT)]
    children={};logs={};retry={}
    if args.adopt_running:
        import psutil
        class Adopted:
            def __init__(self,process):self.process=process;self.pid=process.pid
            def poll(self):return None if self.process.is_running() and self.process.status()!=psutil.STATUS_ZOMBIE else 0
            def terminate(self):self.process.terminate()
        try:previous=json.loads((data/'supervisor_status.json').read_text(encoding='utf-8'))
        except (OSError,ValueError):previous={}
        for name,command in commands.items():
            try:
                process=psutil.Process(previous['children'][name]['pid'])
                actual=process.cmdline()
                same_args=actual[1:]==command[1:]
                if not same_args or process.create_time()>previous['time']:continue
                if Path(command[0]).name.lower().startswith('python'):
                    if process.cwd()!=str(ROOT):continue
                elif Path(process.exe()).resolve()!=Path(command[0]).resolve():continue
                children[name]=Adopted(process)
            except (KeyError,OSError,psutil.Error):continue
    try:
        while True:
            if native.get('enabled'):
                try:
                    binary,web,wanted_release=web_runtime(ROOT)
                    if wanted_release!=active_release:
                        child=children.get('web')
                        if child and child.poll() is None:
                            child.terminate()
                            deadline=time.monotonic()+15
                            while child.poll() is None and time.monotonic()<deadline:time.sleep(.1)
                            if child.poll() is None:raise RuntimeError('Previous web process did not stop')
                        commands['web']=[str(binary)]
                        web_env=web_environment(ROOT,native,web)
                        active_release=wanted_release
                        retry['web']=0
                except (OSError,ValueError,KeyError,RuntimeError) as error:
                    print(f'Release switch deferred: {error}',flush=True)
            for name,command in commands.items():
                child=children.get(name)
                if (not child or child.poll() is not None) and time.time()>=retry.get(name,0):
                    if name in logs:logs[name].close()
                    logs[name]=(data/(name+'.log')).open('ab')
                    children[name]=subprocess.Popen(command,cwd=ROOT,stdout=logs[name],stderr=subprocess.STDOUT,
                        env=web_env if name=='web' else None,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                    retry[name]=time.time()+20
            (data/'supervisor_status.json').write_text(json.dumps(dict(time=time.time(),pid=os.getpid(),
                deployment_support=1,release=active_release,
                children={k:dict(pid=p.pid,running=p.poll() is None) for k,p in children.items()})),encoding='utf-8')
            # Backups are explicit deployment operations; never block supervision.
            time.sleep(5)
    finally:
        for child in children.values():
            if child.poll() is None:child.terminate()
        for log in logs.values():log.close()
        lock.close()


if __name__=='__main__':main()
