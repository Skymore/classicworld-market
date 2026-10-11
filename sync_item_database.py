"""Cache the complete public Classic World catalog; never contacts game servers."""
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / 'item_database' / 'sources'
BASE = 'https://mxdgcw.dvg.cn'

def fetch(url, path):
    if path.exists():
        return json.loads(path.read_text(encoding='utf-8'))
    tmp = path.with_suffix('.download')
    subprocess.run(['curl.exe', '-sS', '-L', '--fail', '--max-time', '30',
                    '-o', str(tmp), url], check=True)
    data = json.loads(tmp.read_text(encoding='utf-8'))
    if data.get('ok') is False:
        raise ValueError(data)
    tmp.replace(path)
    time.sleep(0.25)
    return data

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    first = fetch(BASE + '/api/item_list.php?catalog=all&sort=itemid&dir=asc&page=1&page_size=100', CACHE/'catalog_001.json')
    rows = []
    for page in range(1, first['pages']+1):
        data = first if page == 1 else fetch(BASE + f'/api/item_list.php?catalog=all&sort=itemid&dir=asc&page={page}&page_size=100', CACHE/f'catalog_{page:03}.json')
        if data['total'] != first['total'] or data['page'] != page:
            raise ValueError('Catalog changed during pagination; refresh source cache.')
        rows.extend(data['rows'])
        print(f"Page {page}/{first['pages']}: {len(rows)}/{first['total']}", flush=True)
    assert len(rows) == first['total'] == len({r['itemid'] for r in rows})
    (CACHE/'dvg_catalog.json').write_text(json.dumps({'source': BASE+'/item_all_list.php', 'rows':rows}, ensure_ascii=False), encoding='utf-8')

if __name__ == '__main__':
    main()
