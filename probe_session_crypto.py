"""Offline legacy-Maple IV/header hypothesis test. Never sends traffic.

IV shuffle adapted from MapleLib, GPL-3.0-or-later,
Copyright (C) 2009, 2010, 2015 Snow and haha01haha01.
"""
from pathlib import Path
import json
import re
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from test_request_transforms import legacy_decode

source=Path(__file__).with_name('maple_crypto_constants.cs').read_text(encoding='utf-8-sig')
shuffle=bytes(int(v,16) for v in re.findall(r'0x([0-9A-Fa-f]{2})',source.split('bShuffle =')[1].split('};')[0]))
assert len(shuffle)==256
user=bytes(int(v,16) for v in re.findall(r'0x([0-9A-Fa-f]{2})',source.split('UserKey =')[1].split('};')[0]))
key=bytearray(32)
for i in range(0,128,16):key[i//4]=user[i]

def advance(iv):
    s=bytearray.fromhex('f25350c6')
    for b in iv:
        a=s[1]
        s[0]=(s[0]+shuffle[a]-b)&255
        s[1]=(a-(s[2]^shuffle[b]))&255
        a=(s[3]-s[0]+shuffle[b])&255
        s[2]=((shuffle[s[3]]+b)^s[2])&255
        s[3]=a
        n=int.from_bytes(s,'little');n=((n<<3)|(n>>29))&0xffffffff
        s[:]=n.to_bytes(4,'little')
    return bytes(s)

def crypt(body,iv):
    enc=Cipher(algorithms.AES(bytes(key)),modes.ECB()).encryptor()
    out=bytearray(body);offset=0;size=0x5b0
    while offset<len(out):
        block=iv*4
        count=min(size,len(out)-offset)
        for p in range(count):
            if p%16==0:block=enc.update(block)
            out[offset+p]^=block[p%16]
        offset+=count;size=0x5b4
    return bytes(out)

def probe(folder):
    streams=json.loads((folder/'session_streams.json').read_text())
    findings=[]
    for server in streams:
        if not server['greeting_hex']:continue
        greeting=bytes.fromhex(server['greeting_hex'])
        flow=server['flow'];reverse=[flow[2],flow[3],flow[0],flow[1]]
        for stream in [server]+[r for r in streams if r['flow']==reverse]:
            msgs=stream['messages']
            if not msgs:continue
            best=[]
            for offset in range(2,len(greeting)-3):
                initial=greeting[offset:offset+4]
                for presteps in range(3):
                    iv=initial
                    for _ in range(presteps):iv=advance(iv)
                    version=int.from_bytes(bytes.fromhex(msgs[0]['header'])[:2],'little')^int.from_bytes(iv[2:4],'little')
                    matches=0
                    for m in msgs:
                        h=bytes.fromhex(m['header'])
                        if (int.from_bytes(h[:2],'little')^int.from_bytes(iv[2:4],'little'))!=version:break
                        matches+=1;iv=advance(iv)
                    if matches>1:
                        best.append(dict(greeting_offset=offset,presteps=presteps,version_xor=version,consecutive_header_matches=matches,total_messages=len(msgs)))
            findings.append(dict(flow=stream['flow'],gap_bytes=stream['gap_bytes'],header_candidates=best))
    (folder/'crypto_hypotheses.json').write_text(json.dumps(findings,indent=2),encoding='utf-8')
    print(json.dumps(findings,indent=2))

if __name__=='__main__':
    import sys
    probe(Path(sys.argv[1]))
