"""One per-user supervisor for the web origin, uploader and Cloudflare tunnel."""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parent


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cloudflared',default=r'C:\Program Files (x86)\cloudflared\cloudflared.exe')
    args=parser.parse_args()
    data=ROOT/'shared_data';data.mkdir(exist_ok=True)
    lock=(data/'supervisor.lock').open('a+b');lock.seek(0);lock.write(b'1');lock.flush();lock.seek(0)
    if os.name=='nt':
        import msvcrt
        try:msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        except OSError:print('Supervisor already running');return
    commands={
        'web':[sys.executable,'-u',str(ROOT/'shared_server.py')],
        'upload':[sys.executable,'-u',str(ROOT/'shared_client.py'),'--upload-only','--home',str(data/'host-client'),
                  '--config',str(data/'owner.json'),'--folder',str(ROOT/'network_captures/market_live')],
        'tunnel':[args.cloudflared,'--no-autoupdate','--config',str(data/'tunnel.yml'),'tunnel','run'],
    }
    children={};logs={};retry={};last_backup=0
    try:
        while True:
            for name,command in commands.items():
                child=children.get(name)
                if (not child or child.poll() is not None) and time.time()>=retry.get(name,0):
                    if name in logs:logs[name].close()
                    logs[name]=(data/(name+'.log')).open('ab')
                    children[name]=subprocess.Popen(command,cwd=ROOT,stdout=logs[name],stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                    retry[name]=time.time()+20
            (data/'supervisor_status.json').write_text(json.dumps(dict(time=time.time(),pid=os.getpid(),
                children={k:dict(pid=p.pid,running=p.poll() is None) for k,p in children.items()})),encoding='utf-8')
            if time.time()-last_backup>86400 and (data/'market.sqlite').exists():
                folder=data/'backups';folder.mkdir(exist_ok=True)
                source=sqlite3.connect(data/'market.sqlite');destination=sqlite3.connect(folder/(time.strftime('%Y%m%d')+'.sqlite'))
                try:source.backup(destination)
                finally:source.close();destination.close()
                last_backup=time.time()
            time.sleep(5)
    finally:
        for child in children.values():
            if child.poll() is None:child.terminate()
        for log in logs.values():log.close()
        lock.close()


if __name__=='__main__':main()
