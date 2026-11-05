"""Conservative Windows native purchaser, running on the scanner input thread.

Resolution-normalized player stores, fully readable listings. Equipment is one
unique physical row (quantity 1) identified by the unique page alignment against
the fresh packet, never an equivalent row. Quantity is bounded by the reservation
and read back before confirmation.
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
from sweep_purchase import PurchaseHalt, PurchasePreparationSkipped, PurchaseResult, PurchaserStatus
from sweep_purchase_flow import Listing, PurchaseFlow, Receipt, View, Action
from sweep_screen import Canvas, Reader, canonical
from sweep_evidence import packet_balance, PurchaseTrace


class WindowsInput:
    def __init__(self, window, reader=None):
        self.window = window
        self.canvas = Canvas(*window.bounds[2:])
        self.reader = reader or Reader()
        self.geometry_checked = False
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
        px, py = self.canvas.point(930, 570)
        if not self.user.SetCursorPos(x+px, y+py):
            raise RuntimeError('Cannot move pointer away from listing tooltip')
        self.window.pause(.08)
        self.check()

    def capture(self):
        self.check()
        shot, bounds = self.window.capture()
        self.check()
        if tuple(bounds) != tuple(self.window.bounds):
            raise RuntimeError('Capture bounds changed')
        if not self.geometry_checked:
            native=Canvas(*self.window.bounds[2:],native=True)
            # Select native geometry only when BOTH Buy and Leave controls
            # match at their exact positions. Keep this mapping for dialogs,
            # scrolling, confirmation and closure throughout this operation.
            if self.reader.shop(native.frame(shot)):
                self.canvas=native
            self.geometry_checked=True
            self.window.purchase_geometry=dict(mode='native' if self.canvas.native else 'scaled',
                                               size=list(self.window.bounds[2:]))
        return self.canvas.frame(shot)

    def click(self, x, y):
        self.check()
        self.window.click(*self.canvas.point(x, y))
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
    # Split stacks may share an inventory slot. Preserve every display row,
    # including its stock, instead of collapsing rows into a slot dictionary.
    ordered = [from_snapshot(dict(raw, items=[row]))['items'][0] for row in raw['items']]
    found = [i for i, r in enumerate(ordered)
             if (r['category'], r['slot']) == (order.category, order.slot)
             and all(r.get(key) == getattr(order, key)
                     for key in ('item_id', 'price', 'bundle', 'equipment'))]
    if not found:
        raise ValueError('Missing or changed listing')
    return packet['title'], ordered, found[0]


def is_equipment(order):
    return order.category == 1 or order.item_id//1000000 == 1


def inventory_position(order):
    """A complete, fresh position in the current capture stream, or unknown.

    The equipment bag is not decoded: its position is the verified packet
    balance alone (quantity None), and a receipt then requires the exact debit.
    """
    if order.inventory is None:
        return None
    try:
        state = order.inventory()
        if (not isinstance(state, dict) or not isinstance(state.get('session'), str) or not state['session']
                or type(state.get('revision')) is not int or state['revision'] < 1
                or type(state.get('mesos')) is not int or state['mesos'] < 0):
            return None
        if is_equipment(order):
            return state['session'], state['revision'], state['mesos'], None
        if order.category not in state.get('categories', []):
            return None
        rows = [row for row in state['items'] if row['item_id'] == order.item_id]
        if len(rows) > 1:
            return None
        quantity = rows[0]['quantity'] if rows else 0
        if type(quantity) is not int or quantity < 0:
            return None
        return state['session'], state['revision'], state['mesos'], quantity
    except (OSError, ValueError, TypeError, KeyError):
        return None


class WindowsPurchaser:
    max_quantity = 9999
    max_units = 9999

    def __init__(self, reader=None, input_factory=None, clock=time.monotonic):
        self.reader = reader or Reader()
        self.input_factory = input_factory or (lambda window: WindowsInput(window,self.reader))
        self.clock = clock
        self.mesos = None

    def status(self):
        ready = os.name == 'nt' and bool(ctypes.windll.shell32.IsUserAnAdmin())
        return PurchaserStatus(ready, '' if ready else '购买需要管理员权限', self.mesos)

    def prepare_inventory(self, window, holdings):
        return self.prepare(window, holdings)

    def prepare(self, window, holdings=None):
        control = self.input_factory(window)
        control.move()
        image = control.capture()
        if self.reader.dialog(image)[0] is not None:
            raise PurchaseHalt(PurchaseResult('not_bought', reason='shop_closed'))
        if not self.reader.shop(image):
            # Preparation only moves the cursor and reads the screen. No
            # reservation or purchase input exists yet; skip this listing and
            # let the scanner independently verify closure before continuing.
            raise PurchasePreparationSkipped('listing_unverified')
        self.mesos = packet_balance(holdings)
        if self.mesos is None:
            self.mesos = self.reader.balance(image)
        if self.mesos is None:
            # A verified store with unreadable scaled digits has not received
            # any purchase input. Skip this visit; do not stop the whole scan.
            return False
        # The visit's fresh packet establishes shop identity. Unsupported
        # title glyphs use an unchanged title bitmap, never guessed OCR.
        return True

    def verify_inventory(self, window, folder, expected=None, bag=True):
        from inventory_check import InventoryChecker, InventoryCheckError
        from shop_window_control import game_menu_visible, single_button_notice_visible
        # Directly use the verified Leave control: Escape is commonly ignored
        # here and can open the game menu. Still require two clear fresh frames.
        control = self.input_factory(window)
        control.move()
        image = control.capture()
        if not self.reader.shop(image) or self.reader.dialog(image)[0] is not None:
            raise InventoryCheckError('购买已完成，但无法确认商店已关闭')
        control.click(604, 272)
        closed = 0
        deadline = self.clock()+2
        while self.clock() < deadline:
            window.pause(.05)
            raw, bounds = window.capture()
            if bounds != window.bounds:
                raise InventoryCheckError('关闭商店时游戏窗口位置变化')
            state = window.vision.window_markers(raw)
            if state['owner']:
                raise InventoryCheckError('关闭商店时出现了自己的商店')
            clear = not state['leave'] and not game_menu_visible(raw) and not single_button_notice_visible(raw)
            closed = closed+1 if clear else 0
            if closed >= 2:
                break
        if closed < 2:
            raise InventoryCheckError('购买已完成，但无法确认商店已关闭')
        if bag:
            # Equipment is settled by the exact packet debit; its bag is not
            # decoded, so an inventory comparison could only fail.
            InventoryChecker(folder).run(window, 'purchase', expected)
        return True

    def buy(self, order, window):
        trace = PurchaseTrace(order, window)
        try:
            result = self._buy(order, window, trace)
        except PurchaseHalt as error:
            trace.finish(error.result)
            raise
        trace.finish(result)
        return result

    def _buy(self, order, window, trace):
        flow = PurchaseFlow(order, self.clock)
        if (type(order.quantity) is not int or not 1 <= order.quantity <= self.max_quantity
                or type(order.bundle) is not int or order.bundle < 1
                or order.quantity*order.bundle > self.max_units
                or is_equipment(order) and (order.quantity, order.bundle) != (1, 1)
                or order.item_id//10000 in (207, 233)):
            return PurchaseResult('not_bought', reason='error')
        try:
            title, ordered, target = ordered_snapshot(window.capture_file, order)
        except (OSError, ValueError, KeyError, TypeError) as error:
            trace.check(stage='snapshot', error_type=type(error).__name__, detail=str(error))
            return PurchaseResult('not_bought', reason='listing_unverified')
        try:
            control = self.input_factory(window)
            control.move()
            title_stamp = None
            before_balance = before_stock = selected_row = None
            before_packet = None
            last_offset, unchanged, scrolls = None, 0, 0
            unreadable = 0
            while True:
                image = control.capture()
                title_pixels = image[157:177,440:931]
                if order.visit_current is not None:
                    if not order.visit_current():
                        flow.halt('shop_closed')
                elif title_stamp is not None and not np.array_equal(title_pixels, title_stamp):
                    flow.halt('shop_closed')
                kind, number = self.reader.dialog(image)
                trace.frame(image, flow.phase, kind)
                if kind:
                    if title_stamp is None:
                        flow.halt('shop_closed')
                    # The game accepts individual units; orders and accounting
                    # use bundles. Reject partial bundles during readback.
                    bundles = (number//order.bundle if type(number) is int
                               and number % order.bundle == 0 else None)
                    view = View(kind, quantity=bundles if kind == 'quantity' else None,
                                total=number if kind == 'confirm' else None,
                                reason=number if kind == 'rejected' else '')
                elif self.reader.shop(image):
                    visible_title = self.reader.title(image) if title_stamp is None and order.visit_current is None else None
                    if visible_title is not None and canonical(visible_title) != canonical(title):
                        flow.halt('shop_closed')
                    # Animated equipment can overlap the owner's nameplate.
                    # Shop identity comes from the fresh packet and verified
                    # target page; retain the unchanged static title throughout.
                    if title_stamp is None:
                        title_stamp = title_pixels.copy()
                    if flow.phase in ('cleanup', 'notice_cleanup'):
                        view = View('shop', shop_verified=True)
                    elif flow.submitted and before_packet is not None:
                        after = inventory_position(order)
                        receipt = None
                        if (after is not None and after[0] == before_packet[0] and after[1] > before_packet[1]
                                and before_packet[2]-after[2] == order.quantity*order.price
                                and (after[3] is None and before_packet[3] is None and is_equipment(order)
                                     or after[3] is not None and before_packet[3] is not None
                                     and after[3]-before_packet[3] == order.quantity*order.bundle)):
                            self.mesos = after[2]
                            receipt = Receipt(order.reservation, flow.listing, order.quantity, order.quantity*order.price)
                        view = View('shop', receipt=receipt, shop_verified=True)
                    else:
                        page = self.reader.page(image)
                        offset = self.reader.offset(page, ordered)
                        equivalent = (self.reader.equivalent_row(page, ordered, target, order.quantity)
                                      if offset is None and hasattr(self.reader,'equivalent_row') else None)
                        if offset is None and equivalent is None:
                            unreadable += 1
                            if unreadable < 3 and self.clock() < order.deadline and order.can_buy():
                                window.pause(.12)
                                continue
                            # No purchase dialog/input has been dispatched in these
                            # phases. A verified open shop can safely be skipped.
                            if hasattr(self.reader, 'alignment_details'):
                                trace.check(stage='page_alignment', target=target,
                                            **self.reader.alignment_details(page, ordered))
                            if flow.phase in ('select', 'selected') and not flow.submitted:
                                return PurchaseResult('not_bought', reason='listing_unverified')
                            flow.halt('listing_unverified')
                        unreadable = 0
                        if equivalent is None and not offset <= target < offset+6:
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
                            trace.action('scroll_down' if target >= offset+6 else 'scroll_up')
                            control.click(638, 537 if target >= offset+6 else 315)
                            window.pause(.12)
                            continue
                        screen_row = equivalent[0] if equivalent is not None else target-offset
                        visible = page[screen_row]
                        if not self.reader.row_matches(visible, ordered[target], complete=True):
                            trace.check(stage='target_row', row=screen_row, item_id=order.item_id,
                                        expected_price=order.price, actual_price=visible.price if visible else None,
                                        actual_name=visible.name if visible else None)
                            reason = ('price_changed' if visible is not None
                                      and canonical(visible.name) == canonical(self.reader.names.get(order.item_id))
                                      and visible.price != order.price else 'listing_unverified')
                            if flow.phase in ('select', 'selected') and not flow.submitted:
                                return PurchaseResult('not_bought', reason=reason)
                            flow.halt(reason)
                        position = inventory_position(order)
                        self.mesos = position[2] if position is not None else self.reader.balance(image)
                        # The fresh capture supplies the available bundle count;
                        # grey text vetoes a listing sold out since that capture.
                        # The game must then echo our quantity and exact total.
                        stock = (equivalent[1] if equivalent is not None else ordered[target]['stock']) if visible.available else 0
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
                    if order.visit_current is not None and not order.visit_current():
                        if action.kind == 'confirm':
                            flow.submitted = False  # No input has been sent yet.
                        flow.halt('shop_closed')
                    if self.clock() >= order.deadline and action.kind not in ('cancel', 'dismiss'):
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
                    trace.action(action.kind)
                    if action.kind == 'select':
                        control.click(535, 321+40*screen_row)
                    elif action.kind == 'buy':
                        before_packet = inventory_position(order)
                        if before_packet is not None and before_packet[2] != self.mesos:
                            # Do not anchor to a delayed/unrelated balance.
                            before_packet = None
                        before_balance, before_stock = self.mesos, stock_pixels.copy()
                        selected_row = screen_row
                        control.click(604, 252)
                    elif action.kind == 'quantity':
                        control.quantity(action.quantity*order.bundle, lambda: self.clock() < order.deadline and order.can_buy())
                    elif action.kind in ('accept_quantity', 'confirm'):
                        control.click(735, 423 if action.kind == 'accept_quantity' else 411 if view.kind == 'item_confirm' else 421)
                    elif action.kind == 'cancel':
                        control.click(783, 423 if view.kind == 'quantity' else 411 if view.kind == 'item_confirm' else 421)
                    elif action.kind == 'dismiss' and view.reason == 'shop_closed':
                        control.click(784, 411)
                    elif action.kind == 'dismiss' and view.kind == 'notice' and not flow.submitted:
                        control.click(784, 421)
                    else:
                        flow.halt('error')
                window.pause(.12)
        except PurchaseHalt:
            raise
        except Exception:
            flow.halt('error')


def create():
    return WindowsPurchaser()
