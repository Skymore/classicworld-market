"""Receive-only Windows collector. No network forwarding or packet send API."""
import ctypes
import json
import os
import queue
import struct
import sys
import threading
import time
from pathlib import Path
from classicworld_codec import advance, frame_header
from market_proxy import Session
from market_inventory import Inventory

# Channel connections have also been observed on 8913. Keep a bounded game
# service range; process ownership is still required before any decoding.
GAME_PORT_MIN, GAME_PORT_MAX = 8500, 8999
FILTER = f'inbound and ip and tcp and !loopback and tcp.SrcPort >= {GAME_PORT_MIN} and tcp.SrcPort <= {GAME_PORT_MAX}'
SNIFF_RECV_ONLY = 1 | 4
LIMIT = 1024 * 1024


def packet(raw):
    if len(raw)<40 or raw[0]>>4!=4 or raw[9]!=6:return None
    ihl=(raw[0]&15)*4;total=int.from_bytes(raw[2:4],'big')
    if ihl<20 or total>len(raw) or total<ihl+20 or int.from_bytes(raw[6:8],'big')&0x3fff:return None
    tcp=raw[ihl:total];offset=(tcp[12]>>4)*4
    if offset<20 or offset>len(tcp):return None
    sport,dport,seq=struct.unpack_from('!HHI',tcp)
    if not GAME_PORT_MIN<=sport<=GAME_PORT_MAX:return None
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
    def __init__(self,folder,owner=game_owner,on_event=None):
        self.folder=Path(folder);self.folder.mkdir(parents=True,exist_ok=True)
        self.owner=owner;self.flows={};self.ignored=0;self.captured=0;self.last_status=0;self.message_counts={};self.last_shop_at=None
        self.last_status_attempt=0
        self._status_warnings={}
        self.on_event=on_event
        self.inventory=Inventory()
    def write_status(self, path, state):
        """UI diagnostics are best effort; file readers must not stop capture."""
        temporary=path.with_suffix('.json.tmp')
        try:
            with temporary.open('w',encoding='utf-8') as out:
                json.dump(state,out);out.flush();os.fsync(out.fileno())
            temporary.replace(path)
            self._status_warnings.pop(path.name,None)
            return True
        except OSError as error:
            now=time.monotonic()
            if now-self._status_warnings.get(path.name,-float('inf'))>=60:
                self._status_warnings[path.name]=now
                print(json.dumps(dict(time=time.time(),event='status_write_deferred',
                    file=path.name,error=type(error).__name__,winerror=getattr(error,'winerror',None))),flush=True)
            return False
    def event(self,kind,**fields):
        entry=dict(time=time.time(),event=kind,**fields)
        if kind=='shop_list':self.last_shop_at=entry['time']
        if kind=='map_location':self.last_location=fields.get('location');self.last_map_at=entry['time']
        path=self.folder/'passive_events.jsonl'
        if path.exists() and path.stat().st_size>4*LIMIT:
            path.replace(self.folder/'passive_events.previous.jsonl')
        with path.open('a',encoding='utf-8') as out:out.write(json.dumps(entry,ensure_ascii=False)+'\n')
        print(json.dumps(entry,ensure_ascii=True),flush=True)
        if kind=='shop_list' and self.on_event:
            try:
                self.on_event(dict(type='captured',file=fields.get('file'),items=fields.get('item_count')))
            except Exception as error:
                print(f'Capture statistics unavailable ({type(error).__name__}).',flush=True)
    def check_owner(self,key,flow,now):
        if flow['decoder'] is None and now>=flow['check']:
            flow['check']=now+0.2
            if self.owner(key):
                session=Session(self,None,None,None,None,key[0],key[1])
                flow['session']=session.id
                self.invalidate_inventory()
                flow['decoder']=Decoder(self.observer(session))
                self.event('game_flow_detected',session=session.id)
                flow['decoder'].feed(flow['buffer']);flow['buffer'].clear()
    def publish_inventory(self):
        return self.write_status(self.folder/'inventory_state.json',
                                 dict(alive_at=int(time.time()), holdings=self.inventory.view()))

    def invalidate_inventory(self, session=None):
        self.inventory.invalidate(session)
        self.publish_inventory()

    def observer(self,session):
        def observe(plain):
            revision = self.inventory.revision
            self.inventory.observe(plain, session.id)
            if self.inventory.revision != revision:
                # Publish the actual stream delta now, not on the 2 s status tick.
                self.publish_inventory()
            # Mapping tables are for active client requests, never needed here.
            opcode=int.from_bytes(plain[:2],'little')
            label=hex(opcode)
            if label in self.message_counts or len(self.message_counts)<256:
                self.message_counts[label]=self.message_counts.get(label,0)+1
            # Roster completion needs the ordered stream, including unexpected
            # frames that invalidate an incomplete initialization envelope.
            if opcode == 0x32:
                session.roster.reset()
                return
            try:session.observe(plain)
            except OSError:
                if self.on_event:
                    self.on_event(dict(type='storage_error'))
                raise
            except Exception as error:
                session.roster.reset()
                session.pending_open=None;session.pending_raw_path=None
                if opcode in (0x1a6,0x1a9):session.market_location=None
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
        if flags&4:
            self.invalidate_inventory(flow.get('session'))
            self.flows.pop(key,None);return
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
            self.invalidate_inventory(flow.get('session'))
            if flow['stream'].pending or (flow['decoder'] and flow['decoder'].buf):self.fail(flow,'Incomplete stream on close')
            self.flows.pop(key,None)
    def fail(self,flow,reason):
        self.invalidate_inventory(flow.get('session'))
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
            if now-flow['last']>600:
                self.invalidate_inventory(flow.get('session'))
                self.flows.pop(key,None);continue
            gap=flow['stream'].gap_since
            if not flow['failed'] and gap is not None and now-gap>10:self.fail(flow,'TCP gap timeout')
        if now-self.last_status_attempt>2:
            self.last_status_attempt=now
            self.publish_inventory()
            state=dict(time=time.time(),mode=getattr(self,'mode','windivert-sniff-recv-only'),packets=self.captured,
                waiting_for_handshake=self.ignored,connections=len(self.flows),
                decoding=sum(bool(f['decoder'] and f['decoder'].iv and not f['failed']) for f in self.flows.values()),
                failed=sum(f['failed'] for f in self.flows.values()),
                frames=sum(f['decoder'].frames for f in self.flows.values() if f['decoder']),
                message_counts=self.message_counts,last_shop_at=self.last_shop_at,
                capture_ports=f'{GAME_PORT_MIN}-{GAME_PORT_MAX}',
                health_state=getattr(self,'health_state',None),
                location=getattr(self,'last_location',None),last_map_at=getattr(self,'last_map_at',None))
            status=self.folder/'passive_status.json'
            if self.write_status(status,state):self.last_status=now


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



