"""Conservative Windows native purchaser, running on the scanner input thread.

Standard 1366x768 player stores, fully readable non-equipment listings.
Quantity is bounded by the reservation and read back before confirmation.
Scroll position is recovered from the
entire visible page against RAW packet order, never from category/slot sorting.
"""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import time

import numpy as np

from shared_protocol import from_snapshot
from sweep_purchase import PurchaseHalt, PurchaseResult, PurchaserStatus
from sweep_purchase_flow import Listing, PurchaseFlow, Receipt, View, Action
from sweep_screen import Reader, canonical


class WindowsInput:
    def __init__(self, window):
        self.window = window
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.user.GetForegroundWindow.restype = wintypes.HWND
        self.user.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
        self.user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.hwnd = self.user.GetForegroundWindow()
        self.check()

    def check(self):
        title = ctypes.create_unicode_buffer(256)
        self.user.GetWindowTextW(self.hwnd, title, len(title))
        rect, point = wintypes.RECT(), wintypes.POINT()
        if (self.user.GetForegroundWindow() != self.hwnd or title.value != 'MapleStory'
                or not self.user.GetClientRect(self.hwnd, ctypes.byref(rect))
                or not self.user.ClientToScreen(self.hwnd, ctypes.byref(point))
                or (point.x, point.y, rect.right, rect.bottom) != tuple(self.window.bounds)):
            raise RuntimeError('Game foreground or client bounds changed')

    def move(self):
        self.check()
        x, y, _, _ = self.window.bounds
        if not self.user.SetCursorPos(x+930, y+570):
            raise RuntimeError('Cannot move pointer away from listing tooltip')
        self.window.pause(.08)
        self.check()

    def capture(self):
        self.check()
        shot, bounds = self.window.capture()
        self.check()
        if tuple(bounds) != tuple(self.window.bounds):
            raise RuntimeError('Capture bounds changed')
        return np.asarray(shot.convert('RGB'))

    def click(self, x, y):
        self.check()
        self.window.click(x, y)
        self.move()

    def quantity(self, value, allowed):
        if type(value) is not int or not 1 <= value <= 9999:
            raise ValueError('Native quantity must be between 1 and 9999')
        from market_keyboard import Input, KeyboardInput
        self.user.SendInput.argtypes = [ctypes.c_uint, ctypes.POINTER(Input), ctypes.c_int]
        self.user.SendInput.restype = ctypes.c_uint

        def key(scan, down):
            if down:
                self.check()
                if not allowed():
                    raise RuntimeError('Purchase permission expired')
            event = Input()
            event.type = 1
            event.payload.keyboard = KeyboardInput(0, scan, 8 | (0 if down else 2), 0, 0)
            if self.user.SendInput(1, ctypes.byref(event), ctypes.sizeof(event)) != 1:
                raise RuntimeError('Quantity input failed')

        try:
            key(0x1d, True)
            key(0x1e, True)
            self.window.pause(.03)
        finally:
            key(0x1e, False)
            key(0x1d, False)
        for digit in str(value):
            scan = 0x0b if digit == '0' else int(digit)+1
            try:
                key(scan, True)
                self.window.pause(.03)
            finally:
                key(scan, False)
        self.move()


