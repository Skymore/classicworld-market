#!/usr/bin/env python3
"""Fetch DVG's Classic World monster list (simplified names and sprites).

    python3 tools/dvg_mobs.py --output data/reference/dvg/mob-list.json

Saves every row of https://mxdgcw.dvg.cn/api/mob-list.php (dataset `gms-cw`,
`lng=CN`), API objects unchanged, in the same shape as `map-list.json`.
`import_catalog` takes the monsters' simplified names from it (`mobname`, the
name Chinese Classic World players see). `icon` is the client sprite path under
https://mxdgcw.dvg.cn; sprites the site serves are copied into
`web/images/mobs/` and listed in its `sources.json`.
"""
import argparse
import datetime
import json
import time
import urllib.request

DVG = "https://mxdgcw.dvg.cn"
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
PAGE_SIZE = 100  # the API's cap


def page(n):
    url = f"{DVG}/api/mob-list.php?page={n}&pageSize={PAGE_SIZE}&sortKey=mobid&sortDir=asc&lng=CN"
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise SystemExit(f"{url}: {data}")
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", required=True)
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between requests")
    args = ap.parse_args()
    rows, n, total = [], 1, None
    while True:
        data = page(n)
        meta = data["meta"]
        if total is not None and meta["total"] != total:
            raise SystemExit("mob list changed while paging; fetch again")
        total = meta["total"]
        rows += data["items"]
        print(f"page {n}/{meta['totalPages']}: {len(rows)}/{total}")
        if n >= meta["totalPages"]:
            break
        n += 1
        time.sleep(args.pause)
    ids = [r["mobid"] for r in rows]
    if len(ids) != len(set(ids)) or len(ids) != total:
        raise SystemExit(f"{len(ids)} rows, {len(set(ids))} ids, total {total}")
    with open(args.output, "w", encoding="utf-8") as out:
        json.dump({"source": f"{DVG}/api/mob-list.php?lng=CN", "fetched": datetime.date.today().isoformat(),
                   "items": rows}, out, ensure_ascii=False, separators=(",", ":"))
        out.write("\n")
    print(f"mobs {len(rows)}")


if __name__ == "__main__":
    main()
