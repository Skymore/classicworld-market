"""Incremental authorized raw evidence sync through a persistent Chrome session.

Run with --root pointing at the shared deployment. A local extension reuses
the normal Chrome session; the unattended worker never solves challenges.
Private snapshots, browser state and receipts stay under shared_data.
"""
import argparse
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

from mesowatch_bridge import BridgeReader, BrowserBlocked, prepare_extension
from mesowatch_convert import mapping_status, timestamp
from mesowatch_points import build

ROOT = Path(__file__).resolve().parent
ORIGIN = 'https://meso.watch'
LIST_URL = ORIGIN + '/data/list.json'
ITEM_BASE = ORIGIN + '/data/markets/Classic%20World/item/'


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.pending')
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                                    allow_nan=False), encoding='utf-8')
    os.replace(temporary, path)


@contextmanager
def worker_lock(home):
    home.mkdir(parents=True, exist_ok=True)
    with (home / 'worker.lock').open('a+b') as lock:
        lock.seek(0); lock.write(b'1'); lock.flush(); lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def item_filename(source_id):
    if not re.fullmatch(r'(basil|cash):[0-9]{8}', source_id):
        raise ValueError('Unsupported source item ID')
    return source_id.replace(':', '_') + '.json'


def validate_list(doc):
    if (not isinstance(doc, dict) or doc.get('market') != 'Classic World'
            or doc.get('preview') is not False or not isinstance(doc.get('items'), list)):
        raise ValueError('Expected published Classic World list; refusing another market or schema')
    if not doc['items'] or not timestamp(doc.get('generated_at')):
        raise ValueError('Empty or unversioned market list')
    ids = [item['id'] for item in doc['items']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate list item ID')


def import_points(root, path):
    native = read_json(root / 'shared_data/native-runtime.json', {})
    settings = native.get('mesowatch', {})
    binary = Path(settings.get('importer', root / 'shared_data/mesowatch-sync/bin/import_mesowatch.exe'))
    env = dict(os.environ, DATABASE_URL=native['database_url'])
    result = subprocess.run([str(binary), str(path)], env=env, capture_output=True,
                            text=True, encoding='utf-8', timeout=300,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        # SQL driver errors may contain private connection details. Keep the
        # status/log safe; do not copy arbitrary stderr into supervisor logs.
        raise RuntimeError(f'Importer failed (exit {result.returncode})')
    return json.loads(result.stdout)


def sync_once(root, reader, importer=None, max_items=150):
    root = Path(root)
    home = root / 'shared_data/mesowatch-sync'
    snapshot = home / 'snapshot'
    state_path = home / 'state.json'
    state = read_json(state_path, {'items': {}})
    # Finish a frozen list before starting a newer one. Otherwise frequently
    # changing top-volume items can starve the tail of an initial full sync.
    listing = read_json(snapshot / 'list.json') if state.get('active_list_hash') else None
    if listing is None:
        listing = reader.get(LIST_URL)
    validate_list(listing)
    version = timestamp(listing['generated_at'])
    if version < state.get('list_version', 0):
        raise ValueError('Source returned an older market list')
    list_hash = fingerprint(listing)
    if list_hash == state.get('completed_list_hash'):
        return dict(status='unchanged', imported=0, pending=0, source_generated_at=listing['generated_at'])
    write_json(snapshot / 'list.json', listing)
    state['active_list_hash'] = list_hash
    write_json(state_path, state)
    catalog = root / 'item_database/items.sqlite'
    with closing(sqlite3.connect(catalog.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        local = {i: {'name_en': en} for i, en in db.execute('SELECT item_id,name_en FROM items')}
    selected, rejected = [], []
    for item in listing['items']:
        try:
            reason = mapping_status(item, local)
        except (ValueError, TypeError):
            reason = 'unsupported_id'
        if reason != 'same_id_and_name':
            rejected.append({'id': item['id'], 'reason': reason})
            continue
        # Summaries select which raw files to fetch; never become price samples.
        signature = fingerprint(item)
        if state['items'].get(item['id'], {}).get('imported_summary') != signature:
            selected.append((item, signature))
    write_json(home / 'rejected-items.json', rejected)
    importer = importer or (lambda path: import_points(root, path))
    totals = dict(status='complete', imported=0, downloaded=0, sales_added=0, changed_sales=0,
                  pending=len(selected), rejected=len(rejected), source_generated_at=listing['generated_at'])
    for item, signature in selected[:max_items]:
        source_id = item['id']
        filename = item_filename(source_id)
        cached = state['items'].setdefault(source_id, {})
        raw_path = snapshot / 'items' / filename
        doc = read_json(raw_path)
        if cached.get('downloaded_summary') != signature or doc is None:
            doc = reader.get(ITEM_BASE + filename)
            if (not isinstance(doc, dict) or doc.get('market') != 'Classic World'
                    or doc.get('id') != source_id or not isinstance(doc.get('sales'), list)
                    or not isinstance(doc.get('listings'), list)):
                raise ValueError(f'Incomplete or wrong raw export: {source_id}')
            generated = timestamp(doc.get('generated_at'))
            if not generated or generated < cached.get('generated_at', 0):
                raise ValueError(f'Stale item export: {source_id}')
            # Source event clocks can run ahead of generated_at (observed in
            # real exports). Compare generations and actual contained evidence,
            # not the export timestamp against its own event timestamps.
            newest_sale = max((timestamp(row.get('time')) or 0 for row in doc['sales']), default=0)
            newest_listing = max((timestamp(row.get('lastSeen')) or 0 for row in doc['listings']), default=0)
            if generated < version and ((timestamp(item.get('lastSold')) or 0) > newest_sale
                                        or (timestamp(item.get('listedLast')) or 0) > newest_listing):
                raise ValueError(f'Item export is behind its list: {source_id}')
            write_json(raw_path, doc)
            cached.update(downloaded_summary=signature, generated_at=generated)
            write_json(state_path, state)
            totals['downloaded'] += 1
        points = build(snapshot, catalog, {source_id})
        # A stable manifest gives retries the same receipt even after a crash.
        points['manifest'].pop('built_at', None)
        points_path = home / 'points-import.json'
        write_json(points_path, points)
        result = importer(points_path)
        if result.get('skipped_items') or result.get('skipped_points'):
            raise ValueError(f'Destination rejected evidence for {source_id}')
        cached['imported_summary'] = signature
        cached['imported_at'] = time.time()
        write_json(state_path, state)
        totals['imported'] += 1
        totals['pending'] -= 1
        totals['sales_added'] += result.get('sales_added', 0)
        totals['changed_sales'] += result.get('changed_sales', 0)
        write_json(home / 'status.json', dict(totals, status='running', time=time.time()))
    if not totals['pending']:
        state.update(completed_list_hash=list_hash, list_version=version, completed_at=time.time())
        state.pop('active_list_hash', None)
        write_json(state_path, state)
    else:
        totals['status'] = 'partial'
    return totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--prepare-extension', action='store_true')
    parser.add_argument('--browser-only', action='store_true', help='Verify browser access without importing')
    args = parser.parse_args()
    root = args.root.resolve()
    home = root / 'shared_data/mesowatch-sync'
    if args.prepare_extension:
        path, extension_id = prepare_extension(home, ROOT / 'tools/mesowatch-extension')
        print(json.dumps(dict(path=str(path), extension_id=extension_id)))
        return 0
    with worker_lock(home), BridgeReader(home) as reader:
        while True:
            native = read_json(root / 'shared_data/native-runtime.json', {})
            settings = native.get('mesowatch', {})
            if args.loop and not settings.get('enabled', False):
                write_json(home / 'status.json', {'status': 'disabled', 'time': time.time()})
                time.sleep(30)
                continue
            interval = max(1800, float(settings.get('interval_seconds', 1800)))
            reader.delay = max(1, float(settings.get('request_delay_seconds', 2)))
            previous = read_json(home / 'status.json', {})
            if args.loop and previous.get('next_run_at', 0) > time.time():
                # Installing/opening Chrome after a missing-browser timeout can
                # resume immediately, without waiting the entire polling period.
                resumed = (previous.get('status') == 'needs_browser_verification'
                           and reader.last_browser_seen > previous.get('time', 0)
                           and previous.get('message', '').startswith('Waiting for'))
                if not resumed:
                    time.sleep(min(30, previous['next_run_at'] - time.time()))
                    continue
            try:
                if args.browser_only:
                    listing = reader.get(LIST_URL)
                    write_json(home / 'browser-check-list.json', listing)
                    validate_list(listing)
                    result = dict(status='complete', pending=0, items=len(listing['items']),
                                  source_generated_at=listing['generated_at'])
                else:
                    import_points(root, '--prune')
                    result = sync_once(root, reader, max_items=max(1, min(150, int(settings.get('max_items', 150)))))
                result['next_run_at'] = time.time() + (60 if result['pending'] else interval)
                result['last_success_at'] = time.time()
            except Exception as error:
                result = dict(status='needs_browser_verification' if isinstance(error, BrowserBlocked) else 'failed',
                              error_type=type(error).__name__, next_run_at=time.time() + interval)
                if isinstance(error, (BrowserBlocked, ValueError, RuntimeError)):
                    result['message'] = str(error)[:300]
            result['time'] = time.time()
            if previous.get('last_success_at') and 'last_success_at' not in result:
                result['last_success_at'] = previous['last_success_at']
            write_json(home / 'status.json', result)
            print(json.dumps(result, ensure_ascii=True), flush=True)
            if not args.loop:
                return 0 if result['status'] in ('complete', 'partial', 'unchanged') else 1


if __name__ == '__main__':
    raise SystemExit(main())
