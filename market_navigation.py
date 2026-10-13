"""Minimap localization and a resource-derived platform/ladder graph (no game I/O)."""
import heapq

import cv2
import numpy as np


class NavigationError(RuntimeError):
    pass


def locate_player(image, roi):
    """Return a unique yellow marker, in minimap pixels; ambiguity is an error."""
    x, y, w, h = roi
    if x < 0 or y < 0 or w < 10 or h < 10 or x+w > image.width or y+h > image.height:
        raise NavigationError('Minimap rectangle is outside the client')
    rgb = np.asarray(image.convert('RGB'))[y:y+h, x:x+w].astype(np.int16)
    mask = ((rgb[:,:,0] >= 210) & (rgb[:,:,1] >= 190) &
            (rgb[:,:,2] < 125) & (abs(rgb[:,:,0]-rgb[:,:,1]) < 65)).astype('uint8')
    count, _, stats, centers = cv2.connectedComponentsWithStats(mask, 8)
    dots = [tuple(map(float, centers[i])) for i in range(1,count)
            if 3 <= stats[i,cv2.CC_STAT_AREA] <= 80
            and 2 <= stats[i,cv2.CC_STAT_WIDTH] <= 12
            and 2 <= stats[i,cv2.CC_STAT_HEIGHT] <= 12]
    if len(dots) != 1:
        raise NavigationError(f'Expected one yellow player marker; found {len(dots)}')
    return dots[0]


def map_signature(image, roi):
    x,y,w,h = roi
    rgb = np.asarray(image.convert('RGB'))[y:y+h,x:x+w]
    # Coarse cells suppress player/shop marker differences while retaining terrain.
    return cv2.resize(rgb,(24,16),interpolation=cv2.INTER_AREA).astype(float)


def check_map(image, profile):
    actual = map_signature(image, profile['minimap'])
    reference = np.asarray(profile['signature'])
    if reference.shape != actual.shape or np.mean(abs(actual-reference)) > 22:
        raise NavigationError('Minimap changed; check room, zoom and minimap visibility')


def shortest_path(profile, start, goal):
    graph={i:[] for i in range(len(profile['nodes']))}
    for e in profile['edges']:
        a,b=e['a'],e['b']
        p,q=profile['nodes'][a],profile['nodes'][b]
        cost=abs(p['x']-q['x'])+2*abs(p['y']-q['y'])
        graph[a].append((b,cost));graph[b].append((a,cost))
    queue=[(0,start,[])];seen=set()
    while queue:
        cost,node,path=heapq.heappop(queue)
        if node in seen:continue
        if node==goal:return path+[node]
        seen.add(node)
        for nxt,weight in graph[node]:heapq.heappush(queue,(cost+weight,nxt,path+[node]))
    raise NavigationError(f'Unreachable waypoint {goal}')


def build_resource_graph(resource, spacing=150):
    """Join flat walkable footholds; connect ladder ends to supporting floors.

    Vertical walls and overlapping floors stay separate. A ladder bottom can
    hang above its floor; the edge retains this distance for jump-to-grab.
    """
    floors=[]
    for s in resource['footholds']:
        if s['y1']!=s['y2'] or s['x1']>=s['x2']:continue
        floors.append(dict(left=s['x1'],right=s['x2'],y=s['y1']))
    merged=[]
    for s in sorted(floors,key=lambda s:(s['y'],s['left'])):
        if merged and merged[-1]['y']==s['y'] and s['left']<=merged[-1]['right']:
            merged[-1]['right']=max(merged[-1]['right'],s['right'])
        else:merged.append(dict(s))
    points=[set([f['left']+25,f['right']-25]) for f in merged]
    for i,f in enumerate(merged):
        points[i].update(range(f['left']+25,f['right']-24,spacing))
    links=[]
    for ladder in resource['ladders']:
        x=ladder['x']
        top=[i for i,f in enumerate(merged) if f['left']<=x<=f['right'] and abs(f['y']-ladder['y1'])<=8]
        bottom=[i for i,f in enumerate(merged) if f['left']<=x<=f['right'] and 0<=f['y']-ladder['y2']<=100 and f['y']>ladder['y1']+10]
        if not top or not bottom:raise NavigationError(f'No supporting platform for ladder at {x}')
        a=min(top,key=lambda i:abs(merged[i]['y']-ladder['y1']))
        b=min(bottom,key=lambda i:merged[i]['y']-ladder['y2'])
        points[a].add(x);points[b].add(x)
        links.append((a,b,x,merged[b]['y']-ladder['y2']))
    nodes=[];edges=[];lookup={}
    for floor,xs in enumerate(points):
        previous=None
        for x in sorted(xs):
            i=len(nodes);lookup[floor,x]=i
            nodes.append(dict(x=x,y=merged[floor]['y'],floor=floor))
            if previous is not None:edges.append(dict(a=previous,b=i,kind='walk'))
            previous=i
    for a,b,x,gap in links:
        edges.append(dict(a=lookup[a,x],b=lookup[b,x],kind='ladder',grab_gap=gap))
    graph=dict(nodes=nodes,edges=edges,floors=merged)
    for i in range(len(nodes)):shortest_path(graph,0,i)
    return graph


def minimap_to_world(position, metadata):
    scale=2**metadata['mag']
    offset=metadata.get('marker_offset',[0,0])
    return ((position[0]-offset[0])*scale-metadata['centerX'],(position[1]-offset[1])*scale-metadata['centerY'])


def world_to_minimap(node, metadata):
    scale=2**metadata['mag']
    offset=metadata.get('marker_offset',[0,0])
    return ((node['x']+metadata['centerX'])//scale+offset[0],(node['y']+metadata['centerY'])//scale+offset[1])
