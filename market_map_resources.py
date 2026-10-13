"""Read-only ClassicWorld PKG1 map metadata extraction.

Supports the zero-IV WZ files shipped by this client. Canvas payloads are skipped.
Format references: MapleLib WzBinaryReader/WzDirectory (see THIRD_PARTY_NOTICES).
"""
import argparse
import json
import struct
import zlib
from pathlib import Path


class WzReader:
    def __init__(self, data, read_canvas=False):
        self.data=data; self.pos=0; self.base=0; self.read_canvas=read_canvas

    def take(self,n):
        if n<0 or not 0<=self.pos<=len(self.data)-n:raise ValueError('WZ read outside file')
        out=self.data[self.pos:self.pos+n];self.pos+=n;return out

    def number(self,fmt):return struct.unpack('<'+fmt,self.take(struct.calcsize('<'+fmt)))[0]

    def compressed(self):
        n=self.number('b');return self.number('i') if n==-128 else n

    def string(self):
        n=self.number('b')
        if not n:return ''
        wide=n>0
        length=self.number('i') if n in (-128,127) else abs(n)
        if not 0<=length<=100000:raise ValueError('Invalid WZ string length')
        if wide:return ''.join(chr(self.number('H')^((0xaaaa+i)&65535)) for i in range(length))
        return bytes(v^((0xaa+i)&255) for i,v in enumerate(self.take(length))).decode('latin1')

    def string_block(self):
        mode=self.number('B')
        if mode in (0,0x73):return self.string()
        if mode in (1,0x1b):
            offset=self.number('i');saved=self.pos;self.pos=self.base+offset
            value=self.string();self.pos=saved;return value
        raise ValueError(f'Unknown string block {mode}')

    def properties(self,depth=0):
        if depth>32:raise ValueError('Property depth exceeded')
        count=self.compressed()
        if not 0<=count<=100000:raise ValueError('Invalid property count')
        out={}
        for _ in range(count):
            name=self.string_block();kind=self.number('B')
            if kind==0:value=None
            elif kind in (2,11):value=self.number('h')
            elif kind in (3,19):value=self.compressed()
            elif kind==4:value=self.number('f') if self.number('B')==128 else 0
            elif kind==5:value=self.number('d')
            elif kind==8:value=self.string_block()
            elif kind==20:
                small=self.number('b');value=self.number('q') if small==-128 else small
            elif kind==9:
                size=self.number('I');end=self.pos+size
                if end>len(self.data):raise ValueError('Extended property exceeds file')
                extension=self.string_block()
                if extension=='Property':
                    self.take(2);value=self.properties(depth+1)
                elif extension=='Shape2D#Vector2D':value=dict(x=self.compressed(),y=self.compressed())
                elif extension=='UOL':self.take(1);value={'uol':self.string_block()}
                elif extension=='Canvas':
                    self.take(1);value=None
                    if self.number('B'):
                        self.take(2);value=self.properties(depth+1)
                    # Canvas children are useful for external links; bitmap is omitted.
                    value=value or {'canvas':True}
                    if self.read_canvas:
                        width=self.compressed();height=self.compressed()
                        fmt=self.compressed()+self.number('B');self.take(4)
                        length=self.number('I');self.take(1)
                        value.update(width=width,height=height,format=fmt,pixels=self.take(length-1))
                else:value={'extended_type':extension}
                if self.pos>end:raise ValueError('Extended property overrun')
                self.pos=end
            else:raise ValueError(f'Unknown property type {kind} at {self.pos}')
            out[name]=value
        return out


