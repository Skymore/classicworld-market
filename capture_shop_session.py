"""Capture a known game endpoint BEFORE returning to its channel, preserving its handshake.

Run elevated. This is a passive capture, never a game request sender.
"""
import argparse
import ctypes
from datetime import datetime
import json
import time
import ipaddress
from monitor_market import ROOT, Capture, connections

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds',type=int,default=180)
    parser.add_argument('--server-subnet',action='append',default=[])
    args=parser.parse_args()
    if not 15<=args.seconds<=600:
        parser.error('seconds must be between 15 and 600')
    if not ctypes.windll.shell32.IsUserAnAdmin():
        raise RuntimeError('Run in an administrator PowerShell window.')
    endpoints,records=connections()
    endpoints={(ip,port) for ip,port in endpoints if 8500<=port<8600}
    if not endpoints:
        raise RuntimeError('No current MapleStory channel connection. Enter the game first.')
    if len(endpoints)>4:
        raise RuntimeError('Ambiguous channel endpoints; no capture started.')
    # Arm before reconnecting. A returned channel can use a different host/port.
    subnets={str(ipaddress.ip_network(ip+'/24',strict=False)) for ip,port in endpoints}
    subnets.update(str(ipaddress.ip_network(s,strict=True)) for s in args.server_subnet)
    if any(not 8544<=port<=8559 for ip,port in endpoints):
        raise RuntimeError('Current port outside validated capture band 8544..8559.')
    filters={(subnet,port) for subnet in subnets for port in range(8544,8560)}
    if len(filters)>32:
        raise RuntimeError('Capture scope exceeds PktMon filter limit.')
    folder=ROOT/'network_captures'/('shop_session_'+datetime.now().strftime('%Y%m%d_%H%M%S'))
    folder.mkdir()
    def event(kind,**fields):
        with (folder/'events.jsonl').open('a',encoding='utf-8') as f:
            f.write(json.dumps(dict(time=datetime.now().astimezone().isoformat(),event=kind,**fields))+'\n')
    capture=Capture(folder,event)
    try:
        capture.start(filters)
        event('initial_connections',connections=records)
        event('scope',server_subnets=sorted(subnets),ports=[8544,8559])
        print('CAPTURING. Remember your current channel.',flush=True)
        print('Change to another channel, then RETURN to the original channel.',flush=True)
        print('Open and close the SAME shop three times, waiting 2 seconds each time.',flush=True)
        print('Game server subnet/port filters are armed before reconnecting.',flush=True)
        print(f'Automatic stop in {args.seconds} seconds. Output: {folder}',flush=True)
        end=time.monotonic()+args.seconds
        while time.monotonic()<end:
            if (folder/'stop.request').exists():
                event('stop_requested');break
            if sum(p.stat().st_size for p in folder.glob('*.etl'))>256*1024*1024:
                event('storage_limit');break
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        capture.finish()
        event('capture_stopped')

if __name__=='__main__':main()