class WindowsSniffer:
    """Receive IP copies through Winsock; never bind any send/injection API."""
    mode='windows-raw-receive-only'
    def __init__(self, accept=packet):
        import socket,ipaddress
        import psutil
        if sys.platform!='win32':raise RuntimeError('Windows is required')
        if not ctypes.windll.shell32.IsUserAnAdmin():raise PermissionError('Run collector as administrator')
        from native_firewall import ensure_capture_firewall
        firewall=ensure_capture_firewall()
        print(json.dumps(dict(event='firewall_ready',**firewall)),flush=True)
        self.sockets=[];self.handle=True;self.accept=accept
        self.received_datagrams=0;self.matched_datagrams=0
        self.tcp_datagrams=0;self.game_outbound_datagrams=0
        stats=psutil.net_if_stats()
        for name,addresses in psutil.net_if_addrs().items():
            if not stats.get(name) or not stats[name].isup:continue
            for address in addresses:
                if address.family!=socket.AF_INET:continue
                ip=ipaddress.ip_address(address.address)
                if ip.is_loopback or ip.is_link_local or ip.is_unspecified:continue
                sock=None
                try:
                    sock=socket.socket(socket.AF_INET,socket.SOCK_RAW,socket.IPPROTO_IP)
                    sock.bind((str(ip),0));sock.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4*1024*1024)
                    sock.ioctl(socket.SIO_RCVALL,getattr(socket,'RCVALL_IPLEVEL',3))
                    self.sockets.append(sock)
                except OSError:
                    if sock:sock.close()
        if not self.sockets:raise OSError('No active IPv4 interface supports Windows receive-only capture')
    def recv(self):
        import select
        while self.handle is not None:
            ready,_,_=select.select(self.sockets,[],[],0.5)
            for sock in ready:
                raw=sock.recv(65535)
                self.received_datagrams+=1
                if len(raw)>=40 and raw[0]>>4==4 and raw[9]==6:
                    self.tcp_datagrams+=1
                    ihl=(raw[0]&15)*4
                    if ihl>=20 and len(raw)>=ihl+4 and GAME_PORT_MIN<=int.from_bytes(raw[ihl+2:ihl+4],'big')<=GAME_PORT_MAX:
                        self.game_outbound_datagrams+=1
                # Only game service ports proceed to the owner gate/decoder.
                if self.accept(raw):
                    self.matched_datagrams+=1
                    return raw
        raise OSError('Capture closed')
    def close(self):
        import socket
        self.handle=None
        for sock in self.sockets:
            try:sock.ioctl(socket.SIO_RCVALL,socket.RCVALL_OFF)
            except OSError:pass
            sock.close()
        self.sockets=[]


