#!/usr/bin/env python3
"""Simplified Chinese names for the bestiary's maps and NPCs.

    python3 tools/zh_names.py fetch --out data/reference/dvg
    python3 tools/zh_names.py build --output data/reference/zh-names.json

`fetch` (stdlib only) saves DVG's GCW lists (`/api/map-list.php`,
`/api/npc-list.php`) and, for ids the lists lack, the name header of
`/map_info.php?id=` / `/npc_info.php?id=`. `build` writes one entry per map
or NPC that Mapledex gives no simplified (`cw`) name: DVG's name when it
passes `dvg_choice` (same English, no placeholder, no traditional
characters), else Mapledex's traditional name through OpenCC t2s (needs
`opencc-python-reimplemented==0.1.7`). Names neither has stay English.
`import_catalog` reads the result; it never replaces a Mapledex name.
"""
import argparse
import datetime
import html
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / "data" / "reference"
DVG = "https://mxdgcw.dvg.cn"
OPENCC_VERSION = "0.1.7"
# The site answers 403 to urllib's default agent.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
# Checked by hand: same NPC on the same maps, English spelled differently
# (Doorbell (Henesys) / Doorbell, Woodworking / Woodcrafting Station).
SAME_DESPITE_ENGLISH = {("npc", 236), ("npc", 432), ("npc", 800013)}
# DVG lists this map as name 维多利亚路 "Victoria Road", street 黄蘑菇屋;
# NiaDB, where our English comes from, has them the other way round.
NAME_IN_STREET = {("map", 10001008)}
# DVG's name for maps it has no name for.
PLACEHOLDER = re.compile(r"^地图 \d+$")
# Checked by hand against NiaDB's English and DVG: Mapledex's simplified name
# for these ids is another map's (蜗牛打猎场Ⅰ for In a Small Forest, 铁甲猪公园Ⅲ
# for Someone Else's House). DVG's name replaces it.
MAPLEDEX_WRONG = {
    ("map", 1001), ("map", 1002), ("map", 1010), ("map", 1011), ("map", 1012), ("map", 1013),
    ("map", 10001005),
}


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


def has_chinese(text):
    return bool(re.search(r"[\u3400-\u9fff]", text or ""))


