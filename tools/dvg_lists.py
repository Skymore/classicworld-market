#!/usr/bin/env python3
"""Fetch DVG's Classic World monster and quest lists (simplified names).

    python3 tools/dvg_lists.py --output data/reference/dvg

Saves every row of https://mxdgcw.dvg.cn/api/mob-list.php and
/api/quest-list.php (dataset `gms-cw`, `lng=CN`), API objects unchanged, as
`mob-list.json` and `quest-list.json` in the same shape as `map-list.json`.
`import_catalog` takes simplified monster names (`mobname`) and quest names
(`questname`) and quest NPC ids (`npcid`) from them: the names Chinese Classic
World players see. A mob's `icon` is the client sprite path under
https://mxdgcw.dvg.cn; sprites the site serves are copied into
`web/images/mobs/` and listed in its `sources.json`.
"""
import argparse
import datetime
import json
import os
import time
import urllib.request

DVG = "https://mxdgcw.dvg.cn"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
PAGE_SIZE = 100  # the API's cap


LISTS = {"mob": "mobid", "quest": "questid"}


def page(kind, n):
    key = LISTS[kind]
    url = f"{DVG}/api/{kind}-list.php?page={n}&pageSize={PAGE_SIZE}&sortKey={key}&sortDir=asc&lng=CN"
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise SystemExit(f"{url}: {data}")
    return data


def fetch(kind, pause):
    rows, n, total = [], 1, None
    while True:
        data = page(kind, n)
        meta = data["meta"]
        if total is not None and meta["total"] != total:
            raise SystemExit(f"{kind} list changed while paging; fetch again")
        total = meta["total"]
        rows += data["items"]
        print(f"{kind} page {n}/{meta['totalPages']}: {len(rows)}/{total}", flush=True)
        if n >= meta["totalPages"]:
            break
        n += 1
        time.sleep(pause)
    ids = [r[LISTS[kind]] for r in rows]
    if len(ids) != len(set(ids)) or len(ids) != total:
        raise SystemExit(f"{kind}: {len(ids)} rows, {len(set(ids))} ids, total {total}")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True, help="DVG reference directory")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    args = ap.parse_args()
    lists = {}
    for kind in LISTS:
        lists[kind] = fetch(kind, args.pause)
        time.sleep(args.pause)
    # Write only after both lists were fetched.
    for kind, rows in lists.items():
        with open(os.path.join(args.output, f"{kind}-list.json"), "w", encoding="utf-8") as out:
            json.dump({"source": f"{DVG}/api/{kind}-list.php?lng=CN", "fetched": datetime.date.today().isoformat(),
                       "items": rows}, out, ensure_ascii=False, separators=(",", ":"))
            out.write("\n")
        print(f"{kind}s {len(rows)}")


if __name__ == "__main__":
    main()