def capture_health(collector,game_connected,elapsed):
    active=list(collector.flows.values())
    decoding=any(f['decoder'] and f['decoder'].iv and not f['failed'] for f in active)
    if decoding:
        if collector.last_shop_at:
            return 'capturing','Shop items recorded / 已记录摊位商品；Uploaded 才表示上传确认。'
        return 'connected','Game stream decoded / 游戏连接解析正常，请手动打开摊位。'
    if any(f['failed'] for f in active):
        return 'parse_error','Reconnect game / 解析中断，请切换频道或重新登录。'
    if game_connected is False:
        return 'no_game','Waiting for MapleStory / 尚无游戏频道连接，请启动游戏并切换频道。'
    if collector.captured:
        return 'handshake','Inbound received; reconnect game / 已收到入站包，请切换频道以读取握手。'
    if elapsed>=15 and game_connected:
        return 'no_inbound','No inbound game packets / 游戏已连接但未收到入站包；请检查代理或防火墙策略，不要关闭安全防护。'
    return 'waiting','Waiting for inbound game packets / 正在检查游戏入站收包。'


def run(folder,seconds=0,backend="windivert",stop_event=None,on_event=None):
    collector=Collector(folder,on_event=on_event);sniffer=WindowsSniffer() if backend=="windows" else Sniffer();collector.mode=getattr(sniffer,"mode","windivert-sniff-recv-only");packets=queue.Queue(maxsize=8192);overflow=threading.Event()
    def receive():
        while sniffer.handle is not None:
            try:raw=sniffer.recv()
            except Exception as error:
                packets.put(error);return
            try:packets.put_nowait(raw)
            except queue.Full:overflow.set()
    thread=threading.Thread(target=receive,daemon=True);thread.start();started=time.monotonic()
    last_health_check=0;health_state=None
    collector.event('capture_started',mode=collector.mode,message='Disable Proxifier for MapleStory; reconnect once, then browse manually.')
    try:
        while (not seconds or time.monotonic()-started<seconds) and not (stop_event and stop_event.is_set()):
            if overflow.is_set():
                for flow in collector.flows.values():collector.fail(flow,'Local capture queue overflow')
                overflow.clear()
            try:
                raw=packets.get(timeout=0.5)
                if isinstance(raw,Exception):raise raw
                collector.receive(raw)
            except queue.Empty:pass
            now=time.monotonic()
            if backend=='windows' and now-last_health_check>=5:
                last_health_check=now
                import psutil
                try:
                    game_connected=any(c.pid and c.raddr and GAME_PORT_MIN<=c.raddr.port<=GAME_PORT_MAX
                        and game_owner((c.raddr.ip,c.raddr.port,c.laddr.ip,c.laddr.port))
                        for c in psutil.net_connections(kind='tcp4'))
                except (OSError,psutil.Error):game_connected=None
                state,message=capture_health(collector,game_connected,now-started)
                collector.health_state=state
                if state!=health_state:
                    collector.event('capture_health',state=state,message=message)
                    health_state=state
            previous_status=collector.last_status
            collector.tick()
            if backend=="windows" and collector.last_status!=previous_status:
                diagnostic=collector.folder/'native_health.json'
                collector.write_status(diagnostic,dict(time=time.time(),reader_alive=thread.is_alive(),
                    sockets=len(sniffer.sockets),received_datagrams=sniffer.received_datagrams,
                    matched_datagrams=sniffer.matched_datagrams,tcp_datagrams=sniffer.tcp_datagrams,
                    game_outbound_datagrams=sniffer.game_outbound_datagrams))
    finally:
        sniffer.close();thread.join(timeout=2)
        collector.inventory.invalidate()
        collector.write_status(collector.folder/'inventory_state.json', dict(alive_at=int(time.time()), holdings=None))
        collector.event('capture_stopped')


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--folder',type=Path,required=True)
    parser.add_argument('--seconds',type=int,default=0);parser.add_argument('--backend',choices=('windows','windivert'),default='windivert');args=parser.parse_args()
    try:run(args.folder,args.seconds,args.backend)
    except KeyboardInterrupt:pass
