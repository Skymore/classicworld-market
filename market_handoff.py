"""Keep decoded game connections across a collector update.

The stream cipher's IV advances with every frame, so a new process can only
follow a connection from its handshake unless it inherits the exact position.
An update therefore hands over in three overlapping steps:

1. The update helper (the new release, already running from its staged
   folder) records raw inbound game packets to a spool file and reports ready.
2. The old collector stops and saves each connection's TCP position, IV and
   partial frame, plus the inventory, to a snapshot.
3. The new collector starts its own capture, restores the snapshot, replays the
   spool and continues live. TCP sequence numbers drop the overlaps.

Nothing here sends packets. Every failure falls back to the old behaviour: the
connection is not restored and the player changes channel once. The spool holds
raw game packets only for the hand-off and is deleted when it is consumed.
"""
import copy
import json
import os
import struct
import threading
import time
from pathlib import Path

SNAPSHOT = 'handoff-state.json'
SPOOL = 'handoff-spool.bin'
READY = 'handoff-spool.ready'    # The helper is recording.
TAKEN = 'handoff-taken'          # The new collector captures; the helper may stop.
DONE = 'handoff-spool.done'      # The spool file is closed and complete.
MAX_AGE = 300
MAX_SPOOL = 64 * 1024 * 1024
RECORD_SECONDS = 240


def _write(path, data):
    temporary = path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(data), encoding='utf-8')
    os.replace(temporary, path)


def clear(folder):
    for name in (SNAPSHOT, SPOOL, READY, TAKEN, DONE):
        try:
            (Path(folder)/name).unlink()
        except OSError:
            pass


def save(collector):
    """Snapshot every healthy decoded connection and the inventory. Returns the flow count."""
    if getattr(collector, 'grind', None) is not None and collector.grind.frames is not None:
        collector.grind.frames.flush()
    flows = []
    for key, flow in collector.flows.items():
        decoder, session = flow.get('decoder'), flow.get('session_object')
        if not decoder or decoder.iv is None or flow.get('failed') or session is None:
            continue
        stream = flow['stream']
        flows.append(dict(key=list(key), syn=flow['syn'], next=stream.next,
                          pending=[[offset, bytes(data).hex()] for offset, data in stream.pending],
                          iv=decoder.iv.hex(), buffer=bytes(decoder.buf).hex(), frames=decoder.frames,
                          session=session.id, location=session.market_location))
        flows[-1]['civ'] = decoder.civ.hex() if decoder.civ else None
        client, stream = flow.get('client_decoder'), flow.get('client_stream')
        if client and stream and not flow.get('client_failed'):
            flows[-1]['client'] = dict(next=stream.next,
                pending=[[offset, bytes(data).hex()] for offset, data in stream.pending],
                iv=client.iv.hex(), buffer=bytes(client.buf).hex(), frames=client.frames)
    if not flows:
        return 0
    inventory = collector.inventory
    state = dict(version=1, time=time.time(), flows=flows, inventory=dict(
        revision=inventory.revision, session=inventory.session, mesos=inventory.mesos,
        capacities=inventory.capacities, observed_at=inventory.observed_at,
        slots=None if inventory.slots is None else [[c, s, i, q] for (c, s), (i, q) in inventory.slots.items()],
        equipment=None if inventory.equipment is None else list(inventory.equipment.values()),
        worn=None if inventory.worn is None else list(inventory.worn.values())))
    if getattr(collector, 'grind', None) is not None:
        from grind_handoff import snapshot
        state['grind'] = snapshot(collector.grind, {f['session'] for f in flows})
    _write(Path(collector.folder)/SNAPSHOT, state)
    return len(flows)


