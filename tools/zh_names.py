#!/usr/bin/env python3
"""Simplified Chinese names for the bestiary's maps, NPCs and quests and the
catalogue's items.

    python3 tools/zh_names.py fetch --out data/reference/dvg
    python3 tools/zh_names.py search --dvg data/reference/dvg
    python3 tools/zh_names.py build --output data/reference/zh-names.json

`fetch` (stdlib only) saves DVG's GCW lists (`/api/map-list.php`,
`/api/npc-list.php`) and, for ids the lists lack, the name header of
`/map_info.php?id=` / `/npc_info.php?id=`. `search` asks DVG's site search
(`/api/search.php?q=<id>`) for the items and NPCs still without a simplified
name and saves the hits to `search.json`. `build` writes one entry per map
or NPC that Mapledex gives no simplified (`cw`) name: DVG's name when it
passes `dvg_choice` (same English, no placeholder, no traditional
characters), else Mapledex's traditional name through OpenCC t2s (needs
`opencc-python-reimplemented==0.1.7`), else the name kept in
`zh-translations.json` (a Chinese MapleStory client name, or our translation
where the Chinese servers have none). Items without a Mapledex simplified name get DVG's
name from `search.json`, else the traditional name through t2s, else our
translation; quests without a DVG name get the name kept in
`zh-translations.json`. A translation is used only while its `en` still
matches the English name. Maps take DVG's name even where Mapledex has a
simplified one (`replaces_mapledex`), except `KEEP_MAPLEDEX_MAP`; map names
then go through `MAP_SERIES` and `map_name`. `import_catalog` reads the
result; it never replaces an existing simplified name unless the entry says
`replaces_mapledex`.
"""
import argparse
import datetime
import html
import json
import re
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / "data" / "reference"
TRANSLATIONS = REFERENCE / "zh-translations.json"
ITEMS = ROOT / "data" / "fixture" / "items.sqlite"
DVG = "https://mxdgcw.dvg.cn"
OPENCC_VERSION = "0.1.7"
# The site answers 403 to urllib's default agent.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
# Checked by hand: same NPC on the same maps, English spelled differently
# (Doorbell (Henesys) / Doorbell, Mailbox (Kerning City) / Mailbox,
# Woodworking / Woodcrafting Station).
SAME_DESPITE_ENGLISH = {("npc", 236), ("npc", 237), ("npc", 432), ("npc", 433), ("npc", 800013)}
# Checked by hand: the same item, renamed in Classic World (GM's Blessing of
# Precision / of the Keen Eye, Signature Color Coupon / Signature Hair Color
# Coupon, Custom Mix Dye Coupon / Custom Hair Dye Coupon, Custom Colorblend Eye
# Color Coupon / Custom Eye Color Coupon).
ITEM_RENAMED = {2023001, 5151100, 5151200, 5152300}
# Our English marks a second item of the same name "(Alt)" / "(Alt 2)"; DVG
# names the item plainly or says what differs (红色药水（账号共享）).
ALT = re.compile(r"\s*\(Alt(?: \d+)?\)\s*$")
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
# Checked by hand: DVG's name breaks the naming of the maps around it, or is a
# typo, so the map keeps Mapledex's simplified name. Every other map takes
# DVG's name when DVG has one for the same English.
KEEP_MAPLEDEX_MAP = {
    10: "蘑菇村, as 蘑菇村村民家 next door (DVG: 小蘑菇)",
    20: "蘑菇村, as 蘑菇村村民家 next door (DVG: 小蘑菇)",
    10000001: "明珠港防具店, as 南港防具店 (DVG: 明珠港防御武器店)",
    10001001: "射手村民宅, as 蘑菇村村民家 and 彩虹村村民家 (DVG: 射手村街道)",
    10001020: "射手村西部小山, as 射手村东部小山 and 射手村西部树林 (DVG: 射手村西边小山)",
    10002002: "魔法密林杂货店, as the other towns' 杂货店 (DVG: 魔法密林百货商店)",
    10003002: "废都药店, as 废都武器店 and the other Kerning City shops (DVG: 废弃都市药店)",
    10003062: "换乘区: DVG's 环乘区 is a typo",
    80001100: "魔法师2转考验场, as DVG's 弓箭手2转考验场 (DVG: 魔法师树洞迷宫)",
    80001200: "飞侠2转考验场, as DVG's 弓箭手2转考验场 (DVG: 飞侠施工现场)",
    80001300: "战士2转考验场, as DVG's 弓箭手2转考验场 (DVG: 战士岩山)",
}
# Checked by hand: one map of a series named unlike the rest of it, in DVG
# too. Its name follows the series.
MAP_SERIES = {
    10002022: "猴子迷宫Ⅰ",  # 猴子迷宫Ⅱ (DVG: 猴林迷宫I)
    10002082: "北部森林训练场Ⅷ",  # 北部森林训练场Ⅰ–Ⅸ (DVG: 树洞迷宫：北部森林 VIII)
    10003102: "三号线一号车库",  # 三号线一号地区B1 (DVG: 三号线1号车库)
    10003105: "三号线二号车库",  # 三号线二号地区B1 (DVG: 三号线2号车库)
    10003109: "三号线三号车库",  # 三号线三号地区B1 (DVG: 三号线3号车库)
    10004120: "幽深的峡谷Ⅲ",  # 幽深的峡谷Ⅰ, Ⅱ (DVG: 幽深峡谷Ⅲ)
}
ROMAN = ("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X")
# A series number spelled in Latin letters ("蜗牛狩猎场 I", "森林迷宫II").
LATIN_NUMBER = re.compile(r"(?<=[\u3400-\u9fff）>])\s*(X|IX|VIII|VII|VI|V|IV|III|II|I)$")


