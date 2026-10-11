import unittest
from market_health import classify
from market_proxy import allowed_destination


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.status=dict(updated_at=100,sessions=[])
        self.records=[dict(remote='8.8.8.8:8540',state='ESTABLISHED')]

    def test_listening_is_not_ready(self):
        self.assertEqual(classify(self.status,[],now=101)['state'],'waiting')

    def test_direct_connection_requires_reconnect(self):
        self.assertEqual(classify(self.status,self.records,now=101)['state'],'reconnect_required')

    def test_ready_requires_protocol_map_and_no_fault(self):
        self.status['sessions']=[dict(host='8.8.8.8',port=8540,closed=False,map_ready=False)]
        self.assertEqual(classify(self.status,[],now=101)['state'],'handshake')
        self.status['sessions'][0]['map_ready']=True
        self.assertEqual(classify(self.status,self.records,now=101)['state'],'ready')
        self.status['sessions'][0]['diagnostic_fault']=True
        self.assertEqual(classify(self.status,[],now=101)['state'],'parse_error')

    def test_stale_status_is_not_ready(self):
        self.assertEqual(classify(self.status,self.records,now=120)['state'],'offline')

    def test_detection_failure_is_not_no_game(self):
        self.assertEqual(classify(self.status,[],error='denied',now=101)['state'],'unknown')

    def test_dynamic_destination_is_bounded(self):
        self.assertTrue(allowed_destination('8.8.8.8',8540,True))
        self.assertFalse(allowed_destination('8.8.8.8',8540,False))
        for host,port in [('127.0.0.1',8540),('192.168.1.1',8540),('8.8.8.8',443),('8.8.8.8',8913)]:
            self.assertFalse(allowed_destination(host,port,True))


if __name__=='__main__': unittest.main()
