"""Real HTTP/SSE regression against an isolated database. Never writes market fixtures to production."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit, urlunsplit, urlencode
import urllib.request
import urllib.error

import psycopg
from psycopg import sql

database = 'presence_test_' + uuid.uuid4().hex[:12]
origin = 'http://127.0.0.1:19769'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with opener.open(req, timeout=10) as response:
        return json.load(response)


with psycopg.connect(os.environ['DATABASE_URL'], autocommit=True) as admin, tempfile.TemporaryDirectory() as scratch:
    admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
    process = None
    try:
        env = dict(os.environ, DATABASE_URL=urlunsplit(urlsplit(os.environ['DATABASE_URL'])._replace(path='/' + database)),
                   BIND='127.0.0.1:19769', PUBLIC_READ='true', RUST_LOG='warn')
        with (Path(scratch)/'server.log').open('wb') as log:
            process = subprocess.Popen([os.environ['PRESENCE_TEST_BINARY']], env=env, stdout=log, stderr=log,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('Isolated test server exited')
                try:
                    identity = request('/api/v1/register', {})
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(.1)
            else:
                raise RuntimeError('Isolated test server not ready')
            now = time.time()
            visit = dict(version=1, world='ClassicWorld', complete=True, observation_id='original',
                         observed_at=now-30, shop_id=300, title='Fixture shop', location=dict(channel=26, room=1),
                         owner=dict(character_id=123, name='ExampleHost', parser='cw_shop_owner_v1'),
                         items=[dict(item_id=4010001, slot=1, price=500, bundle=1, stock=8)])
            request('/api/v1/observations', visit, identity['token'])
            event = dict(version=1, world='ClassicWorld', parser='cw_player_departure_v1', event_id='a'*32,
                         character_id=123, name='ExampleHost', seen_at=now-60, observed_at=now,
                         location=dict(channel=26, room=1))
            try:
                request('/api/v1/collector/player-departure', event)
                raise AssertionError('Anonymous expiration accepted')
            except urllib.error.HTTPError as error:
                assert error.code == 401
            received = threading.Event()
            stream = opener.open(origin+'/api/v1/events', timeout=10)
            def listen():
                try:
                    while True:
                        line = stream.readline()
                        if not line:
                            break
                        if line.strip() == b'event: market':
                            received.set()
                            break
                finally:
                    stream.close()
            listener = threading.Thread(target=listen, daemon=True)
            listener.start()
            assert request('/api/v1/collector/player-departure', event, identity['token'])['ok']
            assert received.wait(10), 'Expiration did not emit market SSE'
            page = request('/api/v1/catalog/page?'+urlencode(dict(url='/item/4010001?hours=all')))['page']
            assert not page['market']['listings']
            expired = page['market']['expired_listings']
            assert len(expired) == 1 and expired[0]['owner_name'] == 'ExampleHost' and expired[0]['unit_price'] == 500
            assert page['stats']['lowest_ask'] is None and page['stats']['listings_count'] == 0
            visit.update(observation_id='newer', observed_at=now+1)
            request('/api/v1/observations', visit, identity['token'])
            page = request('/api/v1/catalog/page?'+urlencode(dict(url='/item/4010001?hours=all')))['page']
            assert len(page['market']['listings']) == 1 and len(page['market']['expired_listings']) == 1
            print('PASS isolated HTTP: authenticated departure, expired API history, active minima, new quote recovery, market SSE')
            roster = dict(version=1,world='ClassicWorld',parser='cw_room_roster_v1',complete=True,
                          event_id='b'*32,location=dict(channel=26,room=1),
                          started_at=now+2,observed_at=now+2.1,character_ids=[999])
            for token, payload, code in [(None,roster,401),(identity['token'],dict(roster,complete=False),400)]:
                try:
                    request('/api/v1/collector/room-roster',payload,token)
                    raise AssertionError('Unproven roster accepted')
                except urllib.error.HTTPError as error:
                    assert error.code==code
            listener.join(timeout=2)
            received.clear();stream=opener.open(origin+'/api/v1/events',timeout=10)
            listener=threading.Thread(target=listen,daemon=True);listener.start()
            result=request('/api/v1/collector/room-roster',roster,identity['token'])
            assert result['ok'] and result['created']
            assert received.wait(10),'Roster expiration did not emit market SSE'
            assert not request('/api/v1/collector/room-roster',roster,identity['token'])['created']
            page=request('/api/v1/catalog/page?'+urlencode(dict(url='/item/4010001?hours=all')))['page']
            assert not page['market']['listings'] and len(page['market']['expired_listings'])==2
            assert page['stats']['lowest_ask'] is None
            print('PASS isolated HTTP: roster auth/validation/idempotency, expired history, minima and live SSE')
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(database)))
