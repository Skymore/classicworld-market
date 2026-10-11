import unittest
from decode_market import decode_known, length_string


class DecodeTests(unittest.TestCase):
    def test_chat_recovers_observed_ciphertext_prefix(self):
        # Prefix independently recovered in the capture; text has a 23-byte length.
        text=b'LoGanav : Buying Meba !'
        self.assertEqual(len(text),23)
        plain=b'\xae\x00\x03\x17\x00'+text
        encrypted=bytes((b+130)&255 for b in plain)
        decoded=decode_known(encrypted)
        self.assertEqual(decoded['text'],text.decode())
        self.assertEqual(decoded['key'],130)

    def test_rejects_inconsistent_text_length(self):
        self.assertIsNone(length_string(b'\xff\x7fhello',0))
        self.assertIsNone(decode_known(b'\xae\x00\x03\xff\x7fhello'))

    def test_rejects_non_text(self):
        self.assertIsNone(length_string(b'\x04\x00\x00\x01\x02\x03',0))


if __name__=='__main__':
    unittest.main()
