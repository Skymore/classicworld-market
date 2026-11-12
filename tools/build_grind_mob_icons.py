"""Extract missing collector monster icons from the local Classic World WZ."""
import argparse
import zlib
from pathlib import Path

from PIL import Image
from market_map_resources import directory, WzReader


def build(path, output):
    reader, version, entries = directory(path)
    output.mkdir(parents=True, exist_ok=True)
    count = 0
    for entry in entries:
        target = output / f'{int(entry["name"].split(".")[0])}.png'
        if target.exists():
            continue
        data = reader.data[entry['offset']:entry['offset'] + entry['size']]
        if sum(data) & 0xffffffff != entry['checksum'] & 0xffffffff:
            raise ValueError('WZ checksum mismatch')
        r = WzReader(data, read_canvas=True)
        if r.string_block() != 'Property':
            raise ValueError('Not a property image')
        r.take(2)
        properties = r.properties()
        canvas = next((properties.get(action, {}).get('0') for action in ('stand', 'move', 'fly')
                       if 'pixels' in (properties.get(action, {}).get('0') or {})), None)
        if not canvas:
            continue
        w, h, fmt = canvas['width'], canvas['height'], canvas['format']
        if not (0 < w <= 2048 and 0 < h <= 2048) or fmt not in (1, 2):
            raise ValueError('Unsupported canvas format')
        expected = w * h * (2 if fmt == 1 else 4)
        raw = zlib.decompressobj().decompress(canvas['pixels'], expected + 1)
        if len(raw) != expected:
            raise ValueError('Unexpected canvas length')
        if fmt == 2:
            image = Image.frombytes('RGBA', (w, h), raw, 'raw', 'BGRA')
        else:
            rgba = bytearray()
            for low, high in zip(raw[::2], raw[1::2]):
                rgba.extend(((high & 15)*17, (low >> 4)*17, (low & 15)*17, (high >> 4)*17))
            image = Image.frombytes('RGBA', (w, h), bytes(rgba))
        image = image.crop(image.getbbox())
        image.save(target)
        count += 1
    print(f'WZ {version}: extracted {count} missing icons')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wz', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('frontend/desktop/public/grind-icons/monsters'))
    args = parser.parse_args()
    build(args.wz, args.output)
