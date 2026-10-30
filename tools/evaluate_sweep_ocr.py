"""Offline, no-input OCR comparison on labelled local game crops.

python tools/evaluate_sweep_ocr.py manifest.json --output results.json [--rapid]
Manifest: {cases:[{image:absolute-path,kind:quantity|confirm|balance,
expected:int,box:[x0,y0,x1,y1],sizes:[[width,height],...]}]}.
Boxes use the 1366x768 reference canvas; images are never uploaded. RapidOCR
is an optional EVALUATION dependency and is not bundled into the collector.
"""
import argparse
import json
from pathlib import Path
import re
import sys
import time
import statistics

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import numpy as np
from PIL import Image
from sweep_screen import Canvas, Reader, money


def evaluate(manifest, rapid=False):
    reader = Reader()
    engine = None
    if rapid:
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import LangRec, ModelType, OCRVersion
        engine = RapidOCR(params={'Global.use_det':False,'Global.use_cls':False,
            'Rec.lang_type':LangRec.EN,'Rec.model_type':ModelType.MOBILE,'Rec.ocr_version':OCRVersion.PPOCRV4,
            'EngineConfig.onnxruntime.intra_op_num_threads':2,
            'EngineConfig.onnxruntime.inter_op_num_threads':1})
    rows = []
    for case in manifest['cases']:
        source = Image.open(case['image']).convert('RGB')
        for size in case.get('sizes',[source.size]):
            frame = Canvas(*size).frame(source.resize(size,Image.Resampling.BILINEAR))
            x0,y0,x1,y1 = case['box']
            # Recognition-only input, with a small neutral border.
            crop = np.asarray(frame[y0:y1,x0:x1]).copy()
            for method in (['glyph','ppocr-v4-en'] if engine else ['glyph']):
                values, elapsed = [], []
                for attempt in range(4):
                    start = time.perf_counter()
                    if method == 'glyph':
                        value = reader.balance(frame) if case['kind']=='balance' else reader.dialog(frame)[1]
                    else:
                        output = engine(crop[:,:,::-1].copy())
                        text = ''.join(output.txts or []).strip()
                        if case['kind']=='confirm':
                            match = re.fullmatch(r'The\s*total\s*price\s*is\s*([0-9,]+)\s*mesos\.?',text)
                            value = money(match[1]) if match else None
                        else:
                            value = money(text)
                    if attempt:
                        values.append(value)
                        elapsed.append((time.perf_counter()-start)*1000)
                rows.append(dict(case=Path(case['image']).name,kind=case['kind'],size=size,
                    method=method,expected=case['expected'],value=values[-1],
                    correct=all(v==case['expected'] for v in values),
                    false_accept=any(v is not None and v!=case['expected'] for v in values),
                    latency_ms=round(statistics.median(elapsed),3)))
    return dict(results=rows,summary={method:dict(samples=len(group),correct=sum(r['correct'] for r in group),
        false_accept=sum(r['false_accept'] for r in group),unknown=sum(r['value'] is None for r in group),
        median_ms=round(statistics.median(r['latency_ms'] for r in group),3))
        for method in sorted({r['method'] for r in rows})
        for group in [[r for r in rows if r['method']==method]]})


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('manifest',type=Path)
    p.add_argument('--output',required=True,type=Path);p.add_argument('--rapid',action='store_true')
    args=p.parse_args()
    result=evaluate(json.loads(args.manifest.read_text(encoding='utf-8')),args.rapid)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result['summary']))
