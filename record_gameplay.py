"""Local 20 Hz gameplay video + keyboard demonstration recorder."""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from collections import deque
from pathlib import Path

from gameplay_recording import Cadence, DEFAULT_KEYS, RecordingSession, validate_session
from gameplay_windows import DXcamSource, KeyboardObserver, WindowTarget, enable_dpi_awareness, list_windows, parse_keys


DEFAULT_OUTPUT = Path(__file__).resolve().parent / "shared_data" / "gameplay_recordings"


class Recorder:
    def __init__(self, window, output, keys, *, fps=20, duration=0, segment_seconds=60):
        self.window, self.output, self.keys = window, Path(output), keys
        self.fps, self.duration, self.segment_seconds = fps, duration, segment_seconds
        self.stop_event = threading.Event()
        self.paused = threading.Event()
        self.finished = threading.Event()
        self.session = None
        self.error = None
        self.status = "正在准备"
        self.preview = None
        self.sample_times = deque(maxlen=60)
        self.thread = None
        self._scope_lock = threading.RLock()

    def start(self):
        self.thread = threading.Thread(target=self.run, name="demo-recorder", daemon=True)
        self.thread.start()

    def control(self, action):
        with self._scope_lock:
            if action == "stop":
                self.stop_event.set()
                if self.session and not self.session.closed:
                    self.session.timeline.gate(False, "stopping")
            elif action == "pause":
                if self.paused.is_set():
                    self.paused.clear()
                else:
                    self.paused.set()
                    if self.session and not self.session.closed:
                        self.session.timeline.gate(False, "manual_pause")

    def _gate(self, target):
        with self._scope_lock:
            active = target.focused() and not self.paused.is_set() and not self.stop_event.is_set()
            reason = ("recording" if active else "stopping" if self.stop_event.is_set()
                      else "manual_pause" if self.paused.is_set() else "window_unfocused")
            held = target.held() if active and not self.session.timeline.active else ()
            self.session.timeline.gate(active, reason, held)
            return active

    def _on_key(self, target, name, down, **extra):
        with self._scope_lock:
            if self._gate(target):
                self.session.timeline.key(name, down, **extra)

    def run(self):
        source, observer = None, None
        try:
            target = WindowTarget(self.window["hwnd"], self.keys)
            self.session = RecordingSession(self.output, fps=self.fps, keys=self.keys,
                                            segment_seconds=self.segment_seconds,
                                            metadata=dict(window=self.window, backend="dxcam-0.3.0",
                                                          input="WH_KEYBOARD_LL", synthetic=False))

            def on_key(name, down, **extra):
                self._on_key(target, name, down, **extra)

            observer = KeyboardObserver(target, on_key, self.control)
            observer.start()
            source = DXcamSource()
            cadence = Cadence(self.fps, time.perf_counter_ns())
            started = time.monotonic()
            waiting_since = None
            while not self.stop_event.is_set():
                if self.duration and time.monotonic() - started >= self.duration:
                    break
                if not target.exists():
                    self.session.diagnostic("target_closed")
                    break
                if self.session.failure or observer.failure:
                    raise RuntimeError(self.session.failure or observer.failure)
                if self._gate(target):
                    bounds = target.bounds()
                    source.configure(bounds)
                    read_begin = time.perf_counter_ns()
                    result = source.read()
                    read_end = time.perf_counter_ns()
                    if result is not None:
                        image, presented, received, source_id = result
                        if read_end - received > 500_000_000:
                            raise RuntimeError("Screen capture stopped delivering frames")
                        if not 0 < presented <= received + 100_000_000:
                            raise RuntimeError("DXcam timestamp is incompatible with the monotonic clock")
                        # Moving/resizing/focus changes invalidate an in-flight screen crop.
                        if self._gate(target) and target.bounds() == bounds:
                            self.session.frame(image, sample_ns=read_end, read_begin_ns=read_begin,
                                               read_end_ns=read_end, source_present_ns=presented,
                                               source_received_ns=received, source_frame_id=source_id,
                                               bounds=list(bounds))
                            self.sample_times.append(read_end)
                            self.preview = image
                            self.status = "录制中"
                            waiting_since = None
                    else:
                        waiting_since = waiting_since or time.monotonic()
                        if time.monotonic() - waiting_since > 5:
                            raise RuntimeError("No screen frames arrived within five seconds")
                        self.status = "等待画面"
                else:
                    source.close()
                    waiting_since = None
                    self.sample_times.clear()
                    self.status = "已暂停" if self.paused.is_set() else "等待游戏切到前台"
                skipped = cadence.advance(time.perf_counter_ns())
                if skipped:
                    self.session.counts["skipped_ticks"] += skipped
                    self.session.diagnostic("sampling_gap", skipped_ticks=skipped)
                self.stop_event.wait(max(0, (cadence.deadline_ns - time.perf_counter_ns()) / 1e9))
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.control("stop")
            for resource in (observer, source):
                if resource:
                    try:
                        resource.close()
                    except Exception as exc:
                        self.error = self.error or str(exc)
                    self.error = self.error or getattr(resource, "failure", None)
            if self.session:
                self.session.close(error=self.error)
                self.error = self.error or self.session.failure
            self.status = "录制失败" if self.error else "已保存"
            self.finished.set()

    def actual_fps(self):
        values = self.sample_times.copy()
        return (len(values) - 1) * 1e9 / (values[-1] - values[0]) if len(values) > 1 else 0.0


