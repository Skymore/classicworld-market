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

The Windows executor is a separate module `sweep_purchaser_windows` exposing `create()`.
"""
from dataclasses import dataclass
from typing import Any, Literal, Optional, Protocol

REASONS = ('sold_out', 'price_changed', 'not_enough_mesos', 'inventory_full',
           'shop_closed', 'window_lost', 'timeout', 'error')
NOT_INSTALLED = '此电脑尚未安装购买执行器'


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


@dataclass(frozen=True)
class PurchaseResult:
    status: Literal['bought', 'not_bought', 'unknown']
    quantity: int = 0
    spent: int = 0
    reason: str = ''


class ShopWindow(Protocol):
    """Provided by the scanner for the open shop. Coordinates are client-relative."""
    bounds: tuple  # (screen x, screen y, width, height) of the game client area
    vision: Any  # the scanner's Vision instance
    capture_file: str  # this visit's shop capture JSON

    def capture(self) -> tuple: ...  # (client image, bounds)
    def click(self, x: int, y: int) -> None: ...
    def press(self, key: str) -> None: ...
    def pause(self, seconds: float) -> None: ...


class Purchaser(Protocol):
    def status(self) -> PurchaserStatus: ...
    def buy(self, order: PurchaseOrder, window: ShopWindow) -> PurchaseResult: ...


class UnavailablePurchaser:
    def __init__(self, reason=NOT_INSTALLED):
        self.reason = reason

    def status(self):
        return PurchaserStatus(False, self.reason, None)

    def buy(self, order, window):
        return PurchaseResult('not_bought', reason='error')


def load_purchaser():
    try:
        import sweep_purchaser_windows
    except ImportError:
        return UnavailablePurchaser()
    try:
        return sweep_purchaser_windows.create()
    except Exception:
        return UnavailablePurchaser('购买执行器无法启动')
