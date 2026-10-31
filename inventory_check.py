"""Visible inventory checks on the scanner input thread, backed by receive-only data."""
import json
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from market_inventory import read_inventory
from sweep_screen import ASSETS, money, runs, bitmap


class InventoryCheckError(Exception):
    """No further scanner input is safe until the inventory check is resolved."""


def inventory_check_failed(error):
    seen = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, InventoryCheckError):
            return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


class InventoryScreen:
    def __init__(self):
        glyphs = json.loads((ASSETS/'inventory-font.json').read_text())['glyphs']
        self.glyphs = {tuple(rows): ch for ch, rows in glyphs}
        self.title = np.asarray(Image.open(ASSETS/'inventory-title.png').convert('RGB'))[:, :85]
        self.mesos = np.asarray(Image.open(ASSETS/'inventory-mesos.png').convert('RGB'))

    def locate(self, image):
        image = np.asarray(image.convert('RGB') if hasattr(image, 'convert') else image)
        # Full-screen clients stretch the same 1366x768 game canvas. Normalize
        # only the verified aspect ratio; arbitrary window sizes stay unsupported.
        height, width = image.shape[:2]
        scales = [1.0]
        if abs(width/height - 1366/768) < .02:
            scales.append(height/768)
        found = []
        for scale in set(scales):
            normalized = cv2.resize(image, (round(width/scale), round(height/scale))) if scale != 1 else image
            scores = cv2.matchTemplate(normalized, self.title, cv2.TM_CCOEFF_NORMED)
            _, score, _, point = cv2.minMaxLoc(scores)
            if score < .90:
                continue
            x, y = point[0]-5, point[1]-4
            if x < 0 or y < 0 or x+209 > normalized.shape[1] or y+289 > normalized.shape[0]:
                continue
            bottom = normalized[y+267:y+285, x+168:x+208]
            if cv2.minMaxLoc(cv2.matchTemplate(bottom, self.mesos, cv2.TM_CCOEFF_NORMED))[1] < .90:
                continue
            values = set()
            band = normalized[y+268:y+283, x+26:x+167, :3]
            for threshold in (110, 120, 130, 140, 150, 160):
                chars = []
                for _, _, pixels in runs(band.max(axis=2) < threshold):
                    rows = np.flatnonzero(pixels.any(axis=1))
                    ch = self.glyphs.get(bitmap(pixels[rows[0]:rows[-1]+1]))
                    if ch is None:
                        chars = []
                        break
                    chars.append(ch)
                value = money(''.join(chars))
                if value is not None:
                    values.add(value)
            found.append((x, y, values.pop() if len(values) == 1 else None))
        return found[0] if len(found) == 1 else None


class InventoryChecker:
    def __init__(self, folder, screen=None, clock=time.monotonic):
        self.folder = Path(folder)
        self.screen = screen or InventoryScreen()
        self.clock = clock

    def run(self, window, reason='scan_start', expected=None):
        deadline = self.clock()+8
        opened = False
        result = None
        try:
            image, bounds = window.capture()
            original = bounds
            view = self.screen.locate(image)
            if view is None:
                window.press('i')
            while self.clock() < deadline:
                window.pause(.12)
                image, bounds = window.capture()
                if bounds != original:
                    raise InventoryCheckError('背包确认时游戏窗口位置变化')
                view = self.screen.locate(image)
                if view is None:
                    continue
                opened = True
                packet = read_inventory(self.folder)
                matches = not expected or (packet and packet.get('mesos') == expected['mesos']
                    and next((i['quantity'] for i in packet.get('items', []) if i['item_id'] == expected['item_id']), 0) == expected['quantity'])
                # The panel controls prove inventory opened; complete current
                # stream data supplies its contents. Re-OCR of scaled currency
                # is redundant and can falsely stop an already confirmed sale.
                current_packet = (packet and isinstance(packet.get('session'), str) and packet['session']
                    and type(packet.get('revision')) is int and packet['revision'] > 0
                    and type(packet.get('mesos')) is int and packet['mesos'] >= 0)
                visual_balance = packet and type(view[2]) is int and packet.get('mesos') == view[2]
                if (packet and set(packet.get('categories', [])) >= {2, 3, 4}
                        and (current_packet or visual_balance) and matches):
                    result = packet
                    break
            if not opened:
                raise InventoryCheckError('无法确认背包已打开')
            # Close only the inventory we recognized. Never use an unverified
            # Escape which could accept/cancel an unrelated game dialog.
            window.press('i')
            closed = False
            for _ in range(12):
                window.pause(.1)
                image, bounds = window.capture()
                if bounds != original:
                    raise InventoryCheckError('关闭背包时游戏窗口位置变化')
                if self.screen.locate(image) is None:
                    closed = True
                    break
            if not closed:
                raise InventoryCheckError('无法确认背包已关闭')
            if result is None:
                raise InventoryCheckError('背包数据尚未完成核对')
            self.record(reason, 'confirmed', mesos=result['mesos'], items=len(result['items']))
            return result
        except Exception as error:
            # Keep one bounded local diagnostic for a failed visual check.
            # It is never included in reports, uploads or release archives.
            if 'image' in locals():
                try:
                    path = self.folder/'sweep/inventory-check-failed.png'
                    path.parent.mkdir(parents=True, exist_ok=True)
                    (image if hasattr(image, 'save') else Image.fromarray(image)).save(path)
                except (OSError, TypeError, AttributeError):
                    pass
            self.record(reason, 'failed', error=str(error)[:160])
            # Startup has not bought anything. Preserve input interruptions so
            # the scanner can wait for the game again instead of revoking intent.
            # Post-purchase verification still fails closed through PurchaseHalt.
            if reason == 'scan_start' and isinstance(error, (RuntimeError, InterruptedError)):
                raise
            if isinstance(error, InventoryCheckError):
                raise
            raise InventoryCheckError('背包确认失败：'+str(error)) from error

    def record(self, reason, status, **fields):
        path = self.folder/'sweep/inventory-checks.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(dict(at=time.time(), reason=reason, status=status, **fields), ensure_ascii=False)+'\n')


def check_at_start(folder, switcher):
    from types import SimpleNamespace
    def capture():
        image, _ = switcher.capture()
        return image, switcher.capture_bounds
    InventoryChecker(folder).run(SimpleNamespace(capture=capture, press=switcher.press_key, pause=switcher.pause))
