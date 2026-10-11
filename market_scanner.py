"""Screenshot-only market collector. No process access or game injection."""
import argparse
import csv
import hashlib
import json
import re
import time
from datetime import datetime
from pathlib import Path

import pyautogui as gui
from rapidocr_onnxruntime import RapidOCR

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / 'market_config.json'
gui.FAILSAFE = True
gui.PAUSE = 0.25


def point(label):
    input(f'{label}：按 Enter，然后在 5 秒内把鼠标移到目标位置。')
    time.sleep(5)
    p = gui.position()
    print(f'已记录 {p.x}, {p.y}')
    return [p.x, p.y]


def calibrate():
    print('请先打开游戏市场，保持窗口位置、缩放和分辨率固定。')
    a = point('价格列表区域左上角')
    b = point('价格列表区域右下角')
    if b[0] <= a[0] or b[1] <= a[1]:
        raise ValueError('右下角必须位于左上角的右下方')
    nxt = point('下一页按钮中心')
    search = None
    if input('是否配置自动搜索？输入 y 启用：').strip().lower() == 'y':
        search = point('搜索输入框中心')
    data = dict(region=[*a, b[0]-a[0], b[1]-a[1]], next_page=nxt,
                search_box=search, screen_size=list(gui.size()),
                delay=2.5, row_tolerance=12)
    CONFIG.write_text(json.dumps(data, indent=2), encoding='utf-8')
    print(f'配置已保存：{CONFIG}')


def recognize(engine, shot, tolerance):
    import numpy as np
    result, _ = engine(np.asarray(shot))
    lines = []
    for box, text, confidence in result or []:
        x = min(p[0] for p in box)
        y = sum(p[1] for p in box) / len(box)
        lines.append((y, x, text, float(confidence)))
    rows = []
    for y, x, text, confidence in sorted(lines):
        if not rows or abs(y - rows[-1]['y']) > tolerance:
            rows.append(dict(y=y, cells=[]))
        rows[-1]['cells'].append((x, text, confidence))
    return [sorted(row['cells']) for row in rows]


def run(args):
    cfg = json.loads(CONFIG.read_text(encoding='utf-8'))
    if list(gui.size()) != cfg['screen_size']:
        raise ValueError('分辨率已变化，请重新校准')
    if args.pages < 1:
        raise ValueError('--pages 必须大于零')
    queries = ['']
    if args.items:
        if not cfg.get('search_box'):
            raise ValueError('请先校准搜索输入框')
        queries = [s.strip() for s in Path(args.items).read_text(encoding='utf-8-sig').splitlines() if s.strip()]
        if not queries:
            raise ValueError('物品列表为空')
    engine = RapidOCR()
    out = ROOT / 'captures' / datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    out.mkdir(parents=True)
    print('5 秒后开始，请切换到市场。鼠标移到屏幕左上角或 Ctrl+C 可停止。')
    time.sleep(5)
    with (out / 'observations.csv').open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(['time', 'query', 'page', 'row', 'ocr_text', 'numeric_candidates', 'min_confidence', 'needs_review', 'screenshot'])
        for qi, query in enumerate(queries):
            if query:
                # Windows clipboard supports Chinese search terms without keystroke encoding.
                import ctypes
                from ctypes import wintypes
                user = ctypes.WinDLL('user32', use_last_error=True)
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
                kernel.GlobalAlloc.restype = wintypes.HGLOBAL
                kernel.GlobalLock.argtypes = [wintypes.HGLOBAL]
                kernel.GlobalLock.restype = ctypes.c_void_p
                kernel.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
                kernel.GlobalFree.argtypes = [wintypes.HGLOBAL]
                user.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
                user.SetClipboardData.restype = wintypes.HANDLE
                data = (query + '\0').encode('utf-16-le')
                handle = kernel.GlobalAlloc(0x42, len(data))
                if not handle:
                    raise OSError('无法分配剪贴板内存')
                ptr = kernel.GlobalLock(handle)
                if not ptr:
                    kernel.GlobalFree(handle)
                    raise OSError('无法锁定剪贴板内存')
                ctypes.memmove(ptr, data, len(data))
                kernel.GlobalUnlock(handle)
                if not user.OpenClipboard(None):
                    kernel.GlobalFree(handle)
                    raise OSError('无法打开剪贴板')
                try:
                    if not user.EmptyClipboard() or not user.SetClipboardData(13, handle):
                        kernel.GlobalFree(handle)
                        raise OSError('无法写入剪贴板')
                finally:
                    user.CloseClipboard()
                gui.click(*cfg['search_box'])
                gui.hotkey('ctrl', 'a')
                gui.hotkey('ctrl', 'v')
                gui.press('enter')
            seen = set()
            for page in range(1, args.pages + 1):
                time.sleep(cfg['delay'])
                shot = gui.screenshot(region=tuple(cfg['region']))
                rows = recognize(engine, shot, cfg['row_tolerance'])
                if not rows:
                    shot.save(out / f'q{qi}_p{page}_empty.png')
                    print('未识别到内容，停止当前物品，避免盲目翻页。')
                    break
                signature = hashlib.sha256(json.dumps([[c[1] for c in r] for r in rows], ensure_ascii=False).encode()).hexdigest()
                if signature in seen:
                    print('页面内容重复，停止当前物品。')
                    break
                seen.add(signature)
                name = f'q{qi}_p{page}.png'
                shot.save(out / name)
                for ri, row in enumerate(rows, 1):
                    text = ' | '.join(c[1] for c in row)
                    numbers = re.findall(r'(?<!\w)\d[\d,，. ]*', text)
                    confidence = min(c[2] for c in row)
                    writer.writerow([datetime.now().astimezone().isoformat(), query, page, ri, text, ' | '.join(n.strip() for n in numbers), round(confidence, 4), True, name])
                f.flush()
                print(f'物品 {query or "当前列表"}，第 {page} 页：{len(rows)} 行')
                if page < args.pages:
                    gui.click(*cfg['next_page'])
    print(f'采集完成：{out}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--calibrate', action='store_true')
    parser.add_argument('--pages', type=int, default=3)
    parser.add_argument('--items', help='UTF-8 文本文件，每行一个搜索词')
    args = parser.parse_args()
    try:
        calibrate() if args.calibrate else run(args)
    except (KeyboardInterrupt, gui.FailSafeException):
        print('\n已停止，已采集数据保留。')
