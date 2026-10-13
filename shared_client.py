"""Windows collector: passive packet copies plus structured HTTPS uploads."""
import argparse
import asyncio
import getpass
import json
import os
import sqlite3
import ssl
import sys
import threading
import time
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from shared_protocol import from_snapshot
from market_location import LocationTimeline
import truststore


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def upload_opener():
    # Use the operating system's trusted roots, including managed Windows roots.
    opener = urllib.request.build_opener(NoRedirect,
        urllib.request.HTTPSHandler(context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)))
    opener.addheaders = [('User-Agent',
        'ClassicWorldCollector/0.2 (+https://github.com/Skymore/classicworld-market)')]
    return opener


def ensure_identity(config_path,endpoint='https://mxd.ruit.me'):
    if config_path.exists():return json.loads(config_path.read_text(encoding='utf-8'))
    if endpoint!='https://mxd.ruit.me' and not endpoint.startswith('http://127.0.0.1:'):
        raise ValueError('Unsupported registration endpoint')
    request=urllib.request.Request(endpoint+'/api/v1/register',data=b'{}',
        headers={'Content-Type':'application/json'},method='POST')
    with upload_opener().open(request,timeout=20) as response:config=json.load(response)
    if not isinstance(config.get('token'),str) or len(config['token'])<30 or not config.get('member_id'):
        raise ValueError('Invalid registration response')
    config['endpoint']=endpoint
    config_path.parent.mkdir(parents=True,exist_ok=True)
    # Exclusive creation prevents simultaneous launches from replacing an identity.
    try:
        with config_path.open('x',encoding='utf-8') as f:json.dump(config,f)
    except FileExistsError:return json.loads(config_path.read_text(encoding='utf-8'))
    if os.name=='nt':
        import subprocess
        subprocess.run(['icacls',str(config_path),'/inheritance:r','/grant:r',getpass.getuser()+':F'],capture_output=True,check=True)
    return config


def upload_once(folder, config, ledger, endpoint=None):
    destination=(endpoint or config['endpoint']).rstrip('/')
    if destination!='https://mxd.ruit.me' and not destination.startswith('http://127.0.0.1:'):
        raise ValueError('Unsupported endpoint; collector only sends to mxd.ruit.me')
    ledger.parent.mkdir(parents=True,exist_ok=True)
    connection=sqlite3.connect(ledger)
    try:
        connection.execute('CREATE TABLE IF NOT EXISTS sent (path TEXT PRIMARY KEY, status TEXT, updated REAL)')
        timeline=LocationTimeline(folder/'map_observations.jsonl')
        total=0
        for path in sorted(folder.glob('shop_*.json')):
            if path.stem.endswith('_zh'):continue
            if connection.execute('SELECT 1 FROM sent WHERE path=?',(path.name,)).fetchone():continue
            try:
                data=json.loads(path.read_text(encoding='utf-8'))
                location=timeline.resolve(data['session'],data['time'],data.get('market_location'))
                payload=from_snapshot(data,location)
            except (ValueError,KeyError,TypeError,OSError):
                # A file could still be being written; retry next pass.
                continue
            request=urllib.request.Request(destination+'/api/v1/observations',
                data=json.dumps(payload,ensure_ascii=False).encode(),
                headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'},method='POST')
            try:
                with upload_opener().open(request,timeout=15) as response:
                    result=json.load(response)
                    if not result.get('ok'):raise ValueError('Upload was not acknowledged')
                state='sent';total+=1
            except urllib.error.HTTPError as error:
                if error.code in (400,409,413):
                    state='rejected_'+str(error.code)
                    print(f'Upload rejected ({error.code}); see local ledger for file.',flush=True)
                else:raise RuntimeError(f'Upload HTTP {error.code}; retained locally') from None
            connection.execute('INSERT OR IGNORE INTO sent VALUES (?,?,?)',(path.name,state,time.time()));connection.commit()
        return total
    finally:connection.close()


def profile(path):
    path.write_text('''<?xml version="1.0" encoding="UTF-8"?>
<ProxifierProfile version="102" platform="Windows" product_id="0" product_minver="400">
<Options><Resolve><AutoModeDetection enabled="true"/><ViaProxy enabled="false"/></Resolve><HandleDirectConnections enabled="false"/></Options>
<ProxyList><Proxy id="100" type="SOCKS5"><Address>127.0.0.1</Address><Port>1088</Port><Options>0</Options></Proxy></ProxyList>
<ChainList/><RuleList>
<Rule enabled="true"><Name>Localhost</Name><Targets>localhost; 127.0.0.1; ::1</Targets><Action type="Direct"/></Rule>
<Rule enabled="true"><Name>ClassicWorld Market</Name><Applications>MapleStory.exe</Applications><Ports>8500-8599</Ports><Action type="Proxy">100</Action></Rule>
<Rule enabled="true"><Name>Default</Name><Action type="Direct"/></Rule>
</RuleList></ProxifierProfile>''',encoding='utf-8')


def start_dashboard(home, config_path, folder, port=8780, open_browser=True):
    import uuid
    instance=uuid.uuid4().hex
    home=Path(home);home.mkdir(parents=True,exist_ok=True)
    command=[sys.executable]
    if not getattr(sys,'frozen',False):command.append(str(Path(__file__).resolve()))
    command.extend(['--dashboard-only','--home',str(home),'--config',str(config_path),
                    '--folder',str(folder),'--dashboard-port',str(port),'--dashboard-instance',instance,'--no-browser'])
    with (home/'dashboard.log').open('a',encoding='utf-8') as log:
        process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    deadline=time.monotonic()+10
    while time.monotonic()<deadline and process.poll() is None:
        try:
            ready=json.loads((home/'dashboard.json').read_text(encoding='utf-8'))
            if ready.get('instance')==instance:
                print('Personal alerts: '+ready['url'],flush=True)
                if open_browser:
                    import webbrowser
                    webbrowser.open(ready['url'])
                return process
        except (OSError,ValueError,KeyError):pass
        time.sleep(.05)
    stop_dashboard(process)
    raise RuntimeError('Personal dashboard did not start; see dashboard.log')


def stop_dashboard(process):
    if process is None or process.poll() is not None:return
    if os.name=='nt':
        # The Windows venv launcher can have a different PID from Python itself.
        # Stop only this spawned dashboard's process tree, never the collector/game.
        subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True)
    else:process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)


