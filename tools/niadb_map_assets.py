#!/usr/bin/env python3
"""Minimaps and monster sprites for the bestiary's map view, from NiaDB.

    python3 tools/niadb_map_assets.py fetch      # stdlib only, ~10 min
    python3 tools/niadb_map_assets.py heads      # needs Pillow

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

Both write a `sources.json` next to the files with the URL and date.
"""
import argparse
import datetime
import json
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


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="download minimaps and monster sprites")
    f.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    sub.add_parser("heads", help="make the 48 px head icons from the sprites")
    args = ap.parse_args()
    if args.command == "fetch":
        fetch(args.pause)
    else:
        heads()


if __name__ == "__main__":
    main()
