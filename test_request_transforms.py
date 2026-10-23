"""Bounded offline hypotheses, not a verified Classic World decryptor.

Legacy byte transform adapted from MapleLib MapleCustomEncryption.cs.
Copyright 2009, 2010, 2015 Snow and haha01haha01; GPL-3.0-or-later.
https://github.com/hadeutscher/MapleLib/blob/master/MapleCryptoLib/MapleCustomEncryption.cs
"""
from collections import Counter
from pathlib import Path
import json

def rol(x,n):
    n%=8
    return ((x<<n)|(x>>(8-n)))&255

def legacy_decode(body):
    data=bytearray(body)
    for _ in range(3):
        previous=0
        for j in range(len(data),0,-1):
            value=rol(data[j-1],3)^0x13
            data[j-1]=rol(((value^previous)-j)&255,4)
            previous=value
        previous=0
        for j in range(len(data),0,-1):
            index=len(data)-j
            value=rol(((data[index]-0x48)&255)^255,j)
            data[index]=rol(((value^previous)-j)&255,5)
            previous=value
    return bytes(data)

def audit(folder):
    data=json.loads((folder/'shop_request_candidates.json').read_text())
    selected=[s['preceding'][-1] for s in data['shops'] if s['preceding']]
    samples=[bytes.fromhex(s['wire']) for s in selected]
    reports={}
    modes={
        'identity':lambda b,k:b,
        'subtract':lambda b,k:bytes((x-k)&255 for x in b),
        'xor':lambda b,k:bytes(x^k for x in b),
        'legacy_only':lambda b,k:legacy_decode(b),
        'subtract_then_legacy':lambda b,k:legacy_decode(bytes((x-k)&255 for x in b)),
        'xor_then_legacy':lambda b,k:legacy_decode(bytes(x^k for x in b)),
        'legacy_then_subtract':lambda b,k:bytes((x-k)&255 for x in legacy_decode(b)),
    }
    for name,transform in modes.items():
        counts=Counter()
        for body in samples:
            counts.update({transform(body,k)[:2].hex() for k in (range(1) if name in ('identity','legacy_only') else range(256))})
        prefix,support=counts.most_common(1)[0]
        reports[name]={'max_samples_sharing_any_two_byte_prefix':support,'sample_count':len(samples),
                      'all_samples_share_prefix':support==len(samples)}
    out={'selected_requests':len(samples),'all_length_10':all(len(s)==10 for s in samples),
         'response_delay_ms_min':min(s['delta_ms'] for s in selected),
         'response_delay_ms_max':max(s['delta_ms'] for s in selected),
         'hypothesis_tests':reports,
         'interpretation':'No matched prefix rejects only these bounded transforms under a common opcode hypothesis; it does not identify the actual cipher.'}
    (folder/'request_transform_audit.json').write_text(json.dumps(out,indent=2),encoding='utf-8')
    print(json.dumps(out,indent=2))

if __name__=='__main__':
    import sys
    audit(Path(sys.argv[1]))
