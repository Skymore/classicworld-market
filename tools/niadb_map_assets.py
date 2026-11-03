#!/usr/bin/env python3
"""Minimaps and monster sprites for the bestiary's map view, from NiaDB.

    python3 tools/niadb_map_assets.py fetch      # stdlib only, ~10 min
    python3 tools/niadb_map_assets.py heads      # needs Pillow
    python3 tools/niadb_map_assets.py worldmap   # needs Pillow, ~1 min
    python3 tools/niadb_map_assets.py scenes     # needs Pillow, ~20 min
    python3 tools/niadb_map_assets.py scene-copies  # needs Pillow, offline

`fetch` saves, for every map in data/reference/niadb/maps.json with
`hasMinimapImage`, https://meowdb.com/msclassic/maps/minimaps/<id>.png as
web/images/minimaps/<id>.png (the client minimap, world size / 16), and for
every monster in monsters.json /msclassic/monsters/sprites/mob_<id>.png as
data/reference/niadb/mob-sprites/<id>.png (the stand sprite; often an
animated GIF behind the .png name). Files already there are kept, so a run
that stopped resumes. Two seconds between requests.

`heads` turns each sprite into web/images/mobs/head/<id>.png: the first
frame, transparent borders trimmed, the top of tall mobs kept, fitted into
48x48. The map view shows them at 24 px on the spawn points.

`worldmap` saves NiaDB's world map: /_data/worldmap-spots.json (each
region's spots, from the client's WorldMap.wz: position, marker type, main
map) and /_data/worldmap-previews.json (the maps each spot covers) into
data/reference/niadb/, and the region pictures and marker sprites from
/msclassic/worldmap/ into web/images/worldmap/. NiaDB's region pictures are
lossless WebP (about 500 KB each); they are saved as lossy WebP at quality 80
(about 100 KB). data/reference/niadb/worldmap-images.json records each
region's picture and size.

`scenes` saves NiaDB's rendered map scenes (the whole map drawn from the
client: background, tiles, objects; no monsters or NPCs), the "bare" variant
of /msclassic/api/assets/maps/<key>?v=12, as web/images/scenes/<id>.webp,
scaled to fit 1760x1040 (twice the map view's size) at WebP quality 75, and a
copy for phones as web/images/scenes/small/<id>.webp, scaled to fit 1100x650.
The map view offers both through `srcset`; the server works out their widths
from the scene's rectangle with the same two boxes (SCENE_FIT and
SCENE_SMALL_FIT in server/crates/market-web/src/bestiary/model.rs), so keep
them in step. The scene index (map id -> key) is read from the map page's
script, as NiaDB's own pages do. A scene covers the terrain's view rectangle,
which is the minimap box for every map checked; when the picture's size
differs from the box, /_data/map-terrain/<id>.json gives the rectangle.
data/reference/niadb/scenes.json records each scene's world rectangle.

`scene-copies` makes the phone copies from the scene pictures already in
web/images/scenes/, without downloading anything.

Each writes a `sources.json` next to the files with the URL and date.
"""
import argparse
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NIADB = ROOT / "data" / "reference" / "niadb"
MINIMAPS = ROOT / "web" / "images" / "minimaps"
SPRITES = NIADB / "mob-sprites"
HEADS = ROOT / "web" / "images" / "mobs" / "head"
SITE = "https://meowdb.com"
# Cloudflare in front of the site rejects urllib's default agent.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
HEAD_SIZE = 48
WORLDMAP = ROOT / "web" / "images" / "worldmap"
# Region pictures and their sizes, as NiaDB's world map page lists them.
REGION_IMAGES = {
    "MapleIsland": ("maple-island.webp", 634, 446),
    "VictoriaIsland": ("victoria-island.webp", 636, 466),
    "OssyriaElNathMts": ("ossyria-el-nath-mts.webp", 636, 467),
    "OssyriaDeadMine": ("ossyria-dead-mine.webp", 637, 468),
}
# Marker sprites by spot type (0 town, 1 spot, 2 cluster, 3 field, 4 facility)
# and the "you are here" arrow.
MARKERS = ["marker-town.png", "marker-spot.png", "marker-cluster.png", "marker-field.png",
           "marker-facility.png", "curpos-0.png"]
