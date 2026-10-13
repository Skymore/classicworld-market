import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile

from market_dashboard import Repository
from market_snapshot import export_snapshot, restore_snapshot


class SnapshotTests(unittest.TestCase):
    def test_export_restore_preserves_prices_without_private_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = Repository(root / 'source', root / 'absent')
            visit = dict(session='PRIVATE_SESSION', host='PRIVATE_IP', raw_source='PRIVATE_PATH',
                         time=1000, shop_id=12, title='Public shop',
                         market_location=dict(channel=1, room=2, map_id=80002002, session='PRIVATE_SESSION'),
                         items=[dict(item_id=1452003, slot=1, price_mesos_candidate=999,
                                     bundle_quantity_candidate=1, available_quantity_candidate=1,
                                     raw_record_hex='010001000100000001000000d0dd0600000000000101e327160000008005bb46e61702ffffffff010100010001003c000200040004ff000000000000')])
            for i, experimental in enumerate((False, True)):
                visit['triggered_by_python'] = experimental
                path = root / f'visit{i}.json'
                path.write_text(json.dumps(visit), encoding='utf-8')
                repo.ingest(path, collector='PRIVATE_COLLECTOR')
                visit['time'] += 1
            with repo.connect() as db:
                db.execute('CREATE TABLE members (token TEXT)')
                db.execute("INSERT INTO members VALUES ('PRIVATE_TOKEN')")
            catalog = root / 'catalog.sqlite'
            with closing(sqlite3.connect(catalog)) as db, db:
                db.execute('CREATE TABLE items (item_id INTEGER,name_zh TEXT,name_en TEXT,category TEXT,name_status TEXT,source_version TEXT,icon_url TEXT,record_json TEXT)')
                db.execute('INSERT INTO items VALUES (?,?,?,?,?,?,?,?)',
                           (1452003, '战斗弓', 'Battle Bow', '弓', 'test', 'test', None,
                            json.dumps(dict(item_id=1452003, level=25, private='PRIVATE_CATALOG'))))
            output = root / 'snapshot.zip'
            manifest = export_snapshot(repo.db, catalog, output)
            self.assertEqual(manifest['counts'], dict(visits=1, observations=1, excluded_experiments=1, catalog_items=1))
            with zipfile.ZipFile(output) as archive:
                for name in archive.namelist():
                    self.assertNotIn(b'PRIVATE_', archive.read(name))
            restored = root / 'restored'
            restore_snapshot(output, restored)
            restored_repo = Repository(restored / 'market_data', restored / 'item_database/items.sqlite')
            report = restored_repo.report(None)
            row = report['products'][0]['quotes'][0]
            self.assertEqual((row['price'], row['stock'], row['level']), (999, 1, 25))
            self.assertEqual(row['location'], dict(channel=1, room=2, map_id=80002002))
            self.assertEqual(row['equipment']['enhancements'], 4)
            self.assertFalse(row['raw_available'])
            with self.assertRaises(FileExistsError):
                restore_snapshot(output, restored)
            with self.assertRaises(FileExistsError):
                export_snapshot(repo.db, catalog, output)

    def test_restore_rejects_extra_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / 'invalid.zip'
            with zipfile.ZipFile(archive_path, 'w') as archive:
                archive.writestr('../unexpected.txt', 'no')
            with self.assertRaises(ValueError):
                restore_snapshot(archive_path, Path(tmp) / 'target')


if __name__ == '__main__':
    unittest.main()
