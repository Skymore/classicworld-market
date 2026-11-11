import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from mesowatch_sync import LIST_URL, ITEM_BASE, BrowserBlocked, read_json, sync_once, write_json


class Reader:
    def __init__(self, listing, documents):
        self.listing, self.documents, self.calls = listing, documents, []

    def get(self, url):
        self.calls.append(url)
        if url == LIST_URL:
            return self.listing
        value = self.documents[url.removeprefix(ITEM_BASE)]
        if isinstance(value, Exception):
            raise value
        return value


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'item_database').mkdir()
        with sqlite3.connect(self.root / 'item_database/items.sqlite') as db:
            db.execute('CREATE TABLE items(item_id INTEGER,name_en TEXT,name_zh TEXT)')
            db.executemany('INSERT INTO items VALUES(?,?,?)', [(4010001,'Iron Ore','铁'),(4010000,'Bronze Ore','铜')])
        db.close()
        self.listing = dict(market='Classic World', preview=False, generated_at='2026-11-10T12:00:00Z',
                            items=[dict(id='basil:04010001',name='Iron Ore',unitBasis='item',sold=1),
                                   dict(id='basil:04010000',name='Bronze Ore',unitBasis='item',sold=1)])
        self.docs = {item['id'].replace(':','_')+'.json': dict(market='Classic World',id=item['id'],
                     generated_at='2026-11-10T11:59:00Z',sales=[],listings=[]) for item in self.listing['items']}
        self.imports = []

    def importer(self, path):
        self.imports.append(read_json(path))
        return dict(sales_added=0,changed_sales=0,skipped_items=[],skipped_points=0)

    def test_unchanged_list_skips_items_and_only_changed_item_is_downloaded(self):
        reader = Reader(self.listing, self.docs)
        self.assertEqual(sync_once(self.root, reader, self.importer)['imported'], 2)
        reader.calls.clear()
        self.assertEqual(sync_once(self.root, reader, self.importer)['status'], 'unchanged')
        self.assertEqual(reader.calls, [LIST_URL])
        self.listing['items'][0]['sold'] = 2
        reader.calls.clear()
        result = sync_once(self.root, reader, self.importer)
        self.assertEqual(result['imported'], 1)
        self.assertEqual(reader.calls, [LIST_URL, ITEM_BASE+'basil_04010001.json'])
        self.assertEqual(len(self.imports[-1]['items']), 1)
        self.assertEqual(self.imports[-1]['sales'], [])

    def test_failed_import_reuses_download_and_does_not_acknowledge_list(self):
        reader = Reader(self.listing, self.docs)
        def fail(_): raise RuntimeError('database unavailable')
        with self.assertRaises(RuntimeError): sync_once(self.root, reader, fail)
        state = read_json(self.root / 'shared_data/mesowatch-sync/state.json')
        self.assertNotIn('completed_list_hash', state)
        self.assertNotIn('imported_summary', state['items']['basil:04010001'])
        reader.calls.clear()
        self.assertEqual(sync_once(self.root, reader, self.importer)['imported'], 2)
        self.assertEqual(reader.calls, [ITEM_BASE+'basil_04010000.json'])

    def test_partial_batch_resumes_even_when_list_has_not_changed(self):
        reader = Reader(self.listing, self.docs)
        result = sync_once(self.root, reader, self.importer, max_items=1)
        self.assertEqual((result['status'],result['pending']), ('partial',1))
        # The next published list changes its first item again. Finish the tail
        # of the active snapshot before chasing the head of the new snapshot.
        self.listing['items'][0]['sold'] = 2
        reader.calls.clear()
        result = sync_once(self.root, reader, self.importer, max_items=1)
        self.assertEqual((result['status'],result['pending']), ('complete',0))
        self.assertEqual(reader.calls, [ITEM_BASE+'basil_04010000.json'])

    def test_challenge_and_incomplete_item_never_replace_a_good_snapshot(self):
        reader = Reader(self.listing,self.docs)
        sync_once(self.root,reader,self.importer)
        self.listing['items'][0]['sold'] = 2
        old = read_json(self.root / 'shared_data/mesowatch-sync/state.json')
        self.docs['basil_04010001.json'] = BrowserBlocked('HTTP 403')
        with self.assertRaises(BrowserBlocked): sync_once(self.root,reader,self.importer)
        self.docs['basil_04010001.json'] = dict(market='Classic World',id='basil:04010001',sales=[])
        with self.assertRaises(ValueError): sync_once(self.root,reader,self.importer)
        state=read_json(self.root / 'shared_data/mesowatch-sync/state.json')
        self.assertEqual(state['items'],old['items'])
        self.assertEqual(state['completed_list_hash'],old['completed_list_hash'])

    def test_wrong_names_are_rejected_before_download(self):
        self.listing['items'][0]['name'] = 'Wrong Ore'
        reader=Reader(self.listing,self.docs)
        result=sync_once(self.root,reader,self.importer)
        self.assertEqual(result['rejected'],1)
        self.assertEqual(result['imported'],1)
        self.assertNotIn(ITEM_BASE+'basil_04010001.json',reader.calls)

    def test_stale_item_is_not_acknowledged(self):
        self.listing['items'][0]['lastSold'] = '2026-11-10T11:59:30Z'
        with self.assertRaisesRegex(ValueError,'behind its list'):
            sync_once(self.root,Reader(self.listing,self.docs),self.importer)
        self.assertEqual(self.imports,[])


if __name__ == '__main__':
    unittest.main()