def map_name(zh):
    """Map names written one way: series numbers as Ⅰ Ⅱ Ⅲ (89 of DVG's names;
    26 use Latin letters) and a space before `<` (33 of DVG's; 18 have none)."""
    zh = LATIN_NUMBER.sub(lambda m: chr(0x2160 + ROMAN.index(m.group(1))), zh)
    return re.sub(r"(?<=\S)<", " <", zh)


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


def catalogue_items(items_db):
    """{id: {"en", "cw", "tw"}} for every item `import_catalog` adds from
    Mapledex `items.json` / `equips.json` and NiaDB `items.json`
    (`ItemReferences`: Mapledex first, NiaDB's English for the rest). Items
    already in `items_db` keep their own names there and are left out."""
    items = {}
    for name in ("items.json", "equips.json"):
        for item in read_json(REFERENCE / "mapledex" / name)["items"]:
            n = item.get("n") or {}
            items.setdefault(item["id"], {"en": clean(n.get("en")), "cw": clean(n.get("cw")), "tw": clean(n.get("zh"))})
    for item in read_json(REFERENCE / "niadb/items.json"):
        try:
            item_id = int(str(item.get("iconKey")).strip())
        except ValueError:
            continue
        row = items.setdefault(item_id, {"en": None, "cw": None, "tw": None})
        if not row["en"]:
            row["en"] = clean(item.get("name"))
    if items_db.exists():
        with sqlite3.connect(items_db) as db:
            for (item_id,) in db.execute("SELECT item_id FROM items"):
                items.pop(item_id, None)
    return dict(sorted(items.items()))


def quests_without_dvg_name(dvg_dir):
    """{id: {"en"}} for the NiaDB quests DVG gives no simplified name with the
    same English (`add_quests` takes DVG's name only then)."""
    dvg = {row["questid"]: row for row in read_json(dvg_dir / "quest-list.json")["items"]}
    out = {}
    for quest in read_json(REFERENCE / "niadb/quests.json"):
        try:
            quest_id = int(str(quest.get("id")).strip())
        except ValueError:
            continue
        en = clean(quest.get("name"))
        row = dvg.get(quest_id)
        if row and clean(row.get("questname")) and fold(row.get("name_en")) == fold(en):
            continue
        out[quest_id] = {"en": en}
    return dict(sorted(out.items()))


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


# DVG search `typename` for each kind `fetch_search` looks up.
SEARCH_TYPES = {"items": "道具", "npcs": "NPC"}


def search_wanted(dvg_dir, items_db):
    """{"items"|"npcs"|"quests": [id, ...]}: what still has no simplified name
    after Mapledex, DVG's lists and pages."""
    wanted = bestiary()
    dvg, _ = dvg_names(dvg_dir)
    npcs = [i for i, o in wanted["npcs"].items() if not o["cw"] and not has_chinese((dvg["npcs"].get(i) or {}).get("zh"))]
    items = [i for i, o in catalogue_items(items_db).items() if not o["cw"]]
    return {"items": items, "npcs": npcs}


