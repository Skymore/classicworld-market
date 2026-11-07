"""Inventory checks from the receive-only capture; no game input or screen reading."""
import json
import time
from pathlib import Path

from market_inventory import read_inventory


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


def complete(packet):
    """A fresh, complete snapshot of the current connection's inventory."""
    return bool(packet and isinstance(packet.get('session'), str) and packet['session']
                and type(packet.get('revision')) is int and packet['revision'] > 0
                and type(packet.get('mesos')) is int and packet['mesos'] >= 0
                and set(packet.get('categories', [])) >= {2, 3, 4})


def matches(packet, expected):
    if not expected:
        return True
    quantity = next((i['quantity'] for i in packet.get('items', []) if i['item_id'] == expected['item_id']), 0)
    return packet.get('mesos') == expected['mesos'] and quantity == expected['quantity']


class InventoryChecker:
    """Confirm holdings from the capture instead of opening the inventory.

    Opening the bag only proved that a window rendered; its contents always
    came from the capture. Pointer occlusion and scaled glyphs made that visual
    step fail on a correct inventory, so it is no longer used. A purchase still
    requires the exact expected balance and item count from fresh packets.
    """
    def __init__(self, folder, screen=None, clock=time.monotonic):
        self.folder = Path(folder)
        self.clock = clock

    def run(self, window, reason='scan_start', expected=None, timeout=8):
        deadline = self.clock()+timeout
        packet = None
        try:
            while True:
                packet = read_inventory(self.folder)
                if complete(packet) and matches(packet, expected):
                    self.record(reason, 'confirmed', mesos=packet['mesos'], items=len(packet['items']))
                    return packet
                if self.clock() >= deadline:
                    break
                # The scanner's pause keeps its foreground and Stop guards.
                window.pause(.12)
            if reason == 'scan_start' and packet is None:
                from free_market_route import PositionSyncError
                raise PositionSyncError('Inventory snapshot unavailable after reconnect')
            raise InventoryCheckError('背包数据尚未完成核对')
        except Exception as error:
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
    InventoryChecker(folder).run(SimpleNamespace(pause=switcher.pause))
