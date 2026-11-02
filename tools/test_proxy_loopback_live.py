"""Administrator-only smoke check using synthetic localhost traffic, no game input."""
import argparse
import json
import socket
import sys
import threading
import time
from pathlib import Path


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--driver-root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    sys.path[:0]=[str(root),str(root/'scanner')]
    sys._MEIPASS=str(args.driver_root)
    from market_passive import Sniffer
    handles=[];seen=[False]*3;errors=[];done=threading.Event()
    marker=b'collector-loopback-readonly-smoke'
    try:
        with socket.socket() as server:
            server.bind(('127.0.0.1',0));server.listen()
            port=server.getsockname()[1]
            for index in range(3):
                handle=Sniffer(f'loopback and ip and tcp and tcp.SrcPort == {port}')
                handles.append(handle)
                def receive(slot=index, reader=handle):
                    try:
                        while not done.is_set():
                            if marker in reader.recv():seen[slot]=True
                    except OSError:
                        if not done.is_set():errors.append('receiver_failed')
                threading.Thread(target=receive,daemon=True).start()
            with socket.create_connection(('127.0.0.1',port)) as client:
                peer,_=server.accept()
                with peer:
                    peer.sendall(marker)
                    assert client.recv(len(marker))==marker
                    deadline=time.monotonic()+5
                    while not all(seen) and time.monotonic()<deadline:time.sleep(.05)
    except Exception as error:
        errors.append(type(error).__name__+': '+str(error))
    finally:
        done.set()
        for handle in handles:handle.close()
        args.output.write_text(json.dumps({'readers':seen,'errors':errors,'passed':all(seen) and not errors}),encoding='utf-8')
    return 0 if all(seen) and not errors else 1


if __name__=='__main__':raise SystemExit(main())
