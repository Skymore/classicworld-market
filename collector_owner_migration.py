"""Idempotent, authenticated historical host enrichment from local shop evidence."""
import json
import sqlite3
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from contextlib import closing
from pathlib import Path
from market_shop_owner import owner_from_snapshot
from shared_protocol import from_snapshot


def migrate_owners(folder, config, ledger, opener, endpoint=None, stop=None, limit=10):
    destination=(endpoint or config['endpoint']).rstrip('/')
    url=urlsplit(destination)
    local=(url.scheme=='http' and url.hostname=='127.0.0.1' and url.port is not None
           and not url.username and not url.password and not url.path and not url.query and not url.fragment)
    if destination!='https://mxd.ruit.me' and not local:
        raise ValueError('Unsupported owner migration endpoint')
    folder,ledger=Path(folder),Path(ledger)
    if not ledger.exists(): return 0
    repaired=0
    with closing(sqlite3.connect(ledger)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS owner_repairs (path TEXT PRIMARY KEY,status TEXT,updated REAL)')
        db.execute('CREATE TABLE IF NOT EXISTS owner_repair_state (key TEXT PRIMARY KEY,value REAL)')
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sent'").fetchone(): return 0
        db.commit()
        next_run=db.execute("SELECT value FROM owner_repair_state WHERE key='next_run'").fetchone()
        if next_run and next_run[0]>time.time(): return 0
        # Bound work and network use per pass. No repeated whole-directory scans.
        paths=db.execute("SELECT s.path FROM sent s LEFT JOIN owner_repairs r ON r.path=s.path WHERE s.status IN ('sent','rejected_409') AND r.path IS NULL ORDER BY s.updated DESC LIMIT ?",(limit,)).fetchall()
        for (filename,) in paths:
            if stop is not None and stop.is_set(): break
            if Path(filename).name!=filename: continue
            try:
                snapshot=json.loads((folder/filename).read_text(encoding='utf-8'))
                owner=owner_from_snapshot(snapshot,folder)
                if owner is None:
                    db.execute('INSERT OR IGNORE INTO owner_repairs VALUES (?,?,?)',(filename,'no_local_evidence',time.time()))
                    db.commit()
                    continue
                payload=from_snapshot(snapshot,now=snapshot['time'])
                payload['owner']=owner
            except (OSError,ValueError,KeyError,TypeError):
                db.execute('INSERT OR IGNORE INTO owner_repairs VALUES (?,?,?)',(filename,'invalid_local_evidence',time.time()))
                db.commit()
                continue
            request=urllib.request.Request(destination+'/api/v1/collector/repair-owner',
                data=json.dumps(payload,ensure_ascii=False).encode(),method='POST',
                headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
            try:
                with opener.open(request,timeout=15) as response: result=json.load(response)
                if not result.get('ok'): break
                repaired+=int(bool(result.get('repaired')))
                status='repaired'
            except urllib.error.HTTPError as error:
                if error.code in (400,409): status='conflict_'+str(error.code)
                elif error.code in (404,405,429):
                    delay=3600 if error.code in (404,405) else 60
                    db.execute("INSERT OR REPLACE INTO owner_repair_state VALUES ('next_run',?)",(time.time()+delay,))
                    break
                else: break
            except (OSError,ValueError): break
            db.execute('INSERT OR IGNORE INTO owner_repairs VALUES (?,?,?)',(filename,status,time.time()))
            db.commit()
        db.execute("INSERT INTO owner_repair_state VALUES ('next_run',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)",(time.time()+10,))
    return repaired