def fetch_search(out, pause, items_db):
    """DVG `/api/search.php?q=<id>` for each id `search_wanted` lists; keeps the
    results whose `mid` is that id, API objects unchanged."""
    wanted = search_wanted(out, items_db)
    rows = []
    total = sum(len(ids) for ids in wanted.values())
    n = 0
    for kind, ids in wanted.items():
        for entity_id in ids:
            n += 1
            data = json.loads(get(f"{DVG}/api/search.php?q={entity_id}&lng=CN"))
            if not data.get("ok"):
                raise ValueError(f"search {entity_id}: {data}")
            hits = [i for i in data.get("items", []) if str(i.get("mid")) == str(entity_id)]
            rows.append({"kind": kind, "id": entity_id, "results": hits})
            print(f"search {n}/{total}: {kind} {entity_id} -> {[h.get('name') for h in hits]}")
            time.sleep(pause)
    write_json(out / "search.json", {
        "source": f"{DVG}/api/search.php?q=<id>&lng=CN (results whose mid is the id)",
        "fetched": datetime.date.today().isoformat(),
        "items": rows,
    })


def search_names(dvg_dir):
    """{"items"|"npcs"|"quests": {id: {"zh", "en"}}} from `search.json`."""
    path = dvg_dir / "search.json"
    out = {kind: {} for kind in SEARCH_TYPES}
    if not path.exists():
        return out, None
    saved = read_json(path)
    for row in saved["items"]:
        for hit in row["results"]:
            if hit.get("typename") == SEARCH_TYPES[row["kind"]]:
                out[row["kind"]][row["id"]] = {"zh": clean(hit.get("name")), "en": clean(hit.get("name_us")), "street": None}
                break
    return out, saved["fetched"]


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
    if kind == "item":
        same = same or fold(dvg["en"]) == fold(ALT.sub("", ours["en"] or "")) or entity_id in ITEM_RENAMED
    if not same and (kind, entity_id) not in NAME_IN_STREET:
        return None, "English differs"
    return zh, None


