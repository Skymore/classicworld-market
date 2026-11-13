"""Receive-only Windows collector. No network forwarding or packet send API."""
import ctypes
import json
import os
import queue
import struct
import sys
import threading
import time
import uuid
from pathlib import Path
from classicworld_codec import advance, aes_payload, frame_header
from market_proxy import Session
from market_inventory import Inventory

# Capture copies only; process ownership and protocol greeting gate decoding.
FILTER = 'tcp'
SNIFF_RECV_ONLY = 1 | 4
LIMIT = 1024 * 1024
# Shown when the WinDivert copy is unavailable and only native capture runs.
LOCAL_UNAVAILABLE = '加速器连接不可用'


def packet(raw):
    from game_transport import tcp_packet
    parsed = tcp_packet(raw)
    if parsed and parsed[1] == 'server':
        connection, _, sequence, flags, data = parsed
        return connection, sequence, flags, data
    return None


def game_packet(raw):
    """Either direction of a game connection (the grind tracker reads both)."""
    from game_transport import tcp_packet
    return tcp_packet(raw) is not None


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


class ClientDecoder:
    """The player's own messages: AES frames under the greeting's client IV.

    Same layout the local proxy forwards (market_proxy.ClientBridge); only
    read here, never re-encoded or sent."""
    def __init__(self,iv,observe):self.buf=bytearray();self.iv=iv;self.observe=observe;self.frames=0
    def feed(self,data):
        self.buf.extend(data)
        if len(self.buf)>LIMIT:raise ValueError('Client frame buffer limit')
        while len(self.buf)>=4:
            header=bytes(self.buf[:4]);a,b=struct.unpack('<HH',header);length=a^b
            if length<2 or header!=frame_header(length,self.iv,True):raise ValueError('Client frame/IV mismatch')
            if len(self.buf)<4+length:return
            plain=aes_payload(bytes(self.buf[4:4+length]),self.iv)
            del self.buf[:4+length];self.iv=advance(self.iv);self.frames+=1
            self.observe(plain)
    def resync(self,missing,data):return resync(self,missing,data,True)


class Decoder:
    def __init__(self,observe):self.buf=bytearray();self.iv=None;self.civ=None;self.observe=observe;self.frames=0
    def feed(self,data):
        self.buf.extend(data)
        if len(self.buf)>LIMIT:raise ValueError('Frame buffer limit')
        if self.iv is None:
            if len(self.buf)<21:return
            if self.buf[:11].hex()!='1300010001000000010030':raise ValueError('Unsupported greeting')
            self.civ=bytes(self.buf[11:15]);self.iv=bytes(self.buf[15:19]);del self.buf[:21]
        while len(self.buf)>=4:
            header=bytes(self.buf[:4]);a,b=struct.unpack('<HH',header);length=a^b
            if length<2 or header!=frame_header(length,self.iv,False):raise ValueError('Frame/IV mismatch; reconnect required')
            if len(self.buf)<4+length:return
            plain=bytes((b-self.iv[0])&255 for b in self.buf[4:4+length])
            del self.buf[:4+length];self.iv=advance(self.iv);self.frames+=1
            self.observe(plain)
    def resync(self,missing,data):return resync(self,missing,data,False)


