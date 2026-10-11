"""Build a version-labelled local SQLite/JSON catalog and enrich captured shops."""
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter
import json
import re
import sqlite3

ROOT = Path(__file__).resolve().parent
OUT = ROOT/'item_database'
BASE = 'https://mxdgcw.dvg.cn'

def has_chinese(s):
    return bool(re.search(r'[\u3400-\u9fff]', s or ''))

def build():
    catalog = json.loads((OUT/'sources/dvg_catalog.json').read_text(encoding='utf-8'))['rows']
    records, sources = {}, []
    for r in catalog:
        i = r['itemid']
        assert i not in records
        chinese = r['name'] if has_chinese(r['name']) else None
        records[i] = dict(item_id=i, name_zh=chinese, name_en=r.get('name_us'),
            name_status='database_chinese' if chinese else 'needs_translation',
            name_source=BASE+f'/item_info.php?id={i}',
            category=r.get('category_label'), category_code=r.get('type'),
            icon_url=BASE+r['icon'] if r.get('icon','').startswith('/') else r.get('icon'),
            source_version='DVG GCW snapshot 2026-10-10; upstream client version unspecified',
            level=r.get('level'), cash=r.get('cash'), tradeable=r.get('tradeable'),
            npc_price=r.get('price'), requirements=r.get('req'),
            base_stats=r.get('main_stats', []), description_zh=r.get('desc'),
            description_status='source_text_not_independently_validated',
            mapledex_reference=None)
        sources.append(('dvg',i,r))
    for category in ('equips','items'):
        path = ROOT/f'mapledex_{category}.json'
        for r in json.loads(path.read_text(encoding='utf-8'))['items']:
            i=r['id']; names=r.get('n',{})
            sources.append(('mapledex',i,r))
            if i not in records:
                records[i]=dict(item_id=i,name_zh=None,name_en=names.get('en'),
                    name_status='needs_translation',name_source=None,category=r.get('slot',r.get('type')),
                    category_code=r.get('slot',r.get('type')),icon_url=None,
                    source_version='Mapledex CW GMS_COT2_2026-08-11',level=r.get('reqLevel'),
                    cash=None,tradeable=None,npc_price=r.get('price'),requirements=None,
                    base_stats=[],description_zh=None)
            rec=records[i]
            rec['mapledex_reference']={'version':'CW GMS_COT2_2026-08-11', 'data':r,
                'url':f'https://kafuffu20.com/classic-world/data/{category}.json'}
            if not rec['name_zh'] and has_chinese(names.get('cw')):
                rec.update(name_zh=names['cw'],name_status='database_chinese',
                    name_source=f'https://kafuffu20.com/classic-world/zh-cn/{category}/{i}/')
            if not rec.get('name_en') or has_chinese(rec['name_en']):
                rec['name_en']=names.get('en') or rec.get('name_en')
    # Additional public search responses preserve exact ID matching.
    for path in ROOT.glob('dvg_*.json'):
        if not re.fullmatch(r'dvg_\d+\.json',path.name):
            continue
        i=int(path.stem.split('_')[1])
        matches=[r for r in json.loads(path.read_text(encoding='utf-8')).get('items',[]) if str(r.get('mid'))==str(i)]
        if len(matches)==1 and i in records:
            r=matches[0]; rec=records[i]
            sources.append(('dvg_search',i,r))
            if not rec['name_zh'] and has_chinese(r.get('name')):
                rec.update(name_zh=r['name'],name_status='database_chinese',name_source=BASE+r['url'])
            if not rec.get('name_en'):
                rec['name_en']=r.get('name_us')
    if 1077060 in records and not records[1077060]['name_zh']:
        records[1077060].update(name_zh='可可熊鞋',name_status='assistant_translation',
            translation_basis='Cacao Bear Shoes; unofficial translation')
    reference_names=json.loads((OUT/'untranslated_names.json').read_text(encoding='utf-8'))
    translations={}
    for line in (OUT/'reference_translations.txt').read_text(encoding='utf-8').splitlines():
        number,zh=line.split('\t',1)
        en=reference_names[int(number)]
        assert en not in translations and has_chinese(zh)
        translations[en]=zh
    assert len(translations)==len(reference_names)
    for rec in records.values():
        if not rec['name_zh'] and rec['name_en'] in translations:
            rec.update(name_zh=translations[rec['name_en']], name_status='assistant_translation',
                translation_basis=rec['name_en']+'; unofficial reference translation')
    items=sorted(records.values(),key=lambda r:r['item_id'])
    metadata=dict(game='MapleStory Classic World', snapshot_date='2026-10-10',
        generated_utc=datetime.now(timezone.utc).isoformat(),items=len(items),
        dvg_published_catalog_rows=len(catalog),mapledex_rows=sum(s=='mapledex' for s,_,_ in sources),
        name_coverage=dict(Counter(r['name_status'] for r in items)),
        scope='Complete downloaded public catalog, not a claim of all server-side items or release availability.',
        property_policy='DVG base_stats and Mapledex reference retained separately. Not individual rolled/scrolled equipment stats.',
        icons='Remote public icon URLs; images require internet, not cached locally.')
    (OUT/'items.json').write_text(json.dumps({'metadata':metadata,'items':items},ensure_ascii=False,indent=2),encoding='utf-8')
    (OUT/'coverage.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    slim=[{k:v for k,v in r.items() if k!='mapledex_reference'} for r in items]
    template=(ROOT/'item_catalog_template.html').read_text(encoding='utf-8')
    # Keep the HTML editor lightweight when Codex restores the open file tab.
    # A sibling script also works offline via file:// (unlike fetch of JSON).
    (OUT/'catalog-data.js').write_text('window.CATALOG_ITEMS = [\n'+',\n'.join(json.dumps(r,ensure_ascii=False).replace('<','\\u003c') for r in slim)+'\n];\n',encoding='utf-8')
    (OUT/'catalog.html').write_text(template,encoding='utf-8')
    conn=sqlite3.connect(OUT/'items.sqlite')
    with conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS items(item_id INTEGER PRIMARY KEY,name_zh TEXT,name_en TEXT,category TEXT,name_status TEXT,source_version TEXT,icon_url TEXT,record_json TEXT);
        CREATE TABLE IF NOT EXISTS source_records(source TEXT,item_id INTEGER,record_json TEXT,PRIMARY KEY(source,item_id));
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value_json TEXT);
        DELETE FROM items; DELETE FROM source_records; DELETE FROM metadata;
        CREATE INDEX IF NOT EXISTS items_name_zh ON items(name_zh);
        CREATE INDEX IF NOT EXISTS items_category ON items(category);
        ''')
        conn.executemany('INSERT INTO items VALUES(?,?,?,?,?,?,?,?)',[(r['item_id'],r['name_zh'],r['name_en'],r['category'],r['name_status'],r['source_version'],r['icon_url'],json.dumps(r,ensure_ascii=False)) for r in items])
        conn.executemany('INSERT OR REPLACE INTO source_records VALUES(?,?,?)',[(s,i,json.dumps(r,ensure_ascii=False)) for s,i,r in sources])
        conn.executemany('INSERT INTO metadata VALUES(?,?)',[(k,json.dumps(v,ensure_ascii=False)) for k,v in metadata.items()])
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    conn.close()
    enriched=0
    for path in (ROOT/'network_captures').glob('*/decoded_shops.json'):
        data=json.loads(path.read_text(encoding='utf-8'))
        missing=[]
        for shop in data['shops']:
            for row in shop['items']:
                rec=records.get(row['item_id'])
                if rec and rec['name_zh']:
                    row.update({k:rec.get(k) for k in ('name_zh','name_en','name_status','name_source','icon_url')})
                    enriched+=1
                else:
                    missing.append(row['item_id'])
        data['translation_summary']={'rows':sum(len(s['items']) for s in data['shops']), 'missing_ids':sorted(set(missing))}
        path.with_name('decoded_shops_zh.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'catalog':metadata,'enriched_market_rows':enriched},ensure_ascii=False,indent=2))

if __name__=='__main__':
    build()
