"""UI calibration and feedback-controlled traversal for resource-derived maps."""
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from market_navigation import (NavigationError, build_resource_graph, check_map,
                               locate_player, map_signature, shortest_path,
                               world_to_minimap, minimap_to_world)


def calibrate(image, resource, destination):
    from market_auto_calibration import calibrate_automatically
    return calibrate_automatically(image, resource, destination)


def traverse(profile_path, capture, inspect, pulse, pause, scan, log, done, test_only=False, position_path=None):
    profile_path=Path(profile_path)
    profile=json.loads(profile_path.read_text(encoding='utf-8'))
    if profile.get('version')!=3:raise NavigationError('Unsupported calibration version')
    resource=profile['resource'];graph=build_resource_graph(resource)
    jump_key=profile.get('jump_key','alt')
    if jump_key not in ('alt','space','ctrl'):raise NavigationError('Unsupported jump key in navigation profile')
    template=np.asarray(Image.open(profile_path.parent/profile['name_template']).convert('RGB'))
    bounds=None
    network_state=None
    network_session=None
    def observe():
        nonlocal bounds,network_state,network_session
        image,current=capture()
        if bounds is None:bounds=current
        if current!=bounds or list(image.size)!=profile['client_size']:
            raise NavigationError('Window changed; recalibrate')
        state=inspect(image)
        if state['owner'] or state['leave']:raise NavigationError('Close shop before navigation')
        check_map(image,profile)
        if position_path:
            from market_position_feed import read_position
            try:network_state=read_position(position_path,resource['map_id'])
            except (ValueError,OSError) as error:raise NavigationError(str(error)) from error
            if network_session is None:network_session=network_state['session']
            if network_session!=network_state['session']:raise NavigationError('Game connection changed; restart navigation')
            info=resource['info']
            if not (info['VRLeft']-30<=network_state['x']<=info['VRRight']+30 and
                    info['VRTop']-30<=network_state['y']<=info['VRBottom']+30):
                raise NavigationError('Network position outside map bounds')
            return image,world_to_minimap(network_state,resource['minimap'])
        return image,locate_player(image,profile['minimap'])
    def avatar(image):
        from market_auto_calibration import find_name
        (x,y,right,_),_=find_name(image,Image.fromarray(template))
        return (x+right)/2,y-8
    image,pos=observe();world=minimap_to_world(pos,resource['minimap'])
    # Starting only on a known floor avoids routing through empty space.
    starts=[(abs(n['x']-world[0]),i) for i,n in enumerate(graph['nodes']) if abs(n['y']-world[1])<=24]
    entry_source=None
    if not starts and position_path:
        for edge in graph['edges']:
            if edge['kind']!='ladder':continue
            a,b=graph['nodes'][edge['a']],graph['nodes'][edge['b']]
            if abs(a['x']-world[0])<=4 and min(a['y'],b['y'])<world[1]<max(a['y'],b['y']):
                current=min((edge['a'],edge['b']),key=lambda i:abs(graph['nodes'][i]['y']-world[1]))
                entry_source=graph['nodes'][edge['b'] if current==edge['a'] else edge['a']]
                starts=[(0,current)];break
    if not starts:raise NavigationError('Stand on a platform before starting')
    _,current=min(starts)
    pending=set(range(len(graph['nodes'])))
    visited_shops=[]

    def move_network(target,kind,source=None,grab_gap=0):
        started=time.monotonic();jumped=False
        while time.monotonic()-started<45:
            observe()
            dx,dy=target['x']-network_state['x'],target['y']-network_state['y']
            if abs(dx)<=5 and abs(dy)<=2:return
            if kind=='walk':
                if abs(dy)>8:raise NavigationError('Network position left the walking platform')
                if abs(dx)<=5:raise NavigationError('Cannot confirm network platform height')
                keys=['right' if dx>0 else 'left']
            elif abs(dx)>4:
                if abs(network_state['y']-source['y'])>8:
                    raise NavigationError('Network position is not aligned with ladder')
                keys=['right' if dx>0 else 'left']
            else:
                keys=['down' if dy>0 else 'up']
                if dy<0 and grab_gap>10 and not jumped:
                    keys.append(jump_key);jumped=True
            duration=min(.18,max(.025,abs(dx)/180)) if keys[0] in ('left','right') else .18
            before=network_state['sequence']
            log(result='network_navigation_pulse',position=[network_state['x'],network_state['y']],
                target=[target['x'],target['y']],keys=keys,sequence=before)
            pulse(keys,duration)
            # Client movement reports are batched (~0.51 s in the capture).
            # Do not issue another input against the same old coordinates.
            deadline=time.monotonic()+2
            while True:
                pause(.1);observe()
                if network_state['sequence']!=before:break
                if time.monotonic()>deadline:raise NavigationError('No new movement report after input')
            pause(.6) # allow the key release/deceleration report to arrive
        raise NavigationError('Network waypoint timeout')

    def move(target,kind,source=None,grab_gap=0):
        if position_path:return move_network(target,kind,source,grab_gap)
        goal=world_to_minimap(target,resource['minimap'])
        started=time.monotonic();progress=started;last=None;stable=0;jumped=False
        probes=0;last_probe=started;climbing=False
        while True:
            image,pos=observe();now=time.monotonic()
            if now-started>25:raise NavigationError('Waypoint timeout')
            if last is None or math.dist(pos,last)>.4:progress=now;last=pos
            dx,dy=goal[0]-pos[0],goal[1]-pos[1]
            vertical_arrived=abs(dy)<=1
            if kind=='ladder' and target['y']<source['y']:
                # At the upper lip, stopping a pixel early leaves the player
                # hanging on the ladder and prevents opening a shop.
                vertical_arrived=goal[1]-1.5<=pos[1]<=goal[1]-.25
            if abs(dx)<=.65 and vertical_arrived:
                stable+=1
                if stable>=3:return
                pause(.12);continue
            stable=0
            if now-progress>3:raise NavigationError('No movement for three seconds; stopped for inspection')
            if kind=='walk':
                if abs(dy)>2:raise NavigationError('Unexpected platform height while walking')
                if abs(dx)<=.65:raise NavigationError('Cannot confirm platform height')
                keys=['right' if dx>0 else 'left']
            else:
                source_y=world_to_minimap(source,resource['minimap'])[1]
                if abs(pos[1]-source_y)>1.5:climbing=True
                if not climbing and now-last_probe>.8 and probes<4 and abs(dx)<=2:
                    # A minimap cell spans 16 world pixels. Probe within that
                    # cell to enter the narrow ladder catch area, then verify Y.
                    direction='left' if probes%2==0 else 'right'
                    duration=.035*(probes+1)
                    log(result='ladder_alignment_probe',keys=[direction],seconds=duration)
                    pulse([direction],duration);pause(.06)
                    pulse(['down' if dy>0 else 'up'],.24)
                    probes+=1;last_probe=time.monotonic();continue
                if abs(dx)>.65 and not probes and not climbing:
                    if abs(pos[1]-source_y)>2:raise NavigationError('Horizontal drift during climb')
                    keys=['right' if dx>0 else 'left']
                else:
                    keys=['down' if dy>0 else 'up']
                    if dy<0 and grab_gap>10 and not jumped:
                        keys.append(jump_key);jumped=True
            log(result='navigation_pulse',position=pos,target=goal,keys=keys)
            pulse(keys,.06 if abs(dx)<2 and keys[0] in ('left','right') else .16)
            pause(.08)

    # Snap to the closest waypoint on the current platform using feedback.
    move(graph['nodes'][current],'ladder' if entry_source else 'walk',entry_source)
    if test_only:
        ladder_candidates=[]
        for edge in graph['edges']:
            if edge['kind']!='ladder':continue
            for a,b in ((edge['a'],edge['b']),(edge['b'],edge['a'])):
                if profile.get('test_ladder_x') is not None:
                    if graph['nodes'][a]['x']!=profile['test_ladder_x']:continue
                    # Start the requested long-ladder test at its lower end.
                    if graph['nodes'][a]['y']<graph['nodes'][b]['y']:continue
                    path=shortest_path(graph,current,a)
                    ladder_candidates.append((len(path),a,b,edge));continue
                if graph['nodes'][a]['floor']==graph['nodes'][current]['floor']:
                    ladder_candidates.append((abs(graph['nodes'][a]['x']-graph['nodes'][current]['x']),a,b,edge))
        if not ladder_candidates:raise NavigationError('No ladder on current platform')
        _,a,b,edge=min(ladder_candidates,key=lambda c:c[0])
        path=shortest_path(graph,current,a)
        for src,dst in zip(path,path[1:]):
            step=next(e for e in graph['edges'] if {e['a'],e['b']}=={src,dst})
            move(graph['nodes'][dst],step['kind'],graph['nodes'][src],step.get('grab_gap',0))
        log(result='test_walk_passed',node=a)
        move(graph['nodes'][b],'ladder',graph['nodes'][a],edge.get('grab_gap',0))
        log(result='test_ladder_out_passed',node=b)
        move(graph['nodes'][a],'ladder',graph['nodes'][b],edge.get('grab_gap',0))
        log(result='test_ladder_return_passed',node=a)
        image,_=observe();anchor=avatar(image)
        scan(eligible=lambda p:abs(p['x']-anchor[0])<=170 and 70<=anchor[1]-p['y']<=185)
        log(result='test_finished',shop_opened=done())
        return
    while pending and not done():
        node=graph['nodes'][current]
        if current in pending:
            image,pos=observe();anchor=avatar(image);world=minimap_to_world(pos,resource['minimap'])
            def eligible(target):
                dx,dy=target['x']-anchor[0],anchor[1]-target['y']
                if abs(dx)>170 or not 70<=dy<=185:return False
                estimated=(world[0]+dx,node['floor'])
                return not any(f==estimated[1] and abs(x-estimated[0])<35 for x,f in visited_shops)
            def marked(target):visited_shops.append((world[0]+target['x']-anchor[0],node['floor']))
            scan(eligible=eligible,on_visit=marked)
            pending.remove(current);log(result='waypoint_scanned',node=current,remaining=len(pending))
        if not pending or done():break
        paths=[shortest_path(graph,current,target) for target in pending]
        path=min(paths,key=lambda p:sum(math.dist((graph['nodes'][a]['x'],graph['nodes'][a]['y']),
                                                (graph['nodes'][b]['x'],graph['nodes'][b]['y'])) for a,b in zip(p,p[1:])))
        nxt=path[1]
        edge=next(e for e in graph['edges'] if {e['a'],e['b']}=={current,nxt})
        move(graph['nodes'][nxt],edge['kind'],graph['nodes'][current],edge.get('grab_gap',0))
        current=nxt
    log(result='navigation_complete' if not pending else 'visit_limit',remaining=len(pending))
