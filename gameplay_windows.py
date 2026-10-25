"""Windows screen capture and foreground-scoped keyboard observation.

No game memory access and no generated keyboard/mouse input. DXcam is pinned
because monitor discovery uses its Output descriptors (including negative origins).
"""
from __future__ import annotations

import ctypes
import os
import threading
import time
from ctypes import wintypes


NAMED_KEYS = {
    "left": [0x25], "up": [0x26], "right": [0x27], "down": [0x28],
    "space": [0x20], "ctrl": [0xA2, 0xA3], "shift": [0xA0, 0xA1],
    "alt": [0xA4, 0xA5], "tab": [9], "enter": [13], "esc": [27],
    "home": [0x24], "end": [0x23], "pageup": [0x21], "pagedown": [0x22],
    "insert": [0x2D], "delete": [0x2E], "backspace": [8],
    **{str(i): [ord(str(i))] for i in range(10)},
    **{chr(i).lower(): [i] for i in range(65, 91)},
    **{f"f{i}": [0x6F + i] for i in range(1, 13)},
}


def parse_keys(text):
    keys = sorted({part.strip().lower() for part in text.split(",") if part.strip()})
    unknown = set(keys) - NAMED_KEYS.keys()
    if unknown:
        raise ValueError("Unknown keys: " + ", ".join(sorted(unknown)))
    if not keys:
        raise ValueError("Select at least one gameplay key")
    if set(keys) & {"f8", "f9"}:
        raise ValueError("F8 and F9 are reserved for pause and stop")
    return keys


def windows_api():
    if os.name != "nt":
        raise RuntimeError("Live capture requires Windows")
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetForegroundWindow.restype = wintypes.HWND
    for name in ("IsWindow", "IsWindowVisible", "IsIconic"):
        getattr(user, name).argtypes = [wintypes.HWND]
    user.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    user.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetAsyncKeyState.argtypes = [ctypes.c_int]
    user.GetAsyncKeyState.restype = ctypes.c_short
    return user


def enable_dpi_awareness():
    user = windows_api()
    try:
        user.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except AttributeError:
        user.SetProcessDPIAware()


def list_windows():
    user = windows_api()
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    result = []

    def visit(hwnd, _):
        if user.IsWindowVisible(hwnd):
            length = user.GetWindowTextLengthW(hwnd)
            if length:
                title = ctypes.create_unicode_buffer(length + 1)
                user.GetWindowTextW(hwnd, title, len(title))
                pid = wintypes.DWORD()
                user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                result.append(dict(hwnd=int(hwnd), title=title.value, pid=pid.value))
        return True

    user.EnumWindows(callback_type(visit), 0)
    return result


class WindowTarget:
    def __init__(self, hwnd, keys):
        self.user = windows_api()
        self.hwnd = int(hwnd)
        self.keys = keys
        pid = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(self.hwnd, ctypes.byref(pid))
        self.pid = pid.value

    def exists(self):
        pid = wintypes.DWORD()
        self.user.GetWindowThreadProcessId(self.hwnd, ctypes.byref(pid))
        return bool(self.user.IsWindow(self.hwnd) and pid.value == self.pid)

    def focused(self):
        return self.exists() and self.user.GetForegroundWindow() == self.hwnd and not self.user.IsIconic(self.hwnd)

    def held(self):
        return [key for key in self.keys if any(self.user.GetAsyncKeyState(vk) & 0x8000 for vk in NAMED_KEYS[key])]

    def bounds(self):
        rect, point = wintypes.RECT(), wintypes.POINT()
        if not self.user.GetClientRect(self.hwnd, ctypes.byref(rect)) or not self.user.ClientToScreen(self.hwnd, ctypes.byref(point)):
            raise OSError("Cannot read target window bounds")
        return (point.x, point.y, point.x + rect.right, point.y + rect.bottom)


