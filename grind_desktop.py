"""Grind tracker in the collector window: live state, settings, history,
background calibration and the always-on-top overlay.

The capture process owns the tracker and writes captures/grind_state.json;
this process only reads it, edits captures/grind/settings.json, and learns
captures/grind/protocol.json from the recorded frames.
"""
import contextlib
import ctypes
import json
import sqlite3
import threading
import time
from pathlib import Path

from grind_tracker import DEFAULTS, load_settings, write_json

CALIBRATE_EVERY = 300
CALIBRATE_BYTES = 96 * 1024 * 1024
OVERLAY_SIZES = dict(compact=(360, 40), standard=(340, 236), detailed=(360, 380))
GWL_EXSTYLE = -20
WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x80000, 0x20, 0x80, 0x8000000
WDA_NONE, WDA_EXCLUDEFROMCAPTURE = 0, 0x11


class GrindService:
    def __init__(self, folder, assets=None):
        self.folder = Path(folder)
        self.data = self.folder / 'grind'
        self.assets = assets
        self.overlay = None
        self.overlay_hwnd = None
        self.editing = False
        self.stop = threading.Event()
        self.calibrating = False
        self.last_calibration = None
        self.lock = threading.Lock()

    # ----- data for the pages -------------------------------------------
    def settings(self):
        return load_settings(self.data / 'settings.json')

    def save_settings(self, changes):
        if not isinstance(changes, dict):
            raise ValueError('invalid_request')
        with self.lock:
            current = self.settings()
            for key, value in changes.items():
                if key == 'overlay' and isinstance(value, dict):
                    current['overlay'].update({k: v for k, v in value.items() if k in DEFAULTS['overlay']})
                elif key in DEFAULTS and key != 'overlay':
                    current[key] = value
            if not write_json(self.data / 'settings.json', current):
                raise ValueError('unavailable')
        self.apply_overlay(current)
        return current

    def live(self):
        try:
            state = json.loads((self.folder / 'grind_state.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None
        state['stale'] = not 0 <= time.time() - state.get('alive_at', 0) <= 15
        return state

    def history(self, limit=100):
        path = self.data / 'history.sqlite'
        if not path.exists():
            return []
        try:
            with contextlib.closing(sqlite3.connect(path)) as db:
                rows = db.execute('SELECT summary FROM runs ORDER BY started_at DESC LIMIT ?', (limit,)).fetchall()
        except sqlite3.Error:
            return []
        out = []
        for (raw,) in rows:
            try:
                run = json.loads(raw)
            except ValueError:
                continue
            run.pop('recent', None)
            out.append(run)
        return out

    def calibration(self):
        try:
            return json.loads((self.data / 'calibration.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None

    def run(self, name, value=None):
        if name == 'state':
            return dict(live=self.live(), settings=self.settings(), editing=self.editing,
                        calibrating=self.calibrating, calibration=self.calibration())
        if name == 'history':
            return self.history()
        if name == 'settings':
            return self.save_settings(value)
        if name == 'overlay_edit':
            return self.edit_overlay(bool(value))
        if name == 'calibrate':
            threading.Thread(target=self.calibrate_once, args=(True,), daemon=True).start()
            return True
        raise ValueError('invalid_request')

    # ----- background calibration ---------------------------------------
    def start(self):
        threading.Thread(target=self.calibrate_loop, daemon=True, name='grind-calibrate').start()
        self.apply_overlay(self.settings())

    def calibrate_loop(self):
        while not self.stop.wait(30):
            if self.last_calibration and time.time() - self.last_calibration < CALIBRATE_EVERY:
                continue
            self.calibrate_once()

    def calibrate_once(self, force=False):
        from grind_calibrate import calibrate, complete, summary
        from grind_frames import read_frames
        from grind_protocol import load_profile, save_profile
        if self.calibrating:
            return
        current = load_profile(self.data / 'protocol.json')
        if complete(current) and not force:
            return
        files = sorted((self.data / 'frames').glob('frames_*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)
        chosen, total = [], 0
        for path in files:
            size = path.stat().st_size
            if chosen and total + size > CALIBRATE_BYTES:
                break
            chosen.append(path)
            total += size
        if not chosen:
            return
        self.calibrating = True
        try:
            learned = calibrate(read_frames(sorted(chosen)))
            merged = merge_profiles(current, learned)
            save_profile(self.data / 'protocol.json', merged)
            write_json(self.data / 'calibration.json', dict(at=time.time(), files=len(chosen), bytes=total,
                       summary=[dict(label=a, state=b) for a, b in summary(merged)], evidence=learned.get('evidence')))
        finally:
            self.calibrating = False
            self.last_calibration = time.time()

    # ----- overlay -------------------------------------------------------
    def apply_overlay(self, settings):
        overlay = settings['overlay']
        want = settings['enabled'] and overlay['enabled'] and not self.stop.is_set()
        try:
            import webview
        except ImportError:
            return
        if want and self.overlay is None and self.assets is not None:
            width, height = OVERLAY_SIZES.get(overlay['layout'], OVERLAY_SIZES['standard'])
            scale = min(2.0, max(0.6, float(overlay['scale'] or 1)))
            width, height = int(width * scale), int(height * scale)
            x, y = overlay['x'], overlay['y']
            if x is None or y is None:
                screen = webview.screens[0] if webview.screens else None
                x = (screen.width - width - 24) if screen else 40
                y = 96
            self.overlay = webview.create_window('枫叶市集 · 刷图', self.assets, js_api=OverlayAPI(self),
                width=width, height=height, x=x, y=y, resizable=False, frameless=True, easy_drag=True,
                on_top=True, focus=False, transparent=True, shadow=False, background_color='#000000')
            self.overlay.events.shown += lambda: self.style_overlay(settings)
        elif not want and self.overlay is not None:
            window, self.overlay, self.overlay_hwnd = self.overlay, None, None
            try:
                window.destroy()
            except Exception:
                pass
        elif self.overlay is not None:
            self.style_overlay(settings)

    def style_overlay(self, settings):
        """Click-through, no taskbar button, no focus; optionally hidden from captures."""
        if self.overlay is None:
            return
        try:
            handle = self.overlay.native.Handle
            hwnd = int(handle.ToInt64()) if hasattr(handle, 'ToInt64') else int(handle)
        except Exception:
            return
        self.overlay_hwnd = hwnd
        user = ctypes.windll.user32
        user.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        user.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
        styles = user.GetWindowLongPtrW(ctypes.c_void_p(hwnd), GWL_EXSTYLE)
        styles |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        if settings['overlay']['click_through'] and not self.editing:
            styles |= WS_EX_TRANSPARENT
        else:
            styles &= ~WS_EX_TRANSPARENT
        user.SetWindowLongPtrW(ctypes.c_void_p(hwnd), GWL_EXSTYLE, styles)
        affinity = WDA_EXCLUDEFROMCAPTURE if settings['overlay']['hide_in_capture'] else WDA_NONE
        user.SetWindowDisplayAffinity(ctypes.c_void_p(hwnd), affinity)

    def edit_overlay(self, editing):
        """While editing the overlay can be dragged; leaving edit mode saves where it is."""
        self.editing = editing
        settings = self.settings()
        if self.overlay is not None:
            self.style_overlay(settings)
            if not editing:
                try:
                    settings = self.save_settings(dict(overlay=dict(x=self.overlay.x, y=self.overlay.y)))
                except Exception:
                    pass
        return self.editing

    def close(self):
        """The main window is closing: the overlay must not keep the app alive."""
        self.stop.set()
        window, self.overlay = self.overlay, None
        if window is not None:
            try:
                window.destroy()
            except Exception:
                pass


class OverlayAPI:
    """The only methods the overlay page can call."""
    def __init__(self, service):
        self._service = service

    def state(self):
        live = self._service.live()
        return dict(live=live, settings=self._service.settings(), editing=self._service.editing)


def merge_profiles(current, learned):
    """Learned sections replace current ones only when confirmed; a confirmed
    section is never replaced by an unconfirmed result."""
    merged = json.loads(json.dumps(current))
    for key in ('stat', 'snapshot', 'kill', 'spawn', 'pickup'):
        new = learned.get(key) or {}
        if new.get('confirmed'):
            if key == 'snapshot' and (merged.get(key) or {}).get('exp') and not new.get('exp'):
                new = dict(new, exp=merged[key]['exp'])
            merged[key] = new
    merged['evidence'] = learned.get('evidence')
    return merged