def resync(decoder,missing,data,client,frames=64):
    """Continue after `missing` bytes the capture never saw, then `data`.

    A lost segment used to leave the connection undecodable until the next
    channel change. The cipher only needs the right IV, and the IV advances
    once per frame: if the gap ends inside the frame in progress, that frame
    is dropped and decoding resumes exactly after it; otherwise try 0..63
    lost frames and take the earliest place where a frame header and the
    next one both match their IVs (a false match is about 1 in 4 billion).
    Returns the frames lost, or None when no alignment is certain."""
    if decoder.iv is None:return None
    iv,start,dropped=decoder.iv,None,0
    if len(decoder.buf)>=4:
        dropped=1
        a,b=struct.unpack('<HH',bytes(decoder.buf[:4]));owed=4+(a^b)-len(decoder.buf)
        iv=advance(iv)
        if missing<owed:start=owed-missing      # the gap ended inside this frame
    def header_ok(at,key):
        if at+4>len(data):return False
        a,b=struct.unpack_from('<HH',data,at);length=a^b
        return length>=2 and data[at:at+4]==frame_header(length,key,client)
    def confirmed(at,key):
        if not header_ok(at,key):return False
        a,b=struct.unpack_from('<HH',data,at);following=at+4+(a^b)
        return header_ok(following,advance(key))
    best=None
    key=iv
    for lost in range(frames if start is None else 1):
        marker=frame_header(0,key,client)[:2]
        at=data.find(marker,0 if start is None else start)
        while at!=-1 and (best is None or at<best[0]):
            if (start is None or at==start) and confirmed(at,key):
                best=(at,lost,key);break
            if start is not None:break
            at=data.find(marker,at+1)
        key=advance(key)
    if best is None:return None
    at,lost,key=best
    decoder.buf=bytearray(data[at:]);decoder.iv=key
    decoder.feed(b'')
    return dropped+lost


def game_owner(connection):
    from game_transport import game_owner as owns
    return owns(connection)


def grind_tracker(folder,config=None,stop=None):
    """The grind tracker for this capture folder; None if it cannot start.

    It only reads frames the collector already decoded. Its failures are
    printed and disable it; they never stop capture."""
    try:
        from grind_pricing import Prices,site_fetch
        from grind_tracker import Tracker
        fetch=None
        endpoint=(config or {}).get('endpoint','')
        if config and config.get('token') and (endpoint=='https://mxd.ruit.me' or endpoint.startswith('http://127.0.0.1:')):
            from shared_client import upload_opener
            fetch=site_fetch(config,upload_opener)
        prices=Prices(Path(folder)/'grind'/'prices.json',fetch)
        if stop is not None:prices.start(stop)
        return Tracker(folder,prices)
    except Exception as error:
        print(json.dumps(dict(time=time.time(),event='grind_unavailable',error=type(error).__name__,detail=str(error)[:200])),flush=True)
        return None