def self_test(output, seconds=4):
    """Exercises real encoding and timing with generated pixels and key events."""
    import cv2
    import numpy as np
    session = RecordingSession(output, keys=["left", "right", "space"],
                               segment_seconds=1, metadata=dict(synthetic=True, backend="generated"))
    started = time.perf_counter_ns()
    cadence = Cadence(20, started)
    stage = -1
    try:
        while (time.perf_counter_ns() - started) / 1e9 < seconds:
            now = time.perf_counter_ns()
            elapsed = (now - started) / 1e9
            next_stage = min(4, int(elapsed / max(seconds / 5, .05)))
            if next_stage != stage:
                stage = next_stage
                if stage == 0:
                    session.timeline.gate(True, "recording")
                    session.timeline.key("right", True)
                elif stage == 1:
                    session.timeline.key("space", True)
                    session.timeline.key("space", False)  # tap shorter than a frame
                elif stage == 2:
                    session.timeline.gate(False, "manual_pause")
                elif stage == 3:
                    session.timeline.gate(True, "recording", ["left"])
                elif stage == 4:
                    session.timeline.key("left", False)
            image = np.zeros((181, 321, 3), dtype=np.uint8)
            cv2.rectangle(image, (int(elapsed * 45) % 270, 70), (int(elapsed * 45) % 270 + 35, 110), (50, 190, 120), -1)
            cv2.putText(image, f"20 Hz demo {elapsed:.2f}s", (12, 25), cv2.FONT_HERSHEY_SIMPLEX, .5, (240, 240, 240), 1)
            sample = time.perf_counter_ns()
            session.frame(image, sample_ns=sample, read_begin_ns=now, read_end_ns=sample,
                          source_present_ns=now, source_received_ns=sample)
            session.counts["skipped_ticks"] += cadence.advance(time.perf_counter_ns())
            time.sleep(max(0, (cadence.deadline_ns - time.perf_counter_ns()) / 1e9))
    finally:
        session.close()
    report = validate_session(session.directory)
    report["directory"] = str(session.directory)
    return report


