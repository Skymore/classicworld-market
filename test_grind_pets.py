import struct
import unittest

import grind_pets


def pet(serial=1, item=5000007, name=b'Black Pig', level=9, closeness=199, fullness=50):
    """One pet record as the server sends it (layout in grind_pets)."""
    return (struct.pack('<BIB', 3, item, 1) + struct.pack('<Q', serial) + bytes.fromhex('008005bb46e61702')
            + b'\xff\xff\xff\xff' + b'\x01' + name.ljust(13, b'\0')
            + struct.pack('<BHB', level, closeness, fullness) + bytes(31))


def refresh(record, slot=1):
    """The cash slot refresh sent each time fullness drops: remove, then add the pet."""
    return struct.pack('<HBBIB', 0x72, 0, 0, 2, 0) + struct.pack('<BBh', 3, 5, slot) + struct.pack('<BBh', 0, 5, slot) + record


def snapshot(*records):
    head = bytearray(600)
    struct.pack_into('<H', head, 0, 0x1a9)
    return bytes(head) + b''.join(records)


class PetTest(unittest.TestCase):
    def test_records_read_name_level_closeness_and_fullness(self):
        (serial, item, name, level, closeness, fullness), = grind_pets.records(refresh(pet(fullness=78)))
        self.assertEqual((item, name, level, closeness, fullness), (5000007, 'Black Pig', 9, 199, 78))
        self.assertEqual(grind_pets.records(refresh(pet(item=5040000))), [])   # not a pet

    def test_out_hungry_and_sent_home_by_hunger(self):
        pets = {}
        grind_pets.observe(pets, snapshot(pet(fullness=50), pet(serial=2, name=b'Snail', item=5000033)), True, 0)
        self.assertEqual([p['out'] for p in grind_pets.view(pets, 0)], [False, False])   # owned, none out yet
        grind_pets.observe(pets, refresh(pet(fullness=50)), False, 1)
        out, home = grind_pets.view(pets, 1)
        self.assertEqual((out['name'], out['out'], out['hungry'], home['out']), ('Black Pig', True, False, False))
        grind_pets.observe(pets, refresh(pet(fullness=19)), False, 60)
        self.assertTrue(grind_pets.view(pets, 60)[0]['hungry'])
        # At 0 the game sends it home: fullness back to 5, closeness one lower; an echo of
        # that record right after does not bring it back out.
        grind_pets.observe(pets, refresh(pet(fullness=1)), False, 120)
        grind_pets.observe(pets, refresh(pet(fullness=5, closeness=198)), False, 180)
        grind_pets.observe(pets, refresh(pet(fullness=5, closeness=198)), False, 181)
        self.assertFalse(any(p['out'] for p in grind_pets.view(pets, 181)))
        # Summoned again later: out.
        grind_pets.observe(pets, refresh(pet(fullness=5, closeness=198)), False, 400)
        self.assertTrue(grind_pets.view(pets, 400)[0]['out'])

    def test_a_snapshot_keeps_known_pets_out_and_silence_means_the_bag(self):
        pets = {}
        grind_pets.observe(pets, refresh(pet(fullness=50)), False, 0)
        grind_pets.observe(pets, snapshot(pet(fullness=50)), True, 5)    # a channel change
        self.assertTrue(grind_pets.view(pets, 5)[0]['out'])
        self.assertFalse(grind_pets.view(pets, 5 + grind_pets.OUT_SECONDS + 1)[0]['out'])   # recalled by hand


if __name__ == '__main__':
    unittest.main()
