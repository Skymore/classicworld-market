import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import collector_legacy_update as bridge
from collector_update import VERSION, EXE


class LegacyBridge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home'
        self.install = self.root/'installed'
        self.install.mkdir()
        self.stage = self.home/'updates'/'release-example'
        self.bundle = self.stage/'unpacked'/'ClassicWorldCollector'
        self.bundle.mkdir(parents=True)
        (self.install/'install-manifest.json').write_text('{"version":"0.5.10"}')
        self.exe = self.bundle/EXE
        self.exe.write_bytes(b'test bundle')
        self.context = dict(home=str(self.home), install=str(self.install), bundle=str(self.bundle),
                            version='0.5.10', parent_pid=123, parent_created=time.time()-100,
                            argv=['--home',str(self.home),'--upload-only'])
        self.plan = dict(self.context, version='v'+VERSION, silent=True,
                         hashes={EXE:hashlib.sha256(self.exe.read_bytes()).hexdigest()})
        self.path = self.stage/'plan.json'

    def check(self):
        self.path.write_text(json.dumps(self.plan))
        return bridge.validate_plan(self.context,self.path,self.exe)

    def test_exact_legacy_plan_is_accepted(self):
        self.assertEqual(self.check()['parent_pid'],123)

    def test_newer_release_waits_for_superseded_helper_to_release_lock(self):
        with (self.home/'test.lock').open('a+b') as lock, \
                patch('msvcrt.locking',side_effect=[OSError('busy'),OSError('busy'),None]) as acquire, \
                patch.object(bridge.time,'sleep'):
            self.assertTrue(bridge.acquire_lock(lock))
            self.assertEqual(acquire.call_count,3)

    def test_competing_helper_lock_wait_is_bounded(self):
        with (self.home/'test.lock').open('a+b') as lock, \
                patch('msvcrt.locking',side_effect=OSError('busy')), \
                patch.object(bridge.time,'sleep'):
            self.assertFalse(bridge.acquire_lock(lock,timeout=0))

    def test_fixed_versions_and_ordinary_self_tests_never_opt_in(self):
        for version in ('0.5.9','0.5.12',VERSION):
            with self.subTest(version=version):
                self.context['version']=version
                with self.assertRaises(ValueError):self.check()
        self.context['version']='0.5.10'
        self.context['argv'].append('--self-test')
        with self.assertRaises(ValueError):self.check()
        with patch.object(bridge.sys,'frozen',False,create=True):
            self.assertFalse(bridge.maybe_start_bridge())

    def test_rejects_modified_targets_args_parent_and_incomplete_hashes(self):
        for key,value in [('install',str(self.root)),('home',str(self.root)),
                          ('parent_pid',456),('parent_created',0),('argv',[]),('hashes',{}),
                          ('version','v99.0.0'),('silent',False)]:
            with self.subTest(key=key):
                original=self.plan[key];self.plan[key]=value
                with self.assertRaises(ValueError):self.check()
                self.plan[key]=original
        self.exe.write_bytes(b'tampered')
        with self.assertRaises(ValueError):self.check()

    def test_rejects_foreign_home_and_unrelated_stage(self):
        self.context['home']=str(self.root)
        with self.assertRaises(ValueError):self.check()

    def test_only_explicit_current_shutdown_status_allows_handoff(self):
        status=dict(current='0.5.10',state='restarting',available='v'+VERSION,at=time.time())
        self.assertTrue(bridge.restart_requested(status,self.context,'v'+VERSION))
        for key,value in [('state','waiting_for_game_exit'),('state','downloading'),
                          ('current','0.5.12'),('available','v0.5.12'),('at',0),('at','invalid')]:
            with self.subTest(key=key,value=value):
                self.assertFalse(bridge.restart_requested(dict(status,**{key:value}),self.context,'v'+VERSION))

    def test_process_id_reuse_or_changed_arguments_rejects_handoff(self):
        from unittest.mock import Mock
        process=Mock()
        process.create_time.return_value=self.context['parent_created']
        process.exe.return_value=str(self.install/EXE)
        process.cmdline.return_value=[str(self.install/EXE),*self.context['argv']]
        with patch('psutil.Process',return_value=process):
            self.assertIs(bridge.same_process(self.context),process)
            process.create_time.return_value+=100
            with self.assertRaises(ValueError):bridge.same_process(self.context)


if __name__=='__main__':unittest.main()
