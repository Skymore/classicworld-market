"""Resolution-normalized shop/dialog reading. Unknown glyphs never become a price.

Templates contain controls and font glyphs only, not character/account captures.
The raw packet order is the display order; normalized category/slot order is not.
"""
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
import sys

import numpy as np
import cv2
from PIL import Image, ImageFilter

ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).parent))
ASSETS = ROOT/'assets/sweep'


class Frame(np.ndarray):
    """A normalized client capture, retaining whether interpolation was needed."""
    resampled = False
    source_size = (1366, 768)

    def __array_finalize__(self, source):
        self.resampled = getattr(source, 'resampled', False)
        self.source_size = getattr(source, 'source_size', (1366, 768))


@dataclass(frozen=True)
class Canvas:
    width: int
    height: int

    def point(self, x, y):
        if not (0 <= x < 1366 and 0 <= y < 768):
            raise ValueError('Purchase point outside reference canvas')
        return round(x*self.width/1366), round(y*self.height/768)

    def frame(self, image):
        image = np.asarray(image.convert('RGB') if hasattr(image, 'convert') else image)
        if image.shape != (self.height, self.width, 3) or min(self.width, self.height) < 600:
            raise ValueError('Purchase capture dimensions changed')
        scaled = (self.width, self.height) != (1366, 768)
        if scaled:
            image = np.asarray(Image.fromarray(image).resize((1366, 768), Image.Resampling.BICUBIC))
        frame = image.view(Frame)
        frame.resampled = scaled
        frame.source_size = (self.width, self.height)
        return frame


def runs(mask):
    cols = mask.any(axis=0)
    x = 0
    while x < len(cols):
        if not cols[x]:
            x += 1
            continue
        start = x
        while x < len(cols) and cols[x]:
            x += 1
        yield start, x, mask[:, start:x]


def bitmap(mask):
    return tuple(''.join('#' if p else '.' for p in row) for row in mask)


class Font:
    def __init__(self, path, extra=None):
        self.glyphs = [(ch, tuple(rows)) for ch, rows in json.loads(path.read_text())['glyphs']]
        if extra is not None:
            self.glyphs.extend((ch, tuple(rows)) for ch, rows in json.loads(extra.read_text())['glyphs'])
        self.lookup = {rows: ch for ch, rows in self.glyphs}

    def split(self, rows):
        if not rows or len(rows[0]) > 512:
            return None
        # Adjacent y glyphs touch in genuine shop titles. Decode the complete
        # run with bounded, memoized exact matching rather than truncating it.
        @lru_cache(maxsize=513)
        def suffix(offset):
            part = tuple(row[offset:] for row in rows)
            if part in self.lookup:
                return self.lookup[part]
            for ch, glyph in self.glyphs:
                width = len(glyph[0])
                if width < len(part[0]) and all(a[:width] == b for a, b in zip(part, glyph)):
                    tail = suffix(offset+width)
                    if tail is not None:
                        return ch+tail
            return None
        return suffix(0)

    def read(self, mask, spaces=True, caret=False):
        result, previous = '', None
        pieces = list(runs(mask))
        for index, (start, end, pixels) in enumerate(pieces):
            # Quantity caret is taller than a digit. Only a trailing, separate
            # one-column caret is allowed; arbitrary unknown ink is rejected.
            if caret and index == len(pieces)-1 and end-start == 1 and pixels.sum() >= 10:
                continue
            ch = self.split(bitmap(pixels))
            if ch is None:
                return None
            if spaces and previous is not None and start-previous >= (6 if result.endswith('1') else 3):
                result += ' '
            result += ch
            previous = end
        return result or None


def canonical(text):
    return text.replace('I', 'l') if isinstance(text, str) else None


def money(text):
    if not isinstance(text, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)', text):
        return None
    return int(text.replace(',', ''))


@dataclass(frozen=True)
class Row:
    name: str
    bundle: int
    price: int
    available: bool
    selected: bool


