"""Visible-screen shop browsing MVP. No packets are sent by this program.

Preview: --image screenshot.png; live run: --run (F8 starts, F9 stops).
The player must already be standing near the shops; no walking is attempted.
"""
import argparse
import ctypes
import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT/'tools/market_bot_vendor'))
import cv2
import numpy as np
from PIL import Image, ImageDraw

ASSETS = ROOT/'tools/market_bot_templates'


def matches(frame, template, threshold):
    if frame.shape[0] < template.shape[0] or frame.shape[1] < template.shape[1]:
        return []
    scores = cv2.matchTemplate(frame, template, cv2.TM_CCOEFF_NORMED)
    out = []
    for _ in range(80):
        _, score, _, pos = cv2.minMaxLoc(scores)
        if score < threshold:
            break
        x, y = pos
        h, w = template.shape[:2]
        out.append((x, y, w, h, float(score)))
        scores[max(0,y-h):y+h+1, max(0,x-w):x+w+1] = -1
    return out


class Vision:
    def __init__(self):
        self.templates = {name: np.asarray(Image.open(ASSETS/f'{name}.png').convert('RGB'))
                          for name in ('coin_small', 'coin_large', 'leave', 'owner')}

    def inspect(self, image):
        frame = np.asarray(image.convert('RGB'))
        leave = matches(frame, self.templates['leave'], .94)
        owner = matches(frame, self.templates['owner'], .94)
        candidates = []
        if not leave and not owner:
            for name in ('coin_small', 'coin_large'):
                for x,y,w,h,score in matches(frame, self.templates[name], .94):
                    # The coin sits at the lower-left of a title bubble. Click
                    # inside its text area, away from the controls at its bottom.
                    point = (x+40, y-20)
                    if x < 155 or y < 65 or y > image.height-105:
                        continue
                    if not 0 < point[0] < image.width-40 or point[1] < 35:
                        continue
                    if not any(abs(point[0]-c['x'])<25 and abs(point[1]-c['y'])<25 for c in candidates):
                        candidates.append(dict(x=point[0], y=point[1], score=round(score,4)))
        return dict(owner=owner, leave=leave, targets=sorted(candidates, key=lambda c:(c['y']//60,c['x'])))


def save_preview(image, result, folder):
    marked = image.copy()
    draw = ImageDraw.Draw(marked)
    for i, p in enumerate(result['targets'], 1):
        x,y=p['x'],p['y']
        draw.rectangle((x-10,y-8,x+10,y+8),outline='red',width=2)
        draw.text((x+12,y-10), str(i), fill='red')
    marked.save(folder/'preview.png')
    (folder/'targets.json').write_text(json.dumps(result,indent=2),encoding='utf-8')


def run_live(vision, folder, limit):
    import pyautogui as gui
    from ctypes import wintypes
    user = ctypes.windll.user32
    user.FindWindowW.argtypes=[wintypes.LPCWSTR,wintypes.LPCWSTR]
    user.FindWindowW.restype=wintypes.HWND
    user.GetForegroundWindow.restype=wintypes.HWND
    user.GetClientRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]
    user.ClientToScreen.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.POINT)]
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
    hwnd=user.FindWindowW(None,'MapleStory')
    if not hwnd:
        raise RuntimeError('MapleStory window not found')
    gui.FAILSAFE=True
    gui.PAUSE=.08
    print('Focus MapleStory, then press F8 to start. F9 or mouse top-left stops.',flush=True)
    while not user.GetAsyncKeyState(0x77)&0x8000:
        if user.GetAsyncKeyState(0x78)&0x8000:
            return
        time.sleep(.05)

    def check():
        if user.GetAsyncKeyState(0x78)&0x8000:
            raise RuntimeError('Stopped with F9')
        if user.GetForegroundWindow()!=hwnd:
            raise RuntimeError('Game lost foreground; stopped')
        if gui.position().x==0 and gui.position().y==0:
            raise RuntimeError('Mouse failsafe')

    def pause(seconds):
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            check();time.sleep(.03)

    def capture():
        check()
        rect=wintypes.RECT();origin=wintypes.POINT(0,0)
        if not user.GetClientRect(hwnd,ctypes.byref(rect)) or not user.ClientToScreen(hwnd,ctypes.byref(origin)):
            raise RuntimeError('Cannot locate game client')
        if rect.right<600 or rect.bottom<450:
            raise RuntimeError('Game client is minimized or too small')
        return gui.screenshot(region=(origin.x,origin.y,rect.right,rect.bottom)), (origin.x,origin.y,rect.right,rect.bottom)

    def click(x,y,bounds,action):
        check()
        fresh,current=capture()
        if current!=bounds:
            raise RuntimeError('Window moved or resized; stopped')
        state=vision.inspect(fresh)
        if state['owner']:
            raise RuntimeError('Own shop appeared; stopped')
        if action=='open':
            valid=not state['leave'] and any(abs(x-p['x'])<4 and abs(y-p['y'])<4 for p in state['targets'])
        else:
            valid=len(state['leave'])==1 and abs(x-(state['leave'][0][0]+state['leave'][0][2]//2))<4 and abs(y-(state['leave'][0][1]+state['leave'][0][3]//2))<4
        if not valid:
            raise RuntimeError('Target changed before click; stopped')
        gui.moveTo(bounds[0]+x+random.randint(-3,3),bounds[1]+y+random.randint(-2,2),duration=random.uniform(.12,.25))
        check();gui.click()

    seen=[]
    for index in range(limit):
        shot,bounds=capture();state=vision.inspect(shot)
        if state['owner'] or state['leave']:
            raise RuntimeError('A shop window is already open; close it manually first')
        targets=[p for p in state['targets'] if not any(abs(p['x']-x)<25 and abs(p['y']-y)<25 for x,y in seen)]
        if not targets:
            print('No more visible targets. Move manually and run again.',flush=True);return
        if index==0:save_preview(shot,state,folder)
        target=targets[0];seen.append((target['x'],target['y']))
        click(target['x'],target['y'],bounds,'open')
        deadline=time.monotonic()+3
        while True:
            pause(.15);opened,_=capture();state=vision.inspect(opened)
            if state['owner']:
                raise RuntimeError('Own shop detected; stopped without closing it')
            if len(state['leave'])==1:break
            if time.monotonic()>deadline:
                opened.save(folder/'stopped.png')
                raise RuntimeError('Shop did not open clearly; stopped (range/obstruction/dialog)')
        # No wait for packet collection. Only visible shop UI is required.
        pause(random.uniform(.15,.35))
        x,y,w,h,_=state['leave'][0]
        click(x+w//2,y+h//2,bounds,'close')
        deadline=time.monotonic()+2
        while True:
            pause(.15);closed,_=capture();state=vision.inspect(closed)
            if not state['leave'] and not state['owner'] and state['targets']:break
            if time.monotonic()>deadline:
                closed.save(folder/'stopped.png');raise RuntimeError('Shop close not confirmed; stopped')
        with (folder/'visits.jsonl').open('a',encoding='utf-8') as f:
            f.write(json.dumps(dict(time=time.time(),target=target,result='opened_and_closed'))+'\n')
        print(f'Visited {index+1}',flush=True)
        pause(random.uniform(.25,.55))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--image',type=Path,help='Offline screenshot preview; no input actions')
    group.add_argument('--run',action='store_true')
    parser.add_argument('--limit',type=int,default=5)
    args=parser.parse_args()
    if not 1<=args.limit<=30:parser.error('limit must be 1..30')
    folder=ROOT/'bot_runs'/time.strftime('%Y%m%d_%H%M%S');folder.mkdir(parents=True,exist_ok=True)
    vision=Vision()
    try:
        if args.image:
            image=Image.open(args.image).convert('RGB');result=vision.inspect(image)
            save_preview(image,result,folder);print(json.dumps(result));print(folder)
        else:run_live(vision,folder,args.limit)
    except (RuntimeError,KeyboardInterrupt) as error:
        print(f'STOPPED: {error}',flush=True)
        (folder/'stop.txt').write_text(str(error),encoding='utf-8')


if __name__=='__main__':main()
