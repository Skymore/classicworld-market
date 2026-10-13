"""Correlate one foreground shop visit with a newly completed local capture.

This is temporal correlation, not proof that a screen sign matches a shop ID.
Never treats stale, experimental, malformed, or ambiguous results as success.
"""
import json
import math
from pathlib import Path
import time


class CaptureReceipt:
    def __init__(self, folder, now=None):
        self.folder = Path(folder)
        if not self.folder.is_dir():
            raise ValueError('Capture folder does not exist')
        self.started = time.time() if now is None else now
        self.existing = {p.name for p in self.folder.glob('shop_*.json')}

    def poll(self, now=None):
        now = time.time() if now is None else now
        candidates = {}
        for path in self.folder.glob('shop_*.json'):
            if path.name in self.existing:
                continue
            try:
                row = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                continue  # A writer may still be completing this file.
            if not isinstance(row, dict):
                continue
            observed = row.get('time')
            if (isinstance(observed, bool) or not isinstance(observed, (int, float))
                    or not math.isfinite(observed) or not self.started <= observed <= now
                    or row.get('triggered_by_python') is not False
                    or not isinstance(row.get('items'), list)
                    or not isinstance(row.get('shop_id'), int)
                    or isinstance(row['shop_id'], bool)
                    or not isinstance(row.get('session'), (str, int))
                    or not row.get('session')):
                continue
            key = (row['session'], observed, row['shop_id'])
            candidates[key] = dict(file=str(path.resolve()), time=observed,
                                   session=row['session'], shop_id=row['shop_id'],
                                   item_count=len(row['items']),
                                   market_location=row.get('market_location'),
                                   correlation='one_new_capture_during_foreground_visit')
        if len(candidates) > 1:
            raise RuntimeError('Multiple shop captures during one visit; cannot attribute prices')
        return next(iter(candidates.values()), None)
