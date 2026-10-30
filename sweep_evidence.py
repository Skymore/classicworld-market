"""Packet evidence and bounded local replay traces; neither dispatches game input."""
from collections import deque
from pathlib import Path
import json
import time


def packet_balance(state):
    if (isinstance(state, dict) and isinstance(state.get('session'), str) and state['session']
            and type(state.get('revision')) is int and state['revision'] > 0
            and isinstance(state.get('categories'), list) and set(state['categories']) >= {2, 3, 4}
            and type(state.get('mesos')) is int and state['mesos'] >= 0):
        return state['mesos']
    return None


class PurchaseTrace:
    """Keep only recent shop/popup crops, locally, on failure. Never upload images.

    Sixteen fixed slots bound disk use. A manifest names only frames from its
    current attempt. Diagnostic I/O must never change settlement or retry input.
    """
    def __init__(self, order, window):
        self.order = order
        self.folder = Path(window.capture_file).parent/'sweep'/'replays'
        self.frames = deque(maxlen=8)
        self.started = time.monotonic()
        self.actions = []
        self.checks = deque(maxlen=8)

    def check(self, **fields):
        self.checks.append(fields)

    def frame(self, image, phase, kind):
        if self.order.diagnostic:
            self.frames.append((image[150:610,420:940,:3].copy(), phase, kind))

    def action(self, kind):
        self.actions.append(kind)

    def finish(self, result):
        data = dict(reservation=self.order.reservation, item_id=self.order.item_id,
                    quantity=self.order.quantity, price=self.order.price,
                    status=result.status, reason=result.reason, actions=self.actions,
                    elapsed_ms=round((time.monotonic()-self.started)*1000, 1), checks=list(self.checks))
        try:
            if result.status != 'bought' and self.frames:
                from PIL import Image
                # Fixed names overwrite only this component's private ring slot.
                slot = self.folder/str(int(time.time()*1000) % 16)
                slot.mkdir(parents=True, exist_ok=True)
                frames = []
                for i,(pixels,phase,kind) in enumerate(self.frames):
                    name = f'{i}.png'
                    Image.fromarray(pixels).save(slot/name)
                    frames.append(dict(file=name,phase=phase,kind=kind,origin=[420,150]))
                manifest = dict(data,frames=frames)
                pending = slot/'manifest.tmp'
                pending.write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8')
                pending.replace(slot/'manifest.json')
                data['replay'] = str(slot/'manifest.json')
            if self.order.diagnostic:
                self.order.diagnostic(data)
        except Exception:
            pass