def build(dvg_dir, output, items_db):
    from opencc import OpenCC  # opencc-python-reimplemented

    t2s = OpenCC("t2s")
    wanted = bestiary()
    wanted["quests"] = quests_without_dvg_name(dvg_dir)
    wanted["items"] = catalogue_items(items_db)
    dvg, fetched = dvg_names(dvg_dir)
    searched, searched_on = search_names(dvg_dir)
    for entity_id, row in searched["npcs"].items():
        dvg["npcs"].setdefault(entity_id, row)
    dvg["items"] = searched["items"]
    if searched_on:
        fetched = ", ".join(sorted(set(fetched.split(", ")) | {searched_on}))
    translations = read_json(TRANSLATIONS)
    result = {
        "version": f"DVG gms-cw fetched {fetched}; Mapledex tw via OpenCC t2s {OPENCC_VERSION}; "
                   f"translations {translations['version']}",
        "sources": {
            "dvg": f"{DVG} (data/reference/dvg/)",
            "mapledex-tw": "Mapledex n.zh (GMS-TW traditional), converted with OpenCC t2s",
            "cms": "Chinese MapleStory client name of the same GMS quest (cms_quest), "
                   "https://maplestory.io/api/CMS/202/quest, kept in data/reference/zh-translations.json",
            "translated": "our translation, data/reference/zh-translations.json",
        },
        "maps": {},
        "npcs": {},
        "quests": {},
        "items": {},
        "dvg_not_used": [],
        "translations_not_used": [],
    }

    def translated(plural, entity_id, en):
        entry = translations.get(plural, {}).get(str(entity_id))
        if not entry:
            return None
        zh = clean(entry.get("zh"))
        if not zh or t2s.convert(zh) != zh or fold(entry.get("en")) != fold(en):
            reason = "English differs" if zh and t2s.convert(zh) == zh else "empty or traditional characters"
            result["translations_not_used"].append({"kind": plural, "id": entity_id, "reason": reason,
                                                    "en": en, "translation": entry})
            return None
        if entry.get("cms_quest"):
            return {"zh": zh, "source": "cms", "en": en, "cms_quest": entry["cms_quest"]}
        return {"zh": zh, "source": "translated", "en": en}

    for plural, kind in (("maps", "map"), ("npcs", "npc")):
        for entity_id, ours in wanted[plural].items():
            if ours["cw"] and kind != "map":
                continue
            if ours["cw"] and entity_id in KEEP_MAPLEDEX_MAP:
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
            if ours["cw"]:
                # Mapledex already names the map: DVG's name, written the
                # site's way, replaces it when they differ.
                if entry is None:
                    continue
                entry["zh"] = MAP_SERIES.get(entity_id) or map_name(entry["zh"])
                if entry["zh"] == ours["cw"]:
                    continue
                entry["mapledex"] = ours["cw"]
                entry["replaces_mapledex"] = True
            if entry is None and ours["tw"]:
                entry = {"zh": t2s.convert(ours["tw"]), "source": "mapledex-tw", "en": ours["en"], "tw": ours["tw"]}
            if entry is None and ours["en"]:
                entry = translated(plural, entity_id, ours["en"])
            if entry and kind == "map" and not ours["cw"]:
                entry["zh"] = MAP_SERIES.get(entity_id) or map_name(entry["zh"])
            if entry:
                result[plural][str(entity_id)] = entry
    for entity_id, ours in wanted["items"].items():
        if ours["cw"]:
            continue
        entry = None
        if entity_id in dvg["items"]:
            zh, reason = dvg_choice("item", entity_id, ours, dvg["items"][entity_id], t2s)
            if zh:
                entry = {"zh": zh, "source": "dvg", "en": ours["en"]}
            elif reason:
                seen = dvg["items"][entity_id]
                result["dvg_not_used"].append({"kind": "item", "id": entity_id, "reason": reason,
                                               "en": ours["en"], "dvg": seen["zh"], "dvg_en": seen["en"]})
        if entry is None and ours["tw"]:
            entry = {"zh": t2s.convert(ours["tw"]), "source": "mapledex-tw", "en": ours["en"], "tw": ours["tw"]}
        if entry is None and ours["en"]:
            entry = translated("items", entity_id, ours["en"])
        if entry:
            result["items"][str(entity_id)] = entry
    for entity_id, ours in wanted["quests"].items():
        entry = translated("quests", entity_id, ours["en"]) if ours["en"] else None
        if entry:
            result["quests"][str(entity_id)] = entry
    reported = {(s["kind"], s["id"]) for s in result["translations_not_used"]}
    for plural in ("maps", "npcs", "quests", "items"):
        for key, entry in translations.get(plural, {}).items():
            used = result[plural].get(key, {}).get("source") in ("translated", "cms")
            if not used and (plural, int(key)) not in reported:
                result["translations_not_used"].append({"kind": plural, "id": int(key),
                                                        "reason": "has another name or is not listed",
                                                        "translation": entry})
    write_json(output, result)
    for plural in ("maps", "npcs", "quests", "items"):
        missing = sum(1 for o in wanted[plural].values() if not o.get("cw"))
        entries = [e for e in result[plural].values() if "mapledex" not in e]
        by = {s: sum(1 for e in entries if e["source"] == s)
              for s in ("dvg", "mapledex-tw", "cms", "translated")}
        replaced = len(result[plural]) - len(entries)
        print(f"{plural}: {missing} without a simplified name; {by['dvg']} from DVG, "
              f"{by['mapledex-tw']} from Mapledex tw, {by['cms']} from CMS, {by['translated']} translated, "
              f"{missing - sum(by.values())} left in English"
              + (f"; {replaced} Mapledex names replaced" if replaced else ""))
    for skipped in result["dvg_not_used"]:
        print(f"DVG name not used ({skipped['reason']}): {skipped['kind']} {skipped['id']} "
              f"{skipped['en']!r} / DVG {skipped['dvg']!r} {skipped['dvg_en']!r}")
    for skipped in result["translations_not_used"]:
        print(f"translation not used ({skipped['reason']}): {skipped['kind']} {skipped['id']} {skipped['translation']}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)
    f = sub.add_parser("fetch", help="save DVG's map and NPC data")
    f.add_argument("--out", type=Path, default=REFERENCE / "dvg")
    f.add_argument("--pause", type=float, default=0.5, help="seconds between requests")
    q = sub.add_parser("search", help="look up remaining items and NPCs with DVG's site search")
    q.add_argument("--dvg", type=Path, default=REFERENCE / "dvg")
    q.add_argument("--items", type=Path, default=ITEMS)
    q.add_argument("--pause", type=float, default=1.0, help="seconds between requests")
    b = sub.add_parser("build", help="write the name mapping import_catalog reads")
    b.add_argument("--dvg", type=Path, default=REFERENCE / "dvg")
    b.add_argument("--output", type=Path, default=REFERENCE / "zh-names.json")
    b.add_argument("--items", type=Path, default=ITEMS, help="import_catalog's --items; its items keep their names")
    args = ap.parse_args()
    if args.command == "fetch":
        fetch(args.out, args.pause)
    elif args.command == "search":
        fetch_search(args.dvg, args.pause, args.items)
    else:
        build(args.dvg, args.output, args.items)


if __name__ == "__main__":
    main()
