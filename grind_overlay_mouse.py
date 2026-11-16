"""The overlay's buttons and drag-to-move, read from the system mouse.

While the game is in front it confines the mouse to its window and can hold the
mouse capture, so clicks on the overlay (a no-activate WebView2 window on top)
often never reach the page: the buttons did nothing and dragging stuttered
(2026-11-15). A low-level mouse hook sees every click wherever it goes. A left
press inside the overlay is kept from the game and handled here:

- on a button the page reported (`regions`, CSS pixels): the page clicks it when
  the button is released over it;
- anywhere else on the card: dragging moves the window (SetWindowPos, physical
  pixels, so display scaling cannot make it drift).

Mouse movement is never held back; only the press and release are kept from the game.
"""
import ctypes
import json
import queue
import threading

WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP = 0x0200, 0x0201, 0x0202
WH_MOUSE_LL = 14
MOVE_SLOP = 3            # physical pixels before a press on the card starts a drag


class OverlayPointer:
    """Hit testing and drag state, free of Windows calls (tested directly)."""

    def __init__(self):
        self.regions = []    # [{id, x, y, w, h}] in CSS pixels, relative to the window
        self.press = None    # what the current press started on

    def set_regions(self, regions):
        clean = []
        for r in regions or []:
            try:
                clean.append(dict(id=str(r['id']), x=float(r['x']), y=float(r['y']), w=float(r['w']), h=float(r['h'])))
            except (KeyError, TypeError, ValueError):
                continue
        self.regions = clean

    def hit(self, rect, scale, x, y):
        left, top, right, bottom = rect
        if not (left <= x < right and top <= y < bottom):
            return None
        cx, cy = (x - left) / scale, (y - top) / scale
        for r in self.regions:
            if r['x'] <= cx < r['x'] + r['w'] and r['y'] <= cy < r['y'] + r['h']:
                return r['id']
        return 'card'

    def handle(self, message, x, y, rect, scale):
        """(keep from the game, [actions]). Actions: ('click', id), ('move', left, top), ('moved',)."""
        if message == WM_LBUTTONDOWN:
            target = None if rect is None else self.hit(rect, scale, x, y)
            if target is None:
                self.press = None
                return False, []
            self.press = dict(target=target, x=x, y=y, left=rect[0], top=rect[1], dragging=False)
            return True, []
        press = self.press
        if press is None:
            return False, []
        if message == WM_MOUSEMOVE:
            dx, dy = x - press['x'], y - press['y']
            if press['target'] == 'card':
                if press['dragging'] or abs(dx) > MOVE_SLOP or abs(dy) > MOVE_SLOP:
                    press['dragging'] = True
                    return False, [('move', press['left'] + dx, press['top'] + dy)]
            return False, []
        if message == WM_LBUTTONUP:
            self.press = None
            if press['target'] == 'card':
                return True, [('moved',)] if press['dragging'] else []
            released = None if rect is None else self.hit(rect, scale, x, y)
            return True, [('click', press['target'])] if released == press['target'] else []
        return False, []


class OverlayMouse:
    """WH_MOUSE_LL on its own message thread; actions run on a worker thread."""

    def __init__(self, service):
        self.service = service
        self.pointer = OverlayPointer()
        self.thread_id = None
        self.hook = None
        self.jobs = queue.Queue()
        self.callback = None

    def start(self):
        threading.Thread(target=self.loop, daemon=True, name='grind-overlay-mouse').start()
        threading.Thread(target=self.work, daemon=True, name='grind-overlay-actions').start()

    def stop(self):
        if self.thread_id:
            ctypes.windll.user32.PostThreadMessageW(self.thread_id, 0x0012, 0, 0)   # WM_QUIT
        self.jobs.put(None)

    def window(self):
        """(hwnd, rect, display scale) of the shown overlay, else None."""
        hwnd = self.service.overlay_hwnd
        if not hwnd or self.service.overlay is None:
            return None
        if (self.service.settings().get('overlay') or {}).get('mouse_through'):
            return None   # clicks go through to the game
        user = ctypes.windll.user32
        if not user.IsWindowVisible(ctypes.c_void_p(hwnd)):
            return None
        rect = (ctypes.c_long * 4)()
        if not user.GetWindowRect(ctypes.c_void_p(hwnd), rect):
            return None
        try:
            dpi = user.GetDpiForWindow(ctypes.c_void_p(hwnd)) or 96
        except AttributeError:
            dpi = 96
        return hwnd, tuple(rect), dpi / 96

    def on_mouse(self, message, x, y):
        found = self.window() if message == WM_LBUTTONDOWN or self.pointer.press else None
        if message == WM_LBUTTONDOWN and found is None:
            return False
        hwnd, rect, scale = found if found else (None, None, 1.0)
        keep, actions = self.pointer.handle(message, x, y, rect, scale)
        for action in actions:
            if action[0] == 'move' and hwnd:
                # In the hook thread: immediate, smooth.
                ctypes.windll.user32.SetWindowPos(ctypes.c_void_p(hwnd), None, int(action[1]), int(action[2]), 0, 0,
                                                  0x0001 | 0x0004 | 0x0010)   # NOSIZE | NOZORDER | NOACTIVATE
            else:
                self.jobs.put(action)
        return keep

    def work(self):
        while True:
            action = self.jobs.get()
            if action is None:
                return
            try:
                if action[0] == 'click' and self.service.overlay is not None:
                    self.service.overlay.evaluate_js(f'window.__overlayPress && window.__overlayPress({json.dumps(action[1])})')
                elif action[0] == 'moved':
                    self.service.overlay_moved()
            except Exception as error:
                print(f'Overlay action failed ({type(error).__name__}).', flush=True)

    def loop(self):
        from ctypes import wintypes
        user, kernel = ctypes.windll.user32, ctypes.windll.kernel32
        self.thread_id = kernel.GetCurrentThreadId()

        class MSLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long), ('mouseData', wintypes.DWORD),
                        ('flags', wintypes.DWORD), ('time', wintypes.DWORD), ('extra', ctypes.c_size_t)]

        HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        user.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user.CallNextHookEx.restype = ctypes.c_ssize_t
        user.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wintypes.DWORD]
        user.SetWindowsHookExW.restype = ctypes.c_void_p

        def proc(code, wparam, lparam):
            if code == 0 and wparam in (WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP):
                try:
                    info = ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                    if not info.flags & 1 and self.on_mouse(wparam, info.x, info.y):   # not injected
                        return 1
                except Exception:
                    pass
            return user.CallNextHookEx(self.hook, code, wparam, lparam)

        # 64-bit handles: without these types the module handle is cut to 32 bits and the
        # hook is refused (v0.7.71-72: "Overlay mouse hook unavailable", buttons dead).
        kernel.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
        kernel.GetModuleHandleW.restype = ctypes.c_void_p
        user.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
        self.callback = HOOKPROC(proc)
        self.hook = user.SetWindowsHookExW(WH_MOUSE_LL, self.callback, kernel.GetModuleHandleW(None), 0)
        if not self.hook:
            print(f'Overlay mouse hook unavailable ({kernel.GetLastError()}).', flush=True)
            return
        message = wintypes.MSG()
        while user.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            pass
        user.UnhookWindowsHookEx(ctypes.c_void_p(self.hook))
