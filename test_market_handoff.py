import json
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import market_handoff as handoff
from classicworld_codec import advance, frame_header
from market_passive import Collector
from test_market_passive import raw

KEY = ('44.230.128.74', 8501, '192.168.1.5', 51000)


class Wire:
    """A synthetic server stream: greeting, then frames under the advancing IV."""
    def __init__(self):
        self.iv = bytes([1, 2, 3, 4])
        self.seq = 1001
        self.greeting = bytes.fromhex('1300010001000000010030')+b'abcd'+self.iv+b'zz'

    def frame(self, plain):
        data = frame_header(len(plain), self.iv, False)+bytes((b+self.iv[0]) & 255 for b in plain)
        self.iv = advance(self.iv)
        return data

    def packet(self, data):
        packet = raw(self.seq, data)
        self.seq += len(data)
        return packet


def meso(amount):
    return bytes.fromhex('7e0000000100000400')+struct.pack('<Q', amount)+bytes(2)


class HandoffTests(unittest.TestCase):
    def setUp(self):
        import game_transport
        game_transport._syn.clear()
        self.enterContext(patch('game_transport.connections', return_value=frozenset([KEY])))
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))

    def collector(self):
        collector = Collector(self.folder, owner=lambda key: True)
        collector.seen = []
        observer = collector.observer

        def recording(session):
            inner = observer(session)

            def observe(plain):
                collector.seen.append(plain)
                inner(plain)
            return observe
        collector.observer = recording
        return collector

    def started(self):
        """An old collector that decoded the handshake and two frames."""
        wire, old = Wire(), self.collector()
        old.receive(raw(1000, flags=0x12))
        old.receive(wire.packet(wire.greeting))
        old.tick()
        # As after the character snapshot: this connection owns the inventory.
        old.inventory.session = old.flows[KEY]['session']
        old.receive(wire.packet(wire.frame(b'\x01\x00one')+wire.frame(meso(500))))
        old.tick()
        self.assertEqual(old.seen, [b'\x01\x00one', meso(500)])
        return wire, old

    def spool(self, packets, done=True):
        with open(self.folder/handoff.SPOOL, 'wb') as out:
            for packet in packets:
                out.write(struct.pack('<I', len(packet))+packet)
        (self.folder/handoff.READY).write_text('1')
        if done:
            (self.folder/handoff.DONE).write_text('1')

    def test_connection_and_balance_continue_across_the_restart(self):
        wire, old = self.started()
        session = old.flows[KEY]['session']
        # The helper records from before the old capture stops: the first spooled
        # packet was also decoded by the old collector, the split frame was not.
        overlap = wire.packet(wire.frame(b'\x02\x00two'))
        old.receive(overlap)
        split = wire.frame(meso(777))
        first, second = wire.packet(split[:5]), wire.packet(split[5:])
        self.assertEqual(handoff.save(old), 1)
        self.spool([overlap, first, second])
        new = self.collector()
        self.assertEqual(handoff.resume(new, wait=0), 1)
        self.assertEqual(new.seen, [meso(777)])
        self.assertEqual((new.inventory.mesos, new.inventory.session), (777, session))
        # Live capture overlaps the end of the spool, then carries on.
        live = wire.packet(wire.frame(b'\x03\x00three'))
        new.receive(second)
        new.receive(live)
        self.assertEqual(new.seen[-1], b'\x03\x00three')
        self.assertFalse(new.flows[KEY]['failed'])
        # One-shot: nothing is left for a later start.
        self.assertEqual(sorted(p.name for p in self.folder.iterdir() if p.name.startswith('handoff')), [])

    def test_inventory_and_location_are_restored(self):
        wire, old = self.started()
        old.inventory.slots = {(2, 1): (2000002, 600)}
        old.inventory.capacities = (24, 24, 24, 24, 24, 24)
        old.inventory.equipment = {3: dict(slot=3, item_id=1302000, decoded=True, stats=[], remaining_upgrades=7, enhancements=0)}
        old.inventory.worn = {}
        old.flows[KEY]['session_object'].market_location = dict(channel=3, room=7, map_id=80002007)
        revision = old.inventory.revision
        handoff.save(old)
        self.spool([])
        new = self.collector()
        self.assertEqual(handoff.resume(new, wait=0), 1)
        self.assertEqual(new.inventory.slots, {(2, 1): (2000002, 600)})
        self.assertEqual(new.inventory.view()['equipment'][0]['item_id'], 1302000)
        self.assertGreater(new.inventory.revision, revision)
        self.assertEqual(new.flows[KEY]['session_object'].market_location['room'], 7)

    def test_grind_identity_run_and_client_frames_resume_without_channel_change(self):
        from test_grind_live import snapshot, stat, buff
        from test_grind_combat import roster, local_attack
        from classicworld_codec import aes_payload
        from market_passive import Stream, ClientDecoder
        wire, old = self.started()
        session = old.flows[KEY]['session']
        for payload in (snapshot(), roster([(424242, 'Tester', 17)]), buff(3001000, 90000),
                        stat(exp=5100), stat(exp=5200), stat(exp=5300)):
            old.receive(wire.packet(wire.frame(payload)))
        c = old.grind.characters[session]
        c.table = list(range(900))
        c.bag_slots = {(2, 1): (2000002, 10)}
        c.pieces = ({(1302000, 'stats'): 1}, {(1302000, 'stats'): {'item_id': 1302000}})
        c.uses.append([time.time(), 2000002, 1, 1])
        run_id = c.run.id
        iv = bytes([4, 3, 2, 1])
        payload = local_attack([(123, [200])])
        frame = frame_header(len(payload), iv, True) + aes_payload(payload, iv)
        decoder = ClientDecoder(iv, lambda data: None)
        decoder.feed(frame[:6])
        old.flows[KEY].update(client_stream=Stream(2006), client_decoder=decoder)
        old.grind.persist()
        handoff.save(old)
        from grind_handoff import decode
        saved = json.loads((self.folder/handoff.SNAPSHOT).read_text())
        fields = decode(saved['grind']['characters'][0]['fields'])
        self.assertEqual(fields['pieces'], c.pieces)
        self.assertEqual(fields['bag_slots'], c.bag_slots)
        self.spool([wire.packet(wire.frame(stat(exp=5377)))])
        new = self.collector()
        self.assertEqual(handoff.resume(new, wait=0), 1)
        restored = new.grind.characters[session]
        self.assertEqual((restored.name, restored.character_id, restored.map_id), ('Tester', 424242, 10004080))
        self.assertEqual((restored.run.id, restored.run.status, restored.run.segment.exp), (run_id, 'active', 377))
        self.assertEqual(restored.party, c.party)
        self.assertEqual(restored.buffs, c.buffs)
        self.assertEqual(restored.uses, c.uses)
        self.assertFalse(new.grind.restored)
        new.receive_client(KEY, 2006, 0x18, frame[6:], time.monotonic())
        self.assertEqual(restored.run.combat.players[424242]['damage'], 200)
        self.assertFalse(new.flows[KEY].get('client_failed'))

    def test_legacy_upgrade_rebuilds_character_but_never_duplicates_run_totals(self):
        from test_grind_live import snapshot, stat, buff
        wire, old = self.started()
        session = old.flows[KEY]['session']
        for payload in (snapshot(), buff(3001000, 90000), stat(exp=5100), stat(exp=5200), stat(exp=5300)):
            old.receive(wire.packet(wire.frame(payload)))
        old.grind.persist()
        old.grind.frames.close()
        handoff.save(old)
        state = json.loads((self.folder/handoff.SNAPSHOT).read_text())
        del state['grind']  # The previously released collector did not save this.
        (self.folder/handoff.SNAPSHOT).write_text(json.dumps(state))
        self.spool([wire.packet(wire.frame(stat(exp=5400)))])
        new = self.collector()
        self.assertEqual(handoff.resume(new, wait=0), 1)
        c = new.grind.characters[session]
        self.assertEqual((c.name, c.run.segment.exp), ('Tester', 400))
        self.assertEqual(c.run.id, old.grind.characters[session].run.id)
        self.assertIn(3001000, c.buffs)
        self.assertFalse(new.grind.restored)

    def test_identified_run_is_published_before_newer_anonymous_run(self):
        from grind_tracker import Character, Run
        _, collector = self.started()
        tracker = collector.grind
        known, unknown = Character('known'), Character('unknown')
        known.key = known.name = 'Tester'
        known.run = Run(known.facts(), time.time()-100)
        unknown.run = Run(unknown.facts(), time.time())
        tracker.characters = dict(known=known, unknown=unknown)
        tracker.publish(time.time())
        state = json.loads((self.folder/'grind_state.json').read_text(encoding='utf-8'))
        self.assertEqual(state['runs'][0]['character']['name'], 'Tester')

    def test_without_a_recording_or_with_an_old_snapshot_nothing_is_restored(self):
        _, old = self.started()
        handoff.save(old)
        new = self.collector()
        self.assertEqual(handoff.resume(new, wait=0), 0)  # No spool: the gap is unknown.
        self.assertEqual(new.flows, {})
        handoff.save(old)
        state = json.loads((self.folder/handoff.SNAPSHOT).read_text())
        state['time'] -= handoff.MAX_AGE+1
        (self.folder/handoff.SNAPSHOT).write_text(json.dumps(state))
        self.spool([])
        self.assertEqual(handoff.resume(self.collector(), wait=0), 0)

    def test_lost_packets_fall_back_to_reconnect(self):
        wire, old = self.started()
        handoff.save(old)
        wire.packet(wire.frame(b'\x02\x00lost'))  # Never recorded.
        self.spool([wire.packet(wire.frame(b'\x03\x00late'))])
        new = self.collector()
        handoff.resume(new, wait=0)
        self.assertEqual(new.seen, [])
        new.tick(time.monotonic()+11)  # The gap times out exactly as a mid-stream start does.
        self.assertTrue(new.flows[KEY]['failed'])

    def test_helper_records_until_the_new_collector_takes_over(self):
        packets = [raw(1, b'a'), raw(2, b'bc')]

        class Sniffer:
            def __init__(self): self.left, self.closed = list(packets), threading.Event()
            def recv(self):
                if self.left: return self.left.pop(0)
                self.closed.wait(5)
                raise OSError('Capture closed')
            def close(self): self.closed.set()
        thread = handoff.record(self.folder, Sniffer(), seconds=5)
        deadline = time.monotonic()+3
        while not (self.folder/handoff.READY).exists() and time.monotonic() < deadline: time.sleep(.01)
        self.assertTrue((self.folder/handoff.READY).exists())
        (self.folder/handoff.TAKEN).write_text('1')
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue((self.folder/handoff.DONE).exists())
        self.assertEqual(list(handoff.spooled(self.folder/handoff.SPOOL)), packets)

    def test_recording_that_cannot_start_does_not_block_the_update(self):
        with patch('market_passive.WindowsSniffer', side_effect=PermissionError):
            self.assertIsNone(handoff.record(self.folder))


if __name__ == '__main__':
    unittest.main()
