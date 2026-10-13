"""Receive-only WinDivert collector. No network forwarding or packet send API."""
import ctypes
import json
import queue
import struct
import sys
import threading
import time
from pathlib import Path
from classicworld_codec import advance, frame_header
from market_proxy import Session

FILTER = 'inbound and ip and tcp and !loopback and tcp.SrcPort >= 8500 and tcp.SrcPort <= 8599'
SNIFF_RECV_ONLY = 1 | 4
LIMIT = 1024 * 1024


def packet(raw):
    if len(raw)<40 or raw[0]>>4!=4 or raw[9]!=6:return None
    ihl=(raw[0]&15)*4;total=int.from_bytes(raw[2:4],'big')
    if ihl<20 or total>len(raw) or total<ihl+20 or int.from_bytes(raw[6:8],'big')&0x3fff:return None
    tcp=raw[ihl:total];offset=(tcp[12]>>4)*4
    if offset<20 or offset>len(tcp):return None
    sport,dport,seq=struct.unpack_from('!HHI',tcp)
    if not 8500<=sport<=8599:return None
    src='.'.join(map(str,raw[12:16]));dst='.'.join(map(str,raw[16:20]))
    return (src,sport,dst,dport),seq,tcp[13],tcp[offset:]


class Stream:
    """Bounded TCP reassembly anchored at SYN, with serial-number wrap handling."""
    def __init__(self,seq):
        self.next=seq&0xffffffff;self.pending=[];self.gap_since=None

    def feed(self,seq,data,now):
        offset=((seq-self.next+2**31)%2**32)-2**31
        if offset<0:
            data=data[min(-offset,len(data)):];offset=0
        if data:
            if offset>LIMIT:raise ValueError('TCP gap exceeds limit')
            for pos,other in self.pending:
                lo=max(pos,offset);hi=min(pos+len(other),offset+len(data))
                if hi>lo and other[lo-pos:hi-pos]!=data[lo-offset:hi-offset]:
                    raise ValueError('Conflicting TCP overlap')
            if (offset,data) not in self.pending:self.pending.append((offset,data))
        if len(self.pending)>512 or sum(len(b) for _,b in self.pending)>LIMIT:
            raise ValueError('TCP reassembly limit')
        result=bytearray();self.pending.sort(key=lambda p:p[0])
        while self.pending and self.pending[0][0]<=len(result):
            offset,data=self.pending.pop(0)
            result.extend(data[max(0,len(result)-offset):])
        self.next=(self.next+len(result))&0xffffffff
        self.pending=[(pos-len(result),data) for pos,data in self.pending]
        self.gap_since=(self.gap_since if self.gap_since is not None else now) if self.pending else None
        return bytes(result)


class Decoder:
    def __init__(self,observe):self.buf=bytearray();self.iv=None;self.observe=observe;self.frames=0
    def feed(self,data):
        self.buf.extend(data)
        if len(self.buf)>LIMIT:raise ValueError('Frame buffer limit')
        if self.iv is None:
            if len(self.buf)<21:return
            if self.buf[:11].hex()!='1300010001000000010030':raise ValueError('Unsupported greeting')
            self.iv=bytes(self.buf[15:19]);del self.buf[:21]
        while len(self.buf)>=4:
            header=bytes(self.buf[:4]);a,b=struct.unpack('<HH',header);length=a^b
            if length<2 or header!=frame_header(length,self.iv,False):raise ValueError('Frame/IV mismatch; reconnect required')
            if len(self.buf)<4+length:return
            plain=bytes((b-self.iv[0])&255 for b in self.buf[4:4+length])
            del self.buf[:4+length];self.iv=advance(self.iv);self.frames+=1
            self.observe(plain)


def game_owner(key):
    import psutil
    remote,rport,local,lport=key
    for conn in psutil.net_connections(kind='tcp4'):
        if conn.pid and conn.raddr and tuple(conn.laddr)==(local,lport) and tuple(conn.raddr)==(remote,rport):
            try:return psutil.Process(conn.pid).name().lower()=='maplestory.exe'
            except (psutil.NoSuchProcess,psutil.AccessDenied):return False
    return False