class KeyboardObserver:
    """Dedicated hook message loop. Never suppresses or injects input."""
    def __init__(self, target, on_key, on_control):
        self.target = target
        self.on_key = on_key
        self.on_control = on_control
        self.ready = threading.Event()
        self.failure = None
        self.thread_id = None
        self.hotkeys_down = set()
        self.thread = threading.Thread(target=self._run, name="demo-keyboard", daemon=True)

    def start(self):
        self.thread.start()
        if not self.ready.wait(5):
            raise RuntimeError("Keyboard listener did not start")
        if self.failure:
            raise RuntimeError(self.failure)

    def _run(self):
        user = windows_api()
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentThreadId.restype = wintypes.DWORD
        kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        kernel.GetModuleHandleW.restype = wintypes.HMODULE
        self.thread_id = kernel.GetCurrentThreadId()
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

        class KeyData(ctypes.Structure):
            _fields_ = [("vk", wintypes.DWORD), ("scan", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("extra", ctypes.c_size_t)]

        user.SetWindowsHookExW.argtypes = [ctypes.c_int, callback_type, wintypes.HINSTANCE, wintypes.DWORD]
        user.SetWindowsHookExW.restype = wintypes.HANDLE
        user.CallNextHookEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user.CallNextHookEx.restype = ctypes.c_ssize_t
        user.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
        user.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        user.GetMessageW.restype = wintypes.BOOL
        user.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        names = {vk: key for key in self.target.keys for vk in NAMED_KEYS[key]}

        def callback(code, message, pointer):
            try:
                if code >= 0 and message in (0x100, 0x101, 0x104, 0x105):
                    event = ctypes.cast(pointer, ctypes.POINTER(KeyData)).contents
                    down = message in (0x100, 0x104)
                    if not event.flags & 0x10:  # ignore program-generated events
                        if event.vk in (0x77, 0x78):  # F8 / F9, never training labels
                            if down and event.vk not in self.hotkeys_down:
                                self.on_control("pause" if event.vk == 0x77 else "stop")
                            if down:
                                self.hotkeys_down.add(event.vk)
                            else:
                                self.hotkeys_down.discard(event.vk)
                        elif event.vk in names:
                            name = names[event.vk]
                            # Keep a generic modifier down while its other side is held.
                            still_held = not down and any(
                                vk != event.vk and user.GetAsyncKeyState(vk) & 0x8000
                                for vk in NAMED_KEYS[name])
                            if not still_held:
                                self.on_key(name, down, native_time_ms=int(event.time), scan_code=int(event.scan))
            except Exception as exc:
                self.failure = f"Keyboard callback failed: {exc}"
                self.on_control("stop")
            return user.CallNextHookEx(None, code, message, pointer)

        self.callback = callback_type(callback)
        hook = None
        try:
            msg = wintypes.MSG()
            user.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)  # create queue before announcing ready
            hook = user.SetWindowsHookExW(13, self.callback, kernel.GetModuleHandleW(None), 0)
            if not hook:
                raise ctypes.WinError(ctypes.get_last_error())
            self.ready.set()
            while True:
                result = user.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if result == 0:
                    break
                if result == -1:
                    raise ctypes.WinError(ctypes.get_last_error())
                user.TranslateMessage(ctypes.byref(msg))
                user.DispatchMessageW(ctypes.byref(msg))
        except Exception as exc:
            self.failure = f"Keyboard listener: {exc}"
        finally:
            if hook:
                user.UnhookWindowsHookEx(hook)
            self.ready.set()

    def close(self):
        if self.thread_id and self.thread.is_alive():
            user = windows_api()
            user.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user.PostThreadMessageW(self.thread_id, 0x12, 0, 0)
            self.thread.join(timeout=3)
            if self.thread.is_alive():
                raise RuntimeError("Keyboard listener did not stop")


class DXcamSource:
    def __init__(self):
        self.camera = None
        self.bounds = None
        self.latest = None
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.thread = None
        self.failure = None
        self.frame_id = 0

    def configure(self, bounds):
        if self.bounds == bounds and self.camera is not None:
            return
        self.close()
        import dxcam
        left, top, right, bottom = bounds
        chosen = None
        # Pinned DXcam 0.3.0: match absolute monitor geometry, not DISPLAY index.
        for device_index, outputs in enumerate(dxcam.__dict__["__factory"].outputs):
            for output_index, output in enumerate(outputs):
                output.update_desc()
                rect = output.desc.DesktopCoordinates
                if rect.left <= left < right <= rect.right and rect.top <= top < bottom <= rect.bottom:
                    chosen = device_index, output_index, (left - rect.left, top - rect.top,
                                                           right - rect.left, bottom - rect.top)
                    break
            if chosen:
                break
        if chosen is None:
            raise ValueError("Keep the entire game client area on one monitor")
        device, output, region = chosen
        self.camera = dxcam.create(device_idx=device, output_idx=output, output_color="BGR", max_buffer_len=2)
        self.bounds = bounds
        self.failure = None
        self.stopped.clear()
        self.camera.start(region=region, target_fps=60, video_mode=True)
        self.thread = threading.Thread(target=self._receive, name="demo-capture", daemon=True)
        self.thread.start()

    def _receive(self):
        try:
            while not self.stopped.is_set():
                result = self.camera.get_latest_frame(with_timestamp=True)
                if result is None:
                    if not self.stopped.is_set():
                        raise RuntimeError("Capture stream ended")
                    break
                frame, timestamp = result
                received_ns = time.perf_counter_ns()
                with self.lock:
                    self.frame_id += 1
                    # DXGI LastPresentTime and Python perf_counter share Windows QPC.
                    self.latest = (frame, round(timestamp * 1e9), received_ns, self.frame_id)
        except Exception as exc:
            self.failure = f"Screen capture: {exc}"

    def read(self):
        if self.failure:
            raise RuntimeError(self.failure)
        with self.lock:
            return self.latest

    def close(self):
        self.stopped.set()
        try:
            if self.camera is not None:
                self.camera.stop()
            if self.thread is not None:
                self.thread.join(timeout=3)
                if self.thread.is_alive():
                    raise RuntimeError("Capture receiver did not stop")
        finally:
            if self.camera is not None:
                self.camera.release()
                self.camera = None
            self.thread = None
            self.bounds = None
            with self.lock:
                self.latest = None
