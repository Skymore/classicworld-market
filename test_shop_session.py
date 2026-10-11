"""Checks against the newly captured complete reconnect and repeated shop visits."""
from pathlib import Path
import json
import unittest
from decode_market import messages

FOLDER=Path(__file__).parent/'network_captures/shop_session_20261010_170336'

class SessionTests(unittest.TestCase):
    def test_reassembler_preserves_messages_after_greeting(self):
        audited=json.loads((FOLDER/'session_streams.json').read_text())
        expected={(tuple(s['flow']),m['seq']) for s in audited for m in s['messages']}
        actual={(tuple(m['flow']),m['seq']) for m in messages(FOLDER)}
        self.assertEqual(actual,expected)
        self.assertEqual(sum(bool(s['greeting_hex']) for s in audited),2)
        self.assertTrue(all(s['gap_bytes']==0 and s['unparsed_bytes']==0 for s in audited))

    def test_three_same_shop_lists_and_candidate_requests(self):
        shops=json.loads((FOLDER/'decoded_shops.json').read_text())['shops']
        self.assertEqual([s['title'] for s in shops],['cheap cheap']*3)
        self.assertEqual([s['row_count'] for s in shops],[4]*3)
        economic=lambda s:[(r['item_id'],r['price_mesos_candidate'],r['available_quantity_candidate']) for r in s['items']]
        self.assertEqual(economic(shops[0]),economic(shops[1]))
        self.assertEqual(economic(shops[1]),economic(shops[2]))
        candidates=json.loads((FOLDER/'shop_request_candidates.json').read_text())['shops']
        self.assertEqual([s['shop_id_candidate'] for s in candidates],[5830]*3)
        self.assertTrue(all(s['preceding'][-1]['length']==10 and 30<s['preceding'][-1]['delta_ms']<33 for s in candidates))

if __name__=='__main__':unittest.main()