class Collector:
    market_only=True
    def __init__(self,folder,owner=game_owner):
        self.folder=Path(folder);self.folder.mkdir(parents=True,exist_ok=True)
        self.owner=owner;self.flows={};self.ignored=0;self.captured=0;self.last_status=0
    def event(self,kind,**fields):
        entry=dict(time=time.time(),event=kind,**fields)
        path=self.folder/'passive_events.jsonl'
        if path.exists() and path.stat().st_size>4*LIMIT:
            path.replace(self.folder/'passive_events.previous.jsonl')
        with path.open('a',encoding='utf-8') as out:out.write(json.dumps(entry,ensure_ascii=False)+'\n')
        print(json.dumps(entry,ensure_ascii=True),flush=True)
    def check_owner(self,key,flow,now):
        if flow['decoder'] is None and now>=flow['check']:
            flow['check']=now+0.2
            if self.owner(key):
                session=Session(self,None,None,None,None,key[0],key[1])
                flow['decoder']=Decoder(self.observer(session))
                self.event('game_flow_detected',session=session.id)
                flow['decoder'].feed(flow['buffer']);flow['buffer'].clear()
    def observer(self,session):
        def observe(plain):
            # Mapping tables are for active client requests, never needed here.
            opcode=int.from_bytes(plain[:2],'little')
            if opcode not in (0x1a6,0x23a,0x577,0x578):return
            try:session.observe(plain)
            except Exception as error:
                session.pending_open=None;session.pending_raw_path=None
                if opcode==0x1a6:session.market_location=None
                self.event('observation_rejected',opcode=opcode,reason=str(error))
        return observe
    def receive(self,raw,now=None):
        now=time.monotonic() if now is None else now
        parsed=packet(raw)
        if not parsed:return
        self.captured+=1;key,seq,flags,data=parsed
        flow=self.flows.get(key)
        if flags&0x12==0x12:
            if flow and flow['syn']==seq:return # SYN retransmit must not reset IV.
            if len(self.flows)>=64:self.flows.pop(next(iter(self.flows)))
            flow=dict(syn=seq,stream=Stream(seq+1),decoder=None,buffer=bytearray(),created=now,last=now,check=0,failed=False)
            self.flows[key]=flow
        if not flow:self.ignored+=1;return
        flow['last']=now
        if flags&4:self.flows.pop(key,None);return
        if flow['failed']:return
        try:
            ordered=flow['stream'].feed((seq+bool(flags&2))&0xffffffff,data,now)
            if flow['decoder'] is None:
                flow['buffer'].extend(ordered)
                if len(flow['buffer'])>LIMIT:raise ValueError('Pending owner buffer limit')
                self.check_owner(key,flow,now)
            else:flow['decoder'].feed(ordered)
        except Exception as error:
            self.fail(flow,str(error))
        if flags&1:
            if flow['stream'].pending or (flow['decoder'] and flow['decoder'].buf):self.fail(flow,'Incomplete stream on close')
            self.flows.pop(key,None)
    def fail(self,flow,reason):
        flow['failed']=True;flow['buffer'].clear();flow['stream'].pending.clear()
        if flow['decoder']:flow['decoder'].buf.clear()
        self.event('reconnect_required',reason=reason)
    def tick(self,now=None):
        now=time.monotonic() if now is None else now
        for key,flow in list(self.flows.items()):
            if not flow['failed']:
                try:self.check_owner(key,flow,now)
                except Exception as error:self.fail(flow,str(error))
            if flow['decoder'] is None and now-flow['created']>3:
                self.flows.pop(key,None);continue
            if now-flow['last']>600:self.flows.pop(key,None);continue
            gap=flow['stream'].gap_since
            if not flow['failed'] and gap is not None and now-gap>10:self.fail(flow,'TCP gap timeout')
        if now-self.last_status>2:
            state=dict(time=time.time(),mode='windivert-sniff-recv-only',packets=self.captured,
                waiting_for_handshake=self.ignored,connections=len(self.flows),
                decoding=sum(bool(f['decoder'] and f['decoder'].iv and not f['failed']) for f in self.flows.values()),
                failed=sum(f['failed'] for f in self.flows.values()))
            (self.folder/'passive_status.json').write_text(json.dumps(state),encoding='utf-8');self.last_status=now


