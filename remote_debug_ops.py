"""Server-local remote debug operator. Never opens or extends player consent."""
import argparse
import json
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['list','show','exec','stop'])
    parser.add_argument('--session')
    parser.add_argument('--script-file',type=Path)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent)
    args=parser.parse_args()
    if args.action!='list' and not args.session:parser.error('--session is required')
    body={'action':args.action,'session':args.session}
    if args.action=='exec':
        if not args.script_file:parser.error('--script-file is required')
        body['script']=args.script_file.read_text(encoding='utf-8-sig')
    key=(args.root/'shared_data/remote-debug-operator.key').read_text(encoding='utf-8').strip()
    req=Request('http://127.0.0.1:8766/api/v1/remote-debug/operator',data=json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    with build_opener(ProxyHandler({})).open(req,timeout=10) as response:answer=json.load(response)
    print(json.dumps(answer,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
