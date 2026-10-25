"""Read-only, non-activating recording status window."""
import ctypes
from ctypes import wintypes

from gameplay_windows import windows_api


WDA_EXCLUDEFROMCAPTURE = 0x11
OVERLAY_STYLES = 0x08000000 | 0x00000080 | 0x00000020 | 0x00080000


class OverlayWindow:
    def __init__(self, widget):
        self.user = windows_api()
        self.user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        self.user.GetAncestor.restype = wintypes.HWND
        self.hwnd = self.user.GetAncestor(widget.winfo_id(), 2)
        self.user.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        self.user.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        self.user.SetWindowLongPtrW.restype = ctypes.c_ssize_t
        self.user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                          ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        self.user.SetWindowDisplayAffinity.argtypes = [wintypes.HWND, wintypes.DWORD]
        self.user.GetWindowDisplayAffinity.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        # Detach the owner so minimizing the main window does not hide the HUD.
        if self.user.GetWindowLongPtrW(self.hwnd, -8):
            self._set_long(-8, 0)
        self._set_long(-20, (self.styles() | OVERLAY_STYLES) & ~0x00040000)
        if not self.user.SetWindowDisplayAffinity(self.hwnd, WDA_EXCLUDEFROMCAPTURE):
            raise ctypes.WinError(ctypes.get_last_error())
        if self.affinity() != WDA_EXCLUDEFROMCAPTURE:
            raise RuntimeError("当前 Windows 不支持将悬浮窗排除在录制之外")

    def _set_long(self, index, value):
        ctypes.set_last_error(0)
        if not self.user.SetWindowLongPtrW(self.hwnd, index, value) and ctypes.get_last_error():
            raise ctypes.WinError(ctypes.get_last_error())

    def styles(self):
        return self.user.GetWindowLongPtrW(self.hwnd, -20)

    def affinity(self):
        value = wintypes.DWORD()
        if not self.user.GetWindowDisplayAffinity(self.hwnd, ctypes.byref(value)):
            raise ctypes.WinError(ctypes.get_last_error())
        return value.value

    def position(self, x, y, width, height):
        # HWND_TOPMOST, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED.
        if not self.user.SetWindowPos(self.hwnd, wintypes.HWND(-1), x, y, width, height, 0x70):
            raise ctypes.WinError(ctypes.get_last_error())


class StatusOverlay:
    WIDTH, HEIGHT = 386, 48
    COLORS = dict(recording="#7de0aa", paused="#f3c56b", waiting="#b5c1b9",
                  saving="#c5d6f5", saved="#7de0aa", error="#ff9991")

    def __init__(self, parent):
        import tkinter as tk
        self.window = tk.Toplevel(parent)
        self.window.withdraw()
        try:
            self.window.overrideredirect(True)
            self.window.configure(bg="#243b30")
            self.window.attributes("-alpha", .96)
            self.window.geometry(f"{self.WIDTH}x{self.HEIGHT}+0+0")
            self.state = tk.Label(self.window, text="● 准备中", bg="#243b30", fg="#b5c1b9",
                                  font=("Microsoft YaHei UI", 11, "bold"), anchor="w")
            self.state.pack(side="left", padx=(15, 8), fill="y", expand=True)
            self.fps = tk.Label(self.window, text="0.0 Hz", bg="#243b30", fg="#f5f3ed",
                                font=("Segoe UI", 12), width=8)
            self.fps.pack(side="left", fill="y")
            self.duration = tk.Label(self.window, text="00:00", bg="#243b30", fg="#f5f3ed",
                                     font=("Consolas", 12), width=8)
            self.duration.pack(side="left", padx=(4, 12), fill="y")
            self.window.update_idletasks()
            self.native = OverlayWindow(self.window)
            self.visible = False
            self.last_bounds = None
        except Exception:
            self.window.destroy()
            raise

    def update(self, snapshot, bounds):
        self.state.configure(text="● " + snapshot["label"], fg=self.COLORS[snapshot["state"]])
        self.fps.configure(text=f"{snapshot['fps']:.1f} Hz")
        self.duration.configure(text=snapshot["duration"])
        if not self.visible:
            self.window.deiconify()
            self.visible = True
        # Native coordinates also work on monitors to the left of the primary.
        if bounds is not None:
            self.last_bounds = bounds
        left, top, right, _ = self.last_bounds or (0, 0, self.window.winfo_screenwidth(), 0)
        x, y = max(left + 8, right - self.WIDTH - 12), top + 12
        self.native.position(x, y, self.WIDTH, self.HEIGHT)

    def close(self):
        self.window.destroy()