def restore(collector, state, now=None):
    """Rebuild the connections of a snapshot inside a fresh collector."""
    from market_passive import Decoder, ClientDecoder, Stream
    from market_proxy import Session
    now = time.monotonic() if now is None else now
    for saved in state['flows']:
        key = tuple(saved['key'])
        session = Session(collector, None, None, None, None, key[0], key[1])
        session.id = saved['session']
        session.market_location = saved.get('location')
        if getattr(collector, 'grind', None) is not None:
            collector.grind_call('connection', session.id, key)
        stream = Stream(saved['next'])
        stream.pending = [(offset, bytes.fromhex(data)) for offset, data in saved['pending']]
        decoder = Decoder(collector.observer(session))
        decoder.iv = bytes.fromhex(saved['iv'])
        decoder.buf.extend(bytes.fromhex(saved['buffer']))
        decoder.frames = saved['frames']
        decoder.civ = bytes.fromhex(saved['civ']) if saved.get('civ') else None
        if len(decoder.iv) != 4:
            raise ValueError('Invalid saved IV')
        collector.flows[key] = dict(syn=saved['syn'], stream=stream, decoder=decoder, buffer=bytearray(),
                                    created=now, last=now, check=0, failed=False,
                                    session=session.id, session_object=session)
        if saved.get('client'):
            client = saved['client']
            stream = Stream(client['next'])
            stream.pending = [(offset, bytes.fromhex(data)) for offset, data in client['pending']]
            client_iv = bytes.fromhex(client['iv'])
            if len(client_iv) != 4:
                raise ValueError('Invalid saved client IV')
            decoder = ClientDecoder(client_iv, lambda plain, sid=session.id: collector.grind_call('observe_client', sid, plain))
            decoder.buf.extend(bytes.fromhex(client['buffer']))
            decoder.frames = client['frames']
            collector.flows[key].update(client_stream=stream, client_decoder=decoder, client_buffer=bytearray())
    saved, inventory = state['inventory'], collector.inventory
    inventory.session, inventory.mesos = saved['session'], saved['mesos']
    inventory.capacities = None if saved['capacities'] is None else tuple(saved['capacities'])
    inventory.observed_at = saved['observed_at']
    inventory.slots = None if saved['slots'] is None else {(c, s): (i, q) for c, s, i, q in saved['slots']}
    inventory.equipment = None if saved['equipment'] is None else {e['slot']: e for e in saved['equipment']}
    inventory.worn = None if saved['worn'] is None else {e['slot']: e for e in saved['worn']}
    # A new revision: readers must not pair this state with an older receipt.
    inventory.revision = saved['revision']+1
    if getattr(collector, 'grind', None) is not None:
        from grind_handoff import restore as restore_grind, legacy
        sessions = {f['session'] for f in state['flows']}
        if state.get('grind'):
            restore_grind(collector.grind, state['grind'], sessions)
        else:
            legacy(collector.grind, sessions, state['time'])
        for flow in state['flows']:
            character = collector.grind.characters.get(flow['session'])
            if character is not None and not flow.get('client'):
                # Old releases did not hand over outgoing cipher state. Until
                # client frames resume, retain the inventory-delta fallback for
                # consumables rather than waiting for unobservable use packets.
                character.client_seen = False
        own = getattr(collector, 'grind_inventories', None)
        if own is not None:
            from grind_handoff import recover_inventory
            for session in sessions:
                character = collector.grind.characters.get(session)
                if character is None:
                    continue
                if inventory.session == session and inventory.slots is not None:
                    recovered = copy.deepcopy(inventory)
                else:
                    recovered = recover_inventory(collector.grind.data, session, state['time'])
                if recovered is not None:
                    own[session] = recovered
                    collector.grind.inventory(character, recovered, state['time'], rebase=True)
        if inventory.slots is None and inventory.session in sessions:
            from grind_handoff import recover_inventory
            recovered = recover_inventory(collector.grind.data, inventory.session, state['time'])
            if recovered is not None:
                recovered.revision = inventory.revision + 1
                collector.inventory = inventory = recovered
                character = collector.grind.characters.get(inventory.session)
                if character is not None:
                    collector.grind.inventory(character, inventory, state['time'], rebase=True)
    return len(state['flows'])


def spooled(path):
    with open(path, 'rb') as source:
        while True:
            head = source.read(4)
            if len(head) < 4:
                return
            raw = source.read(struct.unpack('<I', head)[0])
            if len(raw) < struct.unpack('<I', head)[0]:
                return  # A torn final record: the live capture overlaps it.
            yield raw


def resume(collector, wait=6):
    """Restore the last snapshot and replay the helper's spool. Returns the flow count.

    Call after this process's own capture has started, so its packets overlap
    the end of the spool.
    """
    folder = Path(collector.folder)
    try:
        try:
            state = json.loads((folder/SNAPSHOT).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return 0
        # Without a recording the missing packets would only show up as a gap.
        if (state.get('version') != 1 or not 0 <= time.time()-state['time'] <= MAX_AGE
                or not (folder/READY).exists() or not (folder/SPOOL).exists()):
            return 0
        (folder/TAKEN).write_text('1', encoding='utf-8')
        deadline = time.monotonic()+wait
        while not (folder/DONE).exists() and time.monotonic() < deadline:
            time.sleep(.05)
        try:
            count = restore(collector, state)
            packets = 0
            for raw in spooled(folder/SPOOL):
                collector.receive(raw)
                packets += 1
        except Exception as error:
            # Half-restored connections would decode garbage: start clean instead.
            collector.flows.clear()
            collector.inventory.invalidate()
            if getattr(collector, 'grind', None) is not None:
                collector.grind.characters.clear()
                collector.grind.restore()
            collector.event('handoff_failed', reason=type(error).__name__)
            return 0
        alive = sum(not flow['failed'] for flow in collector.flows.values() if flow.get('decoder'))
        collector.event('handoff_resumed', connections=count, decoding=alive, packets=packets)
        collector.publish_inventory()
        collector.grind_call('publish', time.time())
        return alive
    finally:
        clear(folder)


def record(folder, sniffer=None, seconds=RECORD_SECONDS):
    """Helper side: spool inbound game packets until the new collector takes over.

    Returns the recording thread (already started), or None when capture cannot start.
    """
    folder = Path(folder)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        clear(folder)
        if sniffer is None:
            from market_passive import WindowsSniffer
            sniffer = WindowsSniffer()
        output = open(folder/SPOOL, 'wb')
    except Exception:
        return None
    stopped = threading.Event()

    def watch():
        deadline = time.monotonic()+seconds
        while time.monotonic() < deadline and not (folder/TAKEN).exists() and not stopped.is_set():
            time.sleep(.05)
        # Let the new collector's capture overlap the last spooled packets.
        if not stopped.is_set():
            time.sleep(.5)
        stopped.set()
        try:
            sniffer.close()
        except Exception:
            pass

    def work():
        written = 0
        try:
            (folder/READY).write_text('1', encoding='utf-8')
            while not stopped.is_set():
                raw = sniffer.recv()
                written += 4+len(raw)
                if written > MAX_SPOOL:
                    break
                output.write(struct.pack('<I', len(raw))+raw)
                output.flush()
        except Exception:
            pass  # Closed by the watcher, or capture failed: the spool ends here.
        finally:
            stopped.set()
            try:
                output.close()
                (folder/DONE).write_text('1', encoding='utf-8')
            except OSError:
                pass

    threading.Thread(target=watch, daemon=True).start()
    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    return thread