def ordered_snapshot(filename, order, now=time.time):
    path = Path(filename)
    if path.stat().st_size > 2*1024*1024:
        raise ValueError('Oversized shop capture')
    raw = json.loads(path.read_text(encoding='utf-8'))
    if not 0 <= now()-raw['time'] <= 60:
        raise ValueError('Shop capture is stale')
    packet = from_snapshot(raw)
    location, owner = packet.get('location') or {}, packet.get('owner') or {}
    if (packet['shop_id'], owner.get('name'), location.get('room'), location.get('channel')) != (
            order.shop_id, order.owner, order.room, order.channel):
        raise ValueError('Wrong shop capture')
    by_slot = {(r['category'], r['slot']): r for r in packet['items']}
    if len(by_slot) != len(raw['items']):
        raise ValueError('Duplicate capture slots')
    ordered = [by_slot[(r.get('category', r['item_id']//1000000), r['slot'])] for r in raw['items']]
    found = [i for i, r in enumerate(ordered) if (r['category'], r['slot']) == (order.category, order.slot)]
    if len(found) != 1:
        raise ValueError('Missing listing')
    row = ordered[found[0]]
    if any(row.get(key) != getattr(order, key) for key in ('item_id', 'price', 'bundle', 'equipment')):
        raise ValueError('Listing changed')
    return packet['title'], ordered, found[0]


class WindowsPurchaser:
    max_quantity = 9999

    def __init__(self, reader=None, input_factory=WindowsInput, clock=time.monotonic):
        self.reader = reader or Reader()
        self.input_factory, self.clock = input_factory, clock
        self.mesos = None

    def status(self):
        ready = os.name == 'nt' and bool(ctypes.windll.shell32.IsUserAnAdmin())
        return PurchaserStatus(ready, '' if ready else '购买需要管理员权限', self.mesos)

    def prepare(self, window):
        control = self.input_factory(window)
        control.move()
        image = control.capture()
        if self.reader.dialog(image)[0] is not None or not self.reader.shop(image):
            raise PurchaseHalt(PurchaseResult('not_bought', reason='shop_closed'))
        self.mesos = self.reader.balance(image)
        if self.mesos is None:
            raise PurchaseHalt(PurchaseResult('not_bought', reason='error'))
        # The visit's fresh packet establishes shop identity. Unsupported
        # title glyphs use an unchanged title bitmap, never guessed OCR.
        return True

    def buy(self, order, window):
        flow = PurchaseFlow(order, self.clock)
        if (type(order.quantity) is not int or not 1 <= order.quantity <= self.max_quantity
                or order.category == 1 or order.equipment is not None
                or order.item_id//10000 in (207, 233)):
            return PurchaseResult('not_bought', reason='error')
        try:
            title, ordered, target = ordered_snapshot(window.capture_file, order)
        except (OSError, ValueError, KeyError, TypeError):
            flow.halt('listing_unverified')
        try:
            control = self.input_factory(window)
            control.move()
            owner_stamp = title_stamp = None
            before_balance = before_stock = selected_row = None
            last_offset, unchanged, scrolls = None, 0, 0
            unreadable = 0
            while True:
                image = control.capture()
                title_pixels = image[157:177,440:931]
                if title_stamp is not None and not np.array_equal(title_pixels, title_stamp):
                    flow.halt('shop_closed')
                kind, number = self.reader.dialog(image)
                if kind:
                    if owner_stamp is None or not np.array_equal(image[287:301,435:521], owner_stamp):
                        flow.halt('shop_closed')
                    view = View(kind, quantity=number if kind == 'quantity' else None,
                                total=number if kind == 'confirm' else None,
                                reason=number if kind == 'rejected' else '')
                elif self.reader.shop(image):
                    visible_title = self.reader.title(image)
                    if visible_title is not None and canonical(visible_title) != canonical(title):
                        flow.halt('shop_closed')
                    stamp = image[287:301,435:521]
                    if owner_stamp is not None and not np.array_equal(stamp, owner_stamp):
                        flow.halt('shop_closed')
                    if owner_stamp is None:
                        owner_stamp = stamp.copy()
                        title_stamp = title_pixels.copy()
                    page = self.reader.page(image)
                    offset = self.reader.offset(page, ordered)
                    if offset is None:
                        unreadable += 1
                        if unreadable < 3 and self.clock() < order.deadline and order.can_buy():
                            window.pause(.12)
                            continue
                        # No purchase dialog/input has been dispatched in these
                        # phases. A verified open shop can safely be skipped.
                        if flow.phase in ('select', 'selected') and not flow.submitted:
                            return PurchaseResult('not_bought', reason='listing_unverified')
                        flow.halt('listing_unverified')
                    unreadable = 0
                    if not offset <= target < offset+6:
                        if flow.phase != 'select' or flow.submitted:
                            flow.halt('error')
                        if self.clock() >= order.deadline:
                            flow.halt('timeout')
                        if not order.can_buy():
                            return PurchaseResult('not_bought', reason='stopped')
                        unchanged = unchanged+1 if offset == last_offset else 0
                        if unchanged >= 2 or scrolls >= len(ordered):
                            return PurchaseResult('not_bought', reason='error')
                        last_offset, scrolls = offset, scrolls+1
                        control.click(638, 537 if target >= offset+6 else 315)
                        window.pause(.12)
                        continue
                    screen_row = target-offset
                    visible = page[screen_row]
                    if not self.reader.row_matches(visible, ordered[target], complete=True):
                        reason = ('price_changed' if visible is not None
                                  and canonical(visible.name) == canonical(self.reader.names.get(order.item_id))
                                  and visible.price != order.price else 'listing_unverified')
                        if flow.phase in ('select', 'selected') and not flow.submitted:
                            return PurchaseResult('not_bought', reason=reason)
                        flow.halt(reason)
                    self.mesos = self.reader.balance(image)
                    # The fresh capture supplies the available bundle count;
                    # grey text vetoes a listing sold out since that capture.
                    # The game must then echo our quantity and exact total.
                    stock = ordered[target]['stock'] if visible.available else 0
                    stock_pixels = image[330+40*screen_row:342+40*screen_row,428:461]
                    receipt = None
                    if flow.submitted and before_balance is not None and self.mesos is not None:
                        if (before_balance-self.mesos == order.quantity*order.price and selected_row == screen_row
                                and before_stock is not None and not np.array_equal(before_stock, stock_pixels)):
                            receipt = Receipt(order.reservation, flow.listing, order.quantity, order.quantity*order.price)
                    view = View('shop', flow.listing, stock=stock, mesos=self.mesos,
                                selected=visible.selected, receipt=receipt, shop_verified=True)
                else:
                    view = View('pending')
                action = flow.step(view)
                if isinstance(action, PurchaseResult):
                    return action
                if isinstance(action, Action):
                    if self.clock() >= order.deadline:
                        if action.kind == 'confirm':
                            flow.submitted = False  # Confirmation has not been dispatched.
                        flow.halt('timeout')
                    if action.kind not in ('cancel', 'dismiss') and not order.can_buy():
                        # Let the state machine observe stopped and cancel a known modal.
                        if flow.submitted:
                            flow.submitted = False  # No confirmation input was dispatched.
                        action = flow._abort(view, 'stopped')
                        if isinstance(action, PurchaseResult):
                            return action
                    if action.kind == 'select':
                        control.click(535, 321+40*screen_row)
                    elif action.kind == 'buy':
                        before_balance, before_stock = self.mesos, stock_pixels.copy()
                        selected_row = screen_row
                        control.click(604, 252)
                    elif action.kind == 'quantity':
                        control.quantity(action.quantity, lambda: self.clock() < order.deadline and order.can_buy())
                    elif action.kind in ('accept_quantity', 'confirm'):
                        control.click(735, 423 if action.kind == 'accept_quantity' else 421)
                    elif action.kind == 'cancel':
                        control.click(783, 423 if view.kind == 'quantity' else 421)
                    elif action.kind == 'dismiss' and view.reason == 'shop_closed':
                        control.click(784, 411)
                    else:
                        flow.halt('error')
                window.pause(.12)
        except PurchaseHalt:
            raise
        except Exception:
            flow.halt('error')


def create():
    return WindowsPurchaser()