class Reader:
    def __init__(self):
        font = ASSETS/'shop-font.json'
        if not font.exists():
            font = ROOT/'server/crates/market-core/assets/font.json'
        self.font = Font(font, ASSETS/'shop-font-extra.json')
        self._cached_line = lru_cache(maxsize=256)(self._decode_line)
        self.dialog_font = Font(ASSETS/'dialog-font.json')
        self.input_font = Font(ASSETS/'input-font.json')
        self.templates = {name: np.asarray(Image.open(ASSETS/(name+'.png')).convert('RGB'))
                          for name in ('buy', 'leave', 'quantity-prompt', 'confirm-prompt', 'cancel', 'quantity-cancel', 'ok', 'room-missing')}
        catalog = ASSETS/'catalog.json'
        if not catalog.exists():
            catalog = ROOT/'server/crates/market-core/assets/catalog.json'
        self.names = {int(key.split(':')[-1]): name for key, name, *_ in json.loads(catalog.read_text())['items']}

    def matches(self, image, name, x, y):
        template = self.templates[name]
        h, w = template.shape[:2]
        crop = image[y:y+h, x:x+w, :3]
        if crop.shape != template.shape:
            return False
        difference = np.abs(crop.astype(int)-template.astype(int))
        if not getattr(image, 'resampled', False):
            return difference.max() <= 2
        # Fixed-position pairs of independent controls establish each view.
        # Interpolation changes edge pixels; text/amounts are checked separately.
        # Exclude the outermost interpolation halo from neighbouring UI pixels.
        crop = crop[1:-1, 1:-1]
        candidates = (template[1:-1, 1:-1], self.scaled_template(name, x, y, image.source_size)[1:-1, 1:-1])
        return any(np.abs(crop.astype(int)-candidate.astype(int)).mean() < 32
                   and float(cv2.matchTemplate(np.asarray(crop), candidate,
                             cv2.TM_CCOEFF_NORMED)[0, 0]) >= .92 for candidate in candidates)

    @lru_cache(maxsize=64)
    def scaled_template(self, name, x, y, size):
        template = self.templates[name]
        height, width = template.shape[:2]
        canvas = np.zeros((768, 1366, 3), dtype=np.uint8)
        canvas[y:y+height, x:x+width] = template
        normalized = Canvas(*size).frame(Image.fromarray(canvas).resize(size, Image.Resampling.BILINEAR))
        return np.asarray(normalized[y:y+height, x:x+width]).copy()

    def shop(self, image):
        # Input and reading share the same normalized client canvas. Controls
        # must still occupy their expected positions before any purchase input.
        if image.shape[:2] != (768, 1366):
            return False
        panel = image[335:410,558:808,:3].astype(int)
        blue = (panel[:,:,2]-panel[:,:,0] > 65) & (panel[:,:,1] > 105) & (panel[:,:,0] < 110)
        return blue.mean() < .45 and self.matches(image, 'leave', 565, 264) and self.matches(image, 'buy', 565, 244)

    def line(self, image, x0, x1, base, white=False, grey=False):
        band = image[base-9:base+4, x0:x1, :3]
        return self._cached_line(band.tobytes(), band.shape, bool(getattr(image, 'resampled', False)), white, grey)

    def _decode_line(self, pixels, shape, resampled, white, grey):
        # Exact field pixels are the cache key. Scrolling, price, stock and
        # selection changes invalidate naturally; unknown text stays unknown.
        band = np.frombuffer(pixels, dtype=np.uint8).reshape(shape)
        if resampled:
            return self.scaled_text(self.font, band, white=white,
                                    thresholds=range(185, 241, 5) if grey else range(110, 161, 5))
        mask = band.min(axis=2) > 240 if white else band.max(axis=2) < (200 if grey else 80)
        return self.font.read(mask)

    @staticmethod
    def scaled_text(font, band, white=False, thresholds=range(100, 181, 2), pattern=None, **options):
        # Decode complete, exact glyphs at several contrast thresholds. Never
        # pick the closest digit, truncate unknown ink or use packet prices as OCR.
        values = set()
        blank_rows = [i for i in range(band.shape[0])
                      if all('#' not in glyph[i] for _, glyph in font.glyphs)]
        sharpened = np.asarray(Image.fromarray(np.asarray(band)).filter(
            ImageFilter.UnsharpMask(radius=.4, percent=150, threshold=0)))
        for pixels in (band, sharpened):
            for threshold in thresholds:
                mask = pixels.min(axis=2) > 255-threshold if white else pixels.max(axis=2) < threshold
                caret = None
                if options.get('caret'):
                    pieces = list(runs(mask))
                    if pieces:
                        start, end, ink = pieces[-1]
                        if end-start == 1 and ink.sum() >= 10:
                            caret = (start, mask[:, start].copy())
                # Resampling can blend the field border into unused font padding.
                mask[blank_rows] = False
                # A trailing input caret intentionally extends beyond glyph
                # padding. Preserve its height so Font.read can exclude it.
                if caret is not None:
                    mask[:, caret[0]] = caret[1]
                value = font.read(mask, **options)
                if value is not None and (pattern is None or re.fullmatch(pattern, value)):
                    values.add(value)
        return values.pop() if len(values) == 1 else None

    def owner(self, image):
        return self.line(image, 435, 521, 297, white=True)

    def title(self, image):
        return self.line(image, 441, 930, 170)

    def balance(self, image):
        return money(self.line(image, 553, 642, 297))

    def row(self, image, index):
        base = 321+40*index
        name = self.line(image, 466, 625, base)
        active = name is not None
        name = name or self.line(image, 466, 625, base, grey=True)
        offer = self.line(image, 466, 625, base+17, grey=not active)
        match = re.fullmatch(r'([0-9,]+) for ([0-9,]+) mesos', offer or '')
        if not name or not match:
            return None
        bundle, price = map(money, match.groups())
        if bundle is None or bundle < 1 or price is None:
            return None
        r, g, b = map(int, image[base-6, 623, :3])
        return Row(name, bundle, price, active, r > 210 and 100 < g < 190 and b < 80)

    def page(self, image):
        return [self.row(image, i) for i in range(6)]

    def row_matches(self, visible, packet, complete=False):
        if visible is None:
            return False
        name, wanted = canonical(visible.name), canonical(self.names.get(packet['item_id']))
        if not wanted:
            return False
        same_name = name == wanted or not complete and name.endswith('...') and wanted.startswith(name[:-3])
        # Rechargeable ammunition is normalized as one set in captures, while
        # the shop prints the remaining charges (e.g. 800). It may anchor a
        # page by exact name/price, but cannot be a fully verified buy target.
        same_bundle = visible.bundle == packet['bundle'] or (not complete
            and packet['item_id']//10000 in (207, 233) and packet['bundle'] == 1)
        return same_name and same_bundle and visible.price == packet['price']

    def offset(self, visible, ordered):
        # Require ordered anchors, and a unique alignment. Identical pages or
        # obscured rows must never assign a visual row to an arbitrary slot.
        candidates = []
        # The game can scroll past the last full page, leaving blank rows at
        # the bottom. Check every offset, retaining unique ordered anchors.
        for start in range(len(ordered)):
            count = min(6, len(ordered)-start)
            readable = [i for i in range(count) if visible[i] is not None]
            # New cash equipment can be absent from the local catalog. Its
            # readable price/bundle still must agree, but it is not a name
            # anchor and can never become a purchase target. Other known
            # rows must uniquely establish this page's raw packet offset.
            anchors = [i for i in readable if self.names.get(ordered[start+i]['item_id'])]
            agrees = all(self.row_matches(visible[i], ordered[start+i]) if i in anchors
                         else (visible[i].price, visible[i].bundle) ==
                              (ordered[start+i]['price'], ordered[start+i]['bundle']) for i in readable)
            if len(anchors) >= min(2,count) and agrees:
                if all(row is None for row in visible[count:]):
                    candidates.append(start)
        return candidates[0] if len(candidates) == 1 else None

    def dialog(self, image):
        if image.shape[:2] != (768, 1366):
            return None, None
        if self.matches(image, 'room-missing', 557, 345):
            return 'rejected', 'shop_closed'
        if self.matches(image, 'quantity-prompt', 566, 347) and self.matches(image, 'quantity-cancel', 763, 416):
            band = image[373:385, 571:790, :3]
            value = (self.scaled_text(self.input_font, band, spaces=False, caret=True)
                     if getattr(image, 'resampled', False)
                     else self.input_font.read(band.max(axis=2) < 80, spaces=False, caret=True))
            return 'quantity', int(value) if value and re.fullmatch(r'[1-9][0-9]{0,3}', value) else None
        if self.matches(image, 'confirm-prompt', 611, 369) and self.matches(image, 'cancel', 763, 414):
            band = image[353:367, 568:800, :3]
            text = (self.scaled_text(self.dialog_font, band, white=True, spaces=False,
                                    pattern=r'Thetotalpriceis([0-9,]+)mesos\.')
                    if getattr(image, 'resampled', False)
                    else self.dialog_font.read(band.min(axis=2) > 240, spaces=False))
            match = re.fullmatch(r'Thetotalpriceis([0-9,]+)mesos\.', text or '')
            return 'confirm', money(match[1]) if match else None
        # A one-button notice is only a UI observation, not evidence of a
        # rejected transaction. The flow may dismiss it BEFORE payment only.
        panel = image[345:390, 565:800, :3].astype(int)
        blue = (panel[:,:,2]-panel[:,:,0] > 65) & (panel[:,:,1] > 105) & (panel[:,:,0] < 110)
        if blue.mean() > .75 and self.matches(image, 'ok', 763, 414):
            return 'notice', None
        return None, None
