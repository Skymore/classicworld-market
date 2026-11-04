#!/usr/bin/env python3
"""Minimaps and monster sprites for the bestiary's map view, from NiaDB.

    python3 tools/niadb_map_assets.py fetch      # stdlib only, ~10 min
    python3 tools/niadb_map_assets.py heads      # needs Pillow
    python3 tools/niadb_map_assets.py worldmap   # needs Pillow, ~1 min
    python3 tools/niadb_map_assets.py scenes     # needs Pillow, ~20 min
    python3 tools/niadb_map_assets.py scene-copies  # needs Pillow, offline
    python3 tools/niadb_map_assets.py client-scenes <directory>  # checked client PNGs + world rectangles

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
lossless WebP (about 500 KB each); they are re-encoded as near-lossless WebP
(`cwebp -near_lossless 60`, about 30% smaller, edges and text stay sharp). Without
`cwebp` on PATH (or in $CWEBP) the pictures are kept as fetched. data/reference/niadb/worldmap-images.json records each
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

`client-scenes` imports checked, full-size client renders named <id>.png
with <id>.json world rectangles {x, y, w, h}. Rejects mismatched aspect
ratios (>2%) and preserves existing scenes. Align renders with the client
minimaps before importing, as described in MAP_SCENES_FROM_CLIENT.md.

`thumbs` makes the map list's card pictures, web/images/map-thumbs/<id>.webp
(480x300, WebP quality 80), for every map with a scene or a minimap on disk:
the middle of the scene cut to 16:10, or without a scene the whole minimap on
the cards' background. It remakes missing ones and ones older than their
picture (`--all`: every one), and `scenes` makes one for each new scene. The
server links a map's thumbnail when the map has a scene or a minimap.

Each writes a `sources.json` next to the files with the URL and date.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
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
# cwebp's near-lossless level: 100 is lossless, lower values let it adjust
# pixel values slightly before lossless coding. 60 keeps every picture above
# 48 dB PSNR against NiaDB's original.
REGION_NEAR_LOSSLESS = 60


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


def near_lossless_webp(body, level):
    """A WebP picture re-encoded near-lossless with cwebp; unchanged when cwebp
    is missing or the result is not smaller."""
    cwebp = os.environ.get("CWEBP") or shutil.which("cwebp")
    if not cwebp:
        print("cwebp not found; region picture kept as fetched")
        return body
    with tempfile.TemporaryDirectory() as folder:
        source, target = Path(folder, "in.webp"), Path(folder, "out.webp")
        source.write_bytes(body)
        subprocess.run([cwebp, "-quiet", "-near_lossless", str(level), "-z", "9", str(source), "-o", str(target)],
                       check=True)
        out = target.read_bytes()
    return out if len(out) < len(body) else body


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
            body = near_lossless_webp(body, REGION_NEAR_LOSSLESS)
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


def save_small_scene(image, source_size, map_id, directory=None):
    """The phone copy, from the source picture or the full-size one; none when
    it would be no smaller than the full-size picture."""
    size = fitted(source_size, SCENE_SMALL_FIT)
    if size == fitted(source_size, SCENE_FIT):
        return None
    directory = SCENES_SMALL if directory is None else Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    save_scene(image, size, directory / f"{map_id}.webp")
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


def client_scenes(directory):
    """Import verified client renders; never replace an existing scene."""
    from PIL import Image

    directory = Path(directory)
    if not directory.is_dir():
        raise ValueError(f"Client scene directory does not exist: {directory}")
    index_path = NIADB / "scenes.json"
    index = read_json(index_path)
    sources_path = SCENES / "sources.json"
    sources = read_json(sources_path)
    done = index["maps"]
    made, existing, rejected = [], [], {}
    SCENES.mkdir(parents=True, exist_ok=True)
    SCENES_SMALL.mkdir(parents=True, exist_ok=True)
    for png in sorted(directory.glob("*.png")):
        if not png.stem.isdecimal():
            continue
        map_id = int(png.stem)
        key = str(map_id)
        target, small = SCENES / f"{key}.webp", SCENES_SMALL / f"{key}.webp"
        if key in done or target.exists() or small.exists():
            existing.append(map_id)
            continue
        try:
            rect = read_json(png.with_suffix(".json"))
            if not isinstance(rect, dict) or any(type(rect.get(k)) is not int for k in ("x", "y", "w", "h")):
                raise ValueError("world rectangle needs integer x, y, w, h")
            if rect["w"] <= 0 or rect["h"] <= 0:
                raise ValueError("world rectangle must have positive width and height")
            with Image.open(png) as image:
                if image.format != "PNG":
                    raise ValueError("source image must be PNG")
                source_size = image.size
                error = abs((image.width / image.height) / (rect["w"] / rect["h"]) - 1)
                if error > 0.02:
                    raise ValueError(f"image and world rectangle aspect ratios differ by {error:.1%}")
                size = fitted(source_size, SCENE_FIT)
                # Encode both copies before publishing either file. The raw
                # source stays outside the repository and is never modified.
                with tempfile.TemporaryDirectory(prefix="client-scene-") as temporary:
                    encoded = Path(temporary) / "scene.webp"
                    save_scene(image, size, encoded)
                    phone = Path(temporary) / f"{key}.webp"
                    if save_small_scene(image, source_size, key, directory=temporary) is None:
                        save_scene(image, fitted(source_size, SCENE_SMALL_FIT), phone)
                    shutil.copyfile(encoded, target)
                    try:
                        shutil.copyfile(phone, small)
                    except Exception:
                        target.unlink(missing_ok=True)
                        small.unlink(missing_ok=True)
                        raise
            done[key] = {"key": "client", **{k: rect[k] for k in ("x", "y", "w", "h")},
                         "source_size": list(source_size), "size": list(size), "source": "client Map.wz"}
            made.append(map_id)
        except (OSError, ValueError, TypeError) as error:
            rejected[map_id] = str(error)
            print(f"client scene {map_id}: rejected: {error}")
    if made:
        today = datetime.date.today().isoformat()
        index["maps"] = dict(sorted(done.items(), key=lambda kv: int(kv[0])))
        index["note"] = ("Written by tools/niadb_map_assets.py scenes and client-scenes: each map's scene picture "
                         "(web/images/scenes/<id>.webp) and its world rectangle (x, y, w, h). "
                         "Entries marked client come from checked client Map.wz renders.")
        index["client_rendered"] = today
        write_json(index_path, index)
        sources["maps"] = sorted(set(sources["maps"]) | set(made))
        sources["note"] = ("Rendered map scenes from NiaDB and checked client Map.wz renders, "
                           "scaled to fit 1760x1040; small/ has copies fitted into 1100x650. "
                           "Game art belongs to NEXON and its affiliates.")
        sources["client_rendered"] = today
        write_json(sources_path, sources)
    print(f"{len(made)} client scenes imported; {len(existing)} existing scenes kept; {len(rejected)} rejected")
    return {"imported": made, "existing": existing, "rejected": rejected}


THUMBS = ROOT / "web" / "images" / "map-thumbs"
MINIMAPS = ROOT / "web" / "images" / "minimaps"
# The map list's 16:10 cards (web/css/dex.css .mtile), at twice their size.
THUMB_SIZE = (480, 300)
THUMB_QUALITY = 80
# The cards' background (.mtile in web/css/dex.css), behind a minimap.
THUMB_BACK = (27, 36, 51)


def save_thumb(map_id):
    """web/images/map-thumbs/<id>.webp for the map list: the middle of the
    scene cut to 16:10, or without a scene the whole minimap on the cards'
    background, clear of the name along the bottom. False when the map has
    neither picture."""
    from PIL import Image

    scene, minimap = SCENES / f"{map_id}.webp", MINIMAPS / f"{map_id}.png"
    tw, th = THUMB_SIZE
    if scene.exists():
        with Image.open(scene) as image:
            w, h = image.size
            if w * th > h * tw:
                cw, ch = round(h * tw / th), h
            else:
                cw, ch = w, round(w * th / tw)
            box = ((w - cw) // 2, (h - ch) // 2, (w - cw) // 2 + cw, (h - ch) // 2 + ch)
            thumb = image.convert("RGB").resize(THUMB_SIZE, Image.LANCZOS, box=box)
    elif minimap.exists():
        with Image.open(minimap) as image:
            image = image.convert("RGBA")
            # 12 px around, 62 px at the bottom for the name.
            fw, fh = tw - 24, th - 12 - 62
            scale = min(fw / image.width, fh / image.height)
            if scale >= 1:
                # Whole steps keep the minimap's pixels sharp.
                n = int(scale)
                image = image.resize((image.width * n, image.height * n), Image.NEAREST)
            else:
                image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                                     Image.LANCZOS)
            thumb = Image.new("RGB", THUMB_SIZE, THUMB_BACK)
            thumb.paste(image, ((tw - image.width) // 2, 12 + (fh - image.height) // 2), image)
    else:
        return False
    THUMBS.mkdir(parents=True, exist_ok=True)
    thumb.save(THUMBS / f"{map_id}.webp", "WEBP", quality=THUMB_QUALITY, method=6)
    return True


def thumbs(every):
    """Thumbnails for every map with a scene or a minimap; without `every`,
    only missing ones and ones older than their picture."""
    ids = {int(p.stem) for folder in (SCENES, MINIMAPS) for p in folder.glob("*.*") if p.stem.isdigit()}
    made = 0
    for map_id in sorted(ids):
        target = THUMBS / f"{map_id}.webp"
        sources = [p for p in (SCENES / f"{map_id}.webp", MINIMAPS / f"{map_id}.png") if p.exists()]
        if not every and target.exists() and all(p.stat().st_mtime <= target.stat().st_mtime for p in sources):
            continue
        made += save_thumb(map_id)
    write_json(THUMBS / "sources.json", {
        "note": "The map list's card pictures, made by tools/niadb_map_assets.py thumbs from "
                "web/images/scenes/ (the middle, cut to 16:10) or, without a scene, web/images/minimaps/. "
                "Game art belongs to NEXON and its affiliates.",
        "size": list(THUMB_SIZE),
        "maps": sorted(int(p.stem) for p in THUMBS.glob("*.webp")),
    })
    print(f"{made} thumbnails in {THUMBS}")


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
        save_thumb(map_id)
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
    client = sub.add_parser("client-scenes", help="import checked client PNG renders and world rectangles")
    client.add_argument("directory", type=Path)
    t = sub.add_parser("thumbs", help="make the map list's card pictures from the scenes and minimaps on disk")
    t.add_argument("--all", action="store_true", help="remake every thumbnail")
    args = ap.parse_args()
    if args.command == "scenes":
        scenes(args.pause)
    elif args.command == "scene-copies":
        scene_copies()
    elif args.command == "client-scenes":
        result = client_scenes(args.directory)
        if result["rejected"]:
            raise SystemExit(1)
    elif args.command == "thumbs":
        thumbs(args.all)
    elif args.command == "fetch":
        fetch(args.pause)
    elif args.command == "worldmap":
        worldmap(args.pause)
    else:
        heads()


if __name__ == "__main__":
    main()
