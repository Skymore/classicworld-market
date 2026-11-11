"""Prepare authorized RAW MesoWatch evidence for the Rust importer.

    python mesowatch_points.py data/reference/mesowatch-market/raw-points

Only per-item sales and listing arrays become points. Summary prices and daily
medians never become observations. Different item export times are retained in
the manifest; immutable sale IDs make repeated incremental imports idempotent.
"""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from mesowatch_convert import ROOT, HOW, mapping_status, numeric_id, timestamp


def location(raw):
    text = raw.get('location')
    match = re.fullmatch(r'Free Market <([0-9]+)>', text or '')
    room = int(match[1]) if match and 0 <= int(match[1]) <= 22 else None
    return dict(channel=raw.get('channel'), room=room,
                map_id=80002000+room if room is not None else None, text=text)


def sale_point(source_id, raw):
    kind = HOW.get(raw.get('how'))
    if kind is None:
        raise ValueError(f"Unknown sale evidence: {raw.get('how')}")
    return dict(source_key=f"{source_id}:{raw['id']}", source_item_id=source_id,
                time=timestamp(raw['time']), kind=kind, unit_price=raw['price'],
                seller=raw.get('seller'), location=location(raw), raw=raw)


def build(snapshot, catalog, source_ids=None):
    snapshot = Path(snapshot)
    listing = json.loads((snapshot/'list.json').read_text(encoding='utf-8'))
    if listing.get('market') != 'Classic World' or listing.get('preview') is not False:
        raise ValueError('Expected the published Classic World market')
    with closing(sqlite3.connect(Path(catalog).resolve().as_uri()+'?mode=ro', uri=True)) as db:
        local = {i: dict(name_en=en, name_zh=zh) for i,en,zh in db.execute('SELECT item_id,name_en,name_zh FROM items')}
    items, sales, quotes, files, rejected = [], [], [], [], []
    seen_sales = set()
    versions = []
    for item in listing['items']:
        source_id = item['id']
        if source_ids is not None and source_id not in source_ids:
            continue
        try:
            status = ('equipment_without_attributes' if numeric_id(source_id) // 1_000_000 == 1
                      else mapping_status(item, local))
        except ValueError:
            status = 'unsupported_id'
        if status != 'same_id_and_name':
            rejected.append(dict(source_item_id=source_id, reason=status))
            continue
        path = snapshot/'items'/(re.sub(r'[^A-Za-z0-9]+', '_', source_id)+'.json')
        if not path.exists():
            continue
        raw_file = path.read_bytes()
        doc = json.loads(raw_file)
        if doc.get('market') != 'Classic World' or doc.get('id') != source_id:
            raise ValueError(f'Wrong item export: {path}')
        if not isinstance(doc.get('sales'), list) or not isinstance(doc.get('listings'), list):
            raise ValueError(f'Incomplete item export: {path}')
        generated = timestamp(doc['generated_at'])
        versions.append(generated)
        files.append(dict(path=path.relative_to(snapshot).as_posix(), generated_at=doc['generated_at'],
                          sha256=hashlib.sha256(raw_file).hexdigest(), sales=len(doc['sales'])))
        items.append(dict(source_item_id=source_id, item_id=numeric_id(source_id),
                          name_en=item['name'], unit_basis=item['unitBasis'], listings_generated_at=generated))
        for row in doc['sales']:
            point = sale_point(source_id,row)
            # Preserve conflicting versions for the importer to quarantine;
            # only collapse exact repeats within the export.
            key = json.dumps(point, sort_keys=True, allow_nan=False)
            if key not in seen_sales:
                sales.append(point)
                seen_sales.add(key)
        for index, row in enumerate(doc.get('listings', [])):
            # The source exposes a bounded sample of shop rows, not shop inventory.
            # No stable row/slot is published. Identify this export's row rather
            # than collapsing different offers from the same seller/location.
            key = json.dumps([source_id,hashlib.sha256(raw_file).hexdigest(),index])
            quotes.append(dict(source_key=hashlib.sha256(key.encode()).hexdigest(), source_item_id=source_id,
                               time=timestamp(row['lastSeen']), generated_at=generated, unit_price=row['price'],
                               seller=row.get('seller'), location=location(row), up=bool(row.get('up')), raw=row))
    if not versions:
        raise ValueError('No raw item exports were found')
    return dict(version=1, source='mesowatch', world='ClassicWorld', generated_at=max(versions),
                manifest=dict(built_at=datetime.now(timezone.utc).isoformat(), files=files,
                              notice=listing.get('notice'), terms=listing.get('terms'),
                              rejected_items=rejected, raw_points_only=True),
                items=items, sales=sales, listings=quotes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot',type=Path)
    parser.add_argument('--catalog',type=Path,default=ROOT/'item_database/items.sqlite')
    parser.add_argument('--output',type=Path)
    args = parser.parse_args()
    points = build(args.snapshot,args.catalog)
    output = args.output or args.snapshot/'points-import.json'
    with output.open('w',encoding='utf-8') as stream:
        json.dump(points,stream,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    print(json.dumps(dict(items=len(points['items']), sales=len(points['sales']), listings=len(points['listings']),
                          rejected_items=len(points['manifest']['rejected_items']),
                          evidence=dict(Counter(s['kind'] for s in points['sales'])),output=str(output)),ensure_ascii=True))


if __name__ == '__main__':
    main()
