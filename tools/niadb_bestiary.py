#!/usr/bin/env python3
"""Fetch NiaDB's (meowdb.com) MapleStory Classic World monsters, maps, drops and mesos.

    python3 tools/niadb_bestiary.py --output data/reference/niadb

Writes four files into the NiaDB reference directory, which `import_catalog`
reads (`--niadb`):

- `monsters.json`: the monster list embedded in https://meowdb.com/msclassic/monsters
  (launch stats and `regions`), objects unchanged.
- `maps.json`: https://meowdb.com/_data/maps.json, unchanged (spawns, NPCs,
  portals, `region`).
- `drops.json`: per monster, `/msclassic/api/drops?monsterId=<id>`, the items
  players have seen drop in Classic World with up/down votes. Per-viewer fields
  (`userVote`, `canEdit`, `isLoggedIn`, `userRole`) are left out.
- `mesos.json`: per monster, `/msclassic/api/mesos-reports?monsterId=<id>`, the
  meso amounts players saw per pile with votes, and NiaDB's `summary` (median
  min and max over its trusted reports). Per-viewer fields (`isOwn`, `userVote`,
  `isLoggedIn`, `userRole`, `userReportId`) are left out.

Monster and map ids are Classic World ids (the same as Mapledex); a drop's
`itemIconKey` is the Classic World item id, `itemId` is NiaDB's own. Requests are
sent one at a time.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SITE = "https://meowdb.com"
# Cloudflare in front of the site rejects urllib's default agent.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
PER_VIEWER = ("userVote", "canEdit", "isOwn")


def get(path):
    request = urllib.request.Request(SITE + path, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code in (403, 429):
            sys.exit(f"stopped at {path}: HTTP {error.code}")
        raise


def monsters():
    """The monster objects embedded in the list page's React payload."""
    page = get("/msclassic/monsters")
    pushes = re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', page)
    text = "".join(json.loads('"' + chunk + '"') for chunk in pushes)
    decoder, found = json.JSONDecoder(), {}
    for match in re.finditer(r'\{"id":\d+,"name":', text):
        try:
            obj, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if {"level", "hp", "exp", "regions"} <= obj.keys():
            found.setdefault(obj["id"], obj)
    if not found:
        sys.exit("no monsters found on /msclassic/monsters; the page layout changed")
    return [found[k] for k in sorted(found)]


def drops(mob_id):
    data = json.loads(get(f"/msclassic/api/drops?monsterId={mob_id}"))
    rows = [{k: v for k, v in row.items() if k not in PER_VIEWER} for row in data.get("drops", [])]
    return {"locked": data.get("locked"), "lockReason": data.get("lockReason"), "drops": rows}


def mesos(mob_id):
    data = json.loads(get(f"/msclassic/api/mesos-reports?monsterId={mob_id}"))
    rows = [{k: v for k, v in row.items() if k not in PER_VIEWER} for row in data.get("reports", [])]
    return {"locked": data.get("locked"), "lockReason": data.get("lockReason"),
            "summary": data.get("summary"), "reports": rows}


def dated(source, per_mob):
    return {
        "source": SITE + source,
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "monsters": per_mob,
    }


def write(path, value):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True, help="NiaDB reference directory")
    ap.add_argument("--pause", type=float, default=3.0, help="seconds between requests")
    args = ap.parse_args()
    mobs = monsters()
    print(f"monsters {len(mobs)}", flush=True)
    time.sleep(args.pause)
    maps = json.loads(get("/_data/maps.json"))
    print(f"maps {len(maps)}", flush=True)
    per_mob, per_mob_mesos = {}, {}
    for n, mob in enumerate(mobs, 1):
        key = str(mob["id"])
        time.sleep(args.pause)
        per_mob[key] = drops(mob["id"])
        time.sleep(args.pause)
        per_mob_mesos[key] = mesos(mob["id"])
        print(f"{n}/{len(mobs)} monster {key}: {len(per_mob[key]['drops'])} drops, "
              f"{len(per_mob_mesos[key]['reports'])} meso reports", flush=True)
    # Write only after every request succeeded, so a stopped run leaves the old files.
    write(os.path.join(args.output, "monsters.json"), mobs)
    write(os.path.join(args.output, "maps.json"), maps)
    write(os.path.join(args.output, "drops.json"), dated("/msclassic/api/drops?monsterId=<id>", per_mob))
    write(os.path.join(args.output, "mesos.json"),
          dated("/msclassic/api/mesos-reports?monsterId=<id>", per_mob_mesos))
    print(f"drops {sum(len(m['drops']) for m in per_mob.values())}, "
          f"monsters with meso reports {sum(1 for m in per_mob_mesos.values() if m['reports'])}")


if __name__ == "__main__":
    main()