def gui(output):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from PIL import Image, ImageTk

    root = tk.Tk()
    root.title("操作录制")
    root.geometry("600x480")
    root.minsize(520, 440)
    root.configure(bg="#f5f3ed")
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure("TFrame", background="#f5f3ed")
    style.configure("TLabel", background="#f5f3ed", foreground="#2f3932")
    style.configure("TButton", padding=6)
    panel = ttk.Frame(root, padding=18)
    panel.pack(fill="both", expand=True)
    panel.columnconfigure(1, weight=1)
    ttk.Label(panel, text="游戏操作录制", font=("Microsoft YaHei UI", 16, "bold")).grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 14))
    ttk.Label(panel, text="游戏窗口").grid(row=1, column=0, sticky="w")
    window_choice = ttk.Combobox(panel, state="readonly")
    window_choice.grid(row=1, column=1, sticky="ew", padx=8)
    windows = []
    recorder = None
    closing = False

    def refresh():
        nonlocal windows
        windows = [w for w in list_windows() if w["pid"] != os.getpid()]
        windows.sort(key=lambda w: (not any(t in w["title"].lower() for t in ("maplestory", "冒险岛", "artale")), w["title"]))
        window_choice["values"] = [f"{w['title']}  [{w['hwnd']}]" for w in windows]
        window_choice.set("")

    refresh_button = ttk.Button(panel, text="刷新", command=refresh)
    refresh_button.grid(row=1, column=2)
    ttk.Label(panel, text="录制按键").grid(row=2, column=0, sticky="w", pady=10)
    keys_var = tk.StringVar(value=DEFAULT_KEYS)
    keys_entry = ttk.Entry(panel, textvariable=keys_var)
    keys_entry.grid(row=2, column=1, columnspan=2, sticky="ew", padx=(8, 0))
    output_var = tk.StringVar(value=str(output))
    ttk.Label(panel, text="保存位置").grid(row=3, column=0, sticky="w")
    output_entry = ttk.Entry(panel, textvariable=output_var)
    output_entry.grid(row=3, column=1, sticky="ew", padx=8)

    def choose_folder():
        selected = filedialog.askdirectory(parent=root)
        if selected:
            output_var.set(selected)

    folder_button = ttk.Button(panel, text="选择", command=choose_folder)
    folder_button.grid(row=3, column=2)
    preview = ttk.Label(panel, text="选择游戏窗口后开始录制", anchor="center")
    preview.grid(row=4, column=0, columnspan=3, sticky="nsew", pady=12)
    panel.rowconfigure(4, weight=1)
    status_var = tk.StringVar(value="就绪 · 20 Hz")
    ttk.Label(panel, textvariable=status_var).grid(row=5, column=0, columnspan=3, sticky="w")
    ttk.Label(panel, text="F8 暂停 / 继续    F9 停止保存").grid(row=6, column=0, columnspan=3, sticky="w", pady=(4, 8))
    buttons = ttk.Frame(panel)
    buttons.grid(row=7, column=0, columnspan=3, sticky="ew")

    def start():
        nonlocal recorder
        try:
            index = window_choice.current()
            if index < 0:
                raise ValueError("请先选择游戏窗口")
            keys = parse_keys(keys_var.get())
            recorder = Recorder(windows[index], output_var.get(), keys)
            recorder.start()
            start_button.configure(state="disabled")
            for widget in (window_choice, keys_entry, output_entry, refresh_button, folder_button):
                widget.configure(state="disabled")
            pause_button.configure(state="normal")
            stop_button.configure(state="normal")
        except Exception as exc:
            messagebox.showerror("无法开始", str(exc), parent=root)

    def open_folder():
        path = recorder.session.directory if recorder and recorder.session else Path(output_var.get())
        path.mkdir(parents=True, exist_ok=True)
        os.startfile(path)

    start_button = ttk.Button(buttons, text="开始录制", command=start)
    start_button.pack(side="left")
    pause_button = ttk.Button(buttons, text="暂停 / 继续", command=lambda: recorder.control("pause"), state="disabled")
    pause_button.pack(side="left", padx=8)
    stop_button = ttk.Button(buttons, text="停止保存", command=lambda: recorder.control("stop"), state="disabled")
    stop_button.pack(side="left")
    ttk.Button(buttons, text="打开文件夹", command=open_folder).pack(side="right")
    last_finished = None

    def update():
        nonlocal last_finished
        if recorder:
            count = recorder.session.counts if recorder.session else {}
            status_var.set(f"{recorder.status} · {recorder.actual_fps():.1f} Hz · {count.get('written', 0)} 帧 · 丢帧 {count.get('dropped', 0)}")
            if recorder.preview is not None:
                image = Image.fromarray(recorder.preview[:, :, ::-1])
                image.thumbnail((540, 235))
                preview.image = ImageTk.PhotoImage(image)
                preview.configure(image=preview.image, text="")
            if recorder.finished.is_set() and last_finished is not recorder:
                last_finished = recorder
                start_button.configure(state="normal")
                window_choice.configure(state="readonly")
                for widget in (keys_entry, output_entry, refresh_button, folder_button):
                    widget.configure(state="normal")
                pause_button.configure(state="disabled")
                stop_button.configure(state="disabled")
                if recorder.error:
                    messagebox.showerror("录制失败", recorder.error, parent=root)
        if closing and (not recorder or recorder.finished.is_set()):
            root.destroy()
        else:
            root.after(200, update)

    def close():
        nonlocal closing
        closing = True
        if recorder and not recorder.finished.is_set():
            recorder.control("stop")
            status_var.set("正在保存")

    root.protocol("WM_DELETE_WINDOW", close)
    refresh()
    update()
    root.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--list-windows", action="store_true")
    parser.add_argument("--window", help="Unique title substring")
    parser.add_argument("--hwnd", type=lambda text: int(text, 0))
    parser.add_argument("--keys", default=DEFAULT_KEYS)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--duration", type=float, default=0, help="Stop after this many seconds; 0 means manual stop")
    parser.add_argument("--segment-seconds", type=float, default=60)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--validate", type=Path)
    args = parser.parse_args()
    if args.duration < 0 or args.segment_seconds <= 0 or not 1 <= args.fps <= 60:
        parser.error("duration must be nonnegative, segment-seconds positive, and fps between 1 and 60")
    if args.validate:
        result = validate_session(args.validate)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if args.self_test:
        result = self_test(args.output, args.duration or 4)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    enable_dpi_awareness()
    if args.list_windows:
        print(json.dumps(list_windows(), ensure_ascii=False, indent=2))
        return 0
    if args.window or args.hwnd:
        candidates = [window for window in list_windows() if
                      (window["hwnd"] == args.hwnd if args.hwnd is not None
                       else args.window.lower() in window["title"].lower())]
        if len(candidates) != 1:
            parser.error("Select exactly one window; use --list-windows and --hwnd")
        recorder = Recorder(candidates[0], args.output, parse_keys(args.keys), fps=args.fps,
                            duration=args.duration, segment_seconds=args.segment_seconds)
        recorder.start()
        try:
            while not recorder.finished.wait(1):
                print(f"{recorder.status} · {recorder.actual_fps():.1f} Hz", flush=True)
        except KeyboardInterrupt:
            recorder.control("stop")
            recorder.finished.wait(35)
        if recorder.session:
            print(recorder.session.directory)
        if recorder.error:
            print(recorder.error)
        return 1 if recorder.error or not recorder.finished.is_set() else 0
    gui(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
