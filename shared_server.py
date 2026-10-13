"""Shared market with public viewing and automatically registered collectors."""
from market_views import view
import argparse
import json
import threading
import time
import sys
from collections import defaultdict, deque
from pathlib import Path

ROOT=Path(__file__).resolve().parent
# Keep the deployed web dependencies available across bundled-runtime updates.
WEB_VENDOR=ROOT/'tools/web_vendor'
if WEB_VENDOR.is_dir():sys.path.insert(0,str(WEB_VENDOR))
from flask import Flask, request, jsonify, make_response, send_file
from shared_store import SharedStore, Conflict
from market_watchlist import search_catalog,report_listings,parse_item_ids


def create_app(store, hostname='mxd.ruit.me', public_read=False):
    app=Flask(__name__,static_folder=None)
    app.config.update(MAX_CONTENT_LENGTH=256*1024,TRUSTED_HOSTS=[hostname,'127.0.0.1','localhost'])
    windows=defaultdict(deque);lock=threading.Lock();cache={}

    def allowed(key,limit):
        with lock:
            now=time.monotonic()
            # Bound unauthenticated-address bookkeeping.
            if len(windows)>2000:windows.clear()
            q=windows[key]
            while q and q[0]<now-60:q.popleft()
            if len(q)>=limit:return False
            q.append(now);return True

    def bearer():
        value=request.headers.get('Authorization','')
        return value[7:] if value.startswith('Bearer ') else None

    def member():return store.authenticate(bearer() or request.cookies.get('fm_session'))

    def address():return request.headers.get('CF-Connecting-IP',request.remote_addr)

    @app.post('/api/v1/register')
    def register():
        if not public_read:return jsonify(error='Registration disabled'),403
        if not allowed('register:'+str(address()),5) or not allowed('register:global',60):
            return jsonify(error='稍后再试'),429
        identity,token=store.invite('anonymous')
        return jsonify(endpoint=f'https://{hostname}',member_id=identity,token=token),201

    @app.after_request
    def headers(response):
        response.headers.update({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
            'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
            'Content-Security-Policy':"default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
        return response

    @app.route('/healthz')
    def health():return jsonify(ok=True)

    @app.post('/api/v1/login')
    def login():
        origin=request.headers.get('Origin')
        if origin and origin not in (f'https://{hostname}',f'http://127.0.0.1:8766'):
            return jsonify(error='Invalid origin'),403
        # Only trust Cloudflare address behind this loopback-only origin.
        address=request.headers.get('CF-Connecting-IP',request.remote_addr)
        if not allowed('login:'+address,10):return jsonify(error='稍后再试'),429
        data=request.get_json(silent=True) or {};token=data.get('token','')
        if not store.authenticate(token):return jsonify(error='访问码无效或已撤销'),401
        response=jsonify(ok=True)
        response.set_cookie('fm_session',token,secure=True,httponly=True,samesite='Strict',max_age=30*86400)
        return response

    @app.post('/api/v1/logout')
    def logout():
        response=jsonify(ok=True);response.delete_cookie('fm_session',secure=True,httponly=True,samesite='Strict');return response

    @app.post('/api/v1/observations')
    def upload():
        if not allowed('upload-ip:'+str(address()),240):return jsonify(error='Rate limited'),429
        who=store.authenticate(bearer())
        if not who:return jsonify(error='Collector token required'),401
        if not allowed('upload:'+who,120):return jsonify(error='Rate limited'),429
        try:created=store.upload(who,request.get_json())
        except Conflict:return jsonify(error='Observation ID content conflict'),409
        except (ValueError,KeyError,TypeError,OverflowError):return jsonify(error='Invalid observation schema'),400
        with lock:cache.clear()
        return jsonify(ok=True,duplicate=not created),201 if created else 200

    @app.get('/')
    @app.get('/alerts')
    def index():
        if not public_read and not member():return send_file(ROOT/'shared_login.html')
        page=(ROOT/'market_index.html').read_text(encoding='utf-8')
        return page.replace('<body>', '<body class="alerts-page">' if request.path=='/alerts' else '<body class="market-page">')

    @app.get('/<asset>')
    def asset(asset):
        if asset not in ('market_ui.js','market_ui.css','market_i18n.js','market_watchlist.js'):return jsonify(error='Not found'),404
        return send_file(ROOT/asset)

    @app.get('/api/v1/market')
    def market():
        who=member()
        if not public_read and not who:return jsonify(error='请登录'),401
        if not allowed('read:'+str(who or address()),60):return jsonify(error='Rate limited'),429
        window=request.args.get('hours','72')
        if window not in ('72','all'):return jsonify(error='hours must be 72 or all'),400
        with lock:
            entry=cache.get(window)
            if entry is None or time.monotonic()-entry['at']>5:
                entry=dict(data=store.report(None if window=='all' else 72),at=time.monotonic());cache[window]=entry
            result=entry['data']
        item=request.args.get('item_id','')
        return jsonify(dict(view(result,summary=request.args.get('summary')=='1',item_id=int(item) if item.isdigit() else None),public_read=public_read))

    @app.get('/api/v1/items/<int:item_id>')
    def item(item_id):
        if not public_read and not member():return jsonify(error='请登录'),401
        detail=store.repo.item_detail(item_id)
        return (jsonify(detail),200) if detail else (jsonify(error='Not found'),404)

    @app.get('/api/v1/watchlist/catalog')
    def watch_catalog():
        if not public_read and not member():return jsonify(error='Please sign in'),401
        if not allowed('watch-catalog:'+str(address()),60):return jsonify(error='Rate limited'),429
        return jsonify(search_catalog(store.repo.catalog,request.args.get('q','')))

    @app.get('/api/v1/watchlist/listings')
    def watch_listings():
        if not public_read and not member():return jsonify(error='Please sign in'),401
        if not allowed('watch-listings:'+str(address()),60):return jsonify(error='Rate limited'),429
        try:ids=parse_item_ids(request.args.get('ids',''))
        except ValueError:return jsonify(error='Invalid item IDs'),400
        with lock:
            entry=cache.get('72')
            if entry is None or time.monotonic()-entry['at']>5:
                entry=dict(data=store.report(72),at=time.monotonic());cache['72']=entry
            result=entry['data']
        return jsonify(report_listings(result,ids))

    return app


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--folder',type=Path,default=ROOT/'shared_data')
    parser.add_argument('--hostname',default='mxd.ruit.me')
    parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--public-read',action='store_true')
    parser.add_argument('--private',action='store_true',help='Require invitations and disable automatic registration')
    parser.add_argument('--invite',metavar='NAME')
    parser.add_argument('--token-out',type=Path)
    parser.add_argument('--revoke',metavar='MEMBER_ID')
    parser.add_argument('--backup',type=Path)
    args=parser.parse_args();store=SharedStore(args.folder)
    if args.invite:
        if not args.token_out:parser.error('--token-out is required; credentials are never printed')
        member,token=store.invite(args.invite)
        args.token_out.parent.mkdir(parents=True,exist_ok=True)
        with args.token_out.open('x',encoding='utf-8') as f:
            json.dump(dict(endpoint=f'https://{args.hostname}',member_id=member,token=token),f)
        print('Member created; credential saved to requested local file.');return
    if args.revoke:store.revoke(args.revoke);print('Member revoked');return
    if args.backup:
        import sqlite3
        args.backup.parent.mkdir(parents=True,exist_ok=True)
        with store.repo.connect() as source,sqlite3.connect(args.backup) as destination:source.backup(destination)
        print('Backup complete');return
    from waitress import serve
    print(f'Shared market listening on 127.0.0.1:{args.port}',flush=True)
    serve(create_app(store,args.hostname,not args.private),host='127.0.0.1',port=args.port,threads=6,
          max_request_body_size=256*1024,channel_timeout=30,connection_limit=80)


if __name__=='__main__':main()
