"""Purchase interface between the sweep engine and an in-game purchase executor (SWEEP.md section 4).

A purchaser implementation must:
1. Run on the scanner input thread while that shop window is open; never open or close the
   shop, and leave the window open when it returns.
2. Before clicking, confirm the (category, slot) row still shows the same item, price, bundle
   and attributes; otherwise return not_bought/price_changed.
3. Never buy more than `quantity` purchases or spend more than `quantity * price`.
4. Return before `deadline` (time.monotonic()). If it clicked buy but cannot confirm the
   outcome, return unknown.
5. Return bought only after confirmation (for example a shop row update or inventory packet).
6. Use only the reasons in REASONS.

An optional verify_inventory hook runs after the confirmed result is settled.
It may close the verified shop, open/check/close the inventory, and return True
to end this visit. The scanner independently verifies closure before moving on.
Multiple bundles of the current item are still bought together in one order.

The Windows executor is a separate module `sweep_purchaser_windows` exposing `create()`. It ships
with the collector; if it cannot be imported or started, purchases report LOAD_FAILED.
"""
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional, Protocol

REASONS = ('sold_out', 'price_changed', 'listing_unverified', 'not_enough_mesos', 'inventory_full',
           'shop_closed', 'window_lost', 'timeout', 'error', 'stopped', 'trade_locked')
LOAD_FAILED = '购买功能加载失败'


@dataclass(frozen=True)
class PurchaserStatus:
    ready: bool
    reason: str
    mesos: Optional[int]


@dataclass(frozen=True)
class PurchaseOrder:
    reservation: str
    item_id: int
    name: str
    category: int
    slot: int
    price: int  # mesos for one purchase of one bundle
    bundle: int
    quantity: int  # purchases (bundles), at most the reservation's grant
    equipment: Any
    shop_id: int
    owner: Optional[str]
    room: int
    channel: int
    deadline: float  # time.monotonic()
    # Recheck immediately before every purchase input, including the final confirmation.
    # No guard means no permission to buy (older/custom callers fail closed).
    can_buy: Callable[[], bool] = field(default=lambda: False, repr=False, compare=False)
    reserve_mesos: int = 0
    inventory: Optional[Callable[[], Optional[dict]]] = field(default=None, repr=False, compare=False)
    visit_current: Optional[Callable[[], bool]] = field(default=None, repr=False, compare=False)
    diagnostic: Optional[Callable[[dict], None]] = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class PurchaseResult:
    status: Literal['bought', 'not_bought', 'unknown']
    quantity: int = 0
    spent: int = 0
    reason: str = ''


class PurchaseHalt(Exception):
    """Stop scanner input even when a purchase outcome is known.

    The executor could not restore/verify the open shop. Preserve its confirmed
    result for settlement, then let the scanner's ShopCallbackError stop input.
    """
    def __init__(self, result):
        self.result = result
        super().__init__('购买窗口未恢复，已停止扫描：'+result.reason)


class ShopWindow(Protocol):
    """Provided by the scanner for the open shop. Coordinates are client-relative."""
    bounds: tuple  # (screen x, screen y, width, height) of the game client area
    vision: Any  # the scanner's Vision instance
    capture_file: str  # this visit's shop capture JSON

    def capture(self) -> tuple: ...  # (client image, bounds)
    def click(self, x: int, y: int) -> None: ...
    def press(self, key: str) -> None: ...
    def pause(self, seconds: float) -> None: ...


def purchase_halted(error):
    """Scanner wrappers retain the original halt as their exception cause."""
    seen = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, PurchaseHalt):
            return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


class Purchaser(Protocol):
    def status(self) -> PurchaserStatus: ...
    def buy(self, order: PurchaseOrder, window: ShopWindow) -> PurchaseResult: ...


class UnavailablePurchaser:
    def __init__(self, reason=LOAD_FAILED):
        self.reason = reason

    def status(self):
        return PurchaserStatus(False, self.reason, None)

    def buy(self, order, window):
        return PurchaseResult('not_bought', reason='error')


def load_purchaser():
    try:
        import sweep_purchaser_windows
        return sweep_purchaser_windows.create()
    except Exception:  # ImportError included: one reason for every load or start failure.
        return UnavailablePurchaser()