def directory(path):
    r=WzReader(Path(path).read_bytes())
    if r.take(4)!=b'PKG1':raise ValueError('Not a PKG1 WZ file')
    r.take(8);start=r.number('I');r.pos=start
    version_tag=r.number('H');count=r.compressed();entries=[]
    if not 0<=count<=100000:raise ValueError('Unsupported WZ directory header')
    for _ in range(count):
        kind=r.number('B')
        if kind not in (3,4):raise ValueError('Unsupported directory entry')
        name=r.string();size=r.compressed();checksum=r.compressed()
        offset_pos=r.pos;encrypted=r.number('I')
        entries.append(dict(name=name,size=size,checksum=checksum,offset_pos=offset_pos,encrypted=encrypted,kind=kind))
    def resolve(e,h):
        n=((((e['offset_pos']-start)^0xffffffff)*h)-0x581c3f6d)&0xffffffff
        shift=n&31;n=((n<<shift)|(n>>(32-shift)))&0xffffffff
        return ((n^e['encrypted'])+2*start)&0xffffffff
    candidates=[]
    for version in range(2000):
        h=0
        for c in str(version):h=(h*32+ord(c)+1)&0xffffffff
        if (0xff^(h>>24)^((h>>16)&255)^((h>>8)&255)^(h&255))!=version_tag:continue
        if all(0<=resolve(e,h)<=len(r.data)-e['size'] for e in entries):
            if all(r.data[resolve(e,h)] in (0x73,0x1b) for e in entries if e['kind']==4):
                candidates.append((version,h))
    if len(candidates)!=1:raise ValueError(f'Cannot uniquely determine WZ version: {candidates}')
    version,h=candidates[0]
    for e in entries:e['offset']=resolve(e,h)
    return r,version,entries


def extract_map(path,map_id):
    r,version,entries=directory(path)
    entry=next((e for e in entries if e['name']==f'{map_id:09d}.img'),None)
    if entry is None:raise ValueError(f'Map {map_id} is not in {path}')
    # Restrict all property references to this image.
    r=WzReader(r.data[entry['offset']:entry['offset']+entry['size']])
    if sum(r.data)&0xffffffff != entry['checksum']&0xffffffff:
        raise ValueError('Map image checksum mismatch')
    if r.string_block()!='Property':raise ValueError('Not a property image')
    r.take(2);properties=r.properties()
    footholds=[]
    for layer,groups in properties.get('foothold',{}).items():
        for group,segments in groups.items():
            for identity,segment in segments.items():
                footholds.append(dict(id=identity,layer=layer,group=group,**segment))
    return dict(map_id=map_id,wz_version=version,info=properties.get('info',{}),
                minimap=properties.get('miniMap',{}),footholds=footholds,
                ladders=list(properties.get('ladderRope',{}).values()),
                portals=list(properties.get('portal',{}).values()))


def extract_minimap(path,map_id):
    from PIL import Image
    reader,_,entries=directory(path)
    entry=next(e for e in entries if e['name']==f'{map_id:09d}.img')
    data=reader.data[entry['offset']:entry['offset']+entry['size']]
    if sum(data)&0xffffffff!=entry['checksum']&0xffffffff:raise ValueError('Canvas checksum mismatch')
    reader=WzReader(data,read_canvas=True)
    if reader.string_block()!='Property':raise ValueError('Invalid canvas image')
    reader.take(2);canvas=reader.properties()['miniMap']['canvas']
    w,h,fmt=canvas['width'],canvas['height'],canvas['format']
    if not (0<w<=2048 and 0<h<=2048) or fmt not in (1,2):raise ValueError('Unsupported minimap pixel format')
    expected=w*h*(2 if fmt==1 else 4)
    # This client's WZ zlib payload omits the stream trailer. Validate decoded
    # byte count as well as the containing WZ image checksum.
    raw=zlib.decompressobj().decompress(canvas['pixels'],expected+1)
    if len(raw)!=expected:raise ValueError('Unexpected decoded minimap size')
    if fmt==2:return Image.frombytes('RGBA',(w,h),raw,'raw','BGRA')
    rgba=bytearray()
    for low,high in zip(raw[::2],raw[1::2]):
        rgba.extend(((high&15)*17,(low>>4)*17,(low&15)*17,(high>>4)*17))
    return Image.frombytes('RGBA',(w,h),bytes(rgba))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--wz',type=Path,required=True);p.add_argument('--map-id',type=int,required=True)
    p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    result=extract_map(a.wz,a.map_id)
    a.output.parent.mkdir(parents=True,exist_ok=True)
    canvas_file=a.wz.parent/'_Canvas'/'_Canvas_000.wz'
    if canvas_file.exists():
        template=a.output.with_suffix('.minimap.png')
        extract_minimap(canvas_file,a.map_id).save(template)
        result['minimap']['template']=template.name
    a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(map_id=a.map_id,footholds=len(result['footholds']),ladders=len(result['ladders']),output=str(a.output))))


if __name__=='__main__':main()