def fold(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


# ---------- what the bestiary lists ----------


def clean(text):
    text = html.unescape((text or "").strip())
    return text or None


def bestiary():
    """{"maps"|"npcs": {id: {"en", "cw", "tw"}}} for every map and NPC
    `import_catalog` writes: Mapledex first, NiaDB for the rest."""
    mdx_maps = read_json(REFERENCE / "mapledex/maps.json")["items"]
    mdx_npcs = read_json(REFERENCE / "mapledex/npcs.json")["items"]
    nia_maps = read_json(REFERENCE / "niadb/maps.json")
    nia_shops = read_json(REFERENCE / "niadb/npc-shops.json")

    def names(n):
        return {"en": clean(n.get("en")), "cw": clean(n.get("cw")), "tw": clean(n.get("zh"))}

    maps = {m["id"]: names(m["n"]) for m in mdx_maps}
    for m in nia_maps:
        # NiaDB names the map; a Mapledex English name that differs is another
        # map's (import_catalog `take_nia_name`), and so are its Chinese names.
        row, name = maps.get(int(m["id"])), clean(m.get("name"))
        if row and name and fold(name) != fold(row["en"]):
            maps[int(m["id"])] = {"en": name, "cw": None, "tw": None}
    for kind, entity_id in MAPLEDEX_WRONG:
        if kind == "map" and entity_id in maps:
            maps[entity_id]["cw"] = None
    npcs = {i: {"en": None, "cw": None, "tw": None} for m in mdx_maps for i in m.get("npcs", [])}
    npcs.update({n["id"]: names(n["n"]) for n in mdx_npcs})
    for m in nia_maps:
        if int(m["id"]) not in maps and clean(m.get("name")):
            maps[int(m["id"])] = {"en": clean(m["name"]), "cw": None, "tw": None}
    nia_npcs = [(n["id"], n.get("name")) for m in nia_maps if int(m["id"]) in maps for n in m.get("npcs", [])]
    nia_npcs += [(s["npcId"], s.get("npcName")) for s in nia_shops]
    for npc_id, name in nia_npcs:
        row = npcs.setdefault(int(npc_id), {"en": None, "cw": None, "tw": None})
        if not any(row.values()):
            row["en"] = clean(name)
    return {"maps": dict(sorted(maps.items())), "npcs": dict(sorted(npcs.items()))}


# ---------- fetch ----------


def get(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json, text/html", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def fetch_list(kind, pause):
    """All rows of /api/<kind>-list.php, API objects unchanged."""
    key = {"map": "mapid", "npc": "npcid"}[kind]
    rows, page, total = [], 1, None
    while True:
        url = f"{DVG}/api/{kind}-list.php?page={page}&pageSize=500&sortKey={key}&sortDir=asc&lng=CN"
        data = json.loads(get(url))
        if not data.get("ok"):
            raise ValueError(f"{url}: {data}")
        meta = data["meta"]
        if total is not None and meta["total"] != total:
            raise ValueError(f"{kind} list changed while paging; fetch again")
        total = meta["total"]
        rows += data["items"]
        print(f"{kind} list page {page}/{meta['totalPages']}: {len(rows)}/{total}")
        if page >= meta["totalPages"]:
            break
        page += 1
        time.sleep(pause)
    ids = [r[key] for r in rows]
    assert len(ids) == len(set(ids)) == total, f"{kind} list: {len(ids)} rows, total {total}"
    return rows


HEADER = re.compile(
    r'<h1[^>]*data-ui-item-tip="(?P<kind>map|npc)" data-ui-item-tip-id="(?P<id>\d+)"[^>]*>(?P<name>[^<]*)</h1>'
    r'\s*(?:<span class="gcw-entity-english-name"[^>]*>(?P<en>[^<]*)</span>)?'
    r'\s*(?:<p[^>]*>(?P<sub>[^<]*)</p>)?'
)


def fetch_page(kind, entity_id):
    """The detail page's name header; `found: false` when DVG has no such id."""
    page = get(f"{DVG}/{kind}_info.php?id={entity_id}")
    match = HEADER.search(page or "")
    if not match or int(match["id"]) != entity_id:
        return {"id": entity_id, "found": False}
    return {
        "id": entity_id,
        "found": True,
        "name": clean(match["name"]),
        "name_en": clean(match["en"]),
        "subtitle": clean(match["sub"]),
    }


def fetch(out, pause):
    out.mkdir(parents=True, exist_ok=True)
    fetched = datetime.date.today().isoformat()
    wanted = bestiary()
    for kind, plural, key in (("map", "maps", "mapid"), ("npc", "npcs", "npcid")):
        rows = fetch_list(kind, pause)
        write_json(out / f"{kind}-list.json", {
            "source": f"{DVG}/api/{kind}-list.php?lng=CN",
            "fetched": fetched,
            "items": rows,
        })
        listed = {r[key] for r in rows}
        missing = [i for i in wanted[plural] if i not in listed]
        pages = []
        for n, entity_id in enumerate(missing, 1):
            pages.append(fetch_page(kind, entity_id))
            print(f"{kind} page {n}/{len(missing)}: {entity_id} found={pages[-1]['found']}")
            time.sleep(pause)
        write_json(out / f"{kind}-pages.json", {
            "source": f"{DVG}/{kind}_info.php?id=<id> (h1 name, English name, subtitle)",
            "fetched": fetched,
            "items": pages,
        })


# ---------- build ----------


def dvg_names(dvg_dir):
    """{"maps"|"npcs": {id: {"zh", "en", "street"}}} from the saved lists and pages."""
    out = {"maps": {}, "npcs": {}}
    fetched = set()
    for kind, plural, key, name in (("map", "maps", "mapid", "mapName"), ("npc", "npcs", "npcid", "npcname")):
        listing = read_json(dvg_dir / f"{kind}-list.json")
        pages = read_json(dvg_dir / f"{kind}-pages.json")
        fetched.update((listing["fetched"], pages["fetched"]))
        for row in listing["items"]:
            out[plural][row[key]] = {
                "zh": clean(row.get(name)),
                "en": clean(row.get("name_en")),
                "street": clean(row.get("streetName")),
            }
        for page in pages["items"]:
            # Pages were fetched for ids an older list lacked; a newer list wins.
            if page["found"] and page["id"] not in out[plural]:
                out[plural][page["id"]] = {"zh": page["name"], "en": page["name_en"], "street": None}
    return out, ", ".join(sorted(fetched))


def dvg_choice(kind, entity_id, ours, dvg, t2s):
    """(name, None) when DVG's name for this id can be used, else (None, reason)."""
    zh = dvg["street"] if (kind, entity_id) in NAME_IN_STREET else dvg["zh"]
    if not has_chinese(zh):
        return None, None  # DVG has no Chinese name
    if PLACEHOLDER.match(zh):
        return None, "placeholder"
    if t2s.convert(zh) != zh:
        return None, "traditional characters"
    same = not dvg["en"] or fold(dvg["en"]) == fold(ours["en"]) or (kind, entity_id) in SAME_DESPITE_ENGLISH
    if not same and (kind, entity_id) not in NAME_IN_STREET:
        return None, "English differs"
    return zh, None


def build(dvg_dir, output):
    from opencc import OpenCC  # opencc-python-reimplemented

    t2s = OpenCC("t2s")
    wanted = bestiary()
    dvg, fetched = dvg_names(dvg_dir)
    result = {
        "version": f"DVG gms-cw fetched {fetched}; Mapledex tw via OpenCC t2s {OPENCC_VERSION}",
        "sources": {
            "dvg": f"{DVG} (data/reference/dvg/)",
            "mapledex-tw": "Mapledex n.zh (GMS-TW traditional), converted with OpenCC t2s",
        },
        "maps": {},
        "npcs": {},
        "dvg_not_used": [],
    }
    for plural, kind in (("maps", "map"), ("npcs", "npc")):
        for entity_id, ours in wanted[plural].items():
            if ours["cw"]:
                continue
            entry = None
            if entity_id in dvg[plural]:
                zh, reason = dvg_choice(kind, entity_id, ours, dvg[plural][entity_id], t2s)
                if zh:
                    entry = {"zh": zh, "source": "dvg", "en": ours["en"]}
                    if (kind, entity_id) in MAPLEDEX_WRONG:
                        entry["replaces_mapledex"] = True
                elif reason:
                    seen = dvg[plural][entity_id]
                    result["dvg_not_used"].append({"kind": kind, "id": entity_id, "reason": reason,
                                                   "en": ours["en"], "dvg": seen["zh"], "dvg_en": seen["en"]})
            if entry is None and ours["tw"]:
                entry = {"zh": t2s.convert(ours["tw"]), "source": "mapledex-tw", "en": ours["en"], "tw": ours["tw"]}
            if entry:
                result[plural][str(entity_id)] = entry
    write_json(output, result)
    for plural in ("maps", "npcs"):
        missing = sum(1 for o in wanted[plural].values() if not o["cw"])
        by = {s: sum(1 for e in result[plural].values() if e["source"] == s) for s in ("dvg", "mapledex-tw")}
        print(f"{plural}: {missing} without a Mapledex simplified name; {by['dvg']} from DVG, "
              f"{by['mapledex-tw']} from Mapledex tw, {missing - sum(by.values())} left in English")
    for skipped in result["dvg_not_used"]:
        print(f"DVG name not used ({skipped['reason']}): {skipped['kind']} {skipped['id']} "
              f"{skipped['en']!r} / DVG {skipped['dvg']!r} {skipped['dvg_en']!r}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="save DVG's map and NPC data")
    f.add_argument("--out", type=Path, default=REFERENCE / "dvg")
    f.add_argument("--pause", type=float, default=0.5, help="seconds between requests")
    b = sub.add_parser("build", help="write the name mapping import_catalog reads")
    b.add_argument("--dvg", type=Path, default=REFERENCE / "dvg")
    b.add_argument("--output", type=Path, default=REFERENCE / "zh-names.json")
    args = ap.parse_args()
    if args.command == "fetch":
        fetch(args.out, args.pause)
    else:
        build(args.dvg, args.output)


if __name__ == "__main__":
    main()
