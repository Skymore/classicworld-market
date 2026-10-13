"""Visible-screen shop browsing MVP. No packets are sent by this program.

Preview: --image screenshot.png; live run: --run (F8 starts, F9 stops).
Optional recorded routes replay movement and climbing between marked shop rows.
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


MOVEMENT_KEYS={'left':0x25,'up':0x26,'right':0x27,'down':0x28,'alt':0x12,'space':0x20,'ctrl':0x11}


def validate_route(route):
    if route.get('version')!=1 or not isinstance(route.get('steps'),list):
        raise ValueError('Invalid route format')
    steps=route['steps']
    if not 1<=len(steps)<=1000:raise ValueError('Route must contain 1..1000 steps')
    total=0
    if not any(s.get('action')=='scan' for s in steps):raise ValueError('Route needs a scan checkpoint')
    for step in steps:
        if step.get('action')=='scan':
            if not isinstance(step.get('y'),int) or not 35<=step['y']<=2000:raise ValueError('Invalid scan row')
        elif step.get('action')=='move':
            keys=step.get('keys');duration=step.get('seconds')
            if not isinstance(keys,list) or not keys or any(k not in MOVEMENT_KEYS for k in keys) or len(set(keys))!=len(keys):raise ValueError('Invalid movement keys')
            if ('left' in keys and 'right' in keys) or ('up' in keys and 'down' in keys):raise ValueError('Opposing movement keys')
            if not isinstance(duration,(float,int)) or not 0<duration<=10:raise ValueError('Invalid movement duration')
            total+=duration
        elif step.get('action')=='wait':
            duration=step.get('seconds')
            if not isinstance(duration,(float,int)) or not 0<duration<=10:raise ValueError('Invalid wait duration')
            total+=duration
        else:raise ValueError('Unknown route action')
    if total>600:raise ValueError('Route movement exceeds ten minutes')
    size=route.get('client_size')
    if not isinstance(size,list) or len(size)!=2 or any(not isinstance(v,int) or v<1 for v in size):raise ValueError('Missing client size')
    return route


def run_live(vision, folder, limit, route=None, record_path=None, navigation=None, calibrate_resource=None, calibration_output=None, navigation_test=False, position_path=None, capture_folder=None):
    def startup(stage):
        (folder/'startup.json').write_text(json.dumps(dict(stage=stage,time=time.time())),encoding='utf-8')
    startup('loading_keyboard_and_screenshot_backend')
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
    if calibrate_resource or navigation_test:
        startup('waiting_for_game_foreground')
        print('Switch to MapleStory. Starting after 3 seconds in foreground. F9 cancels.',flush=True)
        focused_since=None
        deadline=time.monotonic()+120
        while True:
            if user.GetAsyncKeyState(0x78)&0x8000:return
            now=time.monotonic()
            if now>deadline:raise RuntimeError('Game was not focused within 120 seconds; restart calibration')
            if user.GetForegroundWindow()==hwnd:
                if focused_since is None:
                    focused_since=now;startup('foreground_countdown')
                    print('Game focused: capturing in 3 seconds...',flush=True)
                if now-focused_since>=3:break
            else:focused_since=None
            time.sleep(.05)
    else:
        startup('waiting_for_f8')
        print('Focus MapleStory, then press F8 to start. F9 or mouse top-left stops.',flush=True)
        while not user.GetAsyncKeyState(0x77)&0x8000:
            if user.GetAsyncKeyState(0x78)&0x8000:
                return
            time.sleep(.05)
    startup('started')

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
        check()
        if action=='open':gui.doubleClick(interval=.12)
        else:gui.click()

    def log(**event):
        with (folder/'visits.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(dict(time=time.time(),**event))+'\n')

    def release(keys):
        # Key-up must still execute after a mouse-corner failsafe or focus loss.
        previous=gui.FAILSAFE
        try:
            gui.FAILSAFE=False
            from market_keyboard import send_key
            for key in keys:send_key(key,False)
        finally:gui.FAILSAFE=previous

    def pulse(keys,seconds):
        previous_pause=gui.PAUSE
        try:
            gui.PAUSE=0
            from market_keyboard import send_key
            jump=next((key for key in keys if key in ('space','alt','ctrl')),None)
            if 'up' in keys and jump:
                check();send_key('up',True)
                pause(.08)
                check();send_key(jump,True)
                pause(.12)
                send_key(jump,False)
                pause(max(seconds,.35))
            else:
                for key in keys:check();send_key(key,True)
                pause(seconds)
        finally:
            release(list(reversed(keys)))
            gui.PAUSE=previous_pause

    if calibrate_resource:
        from market_navigation_live import calibrate
        startup('capturing_calibration')
        shot,_=capture()
        state=vision.inspect(shot)
        if state['owner'] or state['leave']:raise RuntimeError('Close the shop before calibration')
        startup('automatic_calibration')
        calibrate(shot,json.loads(calibrate_resource.read_text(encoding='utf-8')),calibration_output)
        startup('calibration_saved')
        print(f'Calibration saved: {calibration_output}',flush=True)
        return

    if record_path:
        start,bounds=capture();start.save(record_path.with_suffix('.start.png'))
        steps=[];active=[];since=time.monotonic();was_mark=False
        print('Recording: move/climb manually. Release movement keys, hover a shop title and press F7 to mark a row. F9 saves. Only arrows and Alt are recorded.',flush=True)
        def append_motion(keys,seconds):
            while seconds>.02:
                chunk=min(seconds,10)
                steps.append(dict(action='move',keys=keys,seconds=round(chunk,3)) if keys else dict(action='wait',seconds=round(chunk,3)))
                seconds-=chunk
        try:
            while True:
                now=time.monotonic()
                if user.GetAsyncKeyState(0x78)&0x8000:
                    append_motion(active,now-since);break
                check()
                keys=[k for k,v in MOVEMENT_KEYS.items() if user.GetAsyncKeyState(v)&0x8000]
                if keys!=active:
                    append_motion(active,now-since);active=keys;since=now
                mark=bool(user.GetAsyncKeyState(0x76)&0x8000)
                if mark and not was_mark:
                    if keys:raise RuntimeError('Release movement keys before F7 checkpoint')
                    shot,current=capture()
                    if current!=bounds:raise RuntimeError('Window changed while recording')
                    state=vision.inspect(shot)
                    if state['owner'] or state['leave']:raise RuntimeError('Close shop before recording a checkpoint')
                    y=int(gui.position().y-bounds[1])
                    if not any(abs(p['y']-y)<=40 for p in state['targets']):raise RuntimeError('Hover a visible shop title before F7')
                    append_motion([],now-since);since=now
                    steps.append(dict(action='scan',y=y));print(f'Checkpoint {sum(x["action"]=="scan" for x in steps)}',flush=True)
                was_mark=mark
                if now-since>10:append_motion(active,now-since);since=now
                if len(steps)>990:raise RuntimeError('Route recording is too long')
                time.sleep(.02)
            recorded=validate_route(dict(version=1,client_size=list(bounds[2:]),steps=steps))
            record_path.write_text(json.dumps(recorded,indent=2),encoding='utf-8')
            print(f'Saved route: {record_path}',flush=True)
        except Exception:
            (folder/'route_incomplete.json').write_text(json.dumps(steps,indent=2),encoding='utf-8');raise
        return

    visited=0
    def scan_row(row_y=None,eligible=None,on_visit=None):
      nonlocal visited
      seen=[]
      for index in range(limit-visited):
        shot,bounds=capture();state=vision.inspect(shot)
        if state['owner'] or state['leave']:
            raise RuntimeError('A shop window is already open; close it manually first')
        targets=[p for p in state['targets'] if (row_y is None or abs(p['y']-row_y)<=40) and (eligible is None or eligible(p)) and not any(abs(p['x']-x)<25 and abs(p['y']-y)<25 for x,y in seen)]
        if not targets:
            log(result='row_complete',row_y=row_y);return
        if index==0:save_preview(shot,state,folder)
        target=targets[0];seen.append((target['x'],target['y']))
        receipt=None
        if capture_folder:
            from market_scan_receipt import CaptureReceipt
            receipt=CaptureReceipt(capture_folder)
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
        collected=None
        if receipt:
            deadline=time.monotonic()+5
            while collected is None:
                collected=receipt.poll()
                if collected is not None:break
                if time.monotonic()>deadline:
                    raise RuntimeError('Shop UI opened but no complete price capture arrived')
                pause(.1)
            log(result='prices_captured',target=target,receipt=collected)
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
            f.write(json.dumps(dict(time=time.time(),target=target,result='opened_and_closed',receipt=collected))+'\n')
        visited+=1
        if on_visit:on_visit(target)
        print(f'Visited {visited}',flush=True)
        pause(random.uniform(.25,.55))

    if navigation:
        from market_navigation_live import traverse
        try:
            traverse(navigation,capture,vision.inspect,pulse,pause,scan_row,log,lambda:visited>=limit,test_only=navigation_test,position_path=position_path)
        finally:release(MOVEMENT_KEYS)
    elif route:
        initial,bounds=capture()
        if list(bounds[2:])!=route['client_size']:raise RuntimeError('Client size differs from recorded route')
        initial.save(folder/'route_start.png')
        print('Route playback: starting position must match the saved start screenshot.',flush=True)
        try:
            for number,step in enumerate(route['steps']):
                if visited>=limit:break
                check();shot,current=capture();state=vision.inspect(shot)
                if current!=bounds:raise RuntimeError('Window moved or resized during route')
                if state['owner'] or state['leave']:raise RuntimeError('Shop window present before route movement')
                log(result='route_step',step=number,action=step['action'])
                if step['action']=='scan':scan_row(step['y'])
                elif step['action']=='wait':pause(step['seconds'])
                else:
                    try:
                        for key in step['keys']:check();gui.keyDown(key)
                        pause(step['seconds'])
                    finally:
                        release(step['keys'])
                    pause(.15)
        finally:
            release(MOVEMENT_KEYS)
    else:scan_row()



def main():
    parser=argparse.ArgumentParser(description=__doc__)
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--image',type=Path,help='Offline screenshot preview; no input actions')
    group.add_argument('--run',action='store_true')
    parser.add_argument('--limit',type=int,default=5)
    parser.add_argument('--navigation-test',action='store_true',help='Walk, climb out/back, then scan; foreground countdown')
    routes=parser.add_mutually_exclusive_group()
    routes.add_argument('--record-route',type=Path)
    routes.add_argument('--route',type=Path)
    routes.add_argument('--navigate-map',type=Path,help='Resource map plus minimap/name calibration')
    parser.add_argument('--position-file',type=Path,help='Use live client movement coordinates for navigation')
    parser.add_argument('--capture-folder',type=Path,help='Require a new completed shop capture before closing each shop')
    routes.add_argument('--calibrate-map',type=Path,help='Extracted WZ map JSON')
    parser.add_argument('--calibration-output',type=Path,default=ROOT/'market_data/maps/room7-navigation.json')
    args=parser.parse_args()
    if not 1<=args.limit<=300:parser.error('limit must be 1..300')
    if args.navigation_test and not args.navigate_map:parser.error('--navigation-test requires --navigate-map')
    if (args.record_route or args.route or args.navigate_map or args.calibrate_map) and not args.run:parser.error('Routes require --run')
    if args.capture_folder and (not args.run or not args.capture_folder.is_dir()):parser.error('--capture-folder requires --run and an existing collector folder')
    route=validate_route(json.loads(args.route.read_text(encoding='utf-8-sig'))) if args.route else None
    if args.record_route:
        args.record_route.parent.mkdir(parents=True,exist_ok=True)
        if args.record_route.exists():parser.error('Route exists; choose a new name to preserve it')
    folder=ROOT/'bot_runs'/time.strftime('%Y%m%d_%H%M%S');folder.mkdir(parents=True,exist_ok=True)
    vision=Vision()
    try:
        if args.image:
            image=Image.open(args.image).convert('RGB');result=vision.inspect(image)
            save_preview(image,result,folder);print(json.dumps(result));print(folder)
        else:run_live(vision,folder,args.limit,route,args.record_route,args.navigate_map,args.calibrate_map,args.calibration_output,args.navigation_test,args.position_file,args.capture_folder)
    except (RuntimeError,KeyboardInterrupt) as error:
        print(f'STOPPED: {error}',flush=True)
        (folder/'stop.txt').write_text(str(error),encoding='utf-8')
        raise SystemExit(1)


if __name__=='__main__':main()