def main():
    default=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ClassicWorldMarket'
    parser=argparse.ArgumentParser()
    parser.add_argument('--home',type=Path,default=default)
    parser.add_argument('--config',type=Path)
    parser.add_argument('--folder',type=Path)
    parser.add_argument('--upload-only',action='store_true',help='Use an already-running collector')
    parser.add_argument('--proxy',action='store_true',help='Legacy SOCKS mode; requires Proxifier')
    parser.add_argument('--capture-only',action='store_true',help='Local passive diagnostics, no upload')
    parser.add_argument('--seconds',type=int,default=0,help='Limit passive diagnostics duration')
    parser.add_argument('--once',action='store_true')
    parser.add_argument('--setup',action='store_true')
    parser.add_argument('--self-test',action='store_true',help='Check bundled codec without game or credentials')
    parser.add_argument('--dashboard-only',action='store_true',help='Open personal alerts without loading the capture driver')
    parser.add_argument('--dashboard-port',type=int,default=8780)
    parser.add_argument('--dashboard-instance',default='',help=argparse.SUPPRESS)
    parser.add_argument('--no-dashboard',action='store_true')
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args();args.home.mkdir(parents=True,exist_ok=True)
    if args.dashboard_only:
        from collector_dashboard import run
        config=json.loads((args.config or args.home/'member.json').read_text(encoding='utf-8'))
        run(args.home,config,args.folder or args.home/'captures',args.dashboard_port,args.dashboard_instance)
        return
    if args.self_test:
        from market_proxy import Proxy, allowed_destination
        from classicworld_codec import aes_payload, advance
        iv=bytes.fromhex('01020304');plain=b'codec-self-test'
        assert aes_payload(aes_payload(plain,iv),iv)==plain
        assert len(advance(iv))==4
        print('Codec self-test passed');return
    if not (args.once or args.upload_only or args.proxy):
        import ctypes
        if os.name=='nt' and not ctypes.windll.shell32.IsUserAnAdmin():
            if getattr(sys,'frozen',False):
                import subprocess
                result=ctypes.windll.shell32.ShellExecuteW(None,'runas',sys.executable,
                    subprocess.list2cmdline(sys.argv[1:]),None,1)
                if result<=32:raise PermissionError('Administrator permission was declined')
                return
            raise PermissionError('Run Python as administrator for passive capture')
    if args.capture_only:
        from market_passive import run
        run(args.folder or args.home/'captures',args.seconds);return
    config_path=args.config or args.home/'member.json'
    new_identity=not config_path.exists()
    config=ensure_identity(config_path)
    print('Collector ID: '+config.get('member_id','existing'),flush=True)
    if args.proxy and (args.setup or new_identity or not (args.home/'ClassicWorldMarket.ppx').exists()):
        profile(args.home/'ClassicWorldMarket.ppx')
        print('Saved private local settings. Import ClassicWorldMarket.ppx in Proxifier. Proxifier is separate software and may require a license.')
        if args.setup:return
    folder=args.folder or args.home/'captures';folder.mkdir(parents=True,exist_ok=True)
    ledger=args.home/'upload.sqlite'
    def worker():
        while True:
            try:
                count=upload_once(folder,config,ledger)
                for extra in config.get('extra_folders',[]):
                    import hashlib
                    source=Path(extra)
                    extra_ledger=args.home/('upload_'+hashlib.sha256(str(source.resolve()).encode()).hexdigest()[:12]+'.sqlite')
                    count+=upload_once(source,config,extra_ledger)
                if count:print(f'Uploaded {count} observations.',flush=True)
            except Exception as error:print(f'Upload unavailable ({type(error).__name__}); will retry.',flush=True)
            if args.once:break
            time.sleep(5)
    if args.once:worker();return
    dashboard=None
    if not args.no_dashboard:
        try:dashboard=start_dashboard(args.home,config_path,folder,args.dashboard_port,not args.no_browser)
        except Exception as error:print(f'Personal alerts unavailable ({type(error).__name__}); see dashboard.log.',flush=True)
    try:
        if args.upload_only:worker();return
        threading.Thread(target=worker,daemon=True).start()
        if not args.proxy:
            from market_passive import run
            print('Passive capture: no Proxifier needed. Disable its game rule, reconnect once, then browse manually.',flush=True)
            run(folder,args.seconds);return
        from market_proxy import Proxy
        print('Local proxy 127.0.0.1:1088. Reconnect game channel after importing profile. Browse manually. Close game session before stopping collector.',flush=True)
        asyncio.run(Proxy(folder,allow_requests=False,market_only=True).run())
    finally:stop_dashboard(dashboard)


if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:pass
    except Exception as error:
        print(f'Collector stopped: {type(error).__name__}: {error}',flush=True)
        if getattr(sys,'frozen',False):input('Press Enter to exit.')