class Collector:
    market_only=True
    def __init__(self,folder,owner=game_owner,on_event=None,config=None,stop=None):
        self.folder=Path(folder);self.folder.mkdir(parents=True,exist_ok=True)
        self.owner=owner;self.flows={};self.ignored=0;self.captured=0;self.last_status=0;self.message_counts={};self.last_shop_at=None
        self.last_status_attempt=0
        self._status_warnings={}
        self.on_event=on_event
        self.inventory=Inventory()
        # Grind tracking keeps one inventory per connection: the shared one above
        # follows whichever connection entered a map last (a market scan on a
        # second client would otherwise steal it from the grinding character).
        self.grind_inventories={}
        self.grind=grind_tracker(self.folder,config,stop)
    def grind_call(self,name,*args):
        if self.grind is None:return
        try:getattr(self.grind,name)(*args)
        except Exception as error:
            print(json.dumps(dict(time=time.time(),event='grind_disabled',where=name,error=type(error).__name__,detail=str(error)[:200])),flush=True)
            self.grind=None
    def write_status(self, path, state):
        """UI diagnostics are best effort; file readers must not stop capture."""
        temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
        try:
            with temporary.open('w',encoding='utf-8') as out:
                json.dump(state,out);out.flush();os.fsync(out.fileno())
            for attempt in range(4):
                try:
                    temporary.replace(path)
                    break
                except PermissionError:
                    if attempt == 3:
                        raise
                    time.sleep(.01)
            self._status_warnings.pop(path.name,None)
            return True
        except OSError as error:
            now=time.monotonic()
            if now-self._status_warnings.get(path.name,-float('inf'))>=60:
                self._status_warnings[path.name]=now
                print(json.dumps(dict(time=time.time(),event='status_write_deferred',
                    file=path.name,error=type(error).__name__,winerror=getattr(error,'winerror',None))),flush=True)
            return False
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
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
        if flow['decoder'] is None and now>=flow['check'] and len(flow['buffer'])>=21:
            flow['check']=now+0.2
            if self.owner(key):
                if len(flow['buffer']) < 21:
                    return
                if flow['buffer'][:11].hex() != '1300010001000000010030':
                    flow['failed'] = True
                    flow['buffer'].clear()
                    return
                session=Session(self,None,None,None,None,key[0],key[1])
                flow['session']=session.id
                flow['session_object']=session  # Saved by market_handoff across an update.
                self.grind_call('connection',session.id,key)
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
        if session is not None:
            self.grind_inventories.pop(session,None)
            self.grind_call('disconnect',session)

    def observer(self,session):
        def observe(plain):
            revision = self.inventory.revision
            self.inventory.observe(plain, session.id)
            if self.inventory.revision != revision:
                # Publish the actual stream delta now, not on the 2 s status tick.
                self.publish_inventory()
            if self.grind is not None:
                own=self.grind_inventories.get(session.id)
                if own is None:own=self.grind_inventories[session.id]=Inventory()
                own.observe(plain, session.id)
                self.grind_call('observe',session.id,plain,own)
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
    def receive_client(self,key,seq,flags,data,now):
        """Client-to-server copy of a decoded game flow, for the grind tracker only.

        Any failure stops client decoding of that flow; the server stream,
        inventory and market capture never depend on it."""
        flow=self.flows.get(key)
        if flow is None or flow.get('client_failed') or self.grind is None:return
        try:
            stream=flow.get('client_stream')
            if stream is None:
                if flags&2 and not flags&16:syn=seq
                else:
                    from game_transport import handshake
                    syn=handshake(key).get('client')
                if syn is None:flow['client_failed']=True;return
                stream=flow['client_stream']=Stream(syn+1);flow['client_buffer']=bytearray()
            ordered=stream.feed((seq+bool(flags&2))&0xffffffff,data,now)
            decoder=flow.get('client_decoder')
            if decoder is None:
                flow['client_buffer'].extend(ordered)
                if len(flow['client_buffer'])>LIMIT:raise ValueError('Client buffer limit')
                server=flow.get('decoder')
                if server is None or server.civ is None or not flow.get('session'):return
                session=flow['session']
                decoder=flow['client_decoder']=ClientDecoder(server.civ,lambda plain:self.grind_call('observe_client',session,plain))
                ordered,flow['client_buffer']=bytes(flow['client_buffer']),bytearray()
            decoder.feed(ordered)
        except Exception as error:
            flow['client_failed']=True;flow.pop('client_buffer',None)
            self.event('client_decode_stopped',reason=str(error)[:120])

    def receive(self,raw,now=None):
        now=time.monotonic() if now is None else now
        from game_transport import tcp_packet
        both=tcp_packet(raw)
        if both and both[1]=='client':
            connection,_,sequence,flags,data=both
            self.receive_client(connection,sequence,flags,data,now);return
        parsed=(both[0],both[2],both[3],both[4]) if both else None
        if not parsed:return
        self.captured+=1;key,seq,flags,data=parsed
        flow=self.flows.get(key)
        if flow is None and not flags & 2:
            from game_transport import handshake
            syn=handshake(key).get('server')
            if syn is not None:
                if len(self.flows)>=64:self.flows.pop(next(iter(self.flows)))
                flow=dict(syn=syn,stream=Stream(syn+1),decoder=None,buffer=bytearray(),created=now,last=now,check=0,failed=False)
                self.flows[key]=flow
        if flags&0x12==0x12:
            if flow and flow['syn']==seq:return # SYN retransmit must not reset IV.
            if len(self.flows)>=64:self.flows.pop(next(iter(self.flows)))
            flow=dict(syn=seq,stream=Stream(seq+1),decoder=None,buffer=bytearray(),created=now,last=now,check=0,failed=False)
            self.flows[key]=flow
        if not flow:self.ignored+=1;return
        flow['last']=now
        if flags&4:
            if flow.get('session'): self.invalidate_inventory(flow['session'])
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
            if flow.get('session'): self.invalidate_inventory(flow['session'])
            if flow['stream'].pending or (flow['decoder'] and flow['decoder'].buf):self.fail(flow,'Incomplete stream on close')
            self.flows.pop(key,None)
    def recover(self,flow):
        """Skip a gap the capture will never fill (it is receive-only: the game
        got those bytes, a retransmission will not come) instead of giving up
        the connection. The market bag snapshot may have missed a change, so it
        is dropped until the next full one; the grind run carries on."""
        skipped=self.skip_gap(flow['stream'],flow['decoder'])
        if skipped is None:
            return False
        missing,lost=skipped
        session=flow.get('session')
        if session:
            self.inventory.invalidate(session);self.publish_inventory()
            obj=flow.get('session_object')
            if obj is not None and getattr(obj,'roster',None) is not None:obj.roster.reset()
        self.event('stream_resynced',session=session,missing_bytes=missing,lost_frames=lost)
        return True
    @staticmethod
    def skip_gap(stream,decoder):
        """(missing bytes, lost frames) once `decoder` is aligned after the
        stream's first gap, or None (nothing changes) when it cannot be."""
        if decoder is None or decoder.iv is None or not stream.pending:return None
        pending=sorted(stream.pending,key=lambda p:p[0])
        missing=pending[0][0];data=bytearray();end=missing;used=0
        for offset,chunk in pending:
            if offset>end:break
            if offset+len(chunk)>end:data.extend(chunk[end-offset:]);end=offset+len(chunk)
            used+=1
        saved=(bytearray(decoder.buf),decoder.iv,decoder.frames)
        try:
            lost=decoder.resync(missing,bytes(data))
        except Exception:
            decoder.buf,decoder.iv,decoder.frames=saved
            return None
        if lost is None:
            return None
        stream.next=(stream.next+end)&0xffffffff
        stream.pending=[(pos-end,chunk) for pos,chunk in pending[used:]]
        stream.gap_since=None
        return missing,lost
    def fail(self,flow,reason):
        self.invalidate_inventory(flow.get('session'))
        flow['failed']=True;flow['buffer'].clear();flow['stream'].pending.clear()
        if flow['decoder']:flow['decoder'].buf.clear()
        self.event('reconnect_required',reason=reason)
    def tick(self,now=None):
        now=time.monotonic() if now is None else now
        self.grind_call('tick')
        for key,flow in list(self.flows.items()):
            if not flow['failed']:
                try:self.check_owner(key,flow,now)
                except Exception as error:self.fail(flow,str(error))
            if flow['decoder'] is None and now-flow['created']>3:
                self.flows.pop(key,None);continue
            if now-flow['last']>600:
                if flow.get('session'): self.invalidate_inventory(flow['session'])
                self.flows.pop(key,None);continue
            gap=flow['stream'].gap_since
            if not flow['failed'] and gap is not None and now-gap>10 and not self.recover(flow):
                self.fail(flow,'TCP gap timeout')
            client=flow.get('client_stream')
            if client is not None and not flow.get('client_failed') and client.gap_since is not None and now-client.gap_since>10:
                skipped=self.skip_gap(client,flow.get('client_decoder'))
                if skipped is None:
                    flow['client_failed']=True;flow.pop('client_buffer',None)
                else:
                    self.event('client_stream_resynced',session=flow.get('session'),missing_bytes=skipped[0],lost_frames=skipped[1])
        if now-self.last_status_attempt>2:
            self.last_status_attempt=now
            self.publish_inventory()
            state=dict(time=time.time(),mode=getattr(self,'mode','windivert-sniff-recv-only'),packets=self.captured,
                waiting_for_handshake=self.ignored,connections=len(self.flows),
                decoding=sum(bool(f['decoder'] and f['decoder'].iv and not f['failed']) for f in self.flows.values()),
                failed=sum(f['failed'] for f in self.flows.values()),
                frames=sum(f['decoder'].frames for f in self.flows.values() if f['decoder']),
                message_counts=self.message_counts,last_shop_at=self.last_shop_at,
                capture_ports='game-process-owned TCP',
                health_state=getattr(self,'health_state',None),
                capture_warning=getattr(self,'capture_warning',None),
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
        from game_transport import capture_priority
        self.handle=self.dll.WinDivertOpen(capture_filter.encode(),0,capture_priority(),SNIFF_RECV_ONLY)
        if self.handle==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        from game_transport import configure_capture_queue
        try:configure_capture_queue(self.dll,self.handle)
        except Exception:
            self.close()
            raise
        # Intentionally never bind or call WinDivertSend.
    def recv(self):
        from game_transport import tcp_packet
        buffer=ctypes.create_string_buffer(65535)
        address=ctypes.create_string_buffer(80)
        size=ctypes.c_uint()
        while self.handle is not None:
            if not self.dll.WinDivertRecv(self.handle,buffer,len(buffer),ctypes.byref(size),address):
                raise ctypes.WinError(ctypes.get_last_error())
            raw=buffer.raw[:size.value]
            if tcp_packet(raw) is not None:
                return raw
        raise OSError('Capture closed')

    def close(self):
        if self.handle is not None:
            self.dll.WinDivertShutdown(self.handle,1)
            self.dll.WinDivertClose(self.handle);self.handle=None



class WindowsSniffer:
    """Receive IP copies through Winsock; never bind any send/injection API."""
    mode='windows-raw-receive-only'
    def __init__(self, accept=game_packet):
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
        # WinDivert also covers IPv6 and interfaces added after startup.
        # Supplement raw sockets across all interfaces, including localhost and IPv6.
        # Separate receive-only handles have distinct priorities so all three
        # decoders (market, channel, position) receive their own packet copies.
        self.local_packets=queue.Queue(maxsize=8192)
        self.local_error=None;self.local_sniffer=None;self.degraded=None;self.local_dropped=0
        try:
            self.local_sniffer=Sniffer('tcp')
        except Exception as error:
            # Antivirus or another WinDivert version can block the driver.
            # Native receive still covers direct IPv4 game connections.
            if not self.sockets:
                self.close()
                raise
            self.degrade(error)
            return
        def receive_local():
            try:
                while self.handle is not None:
                    raw=self.local_sniffer.recv()
                    if self.accept(raw):
                        # A dropped copy shows up as a TCP gap on that flow only.
                        try:self.local_packets.put_nowait(raw)
                        except queue.Full:self.local_dropped+=1
            except Exception as error:
                if self.handle is not None:self.local_error=error
        self.local_thread=threading.Thread(target=receive_local,daemon=True)
        self.local_thread.start()
    def degrade(self,error):
        """Stop only the WinDivert copy; native receive keeps running."""
        self.degraded=LOCAL_UNAVAILABLE
        if self.local_sniffer:
            try:self.local_sniffer.close()
            except Exception:pass
        print(json.dumps(dict(event='local_capture_unavailable',error=type(error).__name__,
            winerror=getattr(error,'winerror',None))),flush=True)
    def recv(self):
        import select
        while self.handle is not None:
            if self.local_error:
                error,self.local_error=self.local_error,None
                if not self.sockets:raise error
                self.degrade(error)
            try:
                raw=self.local_packets.get_nowait()
                self.received_datagrams+=1
                self.matched_datagrams+=1
                self.tcp_datagrams+=1
                return raw
            except queue.Empty:pass
            if not self.sockets:
                time.sleep(.05)
                continue
            ready,_,_=select.select(self.sockets,[],[],0.05)
            for sock in ready:
                raw=sock.recv(65535)
                self.received_datagrams+=1
                if len(raw)>=40 and raw[0]>>4==4 and raw[9]==6:
                    self.tcp_datagrams+=1
                    ihl=(raw[0]&15)*4
                    from game_transport import tcp_packet
                    parsed=tcp_packet(raw)
                    if parsed and parsed[1]=='client':
                        self.game_outbound_datagrams+=1
                # Only game-process-owned flows proceed to the protocol decoder.
                if self.accept(raw):
                    self.matched_datagrams+=1
                    return raw
        raise OSError('Capture closed')
    def close(self):
        import socket
        self.handle=None
        if getattr(self,'local_sniffer',None):self.local_sniffer.close()
        if getattr(self,'local_thread',None):self.local_thread.join(timeout=2)
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


def run(folder,seconds=0,backend="windivert",stop_event=None,on_event=None,config=None):
    grind_stop=threading.Event()
    collector=Collector(folder,on_event=on_event,config=config,stop=grind_stop);sniffer=WindowsSniffer() if backend=="windows" else Sniffer();collector.mode=getattr(sniffer,"mode","windivert-sniff-recv-only");packets=queue.Queue(maxsize=8192);overflow=threading.Event()
    def receive():
        while sniffer.handle is not None:
            try:raw=sniffer.recv()
            except Exception as error:
                packets.put(error);return
            try:packets.put_nowait(raw)
            except queue.Full:overflow.set()
    thread=threading.Thread(target=receive,daemon=True);thread.start();started=time.monotonic()
    last_health_check=0;health_state=None
    collector.event('capture_started',mode=collector.mode,message='Restoring capture / 正在恢复采集状态。')
    # After an update: continue the previous collector's connections (market_handoff).
    try:
        from market_handoff import resume
        resume(collector)
    except Exception as error:
        collector.event('handoff_failed',reason=type(error).__name__)
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
                    from game_transport import connected
                    game_connected=connected()
                except (OSError,psutil.Error):game_connected=None
                state,message=capture_health(collector,game_connected,now-started)
                collector.health_state=state
                if state!=health_state:
                    collector.event('capture_health',state=state,message=message)
                    health_state=state
                warning=getattr(sniffer,'degraded',None)
                if warning!=getattr(collector,'capture_warning',None):
                    collector.capture_warning=warning
                    collector.event('capture_degraded',reason=warning)
            previous_status=collector.last_status
            collector.tick()
            if backend=="windows" and collector.last_status!=previous_status:
                diagnostic=collector.folder/'native_health.json'
                collector.write_status(diagnostic,dict(time=time.time(),reader_alive=thread.is_alive(),
                    sockets=len(sniffer.sockets),received_datagrams=sniffer.received_datagrams,
                    matched_datagrams=sniffer.matched_datagrams,tcp_datagrams=sniffer.tcp_datagrams,
                    game_outbound_datagrams=sniffer.game_outbound_datagrams,
                    local_capture=sniffer.degraded or 'ok',local_dropped=sniffer.local_dropped))
    finally:
        sniffer.close();thread.join(timeout=2)
        try:
            from market_handoff import save
            save(collector)
        except Exception as error:
            collector.event('handoff_failed',reason=type(error).__name__)
        collector.inventory.invalidate()
        collector.write_status(collector.folder/'inventory_state.json', dict(alive_at=int(time.time()), holdings=None))
        grind_stop.set();collector.grind_call('persist')
        collector.event('capture_stopped')


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--folder',type=Path,required=True)
    parser.add_argument('--seconds',type=int,default=0);parser.add_argument('--backend',choices=('windows','windivert'),default='windivert');args=parser.parse_args()
    try:run(args.folder,args.seconds,args.backend)
    except KeyboardInterrupt:pass
