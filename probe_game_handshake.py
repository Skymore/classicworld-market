"""Open one separate TCP connection and read greeting only; sends no application data."""
import argparse
import json
import socket
from pathlib import Path
from datetime import datetime, timezone

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host')
    parser.add_argument('port',type=int)
    args=parser.parse_args()
    output={'host':args.host,'port':args.port,'time_utc':datetime.now(timezone.utc).isoformat(),
            'application_bytes_sent':0,'received_hex':'','status':None}
    try:
        with socket.create_connection((args.host,args.port),timeout=5) as connection:
            connection.settimeout(3)
            data=connection.recv(4096)
            output.update(received_hex=data.hex(),received_bytes=len(data),status='greeting_received' if data else 'closed_without_greeting')
    except (OSError,TimeoutError) as error:
        output.update(status='connection_or_read_failed',error=str(error))
    folder=Path(__file__).resolve().parent/'network_captures'/'handshake_probe'
    folder.mkdir(exist_ok=True)
    path=folder/(datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')+'.json')
    path.write_text(json.dumps(output,indent=2),encoding='utf-8')
    print(json.dumps(output,indent=2))

if __name__=='__main__':main()
