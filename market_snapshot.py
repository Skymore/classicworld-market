"""Export portable market/catalogue data without capture files or credentials."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import zipfile

from market_equipment import decode_equipment, FIELDS
from market_location import LocationTimeline

ROOT = Path(__file__).resolve().parent
FILES = ('market_data/market.sqlite', 'item_database/items.sqlite')
CATALOG_KEYS = {
    'item_id', 'name_zh', 'name_en', 'name_status', 'name_source', 'category',
    'category_code', 'icon_url', 'source_version', 'level', 'cash', 'tradeable',
    'npc_price', 'requirements', 'base_stats', 'description_zh',
    'description_status', 'mapledex_reference', 'translation_basis',
}


def fingerprint(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)


def equipment(record):
    if not record:
        return None
    result = {key: record[key] for key in
              ('status', 'parser', 'remaining_upgrades', 'enhancements', 'mask')
              if key in record}
    known = {key: label for key, label in FIELDS.values()}
    result['stats'] = [dict(key=s['key'], label=known[s['key']], value=s['value'])
                       for s in record.get('stats', []) if s.get('key') in known]
    result['unknown_fields'] = [dict(bit=s['bit'], value=s['value'])
                                for s in record.get('unknown_fields', [])]
    result['note'] = '公开市场快照；装备属性仍需核对'
    return result


def export_snapshot(market, catalog, output, locations=None):
    output = Path(output)
    if output.exists():
        raise FileExistsError(f'Refusing to overwrite {output}')
    timeline = LocationTimeline(Path(locations)) if locations else None
    counts = dict(visits=0, observations=0, excluded_experiments=0, catalog_items=0)
    observed_times = []
    with tempfile.TemporaryDirectory() as tmp:
        temp = Path(tmp)
        for name in FILES:
            (temp / name).parent.mkdir(parents=True, exist_ok=True)
        with closing(readonly(market)) as source, closing(sqlite3.connect(temp / FILES[0])) as target:
            source.execute('BEGIN')  # One consistent read of the live WAL database.
            target.executescript('''
                CREATE TABLE visits (id TEXT PRIMARY KEY, collector TEXT, world TEXT,
                    observed REAL, shop_key TEXT, source TEXT, payload TEXT);
                CREATE INDEX visits_time ON visits(observed);
            ''')
            for vid, world, observed, shop, blob in source.execute(
                    'SELECT id,world,observed,shop_key,payload FROM visits ORDER BY observed,id'):
                visit = json.loads(blob)
                if visit.get('triggered_by_python'):
                    counts['excluded_experiments'] += 1
                    continue
                location = visit.get('market_location')
                if timeline:
                    location = timeline.resolve(visit.get('session'), observed, location)
                if location:
                    location = {key: location[key] for key in ('channel', 'room', 'map_id') if key in location}
                clean = dict(session='snapshot', time=observed, shop_id=visit['shop_id'],
                             title=visit['title'], market_location=location,
                             prices_require_screen_validation=visit.get('prices_require_screen_validation', True),
                             items=[])
                for row in visit['items']:
                    iid = row['item_id']
                    raw = row.get('raw_record_hex', '')
                    variant = row.get('shared_variant') or (
                        hashlib.sha256(bytes.fromhex(raw)[20:]).hexdigest()[:16]
                        if iid // 1000000 == 1 and raw else
                        'unknown' if iid // 1000000 == 1 else 'standard')
                    clean['items'].append(dict(
                        item_id=iid, slot=row['slot'], category=row.get('category', iid // 1000000),
                        price_mesos_candidate=row['price_mesos_candidate'],
                        bundle_quantity_candidate=row['bundle_quantity_candidate'],
                        available_quantity_candidate=row['available_quantity_candidate'],
                        shared_variant=variant,
                        shared_equipment=equipment(row.get('shared_equipment') or decode_equipment(raw, iid))))
                target.execute('INSERT INTO visits VALUES (?,?,?,?,?,?,?)', (
                    fingerprint(vid), 'snapshot', world, observed, fingerprint(shop), 'snapshot',
                    json.dumps(clean, ensure_ascii=False, separators=(',', ':'))))
                counts['visits'] += 1
                counts['observations'] += len(clean['items'])
                observed_times.append(observed)
            target.commit()
        with closing(readonly(catalog)) as source, closing(sqlite3.connect(temp / FILES[1])) as target:
            source.execute('BEGIN')
            target.executescript('''
                CREATE TABLE items (item_id INTEGER PRIMARY KEY, name_zh TEXT, name_en TEXT,
                    category TEXT, name_status TEXT, source_version TEXT, icon_url TEXT, record_json TEXT);
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value_json TEXT);
                CREATE INDEX items_name_zh ON items(name_zh);
                CREATE INDEX items_category ON items(category);
            ''')
            for row in source.execute('SELECT item_id,name_zh,name_en,category,name_status,source_version,icon_url,record_json FROM items ORDER BY item_id'):
                record = {key: value for key, value in json.loads(row[-1]).items() if key in CATALOG_KEYS}
                target.execute('INSERT INTO items VALUES (?,?,?,?,?,?,?,?)',
                               (*row[:-1], json.dumps(record, ensure_ascii=False, separators=(',', ':'))))
                counts['catalog_items'] += 1
            target.execute('INSERT INTO metadata VALUES (?,?)', ('snapshot', json.dumps(counts)))
            target.commit()
        manifest = dict(schema_version=1, generated_utc=datetime.now(timezone.utc).isoformat(),
                        counts=counts, first_observed=min(observed_times, default=None),
                        last_observed=max(observed_times, default=None), files={},
                        scope='Historical observed shops; not the entire market or confirmed transactions.',
                        privacy='No members, tokens, sessions, local paths, network endpoints or raw packets.',
                        catalog_sources=['https://mxdgcw.dvg.cn', 'https://kafuffu20.com/classic-world/'])
        for name in FILES:
            with closing(readonly(temp / name)) as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError(f'Invalid SQLite snapshot: {name}')
            blob = (temp / name).read_bytes()
            manifest['files'][name] = dict(bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest())
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in FILES:
                archive.write(temp / name, name)
            archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


def restore_snapshot(archive_path, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive_path) as archive:
        if set(archive.namelist()) != {*FILES, 'manifest.json'}:
            raise ValueError('Unexpected snapshot contents')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('schema_version') != 1:
            raise ValueError('Unsupported snapshot schema')
        # Check both files before writing either. Existing data is never replaced.
        blobs = {}
        for name in FILES:
            if (destination / name).exists():
                raise FileExistsError(f'Refusing to overwrite {destination / name}')
            blob = archive.read(name)
            expected = manifest['files'][name]
            if len(blob) != expected['bytes'] or hashlib.sha256(blob).hexdigest() != expected['sha256']:
                raise ValueError(f'Snapshot checksum mismatch: {name}')
            blobs[name] = blob
        for name, blob in blobs.items():
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as handle:
                handle.write(blob)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export')
    export.add_argument('--market', type=Path, default=ROOT / FILES[0])
    export.add_argument('--catalog', type=Path, default=ROOT / FILES[1])
    export.add_argument('--locations', type=Path, default=ROOT / 'network_captures/market_live/map_observations.jsonl')
    export.add_argument('--output', type=Path, required=True)
    restore = commands.add_parser('restore')
    restore.add_argument('archive', type=Path)
    restore.add_argument('--destination', type=Path, default=ROOT)
    args = parser.parse_args()
    if args.command == 'export':
        result = export_snapshot(args.market, args.catalog, args.output, args.locations)
    else:
        result = restore_snapshot(args.archive, args.destination)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
