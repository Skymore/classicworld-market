"""Opt-in desktop validation using only a generated window and no input hook."""
import time


def desktop_self_test():
    import numpy as np
    import tkinter as tk
    from gameplay_overlay import StatusOverlay, OVERLAY_STYLES
    from gameplay_windows import DXcamSource, WindowTarget, enable_dpi_awareness, windows_api

    enable_dpi_awareness()
    root = tk.Tk()
    root.title("录制悬浮窗自检（自动关闭）")
    root.geometry("640x280+80+100")
    root.configure(bg="#204080")
    root.attributes("-topmost", True)
    root.update()
    overlay, source = None, DXcamSource()
    try:
        bounds = WindowTarget(root.winfo_id(), []).bounds()
        user = windows_api()
        foreground = user.GetForegroundWindow()
        overlay = StatusOverlay(root)
        snapshot = dict(state="recording", label="录制中", fps=20.0, duration="03:24")
        overlay.update(snapshot, bounds)
        root.update()
        assert user.GetForegroundWindow() == foreground, "Overlay stole foreground focus"
        assert overlay.native.styles() & OVERLAY_STYLES == OVERLAY_STYLES, "Overlay style flags missing"
        assert overlay.native.affinity() == 0x11, "Overlay is not excluded from capture"
        source.configure(bounds)

        def capture():
            # Wait for compositor updates and a newly received capture frame.
            before = source.read()
            before_id = before[3] if before else 0
            deadline = time.monotonic() + 4
            first = time.monotonic()
            while time.monotonic() < deadline:
                root.update()
                result = source.read()
                if result is not None and result[3] > before_id and time.monotonic() - first > .3:
                    image, presented, received, _ = result
                    assert 0 < presented <= received + 100_000_000
                    return image
                time.sleep(.02)
            raise AssertionError("No fresh DXGI frame")

        def covered_pixels(image):
            x = max(8, image.shape[1] - overlay.WIDTH - 12)
            return image[16:50, x + 10:x + overlay.WIDTH - 10]

        expected = np.array([128, 64, 32])
        hidden = covered_pixels(capture())
        assert np.max(np.abs(hidden.astype(float) - expected)) <= 5, "HUD leaked into captured pixels"
        # Positive control: prove this crop really covers the visible HUD.
        assert overlay.native.user.SetWindowDisplayAffinity(overlay.native.hwnd, 0)
        shown = covered_pixels(capture())
        assert np.mean(np.abs(shown.astype(float) - expected)) > 10, "HUD positive control was not visible"
        assert overlay.native.user.SetWindowDisplayAffinity(overlay.native.hwnd, 0x11)
        assert np.max(np.abs(covered_pixels(capture()).astype(float) - expected)) <= 5
        for state, label in (("paused", "已暂停"), ("saving", "正在保存"), ("saved", "已保存"), ("error", "录制失败")):
            overlay.update(dict(state=state, label=label, fps=0.0, duration="03:24"), bounds)
            root.update()
            assert label in overlay.state.cget("text")
            assert user.GetForegroundWindow() == foreground
        root.iconify()
        root.update()
        assert user.IsWindowVisible(overlay.native.hwnd), "Minimizing controls hid the overlay"
        return dict(ok=True, capture_exclusion=True, no_focus_activation=True,
                    click_through_style=True, survives_minimize=True, state_updates=True)
    finally:
        source.close()
        if overlay:
            overlay.close()
        root.destroy()
