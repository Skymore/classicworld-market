import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import numpy as np
from sweep_evidence import packet_balance, PurchaseTrace
from sweep_purchase import PurchaseResult


class EvidenceTests(unittest.TestCase):
    def test_balance_requires_complete_versioned_packet(self):
        state=dict(session='stream',revision=1,categories=[2,3,4],mesos=581155)
        self.assertEqual(packet_balance(state),581155)
        for field,value in [('session',''),('revision',0),('mesos',True),('mesos',-1),('categories',[2]),('categories',None)]:
            self.assertIsNone(packet_balance(dict(state,**{field:value})))

    def test_failed_attempt_saves_bounded_replay_and_callback_failure_does_not_alter_outcome(self):
        with tempfile.TemporaryDirectory() as temp:
            events=[]
            order=SimpleNamespace(reservation='r1',item_id=2000001,quantity=100,price=130,diagnostic=events.append)
            trace=PurchaseTrace(order,SimpleNamespace(capture_file=str(Path(temp)/'shop.json')))
            for _ in range(12):trace.frame(np.zeros((768,1366,3),dtype=np.uint8),'quantity','notice')
            trace.action('dismiss');trace.finish(PurchaseResult('not_bought',reason='error'))
            saved=json.loads(Path(events[0]['replay']).read_text(encoding='utf-8'))
            self.assertEqual(len(saved['frames']),8)
            self.assertEqual(saved['actions'],['dismiss'])
            order.diagnostic=lambda _: (_ for _ in ()).throw(RuntimeError('diagnostics offline'))
            trace.finish(PurchaseResult('bought',1,130))


if __name__=='__main__':unittest.main()
