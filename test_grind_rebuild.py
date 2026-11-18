import json
import tempfile
import unittest
from pathlib import Path

import grind_rebuild
from grind_replay import REPLAY_VERSION


class RebuildTest(unittest.TestCase):
    def test_a_process_only_while_this_release_has_a_rebuild_left(self):
        with tempfile.TemporaryDirectory() as folder:
            status = Path(folder) / 'grind' / 'replay.json'
            self.assertTrue(grind_rebuild.needed(folder))                     # never rebuilt
            status.parent.mkdir(parents=True)
            status.write_text(json.dumps(dict(version=REPLAY_VERSION, state='running')), encoding='utf-8')
            self.assertTrue(grind_rebuild.needed(folder))                     # interrupted: carry on
            status.write_text(json.dumps(dict(version='older', state='done')), encoding='utf-8')
            self.assertTrue(grind_rebuild.needed(folder))                     # an earlier release's
            status.write_text(json.dumps(dict(version=REPLAY_VERSION, state='done')), encoding='utf-8')
            self.assertFalse(grind_rebuild.needed(folder))
            self.assertIsNone(grind_rebuild.start(folder))                    # nothing to start


if __name__ == '__main__':
    unittest.main()
