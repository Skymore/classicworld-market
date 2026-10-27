"""Inspect or explicitly tune the supervised local PostgreSQL shared cache."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.parse import unquote, urlsplit


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--shared-buffers',choices=['128MB','512MB','1GB'],default='1GB')
    args=parser.parse_args()
    root=args.root.resolve(); data=root/'shared_data'; pg=root/'market_data/runtime/pgsql/bin'
    native=json.loads((data/'native-runtime.json').read_text(encoding='utf-8'))
    address=urlsplit(native['database_url'])
    if not native.get('enabled') or address.hostname not in ('127.0.0.1','localhost','::1'):
        raise RuntimeError('Only the supervised local database is supported')
    env=dict(os.environ,PGPASSWORD=unquote(address.password or ''),PGCLIENTENCODING='UTF8',PGCONNECT_TIMEOUT='3')
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    command=[str(pg/'psql.exe'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-h',address.hostname,
             '-p',str(address.port or 5432),'-U',unquote(address.username),'-d',address.path.lstrip('/')]
    def sql(statement):
        result=subprocess.run([*command,'-c',statement],env=env,capture_output=True,text=True,encoding='utf-8',
                              timeout=10,creationflags=flags)
        if result.returncode:raise RuntimeError('Local database command failed')
        return result.stdout.strip()
    print('Current shared_buffers:',sql('SHOW shared_buffers'),flush=True)
    if not args.apply:return
    directory=(data/'postgres').resolve()
    if Path(sql('SHOW data_directory')).resolve()!=directory:
        raise RuntimeError('Database data directory differs from the deployment root')
    source=Path(__file__).resolve().parents[1]
    commit=json.loads((data/'deploy/current.json').read_text())['commit']
    for ref in ['HEAD','main','gitlab/main']:
        if subprocess.check_output(['git','rev-parse',ref],cwd=source,text=True).strip()!=commit:
            raise RuntimeError('Deploy the reviewed main commit before changing the cache')
    status=json.loads((data/'supervisor_status.json').read_text())
    if time.time()-status['time']>20 or not status['children']['database']['running']:
        raise RuntimeError('Database supervisor is not healthy')
    original_pid=status['children']['database']['pid']
    config=directory/'postgresql.auto.conf'
    backup=data/'backups'/('postgresql-auto-'+time.strftime('%Y%m%d-%H%M%S')+'.conf')
    backup.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(config,backup)
    try:
        sql("ALTER SYSTEM SET shared_buffers = '"+args.shared_buffers+"'")
        subprocess.run([str(pg/'pg_ctl.exe'),'stop','-D',str(directory),'-m','fast','-w','-t','30'],
                       check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=35,creationflags=flags)
        # The existing supervisor owns the new process; do not race it by starting
        # a detached postgres that it cannot supervise.
        deadline=time.monotonic()+70
        while time.monotonic()<deadline:
            time.sleep(1)
            try:
                status=json.loads((data/'supervisor_status.json').read_text())
                child=status['children']['database']
                if child['running'] and child['pid']!=original_pid and sql('SHOW shared_buffers')==args.shared_buffers:
                    print('Verified shared_buffers:',args.shared_buffers,'; supervisor restarted database; configuration backup:',backup.name)
                    return
            except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired):pass
        raise RuntimeError('Timed out waiting for the supervised database restart')
    except Exception:
        shutil.copyfile(backup,config)
        print('Restored the previous configuration for the next supervised start',flush=True)
        raise


if __name__=='__main__':main()
