"""Purchase decisions shared by the Windows screen/input adapter and tests.

The 2026-10-28 live flow is select -> buy -> quantity -> total -> result.
The adapter must provide fresh, verified observations and execute each returned
action once on the scanner thread. This module deliberately does not infer a
successful purchase from an OK click, a vanished dialog, or another buyer's stock
change. The native adapter binds fresh screen observations to the current
capture and requires the buyer's own balance debit as well as a stock change.
"""
from dataclasses import dataclass
import time
from typing import Any, Optional

from sweep_purchase import PurchaseHalt, PurchaseResult


@dataclass(frozen=True)
class Listing:
    shop_id: int
    owner: Optional[str]
    room: int
    channel: int
    category: int
    slot: int
    item_id: int
    price: int
    bundle: int
    equipment: Any

    @classmethod
    def from_order(cls, order):
        return cls(**{key: getattr(order, key) for key in cls.__dataclass_fields__})


@dataclass(frozen=True)
class Receipt:
    """Adapter-verified evidence of THIS character's purchase after submission.

    `reservation` associates the adapter's observation with this attempt; it is
    not a game packet field. A stock decrease alone is not a receipt.
    """
    reservation: str
    listing: Listing
    quantity: int
    spent: int


@dataclass(frozen=True)
class View:
    kind: str  # shop, quantity, confirm, rejected, or pending
    listing: Optional[Listing] = None
    stock: Optional[int] = None
    mesos: Optional[int] = None
    selected: bool = False
    quantity: Optional[int] = None
    total: Optional[int] = None
    receipt: Optional[Receipt] = None
    reason: str = ''
    focused: bool = True
    # The adapter must verify the same open shop before declaring cleanup done.
    shop_verified: bool = False


@dataclass(frozen=True)
class Action:
    kind: str  # select, buy, quantity, accept_quantity, confirm, cancel, dismiss
    quantity: int = 0


class PurchaseFlow:
    """One attempt. `step` returns an Action, a PurchaseResult, or None (observe again).

    State advances BEFORE returning an input action, so delayed/stale frames do
    not cause duplicate clicks. On an input error call halt(); never retry the
    action. Keep observing with a bounded capture/pause until result or deadline.
    """
    def __init__(self, order, clock=time.monotonic):
        self.order, self.clock = order, clock
        self.listing = Listing.from_order(order)
        self.phase = 'select'
        self.submitted = False
        self.outcome = None
        self.typed = False
        self.halted = False
        self.cleanup_deadline = order.deadline
        self.cancelled_after_notice = False

    def halt(self, reason='error'):
        self.halted = True
        self.outcome = self.outcome or PurchaseResult(
            'unknown' if self.submitted else 'not_bought', reason=reason)
        raise PurchaseHalt(self.outcome)

    def single_equipment(self):
        return self.order.quantity == 1 and (self.order.category == 1 or self.order.item_id//1000000 == 1)

    def _abort(self, view, reason):
        self.outcome = PurchaseResult('not_bought', reason=reason)
        if view.kind == 'notice' and self.phase in ('quantity', 'confirm') and not self.submitted:
            self.phase = 'notice_cleanup'
            self.cleanup_deadline = self.clock()+2
            return Action('dismiss')
        if view.kind == 'shop' and view.shop_verified:
            self.phase = 'done'
            return self.outcome
        if view.kind in ('quantity', 'confirm', 'item_confirm'):
            self.phase = 'cleanup'
            self.cleanup_deadline = self.clock()+2
            return Action('cancel')
        self.halt(reason)

    def step(self, view):
        if self.halted:
            self.halt()
        if self.phase == 'done':
            return self.outcome
        if not view.focused:
            self.halt('window_lost')
        if self.phase in ('cleanup', 'notice_cleanup'):
            if view.kind == 'shop' and view.shop_verified:
                self.phase = 'done'
                return self.outcome
            if self.clock() >= self.cleanup_deadline:
                self.halt('timeout')
            if self.phase == 'notice_cleanup' and view.kind in ('quantity', 'confirm', 'item_confirm') and not self.cancelled_after_notice:
                self.cancelled_after_notice = True
                return Action('cancel')
            return None
        # An expired reservation forbids buying, not cancelling a recognized
        # pre-payment dialog. Observe cleanup for a separate bounded interval.
        if self.clock() >= self.order.deadline:
            if not self.submitted:
                return self._abort(view, 'timeout')
            self.halt('timeout')
        if self.submitted:
            if view.kind == 'rejected' and view.reason in (
                    'sold_out', 'not_enough_mesos', 'inventory_full', 'trade_locked', 'shop_closed'):
                self.outcome = PurchaseResult('not_bought', reason=view.reason)
                self.phase = 'cleanup'
                return Action('dismiss')
            receipt = view.receipt
            if receipt is not None:
                if (receipt.reservation != self.order.reservation or receipt.listing != self.listing
                        or type(receipt.quantity) is not int or not 1 <= receipt.quantity <= self.order.quantity
                        or type(receipt.spent) is not int or receipt.spent != receipt.quantity*self.order.price):
                    self.halt('error')
                self.outcome = PurchaseResult('bought', receipt.quantity, receipt.spent)
                if view.kind == 'shop' and view.shop_verified:
                    self.phase = 'done'
                    return self.outcome
                # Already confirmed, but unknown dialog: stop input, preserve settlement.
                self.halt('error')
            return None  # Never resubmit after the final confirmation.
        if not self.order.can_buy():
            return self._abort(view, 'stopped')
        if view.kind == 'notice' and self.phase in ('quantity', 'confirm'):
            return self._abort(view, 'error')
        if self.phase in ('select', 'selected'):
            if view.kind != 'shop' or not view.shop_verified:
                self.halt('shop_closed')
            if view.listing != self.listing:
                return self._abort(view, 'price_changed')
            if type(view.stock) is not int or view.stock < self.order.quantity:
                return self._abort(view, 'sold_out')
            if type(view.mesos) is not int:
                return self._abort(view, 'error')
            if view.mesos < self.order.quantity*self.order.price+self.order.reserve_mesos:
                return self._abort(view, 'not_enough_mesos')
            if self.phase == 'select':
                self.phase = 'selected'
                return Action('select')
            if view.selected:
                self.phase = 'quantity'
                return Action('buy')
            return None
        if self.phase == 'quantity':
            if view.kind == 'shop':
                return None  # Buy click has not painted its dialog yet.
            if (view.kind in ('confirm', 'item_confirm') and not self.typed and self.single_equipment()):
                # A single equipment piece may go straight to the total
                # prompt. The exact total below still gates confirmation.
                self.phase = 'confirm'
            elif view.kind != 'quantity':
                self.halt('error')
        if self.phase == 'quantity':
            if not self.typed:
                self.typed = True
                return Action('quantity', self.order.quantity)
            if type(view.quantity) is int and view.quantity == self.order.quantity:
                self.phase = 'confirm'
                return Action('accept_quantity')
            return None  # Never accept unreadable or stale quantity text.
        if self.phase == 'confirm':
            if view.kind == 'quantity':
                return None
            if view.kind == 'item_confirm' and self.single_equipment():
                # The game shows no total for one equipment piece. Its price was
                # read back on the selected row; the packet debit settles it.
                pass
            elif view.kind != 'confirm':
                self.halt('error')
            elif type(view.total) is not int or view.total != self.order.quantity*self.order.price:
                return self._abort(view, 'price_changed')
            # After this action may have been dispatched, any lost evidence is unknown.
            self.submitted, self.phase = True, 'result'
            return Action('confirm')
        self.halt('error')
