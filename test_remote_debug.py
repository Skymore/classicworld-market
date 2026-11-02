import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from collector_remote_debug import RemoteDebug
from remote_debug_process import run

class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.client=RemoteDebug(SimpleNamespace(stop_event=threading.Event()))

    def test_no_persistent_or_implicit_consent(self):
        self.assertFalse(self.client.view()['active'])
        self.assertIsNone(self.client.thread)
        with self.assertRaises(ValueError):self.client.start(True)
        with patch('collector_remote_debug.elevated',return_value=False):
            with self.assertRaises(PermissionError):self.client.start('allow-admin-powershell-15-minutes')

    def test_disconnect_revokes_and_cancels_execution(self):
        calls=[]
        def request(body,**kwargs):
            calls.append(body['action'])
            if body['action']=='open':return {'session':'a'*24}
            if body['action']=='close':return {}
            raise TimeoutError()
        self.client.request=request
        self.client.worker()
        self.assertTrue(self.client.cancel.is_set())
        self.assertFalse(self.client.view()['active'])
        self.assertEqual(calls,['open','poll','close'])

    def test_local_stop_does_not_wait_for_network(self):
        self.client.status['active']=True
        self.client.stop()
        self.assertTrue(self.client.cancel.is_set())
        self.assertFalse(self.client.view()['active'])

    def test_guard_expires_even_when_network_is_busy(self):
        self.client.status['active']=True
        self.client.guard(self.client.cancel,time.monotonic()-1)
        self.assertTrue(self.client.cancel.is_set())
        self.assertFalse(self.client.view()['active'])

    def test_duplicate_delivery_never_executes_twice(self):
        def request(body,**kwargs):
            if body['action']=='open':return {'session':'a'*24}
            if body['action']=='close':return {}
            if body['action']=='result':return {'active':True,'ack':body['command']}
            return {'active':True,'command':{'id':'one','script':'Get-Date'}}
        self.client.request=request
        with patch('collector_remote_debug.run',return_value={'output':'ok','exit_code':0}) as execute:
            self.client.worker()
        self.assertEqual(execute.call_count,1)
        self.assertFalse(self.client.view()['active'])

@unittest.skipUnless(os.name=='nt','Windows process containment')
class ProcessTests(unittest.TestCase):
    # Containment can be exercised without elevating the test runner; production
    # refuses non-elevated execution. A separate elevated smoke verifies token.
    def execute(self,script,cancel=None,timeout=60):
        with patch('remote_debug_process.elevated',return_value=True):
            return run(script,cancel or threading.Event(),timeout)

    def test_output_and_failure(self):
        answer=self.execute("Write-Output 'debug-ok'; Write-Output '中文'")
        self.assertEqual(answer['exit_code'],0)
        self.assertIn('debug-ok',answer['output']);self.assertIn('中文',answer['output'])
        self.assertNotEqual(self.execute("throw 'synthetic failure'")['exit_code'],0)

    def test_cancellation_terminates_children(self):
        import psutil
        with tempfile.TemporaryDirectory() as folder:
            marker=Path(folder)/'child.txt'
            script="$p=Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep 60' -PassThru; [IO.File]::WriteAllText('"+str(marker)+"',[string]$p.Id); Start-Sleep 60"
            cancel=threading.Event();answer={}
            thread=threading.Thread(target=lambda:answer.update(self.execute(script,cancel)))
            thread.start()
            deadline=time.monotonic()+10
            while not marker.exists() and time.monotonic()<deadline:time.sleep(.05)
            cancel.set();thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertTrue(marker.exists())
            pid=int(marker.read_text())
            self.assertFalse(psutil.pid_exists(pid),'descendant must be terminated with the job')

    def test_timeout_and_precancel_never_run(self):
        cancel=threading.Event();cancel.set()
        self.assertEqual(self.execute("throw 'must not run'",cancel)['exit_code'],-1)
        began=time.monotonic();self.execute('Start-Sleep 60',timeout=.2)
        self.assertLess(time.monotonic()-began,5)

if __name__=='__main__':unittest.main()
