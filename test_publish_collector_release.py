import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import collector_update as update
from publish_collector_release import publish


class ReleasePublisherTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        for name in ('SHARED_CLIENT_GUIDE.md', 'COLLECTOR_QUICK_START.txt'):
            (self.root/name).write_text('Synthetic public guide', encoding='utf-8')

    def archive(self, tag='v0.5.10', extra=None):
        path = self.root/f'ClassicWorldCollector-windows-x64-{tag}.zip'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('ClassicWorldCollector/install-manifest.json', json.dumps({'version':tag[1:]}))
            z.writestr('ClassicWorldCollector/'+update.EXE, b'synthetic executable')
            if extra:
                z.writestr(extra, b'synthetic forbidden data')
        return path

    def test_public_download_matches_manifest_and_published_versions_are_immutable(self):
        archive = self.archive()
        manifest = publish(archive, self.root)
        self.assertEqual(manifest['windows_x64']['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        with zipfile.ZipFile(archive, 'a') as z:
            z.writestr('ClassicWorldCollector/changed.txt', 'different')
        with self.assertRaisesRegex(ValueError, 'immutable'):
            publish(archive, self.root)
        stable = self.root/'web/releases/stable.json'
        self.assertEqual(json.loads(stable.read_text()), manifest)

    def test_failed_r2_download_does_not_change_working_manifest(self):
        archive = self.archive()
        previous = publish(archive, self.root)
        with patch.object(update, 'download', side_effect=ValueError('hash mismatch')):
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                publish(archive, self.root, update.DOWNLOAD_BASES[1])
        self.assertEqual(json.loads((self.root/'web/releases/stable.json').read_text()), previous)

    def test_private_data_and_recursive_releases_are_rejected(self):
        for name in ('ClassicWorldCollector/member.json', 'ClassicWorldCollector/web/releases/old.zip',
                     'ClassicWorldCollector/raw.pcap'):
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Private or recursive'):
                    publish(self.archive(extra=name), self.root)
        self.assertFalse((self.root/'web/releases/stable.json').exists())

    def test_stable_cannot_be_downgraded(self):
        publish(self.archive('v0.5.11'), self.root)
        with self.assertRaisesRegex(ValueError, 'downgrade'):
            publish(self.archive(), self.root)


if __name__ == '__main__':
    unittest.main()
