"""Inspect the local proxy or queue one explicit open/close command."""
import argparse
import json
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['status', 'open', 'close'])
parser.add_argument('--session')
parser.add_argument('--shop-id', type=int)
parser.add_argument('--folder', type=Path, default=Path(__file__).parent/'network_captures/proxy_live')
args = parser.parse_args()
status = json.loads((args.folder/'status.json').read_text(encoding='utf-8'))
if args.action == 'status':
    print(json.dumps(status, ensure_ascii=False, indent=2))
else:
    sessions = [s for s in status['sessions'] if not s['closed'] and s['map_ready']]
    if args.session:
        sessions = [s for s in sessions if s['id'] == args.session]
    if len(sessions) != 1:
        parser.error('Select exactly one ready session with --session')
    if args.action == 'open' and args.shop_id is None:
        parser.error('--shop-id is required')
    command = dict(request_id=uuid.uuid4().hex, session=sessions[0]['id'], action=args.action)
    if args.action == 'open':
        command['shop_id'] = args.shop_id
    target = args.folder/'command.json'
    # Atomic publication prevents the running proxy from reading partial JSON.
    temporary = args.folder / (command['request_id'] + '.tmp')
    with temporary.open('x', encoding='utf-8') as out:
        out.write(json.dumps(command))
    if target.exists():
        temporary.unlink()
        parser.error('A command is already queued')
    temporary.rename(target)
    print(json.dumps(command))