class Sniffer:
    def __init__(self, capture_filter=FILTER):
        # Validate ownership lookup before reporting a running capture.
        try:import psutil
        except ImportError as error:
            raise RuntimeError('Missing psutil. Install requirements-shared.txt in the collector Python environment.') from error
        if sys.platform!='win32':raise RuntimeError('Windows is required')
        if not ctypes.windll.shell32.IsUserAnAdmin():raise PermissionError('Run collector as administrator')
        root=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))
        dll=root/'windivert'/'WinDivert.dll'
        if not dll.exists():dll=root/'vendor'/'windivert'/'WinDivert-2.2.2-A'/'x64'/'WinDivert.dll'
        self.dll=ctypes.WinDLL(str(dll),use_last_error=True)
        self.dll.WinDivertOpen.argtypes=[ctypes.c_char_p,ctypes.c_int,ctypes.c_short,ctypes.c_uint64]
        self.dll.WinDivertOpen.restype=ctypes.c_void_p
        self.dll.WinDivertRecv.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint,ctypes.POINTER(ctypes.c_uint),ctypes.c_void_p]
        self.dll.WinDivertRecv.restype=ctypes.c_bool
        self.dll.WinDivertShutdown.argtypes=[ctypes.c_void_p,ctypes.c_int]
        self.dll.WinDivertClose.argtypes=[ctypes.c_void_p]
        self.handle=self.dll.WinDivertOpen(capture_filter.encode(),0,0,SNIFF_RECV_ONLY)
        if self.handle==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        # Intentionally never bind or call WinDivertSend.
    def recv(self):
        buf=ctypes.create_string_buffer(65535);addr=ctypes.create_string_buffer(80);size=ctypes.c_uint()
        if not self.dll.WinDivertRecv(self.handle,buf,len(buf),ctypes.byref(size),addr):
            raise ctypes.WinError(ctypes.get_last_error())
        return buf.raw[:size.value]
    def close(self):
        if self.handle is not None:
            self.dll.WinDivertShutdown(self.handle,1)
            self.dll.WinDivertClose(self.handle);self.handle=None


def run(folder,seconds=0):
    collector=Collector(folder);sniffer=Sniffer();packets=queue.Queue(maxsize=8192);overflow=threading.Event()
    def receive():
        while sniffer.handle is not None:
            try:raw=sniffer.recv()
            except OSError as error:
                packets.put(error);return
            try:packets.put_nowait(raw)
            except queue.Full:overflow.set()
    thread=threading.Thread(target=receive,daemon=True);thread.start();started=time.monotonic()
    collector.event('capture_started',mode='SNIFF|RECV_ONLY',message='Disable Proxifier for MapleStory; reconnect once, then browse manually.')
    try:
        while not seconds or time.monotonic()-started<seconds:
            if overflow.is_set():
                for flow in collector.flows.values():collector.fail(flow,'Local capture queue overflow')
                overflow.clear()
            try:
                raw=packets.get(timeout=0.5)
                if isinstance(raw,Exception):raise raw
                collector.receive(raw)
            except queue.Empty:pass
            collector.tick()
    finally:
        sniffer.close();thread.join(timeout=2);collector.event('capture_stopped')


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--folder',type=Path,required=True)
    parser.add_argument('--seconds',type=int,default=0);args=parser.parse_args()
    try:run(args.folder,args.seconds)
    except KeyboardInterrupt:pass
