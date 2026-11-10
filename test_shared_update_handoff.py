import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import shared_client

@unittest.skipUnless(sys.platform=='win32','Windows packaged updater')
class UpdateHandoff(unittest.TestCase):
    def test_packaged_collector_launches_prepared_helper_after_shutdown(self):
        with tempfile.TemporaryDirectory() as temp:
            home=Path(temp);config=home/'member.json'
            config.write_text(json.dumps({'member_id':'test','token':'synthetic-only','endpoint':'http://127.0.0.1:1'}))
            plan=home/'plan.json';bundle=home/'bundle'
            seen={}
            def ready(home,stop,updates,argv,changed,endpoint,handoff=None):
                seen['handoff']=handoff;updates.append((plan,bundle));stop.set()
            args=['collector','--upload-only','--no-dashboard','--home',str(home),'--config',str(config)]
            with patch.object(sys,'argv',args),patch.object(sys,'frozen',True,create=True),\
                 patch('collector_update.start_checker',side_effect=ready),\
                 patch('collector_history.repair_history',return_value=0),\
                 patch('collector_owner_migration.migrate_owners',return_value=0),\
                 patch('shared_client.subprocess.Popen') as spawn:
                shared_client.main()
            spawn.assert_called_once()
            self.assertEqual(spawn.call_args.args[0],[str(bundle/'ClassicWorldCollector.exe'),'--apply-update',str(plan)])
            # The helper starts outside the install folder, and an upload-only process has no capture to hand over.
            self.assertEqual(spawn.call_args.kwargs['cwd'],home)
            self.assertIsNone(seen['handoff'])

if __name__=='__main__':unittest.main()
