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
from collector_update import VERSION
import truststore
from collector_http import request_json
from collector_recovery import retry_delay
from collector_network import HTTPHandler, HTTPSHandler


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def upload_opener():
    # Use the operating system's trusted roots, including managed Windows roots.
    opener = urllib.request.build_opener(NoRedirect, HTTPHandler,
        HTTPSHandler(context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)))
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


def upload_once(folder, config, ledger, endpoint=None, stop=None, on_event=None):
    destination=(endpoint or config['endpoint']).rstrip('/')
    if destination!='https://mxd.ruit.me' and not destination.startswith('http://127.0.0.1:'):
        raise ValueError('Unsupported endpoint; collector only sends to mxd.ruit.me')
    ledger.parent.mkdir(parents=True,exist_ok=True)
    connection=sqlite3.connect(ledger)
    try:
        connection.execute('CREATE TABLE IF NOT EXISTS sent (path TEXT PRIMARY KEY, status TEXT, updated REAL)')
        timeline=LocationTimeline(folder/'map_observations.jsonl')
        total=0
        paths = sorted([*folder.glob('shop_*.json'), *folder.glob('presence_*.json'), *folder.glob('roster_*.json')])
        if on_event:
            sent = {row[0] for row in connection.execute('SELECT path FROM sent')}
            on_event(dict(type='upload_queue', pending=sum(p.name not in sent and not p.stem.endswith('_zh') for p in paths)))
        for path in paths:
            if stop is not None and stop.is_set():break
            if path.stem.endswith('_zh'):continue
            if connection.execute('SELECT 1 FROM sent WHERE path=?',(path.name,)).fetchone():continue
            try:
                data=json.loads(path.read_text(encoding='utf-8'))
                if path.name.startswith('roster_'):
                    from market_presence import roster_payload
                    payload = roster_payload(data)
                    route = '/api/v1/collector/room-roster'
                elif path.name.startswith('presence_'):
                    from market_presence import departure_payload
                    payload = departure_payload(data)
                    route = '/api/v1/collector/player-departure'
                else:
                    if data.get('owner') is None:
                        from market_shop_owner import owner_from_snapshot
                        owner=owner_from_snapshot(data,folder)
                        if owner is not None: data['owner']=owner
                    location=timeline.resolve(data['session'],data['time'],data.get('market_location'))
                    payload=from_snapshot(data,location)
                    context=timeline.resolve_context(data['session'],data['time'])
                    if context: payload['map_context']={k:context[k] for k in ('channel','map_id')}
                    route = '/api/v1/observations'
            except (ValueError,KeyError,TypeError,OSError):
                # A file could still be being written; retry next pass.
                continue
            request=urllib.request.Request(destination+route,
                data=json.dumps(payload,ensure_ascii=False).encode(),
                headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'},method='POST')
            try:
                result=request_json(request.full_url, payload, dict(request.header_items()), stop=stop)
                if not result.get('ok'):raise ValueError('Upload was not acknowledged')
                state='sent';total+=int(path.name.startswith('shop_'))
            except urllib.error.HTTPError as error:
                if error.code in (400,409,413):
                    state='rejected_'+str(error.code)
                    print(f'Upload rejected ({error.code}); see local ledger for file.',flush=True)
                else:raise
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
    import psutil
    instance=uuid.uuid4().hex
    home=Path(home);home.mkdir(parents=True,exist_ok=True)
    command=[sys.executable]
    if not getattr(sys,'frozen',False):command.append(str(Path(__file__).resolve()))
    command.extend(['--dashboard-only','--home',str(home),'--config',str(config_path),
                    '--folder',str(folder),'--dashboard-port',str(port),'--dashboard-instance',instance,
                    '--dashboard-parent-pid',str(os.getpid()),'--dashboard-parent-created',str(psutil.Process().create_time()),'--no-browser'])
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


def main(argv=None, stop_event=None, update_argv=None, on_event=None):
    default=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ClassicWorldMarket'
    parser=argparse.ArgumentParser()
    parser.add_argument('--home',type=Path,default=default)
    parser.add_argument('--version',action='version',version='ClassicWorldCollector '+VERSION)
    parser.add_argument('--check-updates',action='store_true',help='Check official stable releases without capture')
    parser.add_argument('--repair-history',action='store_true',help='Restore missing historical locations from saved captures, without starting capture')
    parser.add_argument('--no-update',action='store_true',help='Disable automatic update checks for this run')
    parser.add_argument('--apply-update',type=Path,help=argparse.SUPPRESS)
    parser.add_argument('--legacy-update-bridge',type=Path,help=argparse.SUPPRESS)
    parser.add_argument('--check-firewall',action='store_true',help='Configure and verify only this executable game-port firewall rule; no capture or upload')
    parser.add_argument('--backend',choices=('windows','windivert'),default='windows',help='Windows native receive-only capture; legacy WinDivert is optional')
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
    parser.add_argument('--dashboard-parent-pid',type=int,default=0,help=argparse.SUPPRESS)
    parser.add_argument('--dashboard-parent-created',type=float,default=0,help=argparse.SUPPRESS)
    parser.add_argument('--no-dashboard',action='store_true')
    parser.add_argument('--no-browser',action='store_true')
    args=parser.parse_args(argv);args.home.mkdir(parents=True,exist_ok=True)
    if args.legacy_update_bridge:
        from collector_legacy_update import run_bridge
        run_bridge(args.legacy_update_bridge);return
    if args.apply_update:
        from collector_update import apply_plan
        apply_plan(args.apply_update);return
    if args.check_updates:
        from collector_update import read_release
        update=read_release()
        print(json.dumps(dict(current=VERSION,available=update['version'] if update else None)));return
    if args.dashboard_only:
        from collector_dashboard import run
        config=json.loads((args.config or args.home/'member.json').read_text(encoding='utf-8'))
        run(args.home,config,args.folder or args.home/'captures',args.dashboard_port,args.dashboard_instance,args.dashboard_parent_pid,args.dashboard_parent_created)
        return
    if args.repair_history:
        from collector_history import repair_history
        config=json.loads((args.config or args.home/'member.json').read_text(encoding='utf-8-sig'))
        recovered=repair_history([args.folder or args.home/'captures',*config.get('extra_folders',[])],config,upload_opener,threading.Event())
        print(f'Restored locations for {recovered} historical observations.',flush=True)
        return
    if args.self_test:
        from market_proxy import Proxy, allowed_destination
        from classicworld_codec import aes_payload, advance
        iv=bytes.fromhex('01020304');plain=b'codec-self-test'
        assert aes_payload(aes_payload(plain,iv),iv)==plain
        assert len(advance(iv))==4
        print('Codec self-test passed',flush=True)
        from collector_legacy_update import maybe_start_bridge
        maybe_start_bridge();return
    if args.check_firewall or not (args.once or args.upload_only or args.proxy):
        import ctypes
        if os.name=='nt' and not ctypes.windll.shell32.IsUserAnAdmin():
            if getattr(sys,'frozen',False):
                result=ctypes.windll.shell32.ShellExecuteW(None,'runas',sys.executable,
                    subprocess.list2cmdline(sys.argv[1:]),None,1)
                if result<=32:raise PermissionError('Administrator permission was declined')
                return
            raise PermissionError('Run Python as administrator for passive capture')
    if args.check_firewall:
        from native_firewall import ensure_capture_firewall
        print(json.dumps(dict(event='firewall_ready',**ensure_capture_firewall())),flush=True)
        return
    if args.capture_only:
        from market_passive import run
        run(args.folder or args.home/'captures',args.seconds,args.backend);return
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
    capture_changed=threading.Event()
    stopping=stop_event if stop_event is not None else threading.Event()
    update_ready=[]
    def history_worker():
        from collector_history import repair_history
        for attempt in range(3):
            if stopping.is_set():return
            try:
                recovered=repair_history([folder,*config.get('extra_folders',[])],config,upload_opener,stopping)
                if recovered:print(f'Restored locations for {recovered} historical observations.',flush=True)
                return
            except Exception as error:
                print(f'Historical location recovery deferred ({type(error).__name__}).',flush=True)
                if stopping.wait(60*(attempt+1)):return
    def worker():
        attempts = 0
        while not stopping.is_set():
            capture_changed.clear()
            retry=False
            try:
                count=upload_once(folder,config,ledger,stop=stopping,on_event=on_event)
                for extra in config.get('extra_folders',[]):
                    import hashlib
                    source=Path(extra)
                    extra_ledger=args.home/('upload_'+hashlib.sha256(str(source.resolve()).encode()).hexdigest()[:12]+'.sqlite')
                    count+=upload_once(source,config,extra_ledger,stop=stopping)
                if count:
                    print(f'Uploaded {count} observations.',flush=True)
                    if on_event:on_event({'type':'uploaded','count':count})
                attempts=0
            except Exception as error:
                if args.once:
                    raise
                retry=True
                attempts+=1
                print(f'Upload unavailable ({type(error).__name__}); will retry.',flush=True)
                if on_event:on_event({'type':'upload_error'})
                if isinstance(error, (OSError, sqlite3.Error)) and not isinstance(error, (urllib.error.URLError, TimeoutError, ConnectionError, InterruptedError)):
                    if on_event:on_event({'type':'storage_error'})
                # Auth failures require intervention. Transient HTTP failures
                # retain the queue and respect Retry-After, even if new captures
                # arrive continuously and keep the filesystem event signalled.
                delay = 300 if isinstance(error, urllib.error.HTTPError) and error.code in (401,403) else retry_delay(attempts,error)
            if args.once or stopping.is_set():break
            if retry:stopping.wait(delay)
            else:capture_changed.wait(5)
    def owner_history_worker():
        from collector_owner_migration import migrate_owners
        import hashlib
        sources=[(folder,ledger)]
        for extra in config.get('extra_folders',[]):
            source=Path(extra)
            sources.append((source,args.home/('upload_'+hashlib.sha256(str(source.resolve()).encode()).hexdigest()[:12]+'.sqlite')))
        # Historical repairs never block the event-driven live uploader. Share
        # one rate budget across capture folders and retry interrupted batches.
        while not stopping.is_set():
            for source,source_ledger in sources:
                if stopping.is_set():return
                try:
                    count=migrate_owners(source,config,source_ledger,upload_opener(),stop=stopping,limit=10)
                    if count:print(f'Restored shop owners for {count} historical observations.',flush=True)
                except (OSError,ValueError,sqlite3.Error):
                    pass
                if stopping.wait(10):return
    if args.once:worker();return
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    class CaptureHandler(FileSystemEventHandler):
        def on_any_event(self,event):
            path=Path(getattr(event,'dest_path','') or event.src_path)
            if not event.is_directory and (path.match('shop_*.json') or path.match('presence_*.json') or path.match('roster_*.json') or path.name=='map_observations.jsonl'):
                capture_changed.set()
    observer=Observer()
    sources={folder.resolve(),*(Path(p).resolve() for p in config.get('extra_folders',[]))}
    for source in sources:
        source.mkdir(parents=True,exist_ok=True)
        observer.schedule(CaptureHandler(),str(source),recursive=False)
    observer.start()
    dashboard=None
    if not args.no_dashboard:
        try:dashboard=start_dashboard(args.home,config_path,folder,args.dashboard_port,not args.no_browser)
        except Exception as error:print(f'Personal alerts unavailable ({type(error).__name__}); see dashboard.log.',flush=True)
    if getattr(sys,'frozen',False) and os.name=='nt' and not args.no_update and not args.proxy:
        from collector_update import start_checker
        start_checker(args.home,stopping,update_ready,sys.argv[1:] if update_argv is None else update_argv,capture_changed,endpoint=config['endpoint'])
    upload_thread=None
    history_thread=None
    owner_thread=None
    monitor_thread=None
    try:
        history_thread=threading.Thread(target=history_worker,daemon=True);history_thread.start()
        owner_thread=threading.Thread(target=owner_history_worker,daemon=True);owner_thread.start()
        if args.upload_only:worker();return
        upload_thread=threading.Thread(target=worker,daemon=True);upload_thread.start()
        def supervise_upload():
            nonlocal upload_thread
            while not stopping.wait(1):
                if not upload_thread.is_alive():
                    print('Upload worker exited; restarting retained queue.', flush=True)
                    upload_thread=threading.Thread(target=worker,daemon=True)
                    upload_thread.start()
        monitor_thread=threading.Thread(target=supervise_upload,daemon=True,name='upload-supervisor')
        monitor_thread.start()
        if not args.proxy:
            from market_passive import run
            print('Receive-only capture: ' + args.backend + ' backend. Reconnect once, then browse manually.',flush=True)
            run(folder,args.seconds,args.backend,stop_event=stopping,on_event=on_event);return
        from market_proxy import Proxy
        print('Local proxy 127.0.0.1:1088. Reconnect game channel after importing profile. Browse manually. Close game session before stopping collector.',flush=True)
        asyncio.run(Proxy(folder,allow_requests=False,market_only=True).run())
    finally:
        stopping.set();capture_changed.set()
        if monitor_thread:monitor_thread.join(timeout=2)
        observer.stop();observer.join(timeout=5)
        stop_dashboard(dashboard)
        if upload_thread:upload_thread.join(timeout=40)
        if history_thread:history_thread.join(timeout=25)
        if owner_thread:owner_thread.join(timeout=20)
        if update_ready and (upload_thread is None or not upload_thread.is_alive()):
            path,bundle=update_ready[0]
            subprocess.Popen([str(bundle/'ClassicWorldCollector.exe'),'--apply-update',str(path)],
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)


if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:pass
    except Exception as error:
        if '--once' in sys.argv:
            import traceback
            traceback.print_exc()
        print(f'Collector stopped: {type(error).__name__}: {error}',flush=True)
        if getattr(sys,'frozen',False) and '--apply-update' not in sys.argv and sys.stdin and sys.stdin.isatty():
            try:input('Press Enter to exit.')
            except EOFError:pass
        sys.exit(1)