REGION_QUALITY = 80


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


def get(path):
    """The body, or None on 404."""
    request = urllib.request.Request(SITE + path, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        if error.code in (403, 429):
            sys.exit(f"stopped at {path}: HTTP {error.code}")
        raise


def save_all(jobs, out, pause):
    """jobs: [(id, path)]. Returns {id: path} of the files that exist."""
    out.mkdir(parents=True, exist_ok=True)
    found, missing = {}, []
    for n, (key, path) in enumerate(jobs, 1):
        target = out / f"{key}.png"
        if target.exists():
            found[key] = path
            continue
        body = get(path)
        if body is None:
            missing.append(key)
        else:
            target.write_bytes(body)
            found[key] = path
        print(f"{out.name} {n}/{len(jobs)}: {key} {'404' if body is None else len(body)}")
        time.sleep(pause)
    return found, missing


def fetch(pause):
    today = datetime.date.today().isoformat()
    maps = read_json(NIADB / "maps.json")
    jobs = [(int(m["id"]), f"/msclassic/maps/minimaps/{m['id']}.png") for m in maps if m.get("hasMinimapImage")]
    found, missing = save_all(jobs, MINIMAPS, pause)
    write_json(MINIMAPS / "sources.json", {
        "note": "Client minimaps (world size / 16). Game art belongs to NEXON and its affiliates.",
        "source": f"{SITE}/msclassic/maps/minimaps/<9-digit map id>.png",
        "fetched": today,
        "maps": sorted(found),
        "missing": sorted(missing),
    })
    mobs = read_json(NIADB / "monsters.json")
    mobs = mobs["monsters"] if isinstance(mobs, dict) else mobs
    jobs = [(int(m["id"]), f"/msclassic/monsters/sprites/mob_{int(m['id'])}.png") for m in mobs]
    found, missing = save_all(jobs, SPRITES, pause)
    write_json(SPRITES / "sources.json", {
        "note": "Monster stand sprites. Game art belongs to NEXON and its affiliates.",
        "source": f"{SITE}/msclassic/monsters/sprites/mob_<id>.png",
        "fetched": today,
        "mobs": sorted(found),
        "missing": sorted(missing),
    })


def head(image):
    """First frame, trimmed, top square of tall sprites, fitted into HEAD_SIZE."""
    from PIL import Image

    image.seek(0)
    frame = image.convert("RGBA")
    box = frame.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()
    if box:
        frame = frame.crop(box)
    w, h = frame.size
    if h > w * 1.25:  # tall mob: keep the head and shoulders
        frame = frame.crop((0, 0, w, int(w * 1.1)))
    w, h = frame.size
    scale = min(HEAD_SIZE / w, HEAD_SIZE / h, 2.0)
    frame = frame.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    out = Image.new("RGBA", (HEAD_SIZE, HEAD_SIZE), (0, 0, 0, 0))
    out.paste(frame, ((HEAD_SIZE - frame.width) // 2, HEAD_SIZE - frame.height))
    return out


def heads():
    from PIL import Image

    HEADS.mkdir(parents=True, exist_ok=True)
    sources = read_json(SPRITES / "sources.json")
    made = []
    for mob_id in sources["mobs"]:
        with Image.open(SPRITES / f"{mob_id}.png") as image:
            head(image).save(HEADS / f"{mob_id}.png", optimize=True)
        made.append(mob_id)
    write_json(HEADS / "sources.json", {
        "note": "Made by tools/niadb_map_assets.py heads from data/reference/niadb/mob-sprites "
                "(first frame, trimmed, fitted into 48x48). Game art belongs to NEXON and its affiliates.",
        "source": sources["source"],
        "fetched": sources["fetched"],
        "mobs": made,
    })
    print(f"{len(made)} heads in {HEADS}")


def lossy_webp(body, quality):
    """A picture (any format Pillow reads) as lossy WebP bytes."""
    import io
    from PIL import Image

    with Image.open(io.BytesIO(body)) as image:
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        out = io.BytesIO()
        image.save(out, "WEBP", quality=quality, method=6)
    return out.getvalue()


def worldmap(pause):
    today = datetime.date.today().isoformat()
    regions = {image for image, _, _ in REGION_IMAGES.values()}
    for name in ("worldmap-spots.json", "worldmap-previews.json"):
        body = get(f"/_data/{name}")
        if body is None:
            sys.exit(f"/_data/{name}: 404")
        data = json.loads(body)
        data["fetched"] = today
        write_json(NIADB / name, data)
        time.sleep(pause)
    WORLDMAP.mkdir(parents=True, exist_ok=True)
    files = [image for image, _, _ in REGION_IMAGES.values()] + MARKERS
    for name in files:
        body = get(f"/msclassic/worldmap/{name}")
        if body is None:
            sys.exit(f"/msclassic/worldmap/{name}: 404")
        size = len(body)
        if name in regions:
            body = lossy_webp(body, REGION_QUALITY)
        (WORLDMAP / name).write_bytes(body)
        print(f"worldmap {name} {size} -> {len(body)}")
        time.sleep(pause)
    write_json(WORLDMAP / "sources.json", {
        "note": "World map pictures and markers from the client's WorldMap.wz. Game art belongs to NEXON and its affiliates.",
        "source": f"{SITE}/msclassic/worldmap/<name>",
        "fetched": today,
        "files": files,
    })
    write_json(NIADB / "worldmap-images.json", {
        "note": "Written by tools/niadb_map_assets.py worldmap: each region's picture under web/images/worldmap/ and its size in pixels.",
        "regions": {
            region: {"image": f"/web/images/worldmap/{image}", "width": w, "height": h}
            for region, (image, w, h) in REGION_IMAGES.items()
        },
    })


SCENES = ROOT / "web" / "images" / "scenes"
SCENES_SMALL = SCENES / "small"
SCENE_FIT = (1760, 1040)
# Phones show a map view about 300-370 CSS px wide at 2.6-3x, so they ask
# for roughly 900-1100 pixels.
SCENE_SMALL_FIT = (1100, 650)
SCENE_QUALITY = 75
SCENE_INDEX = re.compile(r'"(\d{9})":\{key:"([^"]+)",variants:\[([^\]]*)\]\}')


def scene_index():
    """{9-digit map id: key} for maps with a bare scene, from the script that
    holds NiaDB's scene index."""
    page = get("/msclassic/maps/000001000").decode("utf-8")
    for chunk in sorted(set(re.findall(r'/_next/static/chunks/[^"]+\.js', page))):
        script = get(chunk).decode("utf-8")
        found = {m: key for m, key, variants in SCENE_INDEX.findall(script) if '"bare"' in variants}
        if found:
            return found
        time.sleep(0.5)
    sys.exit("no scene index in the map page's scripts")


def fitted(size, fit):
    """`size` scaled to fit the `fit` box, never up."""
    w, h = size
    scale = min(fit[0] / w, fit[1] / h, 1.0)
    return max(1, round(w * scale)), max(1, round(h * scale))


def save_scene(image, size, target):
    from PIL import Image

    image.convert("RGB").resize(size, Image.LANCZOS).save(target, "WEBP", quality=SCENE_QUALITY, method=6)


def save_small_scene(image, source_size, map_id):
    """The phone copy, from the source picture or the full-size one; none when
    it would be no smaller than the full-size picture."""
    size = fitted(source_size, SCENE_SMALL_FIT)
    if size == fitted(source_size, SCENE_FIT):
        return None
    SCENES_SMALL.mkdir(parents=True, exist_ok=True)
    save_scene(image, size, SCENES_SMALL / f"{map_id}.webp")
    return size


def scene_copies():
    from PIL import Image

    made = 0
    for key, scene in read_json(NIADB / "scenes.json")["maps"].items():
        source = SCENES / f"{key}.webp"
        if not source.exists() or (SCENES_SMALL / f"{key}.webp").exists():
            continue
        with Image.open(source) as image:
            if save_small_scene(image, scene["source_size"], key):
                made += 1
    print(f"{made} phone copies in {SCENES_SMALL}")


def scenes(pause):
    import io
    from PIL import Image

    today = datetime.date.today().isoformat()
    maps = {m["id"]: m for m in read_json(NIADB / "maps.json")}
    index = scene_index()
    SCENES.mkdir(parents=True, exist_ok=True)
    out_path = NIADB / "scenes.json"
    done = read_json(out_path)["maps"] if out_path.exists() else {}
    for n, (nine, key) in enumerate(sorted(index.items()), 1):
        map_id = int(nine)
        target = SCENES / f"{map_id}.webp"
        if str(map_id) in done and target.exists():
            continue  # `scene-copies` makes a missing phone copy
        body = get(f"/msclassic/api/assets/maps/{key}?v=12")
        if body is None:
            print(f"scene {n}/{len(index)}: {nine} 404")
            continue
        image = Image.open(io.BytesIO(body))
        w, h = image.size
        m = maps.get(nine)
        box = m and (-m["miniMapCenterX"], -m["miniMapCenterY"], m["minimapWidth"], m["minimapHeight"])
        if box and (w, h) == (box[2], box[3]):
            rect = list(box)
        else:
            terrain = json.loads(get(f"/_data/map-terrain/{nine}.json") or b"{}")
            vr = terrain.get("vr")
            if not vr:
                print(f"scene {n}/{len(index)}: {nine} {w}x{h} has no view rectangle; skipped")
                continue
            rect = [vr[0], vr[1], vr[2] - vr[0], vr[3] - vr[1]]
        size = fitted((w, h), SCENE_FIT)
        save_scene(image, size, target)
        phone = save_small_scene(image, (w, h), map_id)
        done[str(map_id)] = {"key": key, "x": rect[0], "y": rect[1], "w": rect[2], "h": rect[3],
                             "source_size": [w, h], "size": list(size)}
        write_json(out_path, {
            "note": "Written by tools/niadb_map_assets.py scenes: each map's scene picture "
                    "(web/images/scenes/<id>.webp) and the world rectangle it covers (x, y, w, h).",
            "source": f"{SITE}/msclassic/api/assets/maps/<key>?v=12",
            "fetched": today,
            "maps": dict(sorted(done.items(), key=lambda kv: int(kv[0]))),
        })
        print(f"scene {n}/{len(index)}: {nine} {w}x{h} -> {size[0]}x{size[1]} {target.stat().st_size // 1024} KB"
              + (f", phone {phone[0]}x{phone[1]}" if phone else ""))
        time.sleep(pause)
    write_json(SCENES / "sources.json", {
        "note": "Rendered map scenes (NiaDB, from the client's Map.wz), scaled to fit 1760x1040; "
                "small/ has the phone copies, scaled to fit 1100x650. "
                "Game art belongs to NEXON and its affiliates.",
        "source": f"{SITE}/msclassic/api/assets/maps/<key>?v=12",
        "fetched": today,
        "maps": sorted(int(k) for k in done),
    })


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="download minimaps and monster sprites")
    f.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    sub.add_parser("heads", help="make the 48 px head icons from the sprites")
    w = sub.add_parser("worldmap", help="download the world map data and pictures")
    w.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    c = sub.add_parser("scenes", help="download and scale the rendered map scenes")
    c.add_argument("--pause", type=float, default=1.5, help="seconds between requests")
    sub.add_parser("scene-copies", help="make the missing phone copies of the scenes on disk")
    args = ap.parse_args()
    if args.command == "scenes":
        scenes(args.pause)
    elif args.command == "scene-copies":
        scene_copies()
    elif args.command == "fetch":
        fetch(args.pause)
    elif args.command == "worldmap":
        worldmap(args.pause)
    else:
        heads()


if __name__ == "__main__":
    main()
