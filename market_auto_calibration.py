"""Calibrate from client minimap artwork and the local character name reference."""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

from market_navigation import NavigationError, build_resource_graph, locate_player, map_signature


def find_minimap(image, template):
    frame=np.asarray(image.convert('RGB'))
    reference=np.asarray(template.convert('RGBA'))
    mask=(reference[:,:,3]>200).astype('uint8')*255
    if np.count_nonzero(mask)<50:raise NavigationError('Minimap artwork has too few opaque pixels')
    h,w=reference.shape[:2]
    # Search the entire client so moving the minimap window does not break setup.
    result=cv2.matchTemplate(frame,reference[:,:,:3],cv2.TM_SQDIFF_NORMED,mask=mask)
    result=np.nan_to_num(result,nan=2,posinf=2,neginf=2)
    score,_,(x,y),_=cv2.minMaxLoc(result)
    if score>.20:raise NavigationError(f'Minimap artwork not found ({score:.3f}); open full minimap at native scale')
    result[max(0,y-h//2):y+h//2+1,max(0,x-w//2):x+w//2+1]=2
    if cv2.minMaxLoc(result)[0]<score+.025:raise NavigationError('More than one minimap matches; close screenshot overlays')
    return [x,y,w,h],float(score)


def marker_offset(image, roi, resource):
    x,y,w,h=roi
    rgb=np.asarray(image.convert('RGB'))[y:y+h,x:x+w].astype(int)
    mask=((rgb[:,:,0]>170)&(rgb[:,:,1]<130)&(rgb[:,:,2]<130)).astype('uint8')
    count,_,stats,centers=cv2.connectedComponentsWithStats(mask)
    ys=np.array([centers[i,1] for i in range(1,count) if 3<=stats[i,4]<=35])
    if len(ys)<6:raise NavigationError('Not enough minimap shop markers to calibrate vertical offset')
    meta=resource['minimap'];graph=build_resource_graph(resource)
    floor_ys=np.array([(f['y']+meta['centerY'])//2**meta['mag'] for f in graph['floors']])
    candidates=[]
    for offset in range(-12,4):
        distances=abs(ys[:,None]-(floor_ys+offset)[None,:])
        errors=np.min(distances,axis=1)
        supported=set(np.argmin(distances,axis=1)[errors<1.2])
        candidates.append((float(np.median(errors)),len(supported),offset,float(np.mean(errors<1.2))))
    error,support,offset,fraction=min(candidates)
    if error>.7 or support<2 or fraction<.8:raise NavigationError('Shop markers do not agree with map platforms')
    return [0,offset],dict(median_error=error,supported_floors=support,matched_fraction=fraction)


def find_name(image, reference):
    frame=np.asarray(image.convert('RGB'));template=np.asarray(reference.convert('RGB'))
    result=cv2.matchTemplate(frame,template,cv2.TM_CCOEFF_NORMED)
    # The bottom HUD also repeats the player's name; only locate the scene tag.
    result[max(0,image.height-105):,:]=-1
    _,score,_,(x,y)=cv2.minMaxLoc(result)
    h,w=template.shape[:2]
    result[max(0,y-h):y+h+1,max(0,x-w):x+w+1]=-1
    if score<.80 or cv2.minMaxLoc(result)[1]>=score-.04:raise NavigationError('Character name is hidden or ambiguous')
    return (x,y,x+w,y+h),float(score)


def calibrate_automatically(image, resource, destination):
    destination=Path(destination)
    previous=json.loads(destination.read_text(encoding='utf-8')) if destination.exists() else {}
    minimap=Image.open(destination.parent/resource['minimap']['template'])
    reference=Image.open(destination.parent/'player-name-reference.png')
    roi,map_score=find_minimap(image,minimap)
    offset,evidence=marker_offset(image,roi,resource)
    position=locate_player(image,roi)
    name_box,name_score=find_name(image,reference)
    resource=json.loads(json.dumps(resource));resource['minimap']['marker_offset']=offset
    template=destination.with_suffix('.name.png')
    image.crop(name_box).save(template)
    profile=dict(version=3,resource=resource,client_size=list(image.size),minimap=roi,
                 signature=map_signature(image,roi).tolist(),name_template=template.name,
                 initial_marker=position,calibration_method='wz_artwork_and_name_reference',
                 evidence=dict(map_error=map_score,name_score=name_score,marker_offset=offset,**evidence))
    if 'jump_key' in previous:profile['jump_key']=previous['jump_key']
    destination.write_text(json.dumps(profile,indent=2),encoding='utf-8')
    image.save(destination.with_suffix('.calibration.png'))
    preview=image.copy();draw=ImageDraw.Draw(preview)
    x,y,w,h=roi;draw.rectangle((x,y,x+w,y+h),outline='lime',width=2)
    draw.rectangle(name_box,outline='lime',width=2)
    px,py=x+position[0],y+position[1];draw.ellipse((px-5,py-5,px+5,py+5),outline='cyan',width=1)
    preview.save(destination.with_suffix('.preview.png'))
    return profile
