"""Shared market with public viewing and automatically registered collectors."""
from market_views import view
import argparse
import json
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from flask import Flask, request, jsonify, make_response, send_file
from shared_store import SharedStore, Conflict

ROOT=Path(__file__).resolve().parent


def create_app(store, hostname='mxd.ruit.me', public_read=False):
    app=Flask(__name__,static_folder=None)
    app.config.update(MAX_CONTENT_LENGTH=256*1024,TRUSTED_HOSTS=[hostname,'127.0.0.1','localhost'])
    windows=defaultdict(deque);lock=threading.Lock();cache={'at':0,'data':None}

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
        with lock:cache['at']=0
        return jsonify(ok=True,duplicate=not created),201 if created else 200

    @app.get('/')
    def index():
        if not public_read and not member():return send_file(ROOT/'shared_login.html')
        return send_file(ROOT/'market_index.html')

    @app.get('/<asset>')
    def asset(asset):
        if asset not in ('market_ui.js','market_ui.css'):return jsonify(error='Not found'),404
        return send_file(ROOT/asset)

    @app.get('/api/v1/market')
    def market():
        who=member()
        if not public_read and not who:return jsonify(error='请登录'),401
        if not allowed('read:'+str(who or address()),60):return jsonify(error='Rate limited'),429
        with lock:
            if time.monotonic()-cache['at']>5:
                cache['data']=store.report();cache['at']=time.monotonic()
            result=cache['data']
        item=request.args.get('item_id','')
        return jsonify(dict(view(result,summary=request.args.get('summary')=='1',item_id=int(item) if item.isdigit() else None),public_read=public_read))

    @app.get('/api/v1/items/<int:item_id>')
    def item(item_id):
        if not public_read and not member():return jsonify(error='请登录'),401
        detail=store.repo.item_detail(item_id)
        return (jsonify(detail),200) if detail else (jsonify(error='Not found'),404)

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
