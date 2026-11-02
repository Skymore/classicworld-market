import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
import collector_update as update


def metadata(tag=None):
    if tag is None:
        major,minor,patch_version=map(int,update.VERSION.split('.'))
        tag=f'v{major}.{minor}.{patch_version+1}'
    name=f'ClassicWorldCollector-windows-x64-{tag}.zip'
    return dict(schema=1,version=tag,channel='stable',windows_x64=dict(
        url=f'https://mxd.ruit.me/web/releases/{tag}/{name}',sha256='a'*64,size=100))


class CollectorUpdate(unittest.TestCase):
    def test_official_domain_manifest_and_r2_downloads_need_no_github(self):
        self.assertEqual(update.LATEST,'https://mxd.ruit.me/web/releases/stable.json')
        data=metadata()
        for base in update.DOWNLOAD_BASES:
            data['windows_x64']['url']=base+data['version']+'/ClassicWorldCollector-windows-x64-'+data['version']+'.zip'
            self.assertTrue(update.official_download_url(data['windows_x64']['url']))
            self.assertEqual(update.release_info(data)['url'],data['windows_x64']['url'])
        class Opener:
            def open(self,request,timeout):
                self.request=request
                return io.BytesIO(json.dumps(data).encode())
        opener=Opener()
        self.assertEqual(update.read_release(opener)['version'],data['version'])
        self.assertEqual(opener.request.full_url,update.LATEST)
        self.assertNotIn('Authorization',dict(opener.request.header_items()))

    def test_download_destination_cannot_escape_official_versioned_files(self):
        valid=metadata()['windows_x64']['url']
        bad=[valid.replace('https:','http:'),valid.replace('mxd.ruit.me','mxd.ruit.me.evil.example'),
             valid.replace('mxd.ruit.me','user@mxd.ruit.me'),valid+'?redirect=evil',valid+'#ignored',
             valid.replace('/'+metadata()['version']+'/','/v0.0.0/'),valid.replace('/web/releases/','/web/releases/../'),
             'https://github.com/Skymore/classicworld-market/releases/download/v0.5.11/update.zip']
        for url in bad:
            self.assertFalse(update.official_download_url(url),url)
            with self.assertRaises(ValueError):
                update.ReleaseRedirect().redirect_request(None,None,302,'redirect',{},url)
        for data in (None,[],{},dict(metadata(),schema=2)):
            with self.assertRaises(ValueError):update.release_info(data)

    def test_silent_update_stops_only_after_verified_download_and_wakes_uploader(self):
        stop=threading.Event();wakeup=threading.Event();ready=[]
        with tempfile.TemporaryDirectory() as folder,\
            patch.object(update,'read_release',return_value={'version':'v0.5.11'}),\
            patch.object(update,'ask_update',side_effect=AssertionError('must be silent')),\
            patch.object(update,'write_plan',return_value=(Path('test-plan'),Path('test-bundle'))):
            thread=update.start_checker(Path(folder),stop,ready,[],wakeup,game_running=lambda:False);thread.join(timeout=3)
        self.assertFalse(thread.is_alive());self.assertTrue(stop.is_set());self.assertTrue(wakeup.is_set())
        self.assertEqual(ready,[(Path('test-plan'),Path('test-bundle'))])

    def test_failed_download_keeps_capture_running(self):
        stop=threading.Event();ready=[];reported=threading.Event()
        def status(home,state,**fields):
            if state=='retry_later':reported.set()
        with tempfile.TemporaryDirectory() as folder,\
            patch.object(update,'read_release',return_value={'version':'v0.5.11'}),\
            patch.object(update,'update_status',side_effect=status),\
            patch.object(update,'write_plan',side_effect=ValueError('TEST ONLY bad download')),\
            patch('builtins.print',side_effect=UnicodeEncodeError('ascii','暂',0,1,'test console')),\
            patch.object(update,'show_error',side_effect=AssertionError('no error popup')):
            thread=update.start_checker(Path(folder),stop,ready,[],game_running=lambda:False)
            self.assertTrue(reported.wait(timeout=3));self.assertFalse(stop.is_set());self.assertFalse(ready)
            stop.set();thread.join(timeout=3)

    def test_hourly_fallback_and_push_wake_same_checker_without_duplicate_downloads(self):
        self.assertEqual(update.CHECK_INTERVAL,3600)
        stop=threading.Event();ready=[];calls=[];connected=threading.Event();push={}
        def listen(endpoint,stop,notify):push['notify']=notify;connected.set();stop.wait(5)
        def read():calls.append(time.monotonic());return None
        with tempfile.TemporaryDirectory() as folder,patch.object(update,'listen_updates',side_effect=listen),patch.object(update,'read_release',side_effect=read):
            thread=update.start_checker(folder,stop,ready,[],endpoint='https://mxd.ruit.me',interval=.15,cooldown=0)
            self.assertTrue(connected.wait(1))
            deadline=time.monotonic()+2
            while len(calls)<2 and time.monotonic()<deadline:time.sleep(.01)
            self.assertGreaterEqual(len(calls),2)
            stop.set();thread.join(2)
        stop=threading.Event();ready=[];connected.clear();calls.clear()
        with tempfile.TemporaryDirectory() as folder,patch.object(update,'listen_updates',side_effect=listen),patch.object(update,'read_release',side_effect=read):
            thread=update.start_checker(folder,stop,ready,[],endpoint='https://mxd.ruit.me',interval=3600,cooldown=0)
            self.assertTrue(connected.wait(1))
            deadline=time.monotonic()+2
            while not calls and time.monotonic()<deadline:time.sleep(.01)
            push['notify']('v0.5.11');push['notify']('v0.5.11')
            deadline=time.monotonic()+2
            while len(calls)<2 and time.monotonic()<deadline:time.sleep(.01)
            stop.set();thread.join(2)
            self.assertEqual(len(calls),2)

    def test_download_waits_for_game_exit_without_stopping_capture(self):
        stop=threading.Event();ready=[];waiting=threading.Event();game=threading.Event();game.set()
        def idle():waiting.set();return game.is_set()
        with tempfile.TemporaryDirectory() as folder,patch.object(update,'read_release',return_value={'version':'v0.5.11'}),patch.object(update,'write_plan',return_value=(Path('plan'),Path('bundle'))):
            thread=update.start_checker(folder,stop,ready,[],game_running=idle)
            self.assertTrue(waiting.wait(2));self.assertFalse(stop.is_set());self.assertFalse(ready)
            game.clear();thread.join(7)
            self.assertFalse(thread.is_alive());self.assertTrue(stop.is_set());self.assertEqual(len(ready),1)

    def test_desktop_updates_while_game_runs_only_after_safe_handoff(self):
        stop=threading.Event();ready=[];asked=threading.Event();safe=threading.Event()
        def prepare():asked.set();return safe.is_set()
        with tempfile.TemporaryDirectory() as folder,patch.object(update,'read_release',return_value={'version':'v0.6.56'}),\
             patch.object(update,'write_plan',return_value=(Path('plan'),Path('bundle'))) as plan,\
             patch.object(update,'ask_update',side_effect=AssertionError('no confirmation')):
            thread=update.start_checker(folder,stop,ready,[],game_running=lambda:True,prepare_restart=prepare)
            self.assertTrue(asked.wait(2));self.assertFalse(stop.is_set());self.assertFalse(ready)
            self.assertEqual(json.loads((Path(folder)/'update-status.json').read_text())['state'],'waiting_for_safe_restart')
            safe.set();thread.join(7)
            self.assertFalse(thread.is_alive());self.assertTrue(stop.is_set());self.assertEqual(len(ready),1)
            plan.assert_called_once()

    def test_failed_update_gate_keeps_collector_and_game_running(self):
        stop=threading.Event();ready=[];failed=threading.Event()
        def prepare():failed.set();raise OSError('checkpoint write failed')
        with tempfile.TemporaryDirectory() as folder,patch.object(update,'read_release',return_value={'version':'v0.6.56'}),\
             patch.object(update,'write_plan',return_value=(Path('plan'),Path('bundle'))):
            thread=update.start_checker(folder,stop,ready,[],game_running=lambda:True,prepare_restart=prepare)
            self.assertTrue(failed.wait(2));self.assertFalse(stop.is_set());self.assertFalse(ready)
            stop.set();thread.join(2)

    def test_push_notices_are_bounded_and_only_stable_newer_versions_trigger(self):
        raw=b': keepalive\n\nevent: market\ndata: {}\n\nevent: collector-update\ndata: {"version":"v0.5.7"}\n\nevent: collector-update\ndata: {"version":"v0.5.11","url":"https://evil.example/a.exe"}\n\n'
        with patch.object(update,'VERSION','0.5.10'):
            self.assertEqual(list(update.push_versions(io.BytesIO(raw),threading.Event())),['v0.5.11'])
        for raw in (b'x'*4097,b'event: collector-update\ndata: {"version":"evil"}\n\n'):
            with self.assertRaises(ValueError):list(update.push_versions(io.BytesIO(raw),threading.Event()))

    def test_broken_release_is_not_reinstalled_but_later_versions_remain_eligible(self):
        stop=threading.Event();ready=[];seen=threading.Event()
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder)/'update-blocked.json').write_text('{"version":"v0.5.11"}')
            def read():seen.set();return {'version':'v0.5.11'}
            with patch.object(update,'read_release',side_effect=read),patch.object(update,'write_plan') as plan:
                thread=update.start_checker(folder,stop,ready,[],game_running=lambda:False)
                self.assertTrue(seen.wait(2));stop.set();thread.join(2);plan.assert_not_called()
            stop.clear()
            with patch.object(update,'read_release',return_value={'version':'v0.5.12'}),patch.object(update,'write_plan',return_value=(Path('plan'),Path('bundle'))):
                thread=update.start_checker(folder,stop,ready,[],game_running=lambda:False);thread.join(2)
                self.assertEqual(len(ready),1)

    def test_failed_new_program_self_check_rolls_back_and_relaunches_old(self):
        import psutil
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundle=root/'unpacked'/'ClassicWorldCollector';bundle.mkdir(parents=True)
            old=root/'installed';old.mkdir();(old/update.EXE).write_bytes(b'old');(bundle/update.EXE).write_bytes(b'new')
            (old/'install-manifest.json').write_text(json.dumps({'files':[update.EXE,'install-manifest.json']}))
            plan=root/'plan.json';plan.write_text(json.dumps(dict(version='v0.5.5',bundle=str(bundle),install=str(old),
                parent_pid=987654321,parent_created=0,argv=['--self-test'],hashes={update.EXE:hashlib.sha256(b'new').hexdigest()})))
            with patch.object(update,'check_bundle',side_effect=ValueError('TEST ONLY broken package')),\
                patch.object(update.subprocess,'Popen') as launch,patch.object(update,'show_error'):
                with self.assertRaises(ValueError):update.apply_plan(plan,executable=bundle/update.EXE)
                self.assertEqual((old/update.EXE).read_bytes(),b'old')
                self.assertEqual(launch.call_args.args[0],[str((old/update.EXE).resolve()),'--self-test','--no-update'])

    def test_silent_failure_rolls_back_without_dialog_and_blocks_only_failed_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundle=root/'unpacked'/'ClassicWorldCollector';bundle.mkdir(parents=True)
            old=root/'installed';old.mkdir();(old/update.EXE).write_bytes(b'old');(bundle/update.EXE).write_bytes(b'new')
            (old/'install-manifest.json').write_text(json.dumps({'files':[update.EXE,'install-manifest.json']}))
            plan=root/'plan.json';plan.write_text(json.dumps(dict(version='v0.5.11',bundle=str(bundle),install=str(old),
                silent=True,home=str(root),parent_pid=987654321,parent_created=0,argv=['--self-test'],hashes={update.EXE:hashlib.sha256(b'new').hexdigest()})))
            with patch.object(update,'check_bundle',side_effect=ValueError('TEST ONLY broken package')),patch.object(update.subprocess,'Popen') as launch,patch.object(update,'show_error',side_effect=AssertionError('no dialog')):
                with self.assertRaises(ValueError):update.apply_plan(plan,executable=bundle/update.EXE)
                self.assertEqual((old/update.EXE).read_bytes(),b'old')
                self.assertEqual(json.loads((root/'update-blocked.json').read_text())['version'],'v0.5.11')
                self.assertEqual(launch.call_args.args[0],[str((old/update.EXE).resolve()),'--self-test','--no-browser'])
                if os.name=='nt':self.assertEqual(launch.call_args.kwargs['creationflags'],subprocess.CREATE_NO_WINDOW)
    @unittest.skipUnless(os.name=='nt','Windows packaged updater')
    def test_packaged_helper_replaces_program_preserves_records_and_restarts(self):
        marker=Path('dist/bundle-path.txt')
        if not marker.exists():self.skipTest('Build Windows bundle first')
        source=Path(marker.read_text(encoding='utf-8-sig').strip())
        if not (source/'install-manifest.json').exists():self.skipTest('Updater bundle not built')
        if json.loads((source/'install-manifest.json').read_text(encoding='utf-8-sig'))['version'] != update.VERSION:
            self.skipTest('Build the current version before testing its packaged helper')
        with tempfile.TemporaryDirectory(prefix='collector-update-test-') as folder:
            root=Path(folder);old=root/'installed';stage=root/'update';new=stage/'unpacked'/'ClassicWorldCollector'
            shutil.copytree(source,old);shutil.copytree(source,new)
            (old/'personal-record.json').write_text('TEST ONLY KEEP THIS RECORD')
            home=root/'private';home.mkdir();(home/'member.json').write_text('TEST ONLY NO NETWORK')
            child=subprocess.Popen([str(old/update.EXE),'--version'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            import psutil
            created=psutil.Process(child.pid).create_time();child.communicate(timeout=20)
            plan=stage/'plan.json';plan.write_text(json.dumps(dict(version='v'+update.VERSION,bundle=str(new),install=str(old),silent=True,home=str(home),
                parent_pid=child.pid,parent_created=created,argv=['--self-test','--home',str(home)],
                hashes={p.relative_to(new).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in new.rglob('*') if p.is_file()})),encoding='utf-8')
            # Explorer / scheduled-task launches commonly use the installation
            # directory. The frozen bootloader must release that directory too.
            result=subprocess.run([str(new/update.EXE),'--apply-update',str(plan)],cwd=old,capture_output=True,timeout=75)
            self.assertEqual(result.returncode,0,result.stdout.decode(errors='replace')+result.stderr.decode(errors='replace'))
            self.assertIn(b'Update complete',result.stdout)
            self.assertEqual((old/'personal-record.json').read_text(),'TEST ONLY KEEP THIS RECORD')
            self.assertEqual((home/'member.json').read_text(),'TEST ONLY NO NETWORK')
            self.assertEqual(len(list(root.glob('installed.backup-*'))),1)
            version=subprocess.run([str(old/update.EXE),'--version'],capture_output=True,timeout=20)
            self.assertIn(update.VERSION.encode(),version.stdout)
            # Wait for the relaunched offline self-test and PyInstaller bootloader
            # before TemporaryDirectory removes this isolated test installation.
            for process in psutil.process_iter(['exe']):
                try:
                    exe=process.info['exe']
                    if exe and Path(exe).resolve()==old/update.EXE:
                        process.wait(timeout=20)
                except psutil.NoSuchProcess:pass
    def test_stable_newer_only_and_release_asset_must_be_exact(self):
        self.assertIsNotNone(update.release_info(metadata()))
        self.assertIsNone(update.release_info(metadata('v0.5.4')))
        self.assertIsNone(update.release_info(metadata('v0.5.3')))
        data=metadata();data['channel']='preview';self.assertIsNone(update.release_info(data))
        for key,value in [('sha256',''),('size',update.MAX_ZIP+1),('url','https://evil.example/update.zip')]:
            data=metadata();data['windows_x64'][key]=value
            with self.assertRaises(ValueError):update.release_info(data)
        with self.assertRaises(ValueError):update.release_info(metadata('v0.5.5-beta'))

    def test_no_credentials_sent_and_bad_checksum_never_survives(self):
        class Opener:
            def open(self,request,timeout):
                self.request=request
                return io.BytesIO(b'actual')
        opener=Opener()
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'update.zip'
            info=dict(url=metadata()['windows_x64']['url'],size=6,sha256='0'*64)
            with self.assertRaises(ValueError):update.download(info,path,opener)
            self.assertFalse(path.exists())
            self.assertNotIn('Authorization',dict(opener.request.header_items()))
            info['sha256']=hashlib.sha256(b'actual').hexdigest()
            update.download(info,path,opener)
            self.assertEqual(path.read_bytes(),b'actual')

    def test_archive_paths_and_bombs_rejected_before_extraction(self):
        for name in ('../escape','ClassicWorldCollector/../../escape','/ClassicWorldCollector/a',
            'ClassicWorldCollector/C:/escape','ClassicWorldCollector/aux.txt','ClassicWorldCollector/a\\b'):
            with self.subTest(name=name),tempfile.TemporaryDirectory() as folder:
                archive=Path(folder)/'a.zip';target=Path(folder)/'out'
                with zipfile.ZipFile(archive,'w') as z:
                    entry=zipfile.ZipInfo();entry.filename=name;z.writestr(entry,b'bad')
                with self.assertRaises(ValueError):update.unpack(archive,target)
                self.assertFalse(target.exists())
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'a.zip'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('ClassicWorldCollector/ClassicWorldCollector.exe',b'exe')
                z.writestr('ClassicWorldCollector/_internal/lib',b'lib')
            with patch.object(update,'MAX_EXPANDED',1):
                with self.assertRaises(ValueError):update.unpack(archive,Path(folder)/'out')

    def test_swap_retains_personal_files_removes_stale_libraries_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old=root/'installed';new=root/'staged';backup=root/'backup'
            old.mkdir();new.mkdir()
            for p,data in [('ClassicWorldCollector.exe',b'old'),('obsolete.dll',b'old-lib'),('member.json',b'private'),('captures/record.json',b'record')]:
                path=old/p;path.parent.mkdir(exist_ok=True);path.write_bytes(data)
            (old/'install-manifest.json').write_text(json.dumps({'files':['ClassicWorldCollector.exe','obsolete.dll','install-manifest.json']}))
            (new/update.EXE).write_bytes(b'new')
            update.install_bundle(new,old,backup)
            self.assertEqual((old/update.EXE).read_bytes(),b'new')
            self.assertFalse((old/'obsolete.dll').exists())
            self.assertEqual((old/'member.json').read_bytes(),b'private')
            self.assertEqual((old/'captures/record.json').read_bytes(),b'record')
            self.assertEqual((backup/update.EXE).read_bytes(),b'old')

    def test_directory_swap_failure_restores_original(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old=root/'installed';new=root/'staged';backup=root/'backup'
            old.mkdir();new.mkdir();(old/update.EXE).write_bytes(b'old');(new/update.EXE).write_bytes(b'new')
            (old/'install-manifest.json').write_text(json.dumps({'files':[update.EXE,'install-manifest.json']}))
            rename=Path.rename
            def fail_candidate(path,destination):
                if path.name.startswith('.collector-new-'):raise OSError('TEST ONLY simulated failure')
                return rename(path,destination)
            with patch.object(Path,'rename',fail_candidate):
                with self.assertRaises(OSError):update.install_bundle(new,old,backup)
            self.assertEqual((old/update.EXE).read_bytes(),b'old')
            self.assertFalse(backup.exists())

    def test_changed_staging_refuses_before_install(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundle=root/'unpacked'/'ClassicWorldCollector';bundle.mkdir(parents=True)
            installed=root/'installed';installed.mkdir()
            (bundle/update.EXE).write_bytes(b'changed');(installed/update.EXE).write_bytes(b'old')
            plan=root/'plan.json';plan.write_text(json.dumps(dict(bundle=str(bundle),install=str(installed),
                hashes={update.EXE:'0'*64})))
            with self.assertRaises(ValueError):update.apply_plan(plan,executable=bundle/update.EXE)
            self.assertEqual((installed/update.EXE).read_bytes(),b'old')


if __name__=='__main__':unittest.main()
