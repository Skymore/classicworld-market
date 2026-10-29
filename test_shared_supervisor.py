"""Recovery must continue when the database outlives the first web attempt."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import shared_supervisor as supervisor


class EndLoop(Exception):
    pass


class SupervisorRecoveryTests(unittest.TestCase):
    def test_retries_web_after_database_recovery_without_startup_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = root / 'shared_data'
            data.mkdir()
            # An existing legacy database used to trigger blocking backup work.
            (data / 'market.sqlite').touch()
            (data / 'native-runtime.json').write_text(json.dumps({
                'enabled': True, 'legacy_dashboard_enabled': False,
                'database_url': 'postgresql://unused/unused',
            }))
            launched = []
            ticks = 0

            class Child:
                def __init__(self, command, **kwargs):
                    self.command = command
                    self.pid = 100 + len(launched)
                    self.stopped = False
                    launched.append(self)

                def poll(self):
                    if self.stopped:
                        return 0
                    # First web process exits while PostgreSQL is recovering.
                    if self.command == ['web.exe'] and self.pid == 101:
                        return 1 if ticks else None
                    return None

                def terminate(self):
                    self.stopped = True

            def advance(seconds):
                nonlocal ticks
                ticks += 1
                if ticks == 3:
                    raise EndLoop()

            with patch.object(supervisor, 'ROOT', root), \
                    patch.object(supervisor.sys, 'argv', ['shared_supervisor.py']), \
                    patch.object(supervisor, 'web_runtime', return_value=(Path('web.exe'), root / 'web', 'test-release')), \
                    patch.object(supervisor, 'web_environment', return_value={}), \
                    patch.object(supervisor.subprocess, 'Popen', side_effect=Child), \
                    patch.object(supervisor.subprocess, 'run', side_effect=AssertionError('Blocking subprocess in supervisor')), \
                    patch('sqlite3.connect', side_effect=AssertionError('Blocking backup in supervisor')), \
                    patch.object(supervisor.time, 'time', side_effect=lambda: 200000 + ticks * 25), \
                    patch.object(supervisor.time, 'sleep', side_effect=advance):
                with self.assertRaises(EndLoop):
                    supervisor.main()

            status = json.loads((data / 'supervisor_status.json').read_text())
            self.assertEqual(len([p for p in launched if p.command == ['web.exe']]), 2)
            self.assertEqual(len([p for p in launched if p.command[0].endswith('postgres.exe')]), 1)
            self.assertTrue(status['children']['web']['running'])
            self.assertEqual(status['time'], 200050)
            self.assertFalse((data / 'backups').exists())


if __name__ == '__main__':
    unittest.main()
