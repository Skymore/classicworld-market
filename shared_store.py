"""SQLite WAL shared MVP: immutable uploads and conservative quote projections."""
import hashlib
import json
import secrets
import time
from pathlib import Path
from shared_protocol import validate, digest
from market_dashboard import Repository


class Conflict(ValueError):pass


class SharedStore:
    def __init__(self, folder, catalog=None):
        self.repo=Repository(Path(folder),**({'catalog':Path(catalog)} if catalog else {}))
        with self.repo.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT, hash TEXT UNIQUE, active INTEGER, created REAL)')
            db.execute('CREATE TABLE IF NOT EXISTS uploads (member TEXT, oid TEXT, hash TEXT, received REAL, payload TEXT, PRIMARY KEY(member,oid))')

    def invite(self,name):
        token=secrets.token_urlsafe(32);member=secrets.token_hex(12)
        with self.repo.connect() as db:
            db.execute('INSERT INTO members VALUES (?,?,?,?,?)',(member,name,hashlib.sha256(token.encode()).hexdigest(),1,time.time()))
        return member,token

    def authenticate(self,token):
        if not isinstance(token,str) or not 30<=len(token)<=128:return None
        with self.repo.connect() as db:
            row=db.execute('SELECT id FROM members WHERE hash=? AND active=1',(hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        return row[0] if row else None

    def revoke(self,member):
        with self.repo.connect() as db:db.execute('UPDATE members SET active=0 WHERE id=?',(member,))

    def upload(self,member,data):
        clean=validate(data);encoded=json.dumps(clean,ensure_ascii=False,sort_keys=True);fingerprint=digest(clean)
        with self.repo.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT hash,payload FROM uploads WHERE member=? AND oid=?',(member,clean['observation_id'])).fetchone()
            if old:
                if old[0]!=fingerprint and digest(validate(json.loads(old[1])))!=fingerprint:
                    raise Conflict('Observation ID reused with different content')
                return False
            db.execute('INSERT INTO uploads VALUES (?,?,?,?,?)',(member,clean['observation_id'],fingerprint,time.time(),encoded))
            # Immutable per-observer evidence. Derived quote identity deliberately
            # expires at UTC day boundaries to limit shop-ID reuse ambiguity.
            location=clean['location'];epoch=int(clean['observed_at']//86400)
            shop=digest(['shared-v1',clean['world'],location,clean['shop_id'],clean['title'],epoch,
                         None if location else member])
            items=[];occurrences={}
            for row in clean['items']:
                eq=row.get('equipment')
                variant=digest(eq)[:16] if eq and eq['status']=='candidate' else ('unknown' if eq else 'standard')
                base_slot=row['category']*1000+row['slot']
                occurrence=occurrences.get(base_slot,0);occurrences[base_slot]=occurrence+1
                items.append(dict(item_id=row['item_id'],slot=base_slot+occurrence*1000000,
                    price_mesos_candidate=row['price'],bundle_quantity_candidate=row['bundle'],
                    available_quantity_candidate=row['stock'],shared_equipment=eq,shared_variant=variant))
            payload=dict(session=member,time=clean['observed_at'],title=clean['title'],shop_id=clean['shop_id'],
                         market_location=location,items=items,prices_require_screen_validation=True)
            vid=digest([member,clean['observation_id']])
            db.execute('INSERT INTO visits VALUES (?,?,?,?,?,?,?)',(vid,member,'ClassicWorld',clean['observed_at'],shop,'shared',json.dumps(payload,ensure_ascii=False)))
        return True

    def report(self):
        data=self.repo.report()
        # Report includes provenance fields useful locally, never serve those paths.
        def scrub(value):
            if isinstance(value,dict):return {k:scrub(v) for k,v in value.items() if k not in ('source','raw_source','server_endpoint','collector','session')}
            if isinstance(value,list):return [scrub(v) for v in value]
            return value
        data=scrub(data)
        data.update(health=dict(errors=[]),capture=None,connection_health=dict(state='ready',message='共享市场 · 成员观察数据'),
                    shared=True,dedup_note='同位置/摊位ID/名称/UTC日期的最新快照合并；缺少摊主稳定ID，跨日不合并。')
        return data
